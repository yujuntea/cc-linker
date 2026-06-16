/**
 * Fork resolver — 透明处理 claude-code TUI 切换 / fork 后的 session 续接。
 *
 * 背景:claude-code v2.1.163+ 的 `claude --resume --fork` 会创建新 session
 * (新 UUID、新 short、新 TUI),但写同一份 JSONL。**对话的"实际活跃位置"
 * 可能在 fork 之后的新 session**,而 cc-linker Agent View / handleReply 等
 * 入口拿到的还是老 sessionId。
 *
 * 单一职责:给定任意 sessionId / short,返回
 *   1) 这个 session 自身是否还活着(在 roster 中 + jobs/ 中)
 *   2) 它是否有"更新"的 live fork(同 JSONL + linkScanOffset 更大)
 *
 * 不写任何文件、不发任何网络、纯函数 + DI。
 */

import { join, basename } from 'path';
import { readRosterFromPath, type Roster } from './roster-source';
import type { JobStateEnvelope } from './job-state';
import type { AgentSessionStatus } from './types';

export interface ResolvedForkSummary {
  short: string;
  /** fork 自己的 sessionId(来自 roster.workers[short].sessionId,daemon 权威) */
  fullUuid: string;
  linkScanOffset: number;
  status: AgentSessionStatus;
  waitingFor?: string;
  pid?: number;
  /** state.json.needs 透传 */
  needs?: string | null;
}

export interface ResolvedSession {
  short: string;
  fullUuid: string;
  jsonlPath: string | null;
  isLive: boolean;          // 自身在 roster + jobs 中?
  hasLiveFork: boolean;     // 有活 fork?
  liveFork?: ResolvedForkSummary;
  /** 仅自身活的场合填,给 UI 展示"已续接到 [新 session]"用 */
  ownState?: {
    status: AgentSessionStatus;
    waitingFor?: string;
    pid?: number;
  };
}

export interface ResolveOptions {
  /** 测试 override;默认 ~/.claude/jobs */
  jobsDir?: string;
  /** 测试 override;默认 ~/.claude/daemon/roster.json */
  rosterPath?: string;
}

/**
 * 把 full UUID 或 short 规范化:
 *   'abcd1234' → { short: 'abcd1234', fullUuid: null }
 *   'abcd1234-1234-1234-1234-123456789012' → { short: 'abcd1234', fullUuid: 'abcd1234-...' }
 */
function normalize(input: string): { short: string; fullUuid: string | null } {
  if (input.length === 8) return { short: input, fullUuid: null };
  return { short: input.slice(0, 8), fullUuid: input };
}

/** 从 jobs/<short>/state.json 派生活 session 的 full UUID(linkScanPath basename 去 .jsonl) */
function deriveFullUuidFromJob(env: JobStateEnvelope): string {
  const link = env.state.linkScanPath;
  if (link) return basename(link).replace(/\.jsonl$/, '');
  return env.short;
}

/** 把 JobStateEnvelope 投到 AgentSessionStatus(同 job-state.ts jobStateToSession 的简化版) */
function jobStateToStatus(env: JobStateEnvelope): AgentSessionStatus {
  const s = env.state.state;
  if (s === 'running' || s === 'working') {
    return env.state.needs ? 'waiting' : 'busy';
  }
  if (s === 'blocked') return 'waiting';
  if (s === 'done' || s === 'stopped' || s === 'failed') return 'idle';
  return 'unknown';
}

/**
 * 主入口。
 *
 * @param input  8 字符 short 或 36 字符 full UUID
 * @param opts   测试注入(默认读 ~/.claude/jobs + ~/.claude/daemon/roster.json)
 * @returns ResolvedSession 或 null(input 不存在且无任何引用)
 */
