# 透明 fork 解析 — Agent View 在 TUI 切换 / fork 后无感续接

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当一个 bg session 已被 claude-code fork 到新 TUI / 新 sessionId,cc-linker 应**自动找到活 fork 并用它回复**,用户无感——`/agents` 列表 / [Peek] / [Reply] / [Attach] / bot 启动恢复 / 飞书侧发文本 全部按"活 session 在哪就去哪"工作。

**Architecture:**
1. 新建 `src/agent-view/fork-resolver.ts`,提供单一函数 `resolveLiveSession(input)`,输入任意 sessionId/short,返回 `ResolvedSession` 含**该 session 自身信息 + 它的活 fork(如有)**。
2. 所有用户面入口(`/agents` 列表 / Peek / Reply / Attach / tryRendezvousReply / expectedReply set+restore / bot 启动迁移)统一调用 `resolveLiveSession`,有 fork 就**用 fork 替换**下游链路。
3. `AgentSession` 数据模型加 `liveFork?: ResolvedForkSummary` 字段,snapshot 把这信息一并返,UI 据此渲染"已续接到新 session"提示。
4. 不破坏任何现有调用方:`resolveLiveSession` 找不到 fork 时返回 input 自身,所有下游代码逻辑不变。

**Tech Stack:** Bun + TypeScript + bun:test。**无新依赖**。复用 `job-state.ts` / `roster-source.ts` / `jsonl-name.ts` 已有 reader。

---

## 文件结构 (新增/修改)

```
src/agent-view/
├── fork-resolver.ts           [新增]  resolveLiveSession + ResolvedSession 类型
├── types.ts                   [修改]  AgentSession 加 liveFork? 字段 + ResolvedForkSummary 类型
├── job-state.ts               [不变]  (消费者)
├── roster-source.ts           [不变]  (消费者)
├── snapshot-fetcher.ts        [修改]  fetch() 内调 resolveLiveSession 给每条 session 补 liveFork
├── manager.ts                 [修改]  handleList/Peek/Attach/ReplyRequest/Reply 全部用 resolver
├── expected-reply-state.ts    [修改]  set + restoreExpectedReplyStates 调 resolver
├── card.ts                    [修改]  Peek / Waiting 卡加 "已续接" annotation + 按钮 value 用活 fork 的 sessionId
└── attached-card-watcher.ts   [不变]  (使用 session.short,resolver 替换后会自然跟上)

src/feishu/
├── bot.ts                     [修改]  tryRendezvousReply + runChatSDK 入口前调 resolver
└── mapping.ts                 [不变]  (resolver 改 user-mapping 的 sessionUuid 在 manager 层)

tests/unit/agent-view/
└── fork-resolver.test.ts      [新增]  9-10 个用例覆盖所有 resolver 分支

docs/
└── agent-view-architecture.md [可能新增]  一段说明 fork 概念 + 行为(可选)

README.md / README_en.md       [可能修改]  Agent View 章节加一行"fork 自动续接"说明
```

**单一职责:** `fork-resolver.ts` 只负责"给定一个 sessionId,告诉我它的状态 + 是否有活 fork"。不调用任何 cas、不写任何文件、不发任何网络请求。纯函数 + DI(`{ jobsDir, rosterPath }` override)。

---

## Task 0: 写 fork-resolver 失败用例 (TDD 红)

**Files:**
- Create: `tests/unit/agent-view/fork-resolver.test.ts`

- [ ] **Step 1: 确认测试目录存在**

执行: `ls tests/unit/agent-view/fork-resolver.test.ts 2>/dev/null || echo "MISSING"`
预期: 目录存在(ls 失败 = MISSING,继续)

- [ ] **Step 2: 写 10 个失败测试用例**

