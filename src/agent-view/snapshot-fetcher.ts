// src/agent-view/snapshot-fetcher.ts
//
// v2.3 重构:数据源从 `claude agents --json`(v2.1.163 字段坏掉,所有 background
// 都返回 status="idle")切换到 ~/.claude/jobs/<short>/state.json(CLI 维护的权威
// 状态机)。
//
// 流水线:
//   VersionGuard → DaemonProbe
//   → smoke-test(`claude agents --json`,返回值丢弃,仅用于确认 CLI/daemon 健康)
//   → readAllJobStates → jobStateToSession[] → 过滤 status='unknown'
//   → 给 stopped 名字加 🛑 前缀 / done 加 ✅ 前缀
//   → attachRosterSources(roster.json 补 dispatch.source)
//   → 给 settled session source 兜底(roster 清空后走 daemon.log claimedSources)
//   → cold-path name fallback(state.json.name 为空时走 JSONL first-prompt 推断)
//   → filterUserDispatched
//
// `claude agents --json` 调用保留作 smoke test(确认 CLI 健康 / 给 daemon 心跳),
// 返回值不再做真理源。下个 release 可彻底去掉这一步。
//
// 测试 hook 见 _jobStateHooks。v2.2 时代的 _nameCacheHooks / _jsonlIndexHooks /
// enrichCompletedSessions 全部退役 — state.json 直接提供 name / cwd / status /
// linkScanPath,无需绕道还原。

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { VersionGuard } from './version-guard';
import { DaemonProbe } from './daemon-probe';
import { attachRosterSources, filterUserDispatched } from './snapshot';
import { readRoster, buildRosterSourceMap } from './roster-source';
import { readClaimedSources } from './daemon-log-reader';
import { deriveNameFromJsonl } from './jsonl-name';
import { readAllJobStates, jobStateToSession } from './job-state';
import { resolveLiveSession } from './fork-resolver';
import { logger } from '../utils/logger';
import type { AgentSession, AgentSessionSource } from './types';

export type FetchResult =
  | { ok: true; sessions: AgentSession[] }
  | { ok: false; reason: string };

// 测试 hook:让 tests 替换数据源 + 冷路径 + 副信号源(daemon.log claimed tail)
// 全部走 mutable object 而非 mock.module — 后者在 Bun 跨文件不可撤销,会污染
// daemon-log-reader.test.ts / daemon-probe.test.ts 等单元测试。
export const _jobStateHooks = {
  readAllJobStates,
  deriveNameFromJsonl,
  readClaimedSources,
  // v2.7: 暴露 readRoster 给 staleness detection 测试
  readRoster,
};

// v2.7: stale state.json 检测的 JSONL mtime 阈值。
// 贴合 TUI 行为 — TUI 也用"JSONL 最近被改过"作为活进程信号。
// 5 分钟阈值避免一次性 batch write 误判, 也足够覆盖正常 bg turn 时长
// (典型 working turn 几秒到几分钟)。
const STALE_JSONL_THRESHOLD_MS = 5 * 60 * 1000;