export async function resolveLiveSession(
  input: string,
  opts: ResolveOptions = {},
): Promise<ResolvedSession | null> {
  const { short, fullUuid: inputFullUuid } = normalize(input);

  // 1. 读 roster + jobs (默认路径用 1s 缓存;测试 override 不用缓存)
  const useCache = !opts.jobsDir && !opts.rosterPath;
  const jobsDir = opts.jobsDir ?? join(process.env.HOME ?? '', '.claude', 'jobs');
  const rosterPath = opts.rosterPath ?? join(process.env.HOME ?? '', '.claude', 'daemon', 'roster.json');
  const { roster, jobs: jobEnvs } = await readRosterAndJobs(rosterPath, jobsDir, useCache);

  // 2. 找 input 自身对应的 job envelope(按 short 匹配;input 的 fullUuid 不一致也不影响)
  const ownJob = jobEnvs.find(e => e.short === short);
  const ownJsonlPath = ownJob?.state.linkScanPath ?? null;

  // 3. 自身是否活 = ownJob 存在 + roster 有此 short
  const isLive = !!(ownJob && roster?.workers?.[short]);

  // 4. 找"活 fork":
  //    - ownJob 在: 找其他 job 共享同一 linkScanPath
  //    - ownJob 不在(自身死了): 找任何活 job 的 linkScanPath 文件名 === inputFullUuid.jsonl
  const inputJsonlSuffix = inputFullUuid ? `${inputFullUuid}.jsonl` : null;
  const liveForkCandidates = jobEnvs.filter(e => {
    if (e === ownJob) return false;
    if (!roster?.workers?.[e.short]) return false;  // 必须真活
    const link = e.state.linkScanPath;
    if (!link) return false;
    if (ownJsonlPath && link === ownJsonlPath) return true;  // ownJob 存在,按 linkScanPath 精确匹配
    if (!ownJob && inputJsonlSuffix && link.endsWith(`/${inputJsonlSuffix}`)) {
      return true;  // ownJob 不在,按 UUID 文件名兜底匹配
    }
    return false;
  });

  let liveFork: ResolvedForkSummary | undefined;
  if (liveForkCandidates.length > 0) {
    const chosen = liveForkCandidates.reduce((a, b) =>
      (b.state.linkScanOffset ?? 0) > (a.state.linkScanOffset ?? 0) ? b : a
    );
    // ★ CRITICAL: fullUuid 用 roster.sessionId(daemon 权威),不用 linkScanPath 派生
    // 真实数据 0abb6d98: linkScanPath = 482b3a60-...jsonl,basename 派生会得到 parent 的 UUID
    // 那样 handleReply 用 short='482b3a60' 找 sock 还是失败 — 必须用 fork 自己的 sessionId
    // v2.6.1: 加 fallback,roster 缺 sessionId 时(罕见)用 short 兜底,避免下游 .slice() 抛 TypeError
    const liveRosterWorker = roster!.workers[chosen.short];
    liveFork = {
      short: chosen.short,
      fullUuid: liveRosterWorker.sessionId || chosen.short,
      linkScanOffset: chosen.state.linkScanOffset ?? 0,
      status: jobStateToStatus(chosen),
      waitingFor: chosen.state.needs ?? undefined,
      pid: liveRosterWorker.pid,
      needs: chosen.state.needs ?? null,
    };
  }

  // 6. input 完全不存在(nil UUID sentinel → 返回 null;其他都返回 ResolvedSession
  //    描述"已知不活"的 input,让调用方拿到 isLive=false 走统一分支)
  if (!ownJob && !liveFork && short === '00000000') return null;

  // 7. 组装结果 — fullUuid 源优先级
  //    a) roster.workers[short].sessionId(自身活的,最权威)
  //    b) liveFork.fullUuid(自身死了,有活 fork)
  //    c) ownJob 的 linkScanPath basename 派生(self-link 场景,极少)
  //    d) inputFullUuid(input 是 short 形式,无 fullUuid,fallback)
  const fullUuid =
    (ownJob && roster?.workers?.[short]?.sessionId) ||
    liveFork?.fullUuid ||
    (ownJob ? deriveFullUuidFromJob(ownJob) : '') ||
    inputFullUuid ||
    '';

  const result: ResolvedSession = {
    short,
    fullUuid,
    jsonlPath: ownJsonlPath,
    isLive,
    hasLiveFork: !!liveFork,
  };
  if (liveFork) result.liveFork = liveFork;
  if (ownJob) {
    result.ownState = {
      status: jobStateToStatus(ownJob),
      waitingFor: ownJob.state.needs ?? undefined,
      pid: roster?.workers?.[short]?.pid,
    };
  }
  return result;
}

// 注:支持 2 层链式 fork(因为 handleReplyRequest + handleReply 各 resolve 一次)
//    3+ 层链没测,生产用之前先手动验证

// --- internals:ROSTER/JOBS readers (DI-friendly) ---

interface CacheEntry {
  ts: number;
  jobsDir: string;
  rosterPath: string;
  roster: Roster | null;
  jobs: JobStateEnvelope[];
}

let _cache: CacheEntry | null = null;
const CACHE_TTL_MS = 1000;

async function readRosterAndJobs(
  rosterPath: string,
  jobsDir: string,
  useCache: boolean,
): Promise<{ roster: Roster | null; jobs: JobStateEnvelope[] }> {
  if (useCache && _cache && _cache.jobsDir === jobsDir && _cache.rosterPath === rosterPath
      && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return { roster: _cache.roster, jobs: _cache.jobs };
  }
  const roster = readRosterFromPath(rosterPath);
  const { readAllJobStates } = await import('./job-state');
  const jobs = await readAllJobStates(jobsDir);
  if (useCache) {
    _cache = { ts: Date.now(), jobsDir, rosterPath, roster, jobs };
  }
  return { roster, jobs };
}

/**
 * 测试钩子:重置模块级缓存。
 * @internal
 */
export function __resetResolverCache(): void {
  _cache = null;
}