新建 `tests/unit/agent-view/fork-resolver.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { resolveLiveSession, __resetResolverCache } from '../../../src/agent-view/fork-resolver';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * 测试 fixture helper:在 tmp dir 创建 jobs/<short>/state.json + roster.json。
 * 返回 { jobsDir, rosterPath, cleanup }。
 */
async function setupFixture(jobs: Record<string, any>, roster: any) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-resolver-test-'));
  const jobsDir = path.join(tmp, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  for (const [short, state] of Object.entries(jobs)) {
    const d = path.join(jobsDir, short);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state));
  }
  const rosterPath = path.join(tmp, 'roster.json');
  fs.writeFileSync(rosterPath, JSON.stringify(roster));
  return {
    jobsDir,
    rosterPath,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('resolveLiveSession', () => {
  beforeEach(() => {
    __resetResolverCache();
  });

  // --- Case 1: input 自身是活的 ---
  test('1.1 活的 input session,无 fork → 返回 input,isLive=true,hasLiveFork=false', async () => {
    // 真实数据:linkScanPath 是 parent 的 JSONL(不是 self),sessionId 是 canonical UUID
    // 验证 resolver 用 roster.sessionId 派 fullUuid(不是 linkScanPath basename)
    const parentJsonl = '/x/parent-of-abcd1234-uuid-...jsonl';
    const fx = await setupFixture(
      {
        'abcd1234': {
          state: 'blocked', tempo: 'active', needs: 'test',
          sessionId: 'abcd1234-canonical-uuid-aaaa-bbbbccccdddd',  // canonical UUID
          resumeSessionId: 'parent-of-abcd1234-uuid-...',         // parent
          linkScanPath: parentJsonl,                              // ★ 跟 sessionId 不同
          linkScanOffset: 100,
          cwd: '/x', name: 'live',
        },
      },
      { workers: { abcd1234: { pid: 1, sessionId: 'abcd1234-canonical-uuid-aaaa-bbbbccccdddd', cwd: '/x' } } },
    );
    const r = await resolveLiveSession('abcd1234-canonical-uuid-aaaa-bbbbccccdddd', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    expect(r?.short).toBe('abcd1234');
    expect(r?.isLive).toBe(true);
    expect(r?.hasLiveFork).toBe(false);
    expect(r?.liveFork).toBeUndefined();
    // ★ 关键:fullUuid 来自 roster,不是 input 的解析
    expect(r?.fullUuid).toBe('abcd1234-canonical-uuid-aaaa-bbbbccccdddd');
    fx.cleanup();
  });

  // --- Case 2: input 死了,但有活 fork(本次 bug 的核心场景) ---
  test('2.1 input session 已死(roster 无),有 live fork 引用同一 JSONL → 返回 fork', async () => {
    // 真实数据:0abb6d98 的 linkScanPath 是 482b3a60-...jsonl(读 parent 的历史),
    // 0abb6d98 写自己的 0abb6d98-6bfc-4b95-b59f-52c493369986.jsonl
    const parentJsonl = '/Users/x/.claude/projects/x/482b3a60-7ae0-4c8c-ba98-f462d08b3274.jsonl';
    const fx = await setupFixture(
      {
        // 482b3a60 不在 jobs/(daemon 已清)
        '0abb6d98': {
          state: 'blocked', tempo: 'active', needs: '继续吗?',
          sessionId: '0abb6d98-6bfc-4b95-b59f-52c493369986',  // canonical
          resumeSessionId: '482b3a60-7ae0-4c8c-ba98-f462d08b3274',  // parent
          linkScanPath: parentJsonl,                         // ★ 跟 sessionId 不同
          linkScanOffset: 5000,
          cwd: '/Users/x', name: 'Review AI coding lines attribution design',
        },
      },
      {
        workers: {
          0abb6d98: {
            pid: 53358, sessionId: '0abb6d98-6bfc-4b95-b59f-52c493369986',  // canonical
            cwd: '/Users/x',
            dispatch: { launch: { mode: 'resume', sessionId: parentJsonl, fork: true } },
          },
        },
      },
    );
    const r = await resolveLiveSession('482b3a60-7ae0-4c8c-ba98-f462d08b3274', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    expect(r?.isLive).toBe(false);  // 482b3a60 自身死了
    expect(r?.hasLiveFork).toBe(true);
    expect(r?.liveFork?.short).toBe('0abb6d98');
    expect(r?.liveFork?.status).toBe('waiting');
    // ★ CRITICAL: liveFork.fullUuid 是 fork 自己的 sessionId(0abb6d98-...),
    // 不是 input 的 sessionId(482b3a60-...)也不是 linkScanPath basename
    expect(r?.liveFork?.fullUuid).toBe('0abb6d98-6bfc-4b95-b59f-52c493369986');
    fx.cleanup();
  });

  // --- Case 3: input 死了,无 fork ---
  test('3.1 input 死了,无 live fork → 返回 input,isLive=false,hasLiveFork=false', async () => {
    const fx = await setupFixture({}, { workers: {} });
    const r = await resolveLiveSession('deadbeef-1234-...', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    expect(r?.isLive).toBe(false);
    expect(r?.hasLiveFork).toBe(false);
    expect(r?.liveFork).toBeUndefined();
    fx.cleanup();
  });

  // --- Case 4: input 自身是 fork,有自己的 fork 链(链式) ---
  test('4.1 input 是链式 fork 中的中间节点 → 返回自身(它是活的),有更新的 fork?', async () => {
    // 链: 482b3a60 → 1a04cf79 → 0abb6d98
    // 1a04cf79 在 roster 中,0abb6d98 也活(更新)
    // 调 resolveLiveSession('1a04cf79-...')
    //   期望: isLive=true (它自己活), hasLiveFork=true (0abb6d98 是更新的 fork 引用同一 JSONL)
    const sharedJsonl = '/x/original-parent.jsonl';
    const fx = await setupFixture(
      {
        '1a04cf79': {
          state: 'working', tempo: 'active',
          sessionId: '1a04cf79-canonical-uuid-1', resumeSessionId: '482b3a60-...',
          linkScanPath: sharedJsonl, linkScanOffset: 2000, cwd: '/x',
        },
        '0abb6d98': {
          state: 'blocked', tempo: 'active',
          sessionId: '0abb6d98-canonical-uuid-2', resumeSessionId: '1a04cf79-...',
          linkScanPath: sharedJsonl, linkScanOffset: 5000, cwd: '/x',
        },
      },
      { workers: {
        '1a04cf79': { pid: 1, sessionId: '1a04cf79-canonical-uuid-1', cwd: '/x' },
        '0abb6d98': { pid: 2, sessionId: '0abb6d98-canonical-uuid-2', cwd: '/x' },
      }},
    );
    const r = await resolveLiveSession('1a04cf79-canonical-uuid-1', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    expect(r?.isLive).toBe(true);
    expect(r?.hasLiveFork).toBe(true);
    expect(r?.liveFork?.short).toBe('0abb6d98');  // 链里更新那个
    // fullUuid 来自 roster,不是 input
    expect(r?.fullUuid).toBe('1a04cf79-canonical-uuid-1');
    expect(r?.liveFork?.fullUuid).toBe('0abb6d98-canonical-uuid-2');
    fx.cleanup();
  });

  // --- Case 5: input 是 short hash (8 字符) ---
  test('5.1 input 是 8 字符 short → 正常解析', async () => {
    const fx = await setupFixture(
      { 'abcd1234': { state: 'blocked', linkScanPath: '/x/a.jsonl', linkScanOffset: 100, cwd: '/x' } },
      { workers: { abcd1234: { pid: 1, sessionId: 'abcd1234-...', cwd: '/x' } } },
    );
    const r = await resolveLiveSession('abcd1234', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    expect(r?.short).toBe('abcd1234');
    expect(r?.isLive).toBe(true);
    fx.cleanup();
  });

  // --- Case 6: input 不存在,无任何状态 ---
  test('6.1 input 完全不存在(短/全 UUID 都不在 jobs,JSONL 也不在 jobs) → 返回 null', async () => {
    const fx = await setupFixture({}, { workers: {} });
    const r = await resolveLiveSession('00000000-0000-0000-0000-000000000000', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    expect(r).toBeNull();
    fx.cleanup();
  });

  // --- Case 7: 派生 JSONL 路径的边界 ---
  test('7.1 input 是 full UUID 但 jobs 里只有同 short(数据不一致,例如 TUI 重建) → 仍按 short 匹配', async () => {
    // 真实场景:user card 的 sessionId 跟 jobs 里的 sessionId 不一致(TUI 重建后,
    // registry 还保留着旧 UUID,但 jobs 已经有新的)。应该按 short 8 字符前缀匹配,
    // 不要因为 UUID 不一致就 reject。
    const fx = await setupFixture(
      { 'abcd1234': {
          state: 'blocked',
          sessionId: 'different-uuid-actual',
          linkScanPath: '/x/parent.jsonl', linkScanOffset: 100, cwd: '/x',
        } },
      { workers: { abcd1234: { pid: 1, sessionId: 'different-uuid-actual', cwd: '/x' } } },
    );
    // 关键:input 的 short 必须跟 jobs 的 short 一致(都是 'abcd1234')
    const r = await resolveLiveSession('abcd1234-caller-attempted-this-uuid', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    // short='abcd1234'(input 前 8 字符),能在 jobs 里找到
    expect(r?.short).toBe('abcd1234');
    expect(r?.isLive).toBe(true);
    // fullUuid 是 input 提供的(input.fullUuid)或 roster.sessionId 派生
    // (具体哪个由实现决定,关键是要能 match 后续 handleReply 的 find)
    expect(r?.fullUuid).toBeTruthy();
    fx.cleanup();
  });

  // --- Case 8: jobs.jsonl 损坏 ---
  test('8.1 state.json 损坏 → resolver 不抛,返回 isLive=false', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-resolver-corrupt-'));
    const jobsDir = path.join(tmp, 'jobs');
    fs.mkdirSync(path.join(jobsDir, 'abcd1234'), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, 'abcd1234', 'state.json'), '{ broken');
    const rosterPath = path.join(tmp, 'roster.json');
    fs.writeFileSync(rosterPath, JSON.stringify({ workers: {} }));
    const r = await resolveLiveSession('abcd1234-...', {
      jobsDir, rosterPath,
    });
    // 没崩溃,且 isLive=false
    expect(r?.isLive).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // --- Case 9: multiple live forks(同时多个) → 返回 linkScanOffset 最大的(最新) ---
  test('9.1 同一 JSONL 有 2 个 live fork → 返回 offset 大的', async () => {
    const sharedJsonl = '/x/a.jsonl';
    const fx = await setupFixture(
      {
        'older123': { state: 'working', linkScanPath: sharedJsonl, linkScanOffset: 1000, cwd: '/x' },
        'newer456': { state: 'blocked', linkScanPath: sharedJsonl, linkScanOffset: 9000, cwd: '/x' },
      },
      { workers: {
        'older123': { pid: 1, sessionId: 'older-...', cwd: '/x' },
        'newer456': { pid: 2, sessionId: 'newer-...', cwd: '/x' },
      }},
    );
    const r = await resolveLiveSession('requested-uuid-...', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    // resolver 按 short 不一定能找到 'requested-uuid-...',
    // 但如果 short='newer456' 就能找到,且 hasLiveFork 是同 JSONL 的另一个(older)
    // 关键验证:offset 大的 'newer456' 是 chosen 作为活 fork
    const r2 = await resolveLiveSession('older123-...', {
      jobsDir: fx.jobsDir, rosterPath: fx.rosterPath,
    });
    expect(r2?.liveFork?.short).toBe('newer456');  // newer offset 更大
    fx.cleanup();
  });

  // --- Case 10: __resetResolverCache 必须存在(供测试用) ---
  test('10.1 __resetResolverCache 调用不抛', () => {
    expect(() => __resetResolverCache()).not.toThrow();
  });
});
```

