import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, utimesSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentSnapshotFetcher, _jobStateHooks } from '../../../src/agent-view/snapshot-fetcher';
import { DaemonProbe } from '../../../src/agent-view/daemon-probe';

// ── Mock child_process execFile (smoke test only — return value discarded) ──
const execFileSyncMock = mock((_cmd: string, _args: string[]): string => '');
const execFileMock = mock(
  (_cmd: string, _args: string[], cb: (err: any, stdout: string, stderr: string) => void) => {
    cb(null, '[]', '');  // smoke test default: success with empty array
  }
);

mock.module('node:child_process', () => {
  const real = require('node:child_process');
  return {
    ...real,
    execFileSync: execFileSyncMock,
    execFile: execFileMock,
  };
});

// ── readClaimedSources swap (via _jobStateHooks, not mock.module — the latter
//    would pollute daemon-log-reader.test.ts via Bun's irrevocable module mocks) ──
const readClaimedSourcesMock = mock((_h: number): Map<string, any> => new Map());

// ── readRoster swap (v2.7: 让测试隔离真实 ~/.claude/daemon/roster.json) ──
const readRosterMock = mock((): any => null);

// ── Save / restore _jobStateHooks ──
const origReadAll = _jobStateHooks.readAllJobStates;
const origDerive = _jobStateHooks.deriveNameFromJsonl;
const origReadClaimed = _jobStateHooks.readClaimedSources;
const origReadRoster = _jobStateHooks.readRoster;
const origDaemonCheck = DaemonProbe.check;

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    // VersionGuard's check
    if (cmd === 'claude' && args[0] === '--version') return '2.1.163 (Claude Code)';
    return '';
  });
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, '[]', ''));
  readClaimedSourcesMock.mockReset();
  readClaimedSourcesMock.mockImplementation(() => new Map());
  _jobStateHooks.readClaimedSources = readClaimedSourcesMock;
  // v2.7: 默认 null — 防止真实 ~/.claude/daemon/roster.json 干扰已有 test
  readRosterMock.mockReset();
  readRosterMock.mockImplementation(() => null);
  _jobStateHooks.readRoster = readRosterMock as any;

  // DaemonProbe defaults to true (roster.json exists). Tests override per case.
  (DaemonProbe as any).check = () => true;
});

afterEach(() => {
  _jobStateHooks.readAllJobStates = origReadAll;
  _jobStateHooks.deriveNameFromJsonl = origDerive;
  _jobStateHooks.readClaimedSources = origReadClaimed;
  _jobStateHooks.readRoster = origReadRoster;
  (DaemonProbe as any).check = origDaemonCheck;
});

function mockJobs(envs: any[]) {
  _jobStateHooks.readAllJobStates = mock(() => envs);
}

function makeEnv(stateOverride: any): any {
  // Derive short from the resumeSessionId's first 8 chars so the prefix-step's
  // `envs.find(e => e.short === s.sessionId.slice(0, 8))` matches.
  // v2.7: 显式 short 覆盖 — bg slot reuse 场景下 short 与 resumeSessionId[:8] 不同
  // v2.7.1: mtimeMs 默认 Date.now() — staleness 检测新逻辑用 mtime 对比,
  // 测试需要 realistic mtimeMs(否则 stateAgeMs 巨大导致 JSONL 总是"更新")
  const resumeId = stateOverride.resumeSessionId ?? 'aaaaaaaa-1111-1111-1111-111111111111';
  const short = stateOverride.short ?? resumeId.slice(0, 8);
  return {
    short,
    path: '/x',
    mtimeMs: stateOverride.mtimeMs ?? Date.now(),
    readAt: 200,
    state: {
      state: 'running',
      detail: null, needs: null, inFlight: null,
      linkScanPath: null, linkScanOffset: 0,
      name: 'a session', nameSource: 'auto',
      intent: 'do x', resumeSessionId: resumeId,
      daemonShort: short, template: 'bg',
      respawnFlags: [], cliVersion: '2.1.163', cwd: '/work',
      ...stateOverride,
    },
  };
}

// ── Guards (version / daemon / smoke) ──

