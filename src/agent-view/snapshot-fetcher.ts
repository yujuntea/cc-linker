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

      // v2.7+ (扩展): stale state.json 检测 — bg slot 被 daemon 复用时,
      // state.json 可能停留在旧 incarnation 的"done/blocked"状态(没有覆盖写),
      // 导致 cc-linker 错把活 session 展示在"已完成"或"等待输入"组。
      // TUI 用 JSONL mtime + pid liveness 检测这个问题,所以我们对齐 TUI 行为。
      //
      // 触发条件(应用范围: status 不在 {busy, unknown}):
      //   Signal 1 (主要): s.sessionId !== roster.workers[short].sessionId
      //     → bg slot reuse 后,roster 记录新进程 sessionId,state.json 没更新
      //     → 用 roster 的 sessionId + override 为 busy
      //   Signal 2 (备份): JSONL mtime 比 state.json mtime 新
      //     → bg 在 state.json 之后还在写 JSONL → state.json 已过时
      //     → override 为 busy(不修改 sessionId,因为没有更权威的 source)
      //
      // 关于 Signal 2 (v2.7.1): 之前用绝对 5 分钟阈值,会导致 bg 刚问完问题
      // (state.json + JSONL 同时被改)的 5 分钟 false-positive 窗口。
      // 改成 mtime 相对对比:Claude CLI 写顺序是
      //   JSONL (assistant message) → state.json (state machine update)
      // 所以 state.json 总是略新于 JSONL。"JSONL 比 state.json 新" 只在
      // bg 写完 state.json 后还在继续写 JSONL 时成立 — 即 bg 实际在处理。
      //
      // 安全保证: 只 override status 不在 {busy, unknown},busy 已正确不重写,
      // unknown 留给前端 graceful drop(避免我们猜测未知状态的语义)。
      //
      // 关于 s.sessionId: 直接用 jobStateToSession 算出的 canonical sessionId
      // (它已经做了 sessionId → resumeSessionId → env.short 的 fallback),与
      // sessionId.slice(0,8) 在下游(liveFork 解析、source attribution)用的字段一致。
      let overriddenSession: AgentSession | null = null;
      // 用 explicit list 而非 `!== 'busy'` 避开 TS narrowing 警告(以及更明确意图)
      // unknown 在 line ~91 已被 filter,这里只可能看到 idle / waiting / busy,
      // 我们只 override idle + waiting(busy 已是最新,unknown 不在这里)。
      if (s.status === 'idle' || s.status === 'waiting') {
        const short = env.short;
        const rosterWorker = roster?.workers?.[short];

        // Signal 1: bg slot 被 reuse (roster.sessionId 不同于 s.sessionId)
        if (
          rosterWorker?.sessionId
          && s.sessionId
          && rosterWorker.sessionId !== s.sessionId
        ) {
          logger.warn(
            `[agent-view] ${short}: state.json stale (status=${s.status}) — ` +
            `state.sessionId=${s.sessionId.slice(0, 8)} ` +
            `vs roster.sessionId=${rosterWorker.sessionId.slice(0, 8)}; ` +
            `bg slot reused, overriding to busy`,
          );
          // Immutable spread — 与文件其他地方({ ...s, name })风格一致,
          // 避免就地修改 s 让 reviewer 困惑,也防止下游若拿到 s 引用被污染。
          // waiting → busy 时还要清掉 waitingFor,否则 card.ts 会显示成 ❓ 等待原因
          const { completed: _completed, waitingFor: _waitingFor, ...rest } = s;
          overriddenSession = {
            ...rest,
            sessionId: rosterWorker.sessionId,
            status: 'busy',
            name: s.name.replace(/^[✅🛑❌]\s*/, ''),
          };
        }
        // Signal 2: JSONL 比 state.json 新 — bg 在 state.json 写完后还在写
        else if (env.state.linkScanPath) {
          try {
            const stat = statSync(env.state.linkScanPath);
            const jsonlAgeMs = Date.now() - stat.mtimeMs;
            const stateAgeMs = Date.now() - env.mtimeMs;
            if (jsonlAgeMs < stateAgeMs) {
              logger.warn(
                `[agent-view] ${short}: state.json says ${s.status} but JSONL ` +
                `${Math.round((stateAgeMs - jsonlAgeMs) / 1000)}s newer than state.json; ` +
                `bg actively working, overriding to busy`,
              );
              const { completed: _completed, waitingFor: _waitingFor, ...rest } = s;
              overriddenSession = {
                ...rest,
                status: 'busy',
                name: s.name.replace(/^[✅🛑❌]\s*/, ''),
              };
            }
          } catch {
            // 文件不存在/读不了,graceful 跳过,保留 state.json 的 status
          }
        }
      }

      // 仅在 NOT overridden 时加 emoji prefix — 否则 ✅ 会被加再被剥
      if (overriddenSession) {
        sessions.push(overriddenSession);
      } else {
        let name = s.name;
        if (env.state.state === 'stopped' && !name.startsWith('🛑')) name = `🛑 ${name}`;
        else if (env.state.state === 'done' && !name.startsWith('✅')) name = `✅ ${name}`;
        else if (env.state.state === 'failed' && !name.startsWith('❌')) name = `❌ ${name}`;
        sessions.push(name === s.name ? s : { ...s, name });
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