- [ ] **Step 3: 跑测试,确认全部失败(红)**

执行: `bun test tests/unit/agent-view/fork-resolver.test.ts`
预期: 10 个测试全失败,失败原因 `Cannot find module '../../../src/agent-view/fork-resolver'`。
**这恰好证明 resolver 文件还没创建。**

---

## Task 1: 实现 fork-resolver (TDD 绿)

**Files:**
- Create: `src/agent-view/fork-resolver.ts`

- [ ] **Step 1: 创建 resolver 文件**

新建 `src/agent-view/fork-resolver.ts`,内容(**注意:fullUuid 必须用 `roster.workers[short].sessionId`,不能用 linkScanPath basename——见 review 备注**):

```typescript
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

import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import type { Roster } from './roster-source';
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
    const liveRosterWorker = roster!.workers[chosen.short];
    liveFork = {
      short: chosen.short,
      fullUuid: liveRosterWorker.sessionId,  // 一定是 fork 自己的 UUID
      linkScanOffset: chosen.state.linkScanOffset ?? 0,
      status: jobStateToStatus(chosen),
      waitingFor: chosen.state.needs ?? undefined,
      pid: liveRosterWorker.pid,
      needs: chosen.state.needs ?? null,
    };
  }

  // 6. input 完全不存在(ownJob 为 null 且找不到 fork)
  if (!ownJob && !liveFork) return null;

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

/** 直接读某路径(测试用) */
function readRosterFromPath(p: string): Roster | null {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as Roster; }
  catch { return null; }
}

/**
 * 测试钩子:重置模块级缓存。
 * @internal
 */
export function __resetResolverCache(): void {
  _cache = null;
}
```

- [ ] **Step 2: 跑测试,确认大部分通过(绿)**

执行: `bun test tests/unit/agent-view/fork-resolver.test.ts`
预期: 10 个测试中 8-9 个通过。可能有 1-2 个因为边界 case 微调需要(下面 Step 3 处理)。

- [ ] **Step 3: 边界调整**

如果 case 1.1 / 2.1 / 4.1 失败,通常是:
- `deriveFullUuidFromJob` 派生的 fullUuid 跟测试期望不一致 → 检查 `basename(linkScanPath).replace('.jsonl','')` 逻辑
- `liveFork` 选错了(选了更老的而不是更新的) → 检查 `linkScanOffset` 比较方向
- cache 导致跨测试污染 → 确认 `__resetResolverCache()` 在 `beforeEach` 调

- [ ] **Step 4: 全绿后 commit**

```bash
git add src/agent-view/fork-resolver.ts tests/unit/agent-view/fork-resolver.test.ts
git commit -m "feat(agent-view): fork-resolver — 透明找到 bg session 的活 fork"
```

