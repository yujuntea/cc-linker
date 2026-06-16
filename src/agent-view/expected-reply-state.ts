import type { UserManager, MappingEntry } from '../feishu/mapping';
import { logger } from '../utils/logger';

export interface ExpectedReplyInfo {
  shortId: string;
  sessionId: string;   // = MappingEntry.sessionUuid
  cwd: string;
  /** v2.4: 飞书 card action 的 messageId,用于 tryRendezvousReply 线程化回复 */
  messageId?: string;
  // startedAt / timeoutMs 由 state 内部管理
}

interface InternalEntry {
  shortId: string;
  sessionId: string;
  cwd: string;
  messageId?: string;
  startedAt: number;   // epoch ms
  timeoutMs: number;
  casToken: string;
}

export class ExpectedReplyState {
  private inMemory = new Map<string, InternalEntry>();
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private userManager: UserManager,
    private defaultTimeoutMs: number = 300_000  // 5 分钟
  ) {}

  /**
   * 设置 expectedReply 状态。CAS 写入 user-mapping。
   *
   * v2.3.12 放宽智能 CAS:user-mapping 当前 entry 可能是:
   *   - null → 直接写
   *   - `last_agent_list_card`(上一次 /agents 留下的 list 卡 pointer) → 自动清
   *   - `pending_agent_reply`(上一个 reply 没走完 cleanup) → 自动清
   *   - `session`(任意 sessionUuid,无论同/不同 session) → 自动清
   *     用户点 [Reply] 即显式 override 意图,把之前 attach 的 session 踢掉。
   *     v2.3.3 ~ v2.3.11 这条路径里"不同 sessionUuid"会 throw,UX 极差(用户在
   *     Agent View 点 Reply 别的 session 看到"⚠️ existing entry is 'session' for
   *     a different session"误以为冲突 — 其实他就是想切)。
   *   - `pending_new_session`(用户 /new 没带 prompt,等下一条) → 自动清
   *     没有 in-flight 异步工作,用户改主意点 Reply 安全清。
   *   - `pending_new_session_claimed`(bot 正在 spawn 新 session,bindSessionToClaim
   *     callback 等着回写这条 entry)→ throw,这是唯一真"另一端在跑"
   *     不能动的状态;清掉 SDK 收尾找不到目标 entry,sessionUuid 永远悬空。
   */
  async set(openId: string, info: ExpectedReplyInfo): Promise<void> {
    // v2.6: fork 解析(防止 card 上是 stale sessionId,持久化前翻译)
    // 调用方通常已翻译(handleReplyRequest/handleReply 都做了),这里是兜底
    let effectiveInfo = info;
    try {
      const { resolveLiveSession } = await import('./fork-resolver');
      const resolved = await resolveLiveSession(info.sessionId);
      if (resolved?.hasLiveFork && resolved.liveFork) {
        logger.info(
          `ExpectedReply.set: 翻译 ${info.sessionId.slice(0, 8)} → 活 fork ${resolved.liveFork.short}`,
        );
        effectiveInfo = {
          ...info,
          sessionId: resolved.liveFork.fullUuid,
          shortId: resolved.liveFork.short,
        };
      }
    } catch (err: any) {
      logger.warn(`ExpectedReply.set: resolveLiveSession failed for ${info.sessionId}: ${err?.message ?? err}`);
    }

    const now = Date.now();
    const casToken = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const newEntry: MappingEntry = {
      type: 'pending_agent_reply',
      sessionUuid: effectiveInfo.sessionId,
      cwd: effectiveInfo.cwd,
      createdAt: new Date(now).toISOString(),
      startedAt: new Date(now).toISOString(),
      timeoutMs: this.defaultTimeoutMs,
      shortId: effectiveInfo.shortId,
      cardMessageId: effectiveInfo.messageId,  // v2.4: persist for crash recovery
      casToken,
    };
    // 智能 CAS:探测当前 entry
    const current = this.userManager.getEntry(openId);
    if (current) {
      // 唯一真不能动的状态:bot 正在 spawn 新 session,后续 callback 会回写这条 entry
      if (current.type === 'pending_new_session_claimed') {
        throw new Error(
          `Failed to set expectedReply for ${openId}: bot is spawning a new session ` +
          `(pending_new_session_claimed); please wait for it to finish or send /cancel.`,
        );
      }
      // 其他类型:用户自己的状态,Reply 是显式 override,安全清
      const cleared = await this.userManager.compareAndSwap(openId, current, null);
      if (!cleared) {
        throw new Error(`Failed to set expectedReply for ${openId}: CAS conflict on clear`);
      }
    }
    // 现在 slot 是 null 了,写 pending_agent_reply
    const ok = await this.userManager.compareAndSwap(openId, null, newEntry);
    if (!ok) {
      throw new Error(`Failed to set expectedReply for ${openId}: CAS failed on write`);
    }
    // in-memory — v2.6.1: 用 effectiveInfo 保持 disk(user-mapping)和 memory 一致
    // 之前用 info.* 导致 disk 写 fork UUID、memory 留 stale,get() 返新对象所以没炸,
    // 但任何依赖 memory 状态的代码会读到旧值,易踩坑
    const internal: InternalEntry = {
      shortId: effectiveInfo.shortId,
      sessionId: effectiveInfo.sessionId,
      cwd: effectiveInfo.cwd,
      messageId: effectiveInfo.messageId,
      startedAt: now,
      timeoutMs: this.defaultTimeoutMs,
      casToken,
    };
    this.inMemory.set(openId, internal);
    this.scheduleTimeout(openId);
  }

  /**
   * 清除 expectedReply 状态(从 user-mapping 和 in-memory 都删)。
   * reason: 'user' / 'timeout' / 'overwrite'
   */
  async clear(openId: string, _reason?: 'user' | 'timeout' | 'overwrite'): Promise<void> {
    const current = this.userManager.getEntry(openId);
    if (current?.type === 'pending_agent_reply') {
      await this.userManager.compareAndSwap(openId, current, null);
    }
    // v2.2.19 fix: always clear local state. CAS 1 in handleAttach may have
    // already nulled the user-mapping entry, but in-memory + timer are stale.
    this.inMemory.delete(openId);
    this.clearTimer(openId);
  }

  /**
   * Mark the reply as sent (T2 in rendezvous flow). This is called
   * immediately after the reply is successfully injected into the bg
   * worker, BEFORE waiting for completion. The point is to prevent the
   * user from sending a second reply during the rendezvous wait window
   * (60s+ for slow bg tasks), which would cause duplicate responses
   * because expectedReply is still set.
   *
   * M1 fix: v2.3.11 only cleared in finally, after runChatSDK returned.
   * During the 60s wait, expectedReply stayed set, so a second user
   * text would re-enter handleReply and re-inject.
   *
   * Idempotent: safe to call multiple times or when nothing is pending.
   * After markSent, get() returns undefined and handleChat routes the
   * user's text as regular chat (which the SDK may reject as bg-conflict
   * or accept as new chat).
   */
  async markSent(openId: string): Promise<void> {
    const current = this.userManager.getEntry(openId);
    if (current && current.type === 'pending_agent_reply') {
      await this.userManager.compareAndSwap(openId, current, null);
    }
    this.inMemory.delete(openId);
    this.clearTimer(openId);
  }

  get(openId: string): ExpectedReplyInfo | undefined {
    const e = this.inMemory.get(openId);
    if (!e) return undefined;
    return { shortId: e.shortId, sessionId: e.sessionId, cwd: e.cwd, messageId: e.messageId };
  }

  private scheduleTimeout(openId: string): void {
    this.clearTimer(openId);
    const e = this.inMemory.get(openId);
    if (!e) return;
    const remain = e.timeoutMs - (Date.now() - e.startedAt);
    if (remain <= 0) {
      // 已超时,立即清除
      void this.clear(openId, 'timeout');
      return;
    }
    const timer = setTimeout(() => {
      void this.clear(openId, 'timeout');
    }, remain);
    this.timeoutTimers.set(openId, timer);
  }

  private clearTimer(openId: string): void {
    const t = this.timeoutTimers.get(openId);
    if (t) {
      clearTimeout(t);
      this.timeoutTimers.delete(openId);
    }
  }

  /**
   * Bot 启动恢复(R8):
   * 遍历 user-mapping,对 `pending_agent_reply` 类型:
   * - 已超时:静默删除
   * - 未超时:in-memory 重建 + setTimeout 剩余时间
   */
  async restoreExpectedReplyStates(): Promise<void> {
    const entries = await this.userManager.allEntries();
    for (const [openId, entry] of entries) {
      if (entry.type !== 'pending_agent_reply') continue;
      const startedAt = new Date(entry.startedAt!).getTime();
      const elapsed = Date.now() - startedAt;
      if (elapsed >= entry.timeoutMs!) {
        // 已超时,静默删除
        await this.userManager.compareAndSwap(openId, entry, null);
      } else {
        // v2.6: 翻译 stale sessionId → 活 fork(bot 重启续接)
        let effectiveSessionId = entry.sessionUuid!;
        let effectiveShortId = entry.shortId!;
        try {
          const { resolveLiveSession } = await import('./fork-resolver');
          const resolved = await resolveLiveSession(entry.sessionUuid!);
          if (resolved?.hasLiveFork && resolved.liveFork) {
            logger.info(
              `restoreExpectedReplyStates: 翻译 ${entry.sessionUuid!.slice(0, 8)} → 活 fork ${resolved.liveFork.short}`,
            );
            effectiveSessionId = resolved.liveFork.fullUuid;
            effectiveShortId = resolved.liveFork.short;
          }
        } catch (err: any) {
          logger.warn(`restoreExpectedReplyStates: resolveLiveSession failed for ${entry.sessionUuid!}: ${err?.message ?? err}`);
        }
        // 未超时,重建
        const internal: InternalEntry = {
          shortId: effectiveShortId,
          sessionId: effectiveSessionId,
          cwd: entry.cwd || '',
          messageId: entry.cardMessageId,  // v2.4: restore from user-mapping
          startedAt,
          timeoutMs: entry.timeoutMs!,
          casToken: entry.casToken || '',
        };
        this.inMemory.set(openId, internal);
        this.scheduleTimeout(openId);
      }
    }
  }
}