describe('AgentSnapshotFetcher.fetch — guards', () => {
  test('returns ok=false when version < 2.1.139', async () => {
    execFileSyncMock.mockImplementation(() => '2.1.100 (Claude Code)');
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(false);
  });

  test('returns ok=false when daemon not running', async () => {
    (DaemonProbe as any).check = () => false;
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('daemon');
  });

  test('returns ok=false when smoke test fails (claude not installed)', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) =>
      cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', ''));
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('smoke test failed');
  });

  test('empty jobs dir → ok with empty sessions', async () => {
    mockJobs([]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sessions).toEqual([]);
  });
});

// ── Mapping (state.json → AgentSession[]) ──

describe('AgentSnapshotFetcher.fetch — state.json mapping', () => {
  test('blocked envelope → waiting session with waitingFor + detail + linkScanPath', async () => {
    mockJobs([makeEnv({
      state: 'blocked',
      needs: '是否继续？', detail: '是否继续？',
      linkScanPath: '/path.jsonl', name: 'timer test',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    expect(r.sessions[0].status).toBe('waiting');
    expect(r.sessions[0].waitingFor).toBe('是否继续？');
    expect(r.sessions[0].detail).toBe('是否继续？');
    expect(r.sessions[0].linkScanPath).toBe('/path.jsonl');
    expect(r.sessions[0].name).toBe('timer test');  // no prefix on waiting
  });

  test('running / working → busy', async () => {
    mockJobs([
      makeEnv({ state: 'running', name: 'r1', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
      makeEnv({ state: 'working', name: 'w1', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
    ]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(2);
    expect(r.sessions.every(s => s.status === 'busy')).toBe(true);
  });

  test('done → idle + completed=true + ✅ prefix', async () => {
    mockJobs([makeEnv({ state: 'done', name: 'shell command exec' })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions[0].status).toBe('idle');
    expect(r.sessions[0].completed).toBe(true);
    expect(r.sessions[0].name).toBe('✅ shell command exec');
  });

  test('stopped → idle + completed=true + 🛑 prefix', async () => {
    mockJobs([makeEnv({ state: 'stopped', name: 'bash loop' })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions[0].status).toBe('idle');
    expect(r.sessions[0].completed).toBe(true);
    expect(r.sessions[0].name).toBe('🛑 bash loop');
  });

  // 回归:Claude CLI 把 settled-with-error 标为 'failed',前 v2.3 落到 unknown 被 drop。
  // 修法:跟 done/stopped 并列映射,UI 加 ❌ prefix 跟 TUI 视觉一致。
  test('failed → idle + completed=true + ❌ prefix (not silently dropped)', async () => {
    mockJobs([makeEnv({ state: 'failed', name: 'network timeout task' })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    expect(r.sessions[0].status).toBe('idle');
    expect(r.sessions[0].completed).toBe(true);
    expect(r.sessions[0].name).toBe('❌ network timeout task');
  });

  test('unknown state → filtered out + warn logged once (v2.3.1)', async () => {
    // Spy on logger.warn
    const { logger } = require('../../../src/utils/logger');
    const origWarn = logger.warn;
    const warnCalls: string[] = [];
    logger.warn = (msg: string) => { warnCalls.push(msg); };
    try {
      mockJobs([
        makeEnv({ state: 'future_paused', name: 'mystery1', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
        makeEnv({ state: 'experimental', name: 'mystery2', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
      ]);
      const r = await AgentSnapshotFetcher.fetch();
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.sessions.length).toBe(0);  // both filtered
      // 1 warn 聚合通知,含两种 unknown state 值
      const agentViewWarn = warnCalls.find(m => m.includes('[agent-view]'));
      expect(agentViewWarn).toBeDefined();
      expect(agentViewWarn).toContain('dropped 2 session');
      expect(agentViewWarn).toContain('future_paused');
      expect(agentViewWarn).toContain('experimental');
    } finally {
      logger.warn = origWarn;
    }
  });

  test('no warn when all states known', async () => {
    const { logger } = require('../../../src/utils/logger');
    const origWarn = logger.warn;
    const warnCalls: string[] = [];
    logger.warn = (msg: string) => { warnCalls.push(msg); };
    try {
      mockJobs([makeEnv({ state: 'running', name: 'r', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' })]);
      await AgentSnapshotFetcher.fetch();
      const agentViewWarn = warnCalls.find(m => m.includes('[agent-view] dropped'));
      expect(agentViewWarn).toBeUndefined();
    } finally {
      logger.warn = origWarn;
    }
  });

  test('mixed envelopes preserve all states with right prefix', async () => {
    mockJobs([
      makeEnv({ state: 'running', name: 'r', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
      makeEnv({ state: 'blocked', needs: 'q', name: 'b', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
      makeEnv({ state: 'done', name: 'd', resumeSessionId: 'aaaaaaa3-3333-3333-3333-333333333333' }),
      makeEnv({ state: 'stopped', name: 's', resumeSessionId: 'aaaaaaa4-4444-4444-4444-444444444444' }),
    ]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(4);
    const byShort = Object.fromEntries(r.sessions.map(s => [s.sessionId.slice(0, 8), s]));
    expect(byShort['aaaaaaa1'].status).toBe('busy');
    expect(byShort['aaaaaaa1'].name).toBe('r');  // running, no prefix
    expect(byShort['aaaaaaa2'].status).toBe('waiting');
    expect(byShort['aaaaaaa2'].waitingFor).toBe('q');
    expect(byShort['aaaaaaa3'].status).toBe('idle');
    expect(byShort['aaaaaaa3'].name).toBe('✅ d');
    expect(byShort['aaaaaaa4'].status).toBe('idle');
    expect(byShort['aaaaaaa4'].name).toBe('🛑 s');
  });

  // 三种终态(done/stopped/failed)在同一快照里共存,prefix 各不冲突
  test('three terminal states (done/stopped/failed) coexist with distinct prefixes', async () => {
    mockJobs([
      makeEnv({ state: 'done', name: 'success', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
      makeEnv({ state: 'stopped', name: 'killed', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
      makeEnv({ state: 'failed', name: 'errored', resumeSessionId: 'aaaaaaa3-3333-3333-3333-333333333333' }),
    ]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(3);
    const byShort = Object.fromEntries(r.sessions.map(s => [s.sessionId.slice(0, 8), s]));
    expect(byShort['aaaaaaa1'].name).toBe('✅ success');
    expect(byShort['aaaaaaa2'].name).toBe('🛑 killed');
    expect(byShort['aaaaaaa3'].name).toBe('❌ errored');
  });
});

// ── Source attribution (roster + daemon.log claimedSources tail) ──

describe('AgentSnapshotFetcher.fetch — source attribution', () => {
  test('filterUserDispatched drops spare sub-agent sessions (from claimedSources)', async () => {
    mockJobs([
      makeEnv({ state: 'done', name: 'real task', resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111' }),
      makeEnv({ state: 'done', name: 'spare sub', resumeSessionId: 'aaaaaaa2-2222-2222-2222-222222222222' }),
    ]);
    readClaimedSourcesMock.mockImplementation(() => new Map([
      ['aaaaaaa1', 'slash'],
      ['aaaaaaa2', 'spare'],  // spare is filtered out by filterUserDispatched
    ]));
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    expect(r.sessions[0].name).toBe('✅ real task');
  });

  test('source defaults to "unknown" when neither roster nor claimedSources knows', async () => {
    mockJobs([makeEnv({ state: 'running', name: 'lonely', resumeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111' })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions[0].source).toBe('unknown');
  });
});

// ── Cold-path name fallback (state.json.name null → deriveNameFromJsonl) ──

describe('AgentSnapshotFetcher.fetch — cold-path name fallback', () => {
  test('state.json.name null → uses deriveNameFromJsonl', async () => {
    mockJobs([makeEnv({
      state: 'done', name: null,  // null name triggers fallback
      resumeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
    })]);
    _jobStateHooks.deriveNameFromJsonl = mock(() => ({
      name: 'derived from jsonl',
      sessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
    }));
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    // ✅ prefix preserved + derived name
    expect(r.sessions[0].name).toBe('✅ derived from jsonl');
  });

  // 冷路径 + failed 状态:state.json.name 为空 + state=failed 时,
  // 仍要保留 ❌ prefix 不能被吃成派生裸名
  test('cold-path name fallback preserves ❌ prefix for failed state', async () => {
    mockJobs([makeEnv({
      state: 'failed', name: null,
      resumeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
    })]);
    _jobStateHooks.deriveNameFromJsonl = mock(() => ({
      name: 'derived failure',
      sessionId: 'aaaaaaaa-1111-1111-1111-111111111111',
    }));
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions[0].name).toBe('❌ derived failure');
  });

  test('state.json.name present → no fallback invocation', async () => {
    mockJobs([makeEnv({ state: 'running', name: 'authoritative',
                       resumeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111' })]);
    const deriveSpy = mock(() => null);
    _jobStateHooks.deriveNameFromJsonl = deriveSpy;
    await AgentSnapshotFetcher.fetch();
    expect(deriveSpy).not.toHaveBeenCalled();
  });
});

// ── Stale state.json detection (v2.7) ──
//
// 真实 bug case: bg slot (short=0abb6d98) 被 daemon 复用,新进程 resume 了
// 482b3a60-...,但 state.json 没被覆盖(仍记录旧 incarnation 的 "done")。
// claude agents --json 在 v2.1.163 把所有 background 都返 idle,失去真相源。
// cc-linker snapshot-fetcher 直接信任 stale state.json → Feishu 错显示"已完成",
// 而 TUI 用 JSONL mtime freshness 正确显示 "Working"。
//
// 修复:检测两个信号 → override 为 busy(贴合 TUI 行为)

describe('AgentSnapshotFetcher.fetch — stale state.json detection (v2.7)', () => {
  // tmp 目录存放测试 JSONL(用真实 statSync 测 mtime)
  let tmpJsonlDir: string;
  beforeEach(() => {
    tmpJsonlDir = mkdtempSync(join(tmpdir(), 'agent-view-snapshot-'));
  });

  test('Signal 1: roster.sessionId ≠ state.sessionId → override busy with roster', async () => {
    // 模拟 bg slot 0abb6d98 复用:roster 记录新进程 sessionId=482b3a60-...
    // 但 state.json 还停留在旧 incarnation (sessionId=0abb6d98-...)
    readRosterMock.mockImplementation(() => ({
      workers: {
        '0abb6d98': {
          pid: 82144,
          sessionId: '482b3a60-7ae0-4c8c-ba98-f462d08b3274',
          cwd: '/Users/wuyujun/Git/trae-data-branch/trae-data',
          startedAt: 1781573484361,
          dispatch: { source: 'fleet' },
        },
      },
      updatedAt: Date.now(),
    }));
    mockJobs([makeEnv({
      short: '0abb6d98',  // 显式 short,模拟 bg slot 复用
      state: 'done', name: 'Review AI coding lines attribution design',
      sessionId: '0abb6d98-6bfc-4b95-b59f-52c493369986',  // 旧 incarnation
      resumeSessionId: '667523a6-5c94-476c-8fe8-b52bd7fe1f08',
      linkScanPath: null,
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    const s = r.sessions[0];
    // 关键断言:override 后 status=busy,sessionId 用 roster 的
    expect(s.status).toBe('busy');
    expect(s.sessionId).toBe('482b3a60-7ae0-4c8c-ba98-f462d08b3274');
    // ✅ prefix 被剥掉(无 prefix 表示仍在进行中)
    expect(s.name).toBe('Review AI coding lines attribution design');
    // 没有 completed 标志(只有 idle + completed=true 才进入"已完成"组)
    expect(s.completed).toBeUndefined();
  });

  test('Signal 2: state.json says done but linkScanPath JSONL mtime < 5min → override busy', async () => {
    // 模拟 TUI 使用的 fallback 信号:JSONL 最近被改 → bg 实际在写
    readRosterMock.mockImplementation(() => null);  // roster 信息缺失
    const freshJsonl = join(tmpJsonlDir, 'fresh.jsonl');
    writeFileSync(freshJsonl, '[]');  // mtime = now
    mockJobs([makeEnv({
      state: 'done', name: 'fresh active session',
      linkScanPath: freshJsonl,
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    const s = r.sessions[0];
    expect(s.status).toBe('busy');  // overridden
    expect(s.name).toBe('fresh active session');  // no ✅
  });

  test('Negative: 真正 done (no roster, JSONL stale) → 保持 idle + ✅', async () => {
    // 防御:不该 override 真正完成的 session
    // 真实场景:bg 10 分钟前完成(state.json + JSONL 同时被 Claude CLI 更新,
    // state.json 略晚于 JSONL)。我的 Signal 2 检查 "JSONL 比 state.json 新",
    // 这里 JSONL 比 state.json 旧 10 分钟 → 不 override ✓
    readRosterMock.mockImplementation(() => null);
    const staleJsonl = join(tmpJsonlDir, 'stale.jsonl');
    writeFileSync(staleJsonl, '[]');
    // utimesSync 用 seconds(epoch)。Date.now() 是 ms,除以 1000 转 seconds
    const tenMinAgoSec = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);
    utimesSync(staleJsonl, tenMinAgoSec, tenMinAgoSec);  // JSONL mtime = 10min ago
    // state.json 用 makeEnv 默认 mtimeMs = Date.now() (刚刚)
    // → JSONL mtime < state.json mtime → Signal 2 不触发 ✓
    mockJobs([makeEnv({
      state: 'done', name: 'truly done',
      linkScanPath: staleJsonl,
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.sessions.length).toBe(1);
    const s = r.sessions[0];
    expect(s.status).toBe('idle');
    expect(s.completed).toBe(true);
    expect(s.name).toBe('✅ truly done');  // ✅ prefix 保留
  });

  test('Negative: roster.sessionId === state.sessionId (正常 bg session) → 不 override', async () => {
    // 防御:正常 sessionId 匹配时,即使 status=idle 也不 override
    // (避免误把合法 done 改回 busy)
    readRosterMock.mockImplementation(() => ({
      workers: {
        'aaaaaaa1': {
          pid: 3493, sessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
          cwd: '/x', startedAt: 0,
          dispatch: { source: 'slash' },
        },
      },
      updatedAt: Date.now(),
    }));
    mockJobs([makeEnv({
      state: 'done', name: 'legit completed',
      sessionId: 'aaaaaaa1-1111-1111-1111-111111111111',  // 与 roster 匹配
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
      linkScanPath: null,
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    expect(s.status).toBe('idle');
    expect(s.name).toBe('✅ legit completed');
  });

  // 2026-06-16 P0 bug: state.json says blocked/waiting 但 bg 实际在跑
  // (用户截图 21:25 时,48bbecc6 state=blocked, JSONL mtime 21:24,
  //  bg pid alive — TUI 显示 Working,Feishu 显示等待输入)
  // 修复:扩展 staleness 检测覆盖 waiting 状态。Signal 2 (JSONL fresh)
  // 是关键信号 — 真 waiting session JSONL mtime 通常几小时前 stale。
  test('Signal 2 on waiting: state.json says blocked but JSONL fresh → override to busy', async () => {
    readRosterMock.mockImplementation(() => null);  // 无 roster 信息,纯靠 JSONL freshness
    const freshJsonl = join(tmpJsonlDir, 'fresh-waiting.jsonl');
    writeFileSync(freshJsonl, '[]');  // mtime = now
    mockJobs([makeEnv({
      state: 'blocked', needs: '请问我可以继续吗?',
      name: 'bg actively working despite blocked state',
      linkScanPath: freshJsonl,
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    expect(s.status).toBe('busy');  // overridden from waiting
    expect(s.name).toBe('bg actively working despite blocked state');  // no ✋
    // waitingFor 应被剥掉(busy 时不应有 waitingFor)
    expect(s.waitingFor).toBeUndefined();
  });

  test('Negative waiting: 真在等用户输入 (JSONL stale) → 保持 waiting', async () => {
    // 防御:用户问完问题,bg 等回 — JSONL 几小时前 stale,不应 override
    // 真实场景:bg 3 小时前问完(state.json + JSONL 同时被更新),
    // 之后没人写 JSONL。state.json mtime ≈ JSONL mtime,
    // Signal 2 "JSONL 比 state.json 新" 不触发 → status 保持 waiting ✓
    readRosterMock.mockImplementation(() => null);
    const staleJsonl = join(tmpJsonlDir, 'stale-waiting.jsonl');
    writeFileSync(staleJsonl, '[]');
    const threeHoursAgoSec = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000);
    utimesSync(staleJsonl, threeHoursAgoSec, threeHoursAgoSec);
    mockJobs([makeEnv({
      state: 'blocked', needs: '请问我可以继续吗?',
      name: 'waiting for user',
      linkScanPath: staleJsonl,
      // state.json mtime 与 JSONL mtime 几乎同时(state.json 略晚于 JSONL,
      // 模拟 Claude CLI 的 "先写 JSONL 后写 state.json" 写入顺序)
      mtimeMs: threeHoursAgoSec * 1000 + 50,
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    expect(s.status).toBe('waiting');  // 保持 waiting
    expect(s.waitingFor).toBe('请问我可以继续吗?');
  });

  // v2.7.1 修复验证:bg 刚问完问题 (state.json 比 JSONL 略新),不 false-positive override
  // 这是用户决定去掉 5 分钟窗口后的关键 case — 之前的逻辑会有 5 分钟误判窗口
  test('v2.7.1: bg 刚问完 (state.json 比 JSONL 略新) → 保持 waiting', async () => {
    // 真实场景:bg 刚 ask 问题。Claude CLI 写入顺序:
    //   1. JSONL 写 assistant message(含 question text)
    //   2. state.json 更新到 blocked + needs
    // 所以 state.json 总是略新于 JSONL。Signal 2 检查 "JSONL 比 state.json 新"
    // 不触发 → 保持 waiting ✓
    readRosterMock.mockImplementation(() => null);
    const justAskedJsonl = join(tmpJsonlDir, 'just-asked.jsonl');
    writeFileSync(justAskedJsonl, '[]');  // mtime = now
    const now = Date.now();
    mockJobs([makeEnv({
      state: 'blocked', needs: '需要我把修改整理成一个 patch 文件...',
      name: 'just asked question',
      linkScanPath: justAskedJsonl,
      // state.json 比 JSONL 略新 100ms(模拟 CLI 写入顺序)
      mtimeMs: now + 100,
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    // 关键:不 override,保留 [Reply] 按钮
    expect(s.status).toBe('waiting');
    expect(s.waitingFor).toBe('需要我把修改整理成一个 patch 文件...');
    expect(s.completed).toBeUndefined();
  });

  // v2.7.1 关键 case:用户的原始 bug (48bbecc6 autonomous continuation)
  // state.json stale (1h 前 update),JSONL fresh (1min 前 update) — bg 在处理新 turn
  test('v2.7.1: 用户的原始 bug — state.json stale + JSONL fresh → override busy', async () => {
    // 真实场景:48bbecc6 在用户截图 21:25 时
    //   state.json mtime = 20:01 (1.5h 前,bg 问问题时)
    //   JSONL mtime = 21:24 (1min 前,bg 在自主继续处理)
    //   pid 82144 alive in roster (这里简化为无 roster)
    readRosterMock.mockImplementation(() => null);
    const freshJsonl = join(tmpJsonlDir, 'autonomous-fresh.jsonl');
    writeFileSync(freshJsonl, '[]');  // mtime = now
    const now = Date.now();
    // state.json 1.5 小时前 (1.5h = 5400s = 5400000ms)
    const stateJsonStaleMs = now - 5400 * 1000;
    mockJobs([makeEnv({
      state: 'blocked', needs: '需要我把修改整理成一个 patch 文件...',
      name: 'bg autonomously continuing',
      linkScanPath: freshJsonl,
      mtimeMs: stateJsonStaleMs,
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    // 关键:JSONL 比 state.json 新很多 → override to busy
    expect(s.status).toBe('busy');
    expect(s.waitingFor).toBeUndefined();  // 剥掉
  });

  test('Signal 1 on waiting: bg slot 被 reuse (sessionId mismatch + blocked) → override to busy', async () => {
    // 真实场景:0abb6d98 (no doc) 被 daemon 复用,roster.sessionId 是新进程,
    // state.json 还停留在旧 incarnation 的 blocked 状态
    readRosterMock.mockImplementation(() => ({
      workers: {
        '0abb6d98': {
          pid: 82144,
          sessionId: '482b3a60-7ae0-4c8c-ba98-f462d08b3274',
          cwd: '/Users/wuyujun/Git/trae-data-branch/trae-data',
          startedAt: 1781573484361,
          dispatch: { source: 'fleet' },
        },
      },
      updatedAt: Date.now(),
    }));
    mockJobs([makeEnv({
      short: '0abb6d98',
      state: 'blocked', needs: '需要我把修改整理成一个 patch 文件...',
      name: 'Review AI coding lines attribution design',
      sessionId: '0abb6d98-6bfc-4b95-b59f-52c493369986',  // 旧 incarnation
      resumeSessionId: '667523a6-5c94-476c-8fe8-b52bd7fe1f08',
      linkScanPath: null,
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    expect(s.status).toBe('busy');
    expect(s.sessionId).toBe('482b3a60-7ae0-4c8c-ba98-f462d08b3274');
    expect(s.waitingFor).toBeUndefined();  // 剥掉
  });
});