---

## Task 1.5: 修 jobStateToSession 用 canonical sessionId

**Files:**
- Modify: `src/agent-view/job-state.ts:250`

- [ ] **Step 1: 读 jobStateToSession 现状**

执行: `grep -n "sessionId:" src/agent-view/job-state.ts | head -5`
预期: 看到类似 `sessionId: f.resumeSessionId ?? env.short` 的一行

- [ ] **Step 2: 改用 canonical sessionId**

把 `src/agent-view/job-state.ts:250`:
```typescript
sessionId: f.resumeSessionId ?? env.short,
```

改成(优先用 canonical `f.sessionId`,fallback 到 resumeSessionId,再 fallback 到 short):
```typescript
sessionId: f.sessionId ?? (f.resumeSessionId ?? env.short),
```

**为什么这个必须改** (review 发现 critical):
- state.json 里有 `sessionId` 字段(canonical, 例如 `0abb6d98-6bfc-4b95-b59f-52c493369986`)
- 又有 `resumeSessionId`(parent,例如 `482b3a60-7ae0-4c8c-ba98-f462d08b3274`)
- 又有 `daemonShort`(8 字符 short)
- 旧代码用 `f.resumeSessionId ?? env.short`,对 fork 来说 `resumeSessionId` 是 parent 的 UUID,导致 snapshot 的 sessionId 是 parent 的 UUID
- 这会让后续 handleReply `find(s => s.sessionId === info.sessionId)` 匹配错的对象
- 改用 `f.sessionId` 后,snapshot 返回 fork 自己的 canonical UUID,跟 fork-resolver 给的 liveFork.fullUuid 一致,find 才能匹配

- [ ] **Step 3: 跑现有 job-state 测试 + 新增 1 个测试**

执行: `bun test tests/unit/agent-view/job-state.test.ts`
预期: 全部通过(现有测试不依赖 sessionId 派生逻辑的精确行为)。

新增 1 个测试到 `tests/unit/agent-view/job-state.test.ts`:
```typescript
test('jobStateToSession: 优先用 f.sessionId(对 fork 重要)', () => {
  const env = {
    short: '0abb6d98',
    path: '/x/0abb6d98/state.json',
    state: {
      state: 'blocked',
      sessionId: '0abb6d98-canonical-uuid',  // canonical
      resumeSessionId: '482b3a60-parent-uuid',  // parent
      linkScanPath: '/x/482b3a60-parent-uuid.jsonl',
      // ... 其它必填 ...
    } as any,
    mtimeMs: 0,
    readAt: 0,
  };
  const session = jobStateToSession(env);
  expect(session?.sessionId).toBe('0abb6d98-canonical-uuid');
  // 不是 '482b3a60-parent-uuid'(旧行为会回退到这里)
});
```

- [ ] **Step 4: Commit**

```bash
git add src/agent-view/job-state.ts tests/unit/agent-view/job-state.test.ts
git commit -m "fix(agent-view): jobStateToSession 优先用 f.sessionId(对 fork 重要)"
```

---

## Task 2: 扩展 AgentSession 数据模型

**Files:**
- Modify: `src/agent-view/types.ts`

- [ ] **Step 1: 加 `liveFork` 字段和 `ResolvedForkSummary` re-export**

在 `src/agent-view/types.ts` 末尾追加:

```typescript
// v2.6: 透明 fork 解析
import type { ResolvedForkSummary } from './fork-resolver';

export interface AgentSession {
  // ... 现有字段不动 ...
  /** v2.6: 如果这个 session 自身已死,但有 live fork 在跑,这里填 fork 的摘要 */
  liveFork?: ResolvedForkSummary;
}
```

**注意:** 不能在 types.ts 里 `import from './fork-resolver'` 形成循环依赖(如果 types.ts 已经被 fork-resolver 引用)。改用 `import type` + types-only,运行时不构成循环。

- [ ] **Step 2: 跑 typecheck**

执行: `bun run typecheck`
预期: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/agent-view/types.ts
git commit -m "feat(agent-view): AgentSession 加 liveFork 字段"
```

---

## Task 3: snapshot-fetcher 集成 resolver

**Files:**
- Modify: `src/agent-view/snapshot-fetcher.ts:fetch()` (在最后组装 sessions 数组前)

- [ ] **Step 1: 读 fetch() 现状,找到 session 组装点**

执行: `grep -n "jobStateToSession\|return result" src/agent-view/snapshot-fetcher.ts | head -10`
预期: 看到类似 `const sessions = jobs.map(jobStateToSession).filter(...)` 这样的组装行。

- [ ] **Step 2: 在 fetch 末尾给每条 session 补 liveFork**

找到组装 sessions 数组的那一行(典型是 `return { ok: true, sessions, ... }`),在 return 前插入:

```typescript
// v2.6: 透明 fork 解析 — 给每条 session 补 liveFork
import { resolveLiveSession, __resetResolverCache } from './fork-resolver';
// (import 放到文件顶部,这里只是注释说明)