export const AgentSnapshotFetcher = {
  async fetch(): Promise<FetchResult> {
    const ver = await VersionGuard.check();
    if (!ver.ok) return { ok: false, reason: ver.reason ?? 'version check failed' };
    if (!DaemonProbe.check()) return { ok: false, reason: 'Claude daemon not running' };

    // Smoke test:确认 CLI 可用(给 daemon 心跳),返回值丢弃
    try {
      await new Promise<string>((resolve, reject) => {
        execFile('claude', ['agents', '--json'], (err, out) => {
          if (err) reject(err);
          else resolve(out);
        });
      });
    } catch (err: any) {
      return { ok: false, reason: `claude agents --json smoke test failed: ${err.message}` };
    }

    // 主数据:state.json。
    // 合并 map + filter unknown + staleness 检测 + 加 emoji prefix 在一个循环里,确保 env ↔ session
    // 配对始终用同一份 env(不依赖 sessionId.slice(0,8) 与 env.short 的隐含一致性,
    // 防 fork-from-active session 的 resumeSessionId 是 parent UUID 导致 prefix 漏加)。
    //
    // v2.7: roster 提前读(原在后面),让 staleness 检测能用 — 否则 N 次磁盘读
    const envs = await _jobStateHooks.readAllJobStates();
    const roster = _jobStateHooks.readRoster();
    let sessions: AgentSession[] = [];
    let droppedUnknown = 0;
    const droppedStates: Set<string> = new Set();
    for (const env of envs) {
      const s = jobStateToSession(env);
      if (!s) continue;
      if (s.status === 'unknown') {
        // 未来 Claude CLI 可能加新 state 值(如 'paused')。我们仍 graceful 丢弃,
        // 但聚合一次警告让运维知道有 sessions 被吞了 — 避免"我的 session 消失了"无诊断。
        droppedUnknown++;
        droppedStates.add(String(env.state.state));
        continue;
      }

      // v2.7: stale state.json 检测 — bg slot 被 daemon 复用时,state.json
      // 可能停留在旧 incarnation 的"done"状态(没有覆盖写),导致 cc-linker
      // 错把活 session 展示在"已完成"组。TUI 用 JSONL mtime freshness 检测
      // 这个问题,所以我们对齐 TUI 行为。
      //
      // 两个触发条件:
      //   Signal 1 (主要): state.json.sessionId !== roster.workers[short].sessionId
      //     → bg slot reuse 后,roster 记录新进程 sessionId,state.json 没更新
      //     → 用 roster 的 sessionId + override 为 busy
      //   Signal 2 (备份): state.json 说 idle 但 linkScanPath JSONL 最近被改
      //     → 即使没有 roster 信息,JSONL 在被写 = bg 实际活着
      //     → override 为 busy(不修改 sessionId,因为没有更权威的 source)
      //
      // 安全保证: 只 override `status === 'idle'`(done/stopped/failed 映射),
      // busy/waiting/unknown 不动。
      let overridden = false;
      if (s.status === 'idle') {
        const short = env.short;
        const rosterWorker = roster?.workers?.[short];
        const stateSessionId = env.state.sessionId ?? env.state.resumeSessionId;

        // Signal 1: bg slot 被 reuse (roster.sessionId 不同于 state.json.sessionId)
        if (
          rosterWorker?.sessionId
          && stateSessionId
          && rosterWorker.sessionId !== stateSessionId
        ) {
          logger.warn(
            `[agent-view] ${short}: state.json stale — ` +
            `state.sessionId=${stateSessionId.slice(0, 8)} ` +
            `vs roster.sessionId=${rosterWorker.sessionId.slice(0, 8)}; ` +
            `bg slot reused, overriding to busy`,
          );
          s.sessionId = rosterWorker.sessionId;
          s.status = 'busy';
          s.name = s.name.replace(/^[✅🛑❌]\s*/, '');
          s.completed = undefined;  // 清理 — 之前 idle+completed=true 是 settled 标志
          overridden = true;
        }
        // Signal 2: JSONL 仍在被改(TUI 等价信号,防御 future roster 字段变化)
        else if (env.state.linkScanPath) {
          try {
            const stat = statSync(env.state.linkScanPath);
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs < STALE_JSONL_THRESHOLD_MS) {
              logger.warn(
                `[agent-view] ${short}: state.json says done but JSONL modified ` +
                `${Math.round(ageMs / 1000)}s ago (<${STALE_JSONL_THRESHOLD_MS / 1000}s threshold); ` +
                `bg actively working, overriding to busy`,
              );
              s.status = 'busy';
              s.name = s.name.replace(/^[✅🛑❌]\s*/, '');
              s.completed = undefined;  // 同上
              overridden = true;
            }
          } catch {
            // 文件不存在/读不了,graceful 跳过,保留 state.json 的 status
          }
        }
      }

      // 仅在 NOT overridden 时加 emoji prefix — 否则 ✅ 会被加再被剥
      if (!overridden) {
        let name = s.name;
        if (env.state.state === 'stopped' && !name.startsWith('🛑')) name = `🛑 ${name}`;
        else if (env.state.state === 'done' && !name.startsWith('✅')) name = `✅ ${name}`;
        else if (env.state.state === 'failed' && !name.startsWith('❌')) name = `❌ ${name}`;
        sessions.push(name === s.name ? s : { ...s, name });
      } else {
        sessions.push(s);
      }
    }
    if (droppedUnknown > 0) {
      logger.warn(
        `[agent-view] dropped ${droppedUnknown} session(s) with unknown state values ` +
        `[${[...droppedStates].join(', ')}] — Claude CLI may have added new state(s); ` +
        `consider updating jobStateToSession mapping.`,
      );
    }

    // roster.json 给 source 标签(spare/slash/fleet);settled 后 roster 已清,
    // daemon.log claimedSources 兜底
    const rosterMap = buildRosterSourceMap(roster);
    const claimedSources = _jobStateHooks.readClaimedSources(24);
    sessions = sessions.map(s => {
      const short = s.sessionId.slice(0, 8);
      const src: AgentSessionSource =
        rosterMap.get(short) ?? claimedSources.get(short) ?? 'unknown';
      return { ...s, source: src };
    });

    // 冷路径 name fallback:state.json.name 为空(罕见)时走 JSONL first-prompt
    sessions = sessions.map(s => {
      // 跳过前缀 emoji 检查 (✅ 🛑 ❌ 等占位时)
      const stripped = s.name.replace(/^[✅🛑❌]\s*/, '');
      if (stripped && !/^[0-9a-f]{8}$/.test(stripped)) return s;  // 已有真名
      const short = s.sessionId.slice(0, 8);
      const derived = _jobStateHooks.deriveNameFromJsonl(short);
      if (derived) {
        // 保留 prefix(如果原 name 有 emoji)
        const prefix = s.name.startsWith('✅') ? '✅ '
          : s.name.startsWith('🛑') ? '🛑 '
          : s.name.startsWith('❌') ? '❌ '
          : '';
        return { ...s, name: `${prefix}${derived.name}`, sessionId: derived.sessionId };
      }
      return s;
    });

    // v2.6.1: 透明 fork 解析 — 给每条 session 补 liveFork
    // v2.6.1 优化: 用 Promise.all 并行 — 之前是 sequential await,N 个 session 要 N 次 cache lookup
    // (虽然 1s cache 让 90% 命中,但 sequential 仍要 N 个 microtask 等待)
    // 注意:resolveLiveSession 内部有 1s 缓存,所以并行不会导致 N 次磁盘读
    const resolveResults = await Promise.all(
      sessions
        .filter(s => !!s.sessionId)
        .map(async (s) => {
          try {
            const r = await resolveLiveSession(s.sessionId!);
            return { session: s, resolved: r };
          } catch (err: any) {
            logger.warn(`snapshot-fetcher: resolveLiveSession failed for ${s.sessionId}: ${err?.message ?? err}`);
            return { session: s, resolved: null };
          }
        }),
    );
    for (const { session: s, resolved: r } of resolveResults) {
      if (r?.hasLiveFork && r.liveFork) {
        s.liveFork = r.liveFork;
      }
    }

    sessions = filterUserDispatched(sessions);
    return { ok: true, sessions };
  },
};
