// src/agent-view/attached-card-watcher.ts
/**
 * Attached Card Watcher —镜像 LiveProgressWatcher (src/feishu/live-progress.ts)
 * 的 setInterval / inFlightTick / patchFailureCount模式。
 *
 *单一职责:每 intervalMs调一次 tick(),拉最新 snapshot + recentOutput,
 * patch飞书卡;达到停止条件(idle / user_chat / superseded / user_stop /
 * patch_failed / max_ticks)时清理 setInterval 并 onStop回调。
 */
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/async';
import { AgentSnapshotFetcher } from './snapshot-fetcher';
import { buildAttachedCard } from './card';
import type { FetchResult } from './snapshot-fetcher';

export interface AttachedWatchConfig {
 intervalMs: number;
 maxTicks: number;
 maxPatchFailures: number;
}

export const DEFAULT_ATTACHED_WATCH_CONFIG: AttachedWatchConfig = {
 intervalMs:10_000,
 maxTicks:800,
 maxPatchFailures:3,
};

export interface AttachedWatchDeps {
 openId: string;
 sessionId: string;
 shortId: string;
 name: string;
 cwd: string;
 cardMessageId: string;
 patchFn: (messageId: string, card: string) => Promise<any>;
 config: AttachedWatchConfig;
 /**
 * 三层 JSONL解析(tier1 own / tier2 parent / tier3 claude logs退化),
 * 由 manager注入 this.resolvePeekContent绑定。
 */
 resolveContent: (
 shortId: string,
 maxChars: number,
 ) => Promise<{ text: string | null; format: 'markdown' | 'terminal' }>;
 onStop: (openId: string, reason: string, watcher: AttachedCardWatcher) => void;
}

export class AttachedCardWatcher {
 private intervalHandle: ReturnType<typeof setInterval> | null = null;
 private tickCount =0;
 private patchFailureCount =0;
 private stopped = false;
 private startedAt = Date.now();
 private inFlightTick: Promise<void> | null = null;

 constructor(private readonly deps: AttachedWatchDeps) {}

 start(): void {
 this.intervalHandle = setInterval(
 () => {
 // skip overlap, 同 live-progress.ts:115
 if (this.inFlightTick) return;
 this.inFlightTick = this.tick()
 .catch(err => logger.error(`AttachedCardWatcher tick error: ${err}`))
 .finally(() => {
 this.inFlightTick = null;
 });
 },
 this.deps.config.intervalMs,
 );
 logger.info(
 `AttachedCardWatcher start: openId=${this.deps.openId}, ` +
 `sessionId=${this.deps.sessionId}, cardMessageId=${this.deps.cardMessageId}, ` +
 `intervalMs=${this.deps.config.intervalMs}`,
 );
 }

 async stop(reason: string, opts?: { patchFinal?: boolean }): Promise<void> {
 if (this.stopped) return;
 this.stopped = true;
 if (this.intervalHandle) {
 clearInterval(this.intervalHandle);
 this.intervalHandle = null;
 }
 const elapsedSec = Math.floor((Date.now() - this.startedAt) /1000);
 logger.info(
 `AttachedCardWatcher stop: openId=${this.deps.openId}, ` +
 `reason=${reason}, ticks=${this.tickCount}, elapsed=${elapsedSec}s`,
 );
 this.deps.onStop(this.deps.openId, reason, this);
 //等待 in-flight tick 完成(最多5s,避免 SIGTERM截断 patchFn)
 if (this.inFlightTick) {
 await withTimeout(this.inFlightTick,5000, undefined as void | undefined);
 }
 }

 // tick() 在 Task5 实现
 async tick(): Promise<void> {
 // 占位,实际实现在 Task5
 }
}

/**
 * AttachedWatchers 管理器(per AgentViewManager 实例一个)
 */
export class AttachedWatchers {
 private watchers = new Map<string, AttachedCardWatcher>();

 constructor(
 private readonly patchFn: (messageId: string, card: string) => Promise<any>,
 private readonly resolveContentFn: (
 shortId: string,
 maxChars: number,
 ) => Promise<{ text: string | null; format: 'markdown' | 'terminal' }>,
 private readonly config: AttachedWatchConfig = DEFAULT_ATTACHED_WATCH_CONFIG,
 ) {}

 has(openId: string): boolean {
 return this.watchers.has(openId);
 }

 /**
 *取代式启动:openId已有旧 watcher 时静默 stop,再启新的。
 * cardMessageId 由调用方在调此方法前拿到(buildAttachedCard + cardReplyFn)。
 */
 async start(
 openId: string,
 opts: {
 sessionId: string;
 shortId: string;
 name: string;
 cwd: string;
 cardMessageId: string;
 },
 ): Promise<void> {
 if (this.watchers.has(openId)) {
 await this.watchers.get(openId)!.stop('superseded', { patchFinal: false });
 this.watchers.delete(openId);
 }
 const watcher = new AttachedCardWatcher({
 openId,
 sessionId: opts.sessionId,
 shortId: opts.shortId,
 name: opts.name,
 cwd: opts.cwd,
 cardMessageId: opts.cardMessageId,
 patchFn: this.patchFn,
 config: this.config,
 resolveContent: this.resolveContentFn,
 onStop: (oid, reason, w) => {
 // identity check:避免慢 in-flight tick完成后被旧 watcher clobber
 if (this.watchers.get(oid) === w) this.watchers.delete(oid);
 },
 });
 this.watchers.set(openId, watcher);
 watcher.start();
 }

 async stop(openId: string, reason: string, opts?: { patchFinal?: boolean }): Promise<void> {
 const w = this.watchers.get(openId);
 if (w) {
 await w.stop(reason, opts);
 //双重清理:onStop 已 delete一次(若 identity check命中),这里再保险
 this.watchers.delete(openId);
 }
 }

 /** bot shutdown 时清空所有 */
 async stopAll(): Promise<void> {
 await Promise.all([...this.watchers.values()].map(w => w.stop('shutdown')));
 }
}