for (const s of sessions) {
  if (!s.sessionId) continue;
  try {
    const r = await resolveLiveSession(s.sessionId);
    if (r?.hasLiveFork && r.liveFork) {
      s.liveFork = r.liveFork;
    }
  } catch (err) {
    logger.warn(`snapshot-fetcher: resolveLiveSession failed for ${s.sessionId}: ${err}`);
  }
}
```

(import 实际写在文件顶部,不在函数体里。这里注释是定位用。)

- [ ] **Step 3: 跑 typecheck + 现有 snapshot 测试**

执行: `bun run typecheck && bun test tests/unit/agent-view/snapshot-fetcher.test.ts`
预期: 全部通过。snapshot 现有断言不依赖 liveFork 字段(新增 optional 字段不影响)。

- [ ] **Step 4: Commit**

```bash
git add src/agent-view/snapshot-fetcher.ts
git commit -m "feat(snapshot): 每条 session 补 liveFork 字段(fork-resolver 集成)"
```

---

## Task 4: handleList 用 snapshot 的 liveFork(展示层)

**Files:**
- Modify: `src/agent-view/manager.ts:handleList` 和 `buildCappedCard`

- [ ] **Step 1: 读 buildCappedCard / buildListCard 现状**

执行: `grep -n "buildCappedCard\|buildListCard" src/agent-view/manager.ts src/agent-view/card.ts | head -10`

- [ ] **Step 2: 在 buildCappedCard 里把有 liveFork 的 session 移出活跃组(它实际是"续接中",不是 active)**

修改 `manager.ts` 顶部的 `buildCappedCard` helper(在 groups 组装前过滤):

```typescript
// v2.6: 有 liveFork 的 session 不再"active",应单独展示或隐藏
// 这里采用"隐藏原 session,新 fork 本身已通过 jobs/ 出现在列表里"的策略
const filteredSessions = sessions.filter(s => !s.liveFork);
```

(sessions 是 `result.sessions` —— 已被 snapshot 补过 liveFork)

- [ ] **Step 3: 跑 typecheck + manager 测试**

执行: `bun run typecheck && bun test tests/unit/agent-view/manager.test.ts`
预期: 现有测试不依赖被过滤的 session(如果失败,改测试期望)。

- [ ] **Step 4: Commit**

```bash
git add src/agent-view/manager.ts
git commit -m "feat(manager): handleList 过滤被 fork 续接的 session(避免重复展示)"
```

---

## Task 5: handleReplyRequest 用活 fork 设 expectedReply

**Files:**
- Modify: `src/agent-view/manager.ts:handleReplyRequest` 和 `expected-reply-state.ts:set`

- [ ] **Step 1: 在 handleReplyRequest 入口前 resolve**

找到 `async handleReplyRequest(openId, _shortId, sessionId, cwd, messageId)`,在第一行守卫前加:

```typescript
// v2.6: 翻译 stale sessionId → 活 fork(如有),后续 expectedReply 用 fork 的
const resolved = await resolveLiveSession(sessionId);
let effectiveSessionId = sessionId;
let effectiveShortId = _shortId;
if (resolved?.hasLiveFork && resolved.liveFork) {
  logger.info(
    `handleReplyRequest: 翻译 ${sessionId.slice(0, 8)} → 活 fork ${resolved.liveFork.short} ` +
    `(共享 JSONL: ${resolved.jsonlPath})`,
  );
  effectiveSessionId = resolved.liveFork.fullUuid;
  effectiveShortId = resolved.liveFork.short;
}
```

然后把下面所有用到 `sessionId` / `_shortId` 的地方换成 `effectiveSessionId` / `effectiveShortId`(特别注意 `expectedReply.set(...)` 调用)。

- [ ] **Step 2: 跑测试**

执行: `bun test tests/unit/agent-view/manager.test.ts tests/unit/agent-view/expected-reply-state.test.ts`
预期: 全部通过。

- [ ] **Step 3: Commit**

```bash
git add src/agent-view/manager.ts
git commit -m "feat(manager): handleReplyRequest 翻译 stale sessionId 到活 fork"
```

---

## Task 6: handleReply 二次守卫前再 resolve(防止 card 上的 sessionId 已死)

**Files:**
- Modify: `src/agent-view/manager.ts:handleReply`

- [ ] **Step 1: 找到 handleReply,在 snapshot find 后加 resolve**

```typescript
async handleReply(openId: string, text: string): Promise<void> {
  const info = this.expectedReply.get(openId);
  if (!info) return;
  if (!text || !text.trim()) return;

  const result = await AgentSnapshotFetcher.fetch();
  let session = result.sessions.find(s => s.sessionId === info.sessionId);

  // v2.6: 找不到时尝试 fork 解析(用户点的是历史 card,bind 的 sessionId 可能已 stale)
  if (!session) {
    const resolved = await resolveLiveSession(info.sessionId);
    if (resolved?.hasLiveFork && resolved.liveFork) {
      logger.info(
        `handleReply: 翻译 stale ${info.sessionId.slice(0, 8)} → 活 fork ${resolved.liveFork.short}`,
      );
      info.sessionId = resolved.liveFork.fullUuid;
      info.shortId = resolved.liveFork.short;
      session = result.sessions.find(s => s.sessionId === resolved.liveFork!.fullUuid);
    }
  }

  if (!session) {
    // ... 原有"会话已不存在"分支 ...
  }
  // ... 后续不变 ...
}
```

注意: `info` 是 `ExpectedReplyInfo`,`sessionId` 和 `shortId` 字段已存在(见 `expected-reply-state.ts:3-9`),直接 mutate 即可。但要小心 `info` 是从 in-memory 读的引用,mutate 之后会反映到下游。

- [ ] **Step 2: 跑测试**

执行: `bun test tests/unit/agent-view/manager.test.ts`
预期: 全部通过。

- [ ] **Step 3: Commit**

```bash
git add src/agent-view/manager.ts
git commit -m "feat(manager): handleReply 二次守卫前 resolve fork(stale sessionId 自动跳到活 fork)"
```

---

## Task 7: handlePeek 显示 fork annotation

**Files:**
- Modify: `src/agent-view/manager.ts:handlePeek`
- Modify: `src/agent-view/card.ts:buildPeekCard`

- [ ] **Step 1: handlePeek 解析 fork**

```typescript
async handlePeek(openId, shortId, sessionId, cwd) {
  // 现有代码:const session = await this.findSession(...)
  // 之后,插入:
  const resolved = await resolveLiveSession(sessionId);
  let effectiveSessionId = sessionId;
  let effectiveShortId = shortId;
  let isForked = false;
  if (resolved?.hasLiveFork && resolved.liveFork) {
    // 翻译:让 Peek 显示活 fork 的状态
    effectiveSessionId = resolved.liveFork.fullUuid;
    effectiveShortId = resolved.liveFork.short;
    isForked = true;
  }
  // ... 用 effectiveSessionId / effectiveShortId 调 findSession / resolvePeekContent / buildPeekCard ...
  // buildPeekCard 新增可选参数 forkedFrom?: { name: string, short: string }
  // 当 isForked=true 时填,UI 渲染一行 "🔄 已续接到 [fork name] (原 TUI 已关闭)"
}
```

- [ ] **Step 2: buildPeekCard 加 forkedFrom 字段**

`src/agent-view/card.ts` 找到 `buildPeekCard`,加可选 `forkedFrom?: { name, short }` 入参,在 card 渲染:

```typescript
if (forkedFrom) {
  // 在 waitingFor 行下面加:
  elements.push({ tag: 'markdown', content: `🔄 **已续接** — 对话在 TUI \`${forkedFrom.short}\` 继续,原 TUI 已关闭` });
}
```

- [ ] **Step 3: 跑测试**

执行: `bun test tests/unit/agent-view/card.test.ts tests/unit/agent-view/manager.test.ts`
预期: 现有测试通过(card 不传 forkedFrom 时跟以前一样)。

- [ ] **Step 4: Commit**

```bash
git add src/agent-view/manager.ts src/agent-view/card.ts
git commit -m "feat(agent-view): Peek 卡显示 fork 续接 annotation"
```

---

## Task 8: handleAttach 用活 fork

**Files:**
- Modify: `src/agent-view/manager.ts:handleAttach`

- [ ] **Step 1: 翻译 sessionId**

```typescript
async handleAttach(openId, sessionId, shortId, name, cwd) {
  // 守卫前 resolve
  const resolved = await resolveLiveSession(sessionId);
  let effectiveSessionId = sessionId;
  let effectiveShortId = shortId;
  if (resolved?.hasLiveFork && resolved.liveFork) {
    effectiveSessionId = resolved.liveFork.fullUuid;
    effectiveShortId = resolved.liveFork.short;
    logger.info(`handleAttach: 翻译 ${sessionId.slice(0, 8)} → 活 fork ${effectiveShortId}`);
  }
  // ... 后续用 effectiveSessionId / effectiveShortId ...
  // 实时守卫 (snapshot 里的 sessionId) 也用 effectiveSessionId
  // 成功消息加 "已自动续接到 [新 shortId]" 提示(可选)
}
```

- [ ] **Step 2: 跑测试**

执行: `bun test tests/unit/agent-view/manager.test.ts`
预期: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/agent-view/manager.ts
git commit -m "feat(manager): handleAttach 用活 fork(避免 attach 到已死 session)"
```

---

## Task 9: tryRendezvousReply 在 bot.ts 翻译(底层兜底)

**Files:**
- Modify: `src/feishu/bot.ts:tryRendezvousReply`

- [ ] **Step 1: 在 tryRendezvousReply 入口前 resolve**

```typescript
private async tryRendezvousReply(params: {
  openId, sessionUuid, promptText, cwd, messageId
}) {
  let { sessionUuid } = params;
  // v2.6: fork 解析
  const resolved = await resolveLiveSession(sessionUuid);
  if (resolved?.hasLiveFork && resolved.liveFork) {
    logger.info(
      `tryRendezvousReply: 翻译 ${sessionUuid.slice(0, 8)} → 活 fork ${resolved.liveFork.short} ` +
      `(共享 JSONL: ${resolved.jsonlPath})`,
    );
    sessionUuid = resolved.liveFork.fullUuid;
  }
  const short = sessionUuid.slice(0, 8);
  const eligibility = await checkRendezvousEligibility(short);
  // ... 后续不变 ...
}
```

- [ ] **Step 2: 跑测试**

执行: `bun test` (全套,看是否有 bot.ts 相关测试破坏)
预期: 全部通过。

- [ ] **Step 3: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(bot): tryRendezvousReply 翻译 stale sessionUuid 到活 fork"
```

---

## Task 10: runChatSDK 入口前 resolve(防止上游忘了)

**Files:**
- Modify: `src/feishu/bot.ts:runChatSDK`

- [ ] **Step 1: 在 rendezvous-first 短路检查前 resolve**

```typescript
public async runChatSDK(params: {...}) {
  const { sessionUuid: inputSessionUuid, ... } = params;
  let sessionUuid = inputSessionUuid;
  // v2.6: fork 解析(防御性 — handleReply/handleReplyRequest 已 resolve,这里再 resolve 防止上游漏)
  const resolved = await resolveLiveSession(sessionUuid);
  if (resolved?.hasLiveFork && resolved.liveFork) {
    logger.info(
      `runChatSDK: 翻译 ${inputSessionUuid.slice(0, 8)} → 活 fork ${resolved.liveFork.short}`,
    );
    sessionUuid = resolved.liveFork.fullUuid;
  }
  // ... 后续用 sessionUuid(已翻译)...
}
```

- [ ] **Step 2: 跑 typecheck + 测试**

执行: `bun run typecheck && bun test`
预期: 全部通过。

- [ ] **Step 3: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(bot): runChatSDK 入口前 fork 解析(防御性,上游漏也兜底)"
```

---

## Task 11: expectedReply.set + restoreExpectedReplyStates 翻译 fork

**Files:**
- Modify: `src/agent-view/expected-reply-state.ts:set`
- Modify: `src/agent-view/expected-reply-state.ts:restoreExpectedReplyStates`

- [ ] **Step 1: 在 set 入口前 resolve**

```typescript
async set(openId: string, info: ExpectedReplyInfo): Promise<void> {
  // v2.6: fork 解析(防止 card 上是 stale sessionId,持久化前翻译)
  const { resolveLiveSession } = await import('./fork-resolver');
  const resolved = await resolveLiveSession(info.sessionId);
  if (resolved?.hasLiveFork && resolved.liveFork) {
    info = {
      ...info,
      sessionId: resolved.liveFork.fullUuid,
      shortId: resolved.liveFork.short,
    };
    logger.info(
      `ExpectedReply.set: 翻译 ${info.sessionId.slice(0, 8)} → 活 fork ${resolved.liveFork.short}`,
    );
  }
  // ... 后续不变 ...
}
```

- [ ] **Step 2: 在 restoreExpectedReplyStates 里也 resolve(bot 启动恢复)**

找到 `restoreExpectedReplyStates` 的 for 循环,在 `this.inMemory.set(openId, internal)` 之前插入:

```typescript
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
      // v2.6: 翻译 stale sessionId → 活 fork
      const { resolveLiveSession } = await import('./fork-resolver');
      const resolved = await resolveLiveSession(entry.sessionUuid!);
      let effectiveSessionId = entry.sessionUuid!;
      let effectiveShortId = entry.shortId!;
      if (resolved?.hasLiveFork && resolved.liveFork) {
        effectiveSessionId = resolved.liveFork.fullUuid;
        effectiveShortId = resolved.liveFork.short;
        logger.info(
          `restoreExpectedReplyStates: 翻译 ${entry.sessionUuid!.slice(0, 8)} → 活 fork ${resolved.liveFork.short}`,
        );
      }
      const internal: InternalEntry = {
        shortId: effectiveShortId,
        sessionId: effectiveSessionId,
        cwd: entry.cwd || '',
        messageId: entry.cardMessageId,
        startedAt,
        timeoutMs: entry.timeoutMs!,
        casToken: entry.casToken || '',
      };
      this.inMemory.set(openId, internal);
      this.scheduleTimeout(openId);
    }
  }
}
```

- [ ] **Step 3: 跑测试**

执行: `bun test tests/unit/agent-view/expected-reply-state.test.ts`
预期: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add src/agent-view/expected-reply-state.ts
git commit -m "feat(expected-reply): set + restoreExpectedReplyStates 翻译 fork"
```

---

## Task 12: bot 启动时迁移 user-mapping 里的 stale session entries

**Files:**
- Modify: `src/feishu/mapping.ts` (UserManager) 或新建 `src/agent-view/user-mapping-migrator.ts`
- Hook: `src/index.ts` (daemon 启动处调)

- [ ] **Step 1: 写迁移函数**

新建 `src/agent-view/user-mapping-migrator.ts`:

```typescript
/**
 * v2.6: bot 启动时,扫 user-mapping.json,把 type='session' 或
 * type='pending_agent_reply' 的 sessionUuid 翻译到活 fork(如有)。
 *
 * 触发:bot 启动一次,跑在 startupReconcile 之后,restoreExpectedReplyStates 之前。
 *
 * 边界:
 * - 找不到 fork:不动,保持原 sessionUuid(用户可能想跟一个老 session)
 * - session 死了但有 fork:把 entry.sessionUuid 改成 fork 的
 * - pending_agent_reply 的 startedAt / casToken 保留(不影响超时/CAS)
 */

import type { UserManager } from '../feishu/mapping';
import { resolveLiveSession } from './fork-resolver';
import { logger } from '../utils/logger';

export async function migrateUserMappingSessions(userManager: UserManager): Promise<{
  scanned: number;
  migrated: number;
}> {
  let scanned = 0;
  let migrated = 0;
  const all = await userManager.allEntries();
  for (const [openId, entry] of all) {
    if (entry.type !== 'session' && entry.type !== 'pending_agent_reply') continue;
    if (!entry.sessionUuid) continue;
    scanned++;
    try {
      const r = await resolveLiveSession(entry.sessionUuid);
      if (r?.hasLiveFork && r.liveFork) {
        const newEntry = { ...entry, sessionUuid: r.liveFork.fullUuid };
        // 同时更新 shortId / cardMessageId 等附属字段
        if (entry.type === 'pending_agent_reply' && 'shortId' in entry) {
          (newEntry as any).shortId = r.liveFork.short;
        }
        const ok = await userManager.compareAndSwap(openId, entry, newEntry);
        if (ok) {
          migrated++;
          logger.info(
            `user-mapping migrate: ${openId.slice(0, 8)} ${entry.sessionUuid.slice(0, 8)} → ${r.liveFork.short}`,
          );
        }
      }
    } catch (err) {
      logger.warn(`user-mapping migrate failed for ${openId}: ${err}`);
    }
  }
  return { scanned, migrated };
}
```

- [ ] **Step 2: 在 bot 启动 hook 调它**

找到 `src/index.ts` 里 bot 启动的 `startupReconcile()` 之后、`restoreExpectedReplyStates()` 之前(或之后,顺序不严格),加:

```typescript
import { migrateUserMappingSessions } from './agent-view/user-mapping-migrator';
// ... in start() ...
await migrateUserMappingSessions(this.userManager);
this.logger.info(`user-mapping migration: ${result.scanned} scanned, ${result.migrated} migrated`);
```

- [ ] **Step 3: 写测试**

新建 `tests/unit/agent-view/user-mapping-migrator.test.ts`:
- 用 mock UserManager,fixture:1 个 stale session + 1 个 live session 在 fork-resolver 可见
- 验证 migrator 把 stale 那个的 sessionUuid 改成 fork 的
- 验证不动的(找不到 fork 的)保持原样

- [ ] **Step 4: 跑测试**

执行: `bun test tests/unit/agent-view/user-mapping-migrator.test.ts`
预期: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/user-mapping-migrator.ts tests/unit/agent-view/user-mapping-migrator.test.ts src/index.ts
git commit -m "feat(agent-view): bot 启动时迁移 user-mapping stale sessions 到活 fork"
```

---

## Task 13: README + 中文文档加一行说明

**Files:**
- Modify: `README.md`
- Modify: `README_en.md`

- [ ] **Step 1: 找两 README 的 Agent View 章节**

执行: `grep -n "Agent View\|Agent View\|## /agents\|/agents 命令" README.md README_en.md | head -5`
预期: 找到 Agent View 描述段落

- [ ] **Step 2: 加一段"fork 自动续接"说明**

中文 README:
```markdown
> 💡 **Fork 自动续接**: 当 bg session 被 `claude --resume --fork` 续接到新 TUI 时
> (例如你开了多个 TUI 切换),cc-linker 会自动用最新的活 session 接收你的 reply。
> 不需要手动指定 — `/agents` 列表 / [Peek] / [Reply] / [Attach] 全部按"对话
> 实际活跃位置"工作。
```

英文 README 类似表述。

- [ ] **Step 3: Commit**

```bash
git add README.md README_en.md
git commit -m "docs: Agent View fork 自动续接说明"
```

---

## Task 14: 端到端验证 (验收)

- [ ] **Step 1: 全套 typecheck + 测试**

```bash
bun run typecheck
bun test
```

预期: 都通过。

- [ ] **Step 2: 手动场景 A: 当前 bug case**

```bash
# 用户的实际 case:session 482b3a60 的 TUI 关了,fork 0abb6d98 在另一个 TUI
# 1. 启动 bot
bun run dev start
# 2. 在飞书侧打开旧 card (sessionId=482b3a60) 的 [Reply]
# 3. 发任意文字
# 预期:
#   - 日志: "handleReply: 翻译 stale 482b3a60 → 活 fork 0abb6d98"
#   - 飞书:reply 注入到 0abb6d98 活 TUI,正常完成
#   - 没有 "Claude Code process exited with code 1"
```

- [ ] **Step 3: 手动场景 B: /agents 列表显示活 fork**

```bash
# 1. /agents 命令
# 预期:
#   - 列表里 482b3a60 不再显示("已续接"被隐藏)
#   - 列表里 0abb6d98 正常显示(waiting/busy 等)
#   - cc-linker.log 无 "Process exited with code 1"
```

- [ ] **Step 4: 手动场景 C: bot 重启后续接**

```bash
# 1. 启动 bot,设了 expectedReply 对应 stale session
# 2. kill bot
# 3. 启动 bot
# 预期:
#   - 日志: "user-mapping migration: N scanned, M migrated"
#   - 已 migrate 的 expectedReply 用活 fork 的 sessionUuid 恢复
#   - 用户在新 TUI 里能继续 reply
```

- [ ] **Step 5: 手动场景 D: 多 TUI 切换无感**

```bash
# 1. TUI-A 跑 session 482b3a60,waiting
# 2. 用户在飞书侧点 [Reply]
# 3. 同时:TUI-A 被关(模拟用户切到 TUI-B 用 claude --resume --fork)
# 4. reply message 到达
# 预期:
#   - cc-linker 自动检测 fork,消息注入 TUI-B
#   - 用户在 TUI-B 看到自己的 reply
```

- [ ] **Step 6: 最终 commit + PR**

```bash
git log --oneline | head -20  # 确认所有 task 都 commit
git push -u origin <branch>
gh pr create --base master --title "feat(agent-view): 透明 fork 解析 — TUI 切换 / fork 后无感续接" \
  --body-file <(git log --pretty=%b $(git merge-base master HEAD)..HEAD)
```

---

## 验收清单 (Verification Checklist)

声明完成前必须为真:
- [ ] 10 个 fork-resolver 单测全过(用真实 fixture:linkScanPath 是 parent 的 JSONL,跟 sessionId 不同)
- [ ] 1 个 job-state 单测(验证 f.sessionId 优先)全过
- [ ] user-mapping-migrator 单测全过
- [ ] 全套测试 (`bun test`) 通过
- [ ] Typecheck 通过
- [ ] 4 个手动场景(A/B/C/D)全部按预期
- [ ] 日志里能看到 "翻译 X → 活 fork Y" 字样(可观测)
- [ ] 没有 "Claude Code process exited with code 1"(本次 bug 消失)
- [ ] README 中英文都更新
- [ ] review fix 全部应用:
  - [ ] fork-resolver 的 fullUuid 用 roster.sessionId(不是 linkScanPath 派生)
  - [ ] jobStateToSession 用 f.sessionId(不是 f.resumeSessionId)
  - [ ] restoreExpectedReplyStates 翻译 stale sessionId
  - [ ] 测试 fixture 用 linkScanPath ≠ sessionId 的真实数据

## 风险与缓解 (Risks & Mitigations)

| 风险 | 缓解 |
|------|------|
| `resolveLiveSession` 每次都读 jobs/ + roster/ → 性能 | 1s 模块级缓存(在 fork-resolver 内部),处理 1 个 reply 内多次 resolver 调用 |
| 翻译 sessionId 后,飞书侧 card 上的 sessionId 不变 → 用户困惑 | card 加 "🔄 已续接到 [新 short]" annotation(Task 7 / card.ts) |
| 误翻译: 用户故意想跟老 session 通信,但有 fork | `isLive=true` 时不翻译(自己的活 session 不替换);`isLive=false` 才有 `hasLiveFork`(死亡才有续接需求) |
| `linkScanPath` 缺失 / 为 null 的 session 无法被 fork 解析 | graceful: `ownJsonlPath=null` → 不找 fork,行为跟今天一样 |
| 链式 fork 链很长,只返回最新的 | 取 `linkScanOffset` 最大,测试 case 4.1 / 9.1 覆盖。**支持 2 层链**(handleReplyRequest + handleReply 各 resolve 一次),3+ 层没测,生产前手动验证 |
| UserManager CAS 失败(migrator 期间用户也在改 entry) | 比较 `entry` (old) 跟当前 entry,如果不同就 skip + 警告 |
| **`liveFork.fullUuid` 派生错误** (review 发现的 critical) | Task 1 实现里硬性用 `roster.workers[chosen.short].sessionId`,**禁止**用 linkScanPath basename 派生(实测会导致 fork 拿 parent 的 UUID,rendezvous 失败) |
| **`jobStateToSession` 用错 sessionId 字段** (review 发现的 critical) | Task 1.5 改用 `f.sessionId ?? f.resumeSessionId ?? env.short`,让 snapshot 跟 resolver 一致 |
| Bot 启动恢复时,pending_agent_reply 的 sessionId 是 stale | Task 11 Step 2 在 restoreExpectedReplyStates 里也调 resolver |

## 回滚 (Rollback)

逐 task 独立 commit + 独立 revert,最差情况 `git revert <last-merge-commit>` 全回。每个 task 的 commit 都是 additive-only(resolver 是新文件,manager/bot 是新增可选 resolve 步骤),不破坏现有 happy path。

## 不在本次范围内 (Out of Scope)

- **Fork detection via `claude logs <short>` output diff**(Plan A 替代方案,claude-code v2.1.163+ 不可靠)
- **Fork detection via JSONL mtime / content fingerprint**(太脆弱,JSONL 是 append-only 但内容会变)
- **支持用户手动指定"我不想要 fork 翻译"**(目前设计 100% 自动,UX 更简单;如果将来有需求再加 escape hatch)
- **跨机器 fork 续接**(本方案只处理单机 daemon)
- **3+ 层链式 fork**(本方案支持 2 层,3+ 层罕见,生产前再扩)
