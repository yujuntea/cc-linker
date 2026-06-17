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

  // 2026-06-17 P0 bug (round 2): Signal 2 (mtime comparison) 在生产环境
  // 错误 override 4/5 个 done sessions。原因与 round 1 (waiting) 一样:
  // JSONL 文件 mtime 不是 assistant write 时间 — 它是 daemon settle event
  // 触摸文件的时间。state.json mtime 是 state machine transition 时间。
  // 两者相对顺序对 'bg 是否在跑' 没有意义,真实环境下几乎每个 settled
  // session 都满足 'JSONL 比 state.json 新'。
  //
  // 用户截图(2026-06-17 13:30): TUI 5 completed / 2 working / 5 needs input,
  // Feishu 1 completed / 6 busy / 5 waiting。差 4 个 — 全部是 done 被错误
  // override busy(3267aa2b, ecb21147, fa9ddf02, 8bbaa3c1)。
  test('Signal 2 P0 round 2: done + JSONL mtime newer + no roster → keep idle + ✅', async () => {
    // 真实数据模式 (2026-06-17 用户 ~/.claude/jobs/):
    //   3267aa2b (done): state_age=75627s, jsonl_age=71357s → JSONL 新 4270s
    //   ecb21147 (done): state_age=100058s, jsonl_age=96439s → JSONL 新 3619s
    //   fa9ddf02 (done): state_age=176680s, jsonl_age=172308s → JSONL 新 4372s
    //   8bbaa3c1 (done): state_age=53094s, jsonl_age=53061s → JSONL 新 33s
    readRosterMock.mockImplementation(() => null);  // 无 Signal 1 roster mismatch
    const daemonTouchedJsonl = join(tmpJsonlDir, 'daemon-touched-done.jsonl');
    writeFileSync(daemonTouchedJsonl, '[]');  // mtime = now (daemon settle touched)
    const now = Date.now();
    const oneHourAgoMs = now - 60 * 60 * 1000;
    mockJobs([makeEnv({
      state: 'done', name: '真正 done 的 session (daemon touched JSONL after settle)',
      linkScanPath: daemonTouchedJsonl,
      mtimeMs: oneHourAgoMs,  // state.json 1h 前 (bg settle 时)
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    // 关键:Signal 2 不应在 done 上 fire (mtime 是不可靠信号)
    expect(s.status).toBe('idle');
    expect(s.completed).toBe(true);
    expect(s.name).toBe('✅ 真正 done 的 session (daemon touched JSONL after settle)');
  });

  test('v2.7.3: state=done + JSONL mtime fresh (no roster) → keep idle + ✅ (Signal 2 removed)', async () => {
    // v2.7.3 修复:Signal 2 (mtime-based staleness override) 已完全移除,
    // 因为生产环境数据证明 JSONL 文件 mtime 不是 bg write 时间(是 daemon settle
    // 触摸时间)。原来这个 case 被错误 override 成 busy — 现在保持 idle + ✅。
    //
    // 跟下面 'Negative: 真正 done' 测试场景对称:不管 JSONL 是 stale 还是 fresh,
    // 只要 state.json 说 done + 没有 roster mismatch → 保持 idle + ✅。
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
    // v2.7.3:Signal 2 移除,保持 idle
    expect(s.status).toBe('idle');
    expect(s.completed).toBe(true);
    expect(s.name).toBe('✅ fresh active session');  // ✅ prefix 保留
  });

  test('Negative: 真正 done (no roster, JSONL stale) → 保持 idle + ✅', async () => {
    // 防御:不该 override 真正完成的 session
    // v2.7.3:即使 Signal 2 存在,这个 case 也不该 override (JSONL stale < state.json)
    // v2.7.3 后:Signal 2 完全移除,所有 done sessions 都保持 idle (除非 Signal 1 fire)
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

  // 2026-06-17 P0 regression 防御:state=blocked + needs + JSONL mtime newer
  // than state.json + no roster mismatch → status 必须保持 waiting,
  // NOT 被 override 成 busy。这是真实生产环境数据触发的修复 —
  // 之前 b049f26+5381b40 把 Signal 2 扩展到 waiting 状态,
  // 错误 override 了几乎所有 settled session (5 个 waiting + 多个 done
  // 被错误 promote 成 busy,Feishu 等待输入空)。
  //
  // 注意:这个测试和上面的 "Negative waiting" 是同向的(都期望保持 waiting),
  // 但场景不同:这里 JSONL 比 state.json 新(模拟 daemon settle 触摸的 mtime 模式),
  // 上面是 JSONL 比 state.json 旧。两个 case 都不能 override waiting。
  test('2026-06-17 防御: blocked + JSONL mtime newer than state.json + no roster → keep waiting', async () => {
    readRosterMock.mockImplementation(() => null);  // 无 Signal 1 roster mismatch
    const daemonTouchedJsonl = join(tmpJsonlDir, 'daemon-touched-waiting.jsonl');
    writeFileSync(daemonTouchedJsonl, '[]');  // mtime = now (daemon settle 触摸)
    const now = Date.now();
    mockJobs([makeEnv({
      state: 'blocked', needs: '请问我可以继续吗?',
      name: 'bg settled, daemon touched JSONL after settle',
      linkScanPath: daemonTouchedJsonl,
      mtimeMs: now - 60 * 60 * 1000,  // state.json 1h 前被写
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    // 关键:即使 JSONL mtime 比 state.json 新,waiting 状态也不该 override
    expect(s.status).toBe('waiting');
    expect(s.waitingFor).toBe('请问我可以继续吗?');
    expect(s.name).toBe('bg settled, daemon touched JSONL after settle');  // 无 emoji prefix
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

  // v2.7.1 → v2.7.2:Signal 2 之前以为能检测 "bg autonomously continuing" 案例
  // (state.json stale + JSONL fresh + state=blocked),但生产环境数据证明这个信号
  // 不可靠 — JSONL mtime 是 daemon settle 触摸的,不是 bg write 触摸的。
  // 现在这种 case 不再通过 Signal 2 override (waiting 状态完全不动)。
  //
  // 如果要检测 "bg autonomously continuing",得用别的信号(如进程 liveness / pid alive),
  // 留给后续架构讨论。当前选择保守:不 override waiting — 错把活的 waiting
  // 显示成 busy 是更糟的 UX (用户失去 Reply 按钮)。
  test('v2.7.2: blocked + stale state.json + fresh JSONL + no roster → keep waiting (no false override)', async () => {
    // 之前这个 case 被 override 成 busy,生产环境看是 false positive
    // (用户 2026-06-17 截图 13 个 session 11 个被错误 override)
    readRosterMock.mockImplementation(() => null);
    const freshJsonl = join(tmpJsonlDir, 'autonomous-fresh.jsonl');
    writeFileSync(freshJsonl, '[]');  // mtime = now
    const now = Date.now();
    const stateJsonStaleMs = now - 5400 * 1000;
    mockJobs([makeEnv({
      state: 'blocked', needs: '需要我把修改整理成一个 patch 文件...',
      name: 'bg autonomously continuing (v2.7.2: no longer falsely override)',
      linkScanPath: freshJsonl,
      mtimeMs: stateJsonStaleMs,
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    // v2.7.2: waiting 不再被 override
    expect(s.status).toBe('waiting');
    expect(s.waitingFor).toBe('需要我把修改整理成一个 patch 文件...');
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

  // 2026-06-17 P0 bug: snapshot-fetcher Signal 2 (JSONL mtime 比 state.json 新)
  // 被扩展到 waiting 状态后,几乎所有 settled session 都被错误 override 成 busy。
  // 真实数据(用户 ~/.claude/jobs/*/state.json 共 13 个 session,11 个被错误 override):
  //   - 5 个 waiting sessions: state.json 1h 前 blocked,
  //     JSONL mtime 被 daemon settle event 触摸过 → 触发 Signal 2 → override busy
  //   - 多个 done sessions: 同样的 mtime pattern,也被错误 override
  //
  // 根因:JSONL 文件 mtime 不是 assistant write 时间,而是 daemon settle 时间。
  // state.json mtime 是 state machine transition 时间(可能更早)。
  // 两者相对顺序对"bg 是否在跑"没有意义 — 真实环境下两者可能相差 1h+,
  // 但 bg 完全没在动(d等待回用户,d等待 daemon settle)。
  //
  // 修复:Signal 2 只适用于 idle (终态:done/stopped/failed),
  // 因为终态可以被 bg slot reuse 污染。
  // waiting/blocked 是实时的 state machine 状态 — bg 在等用户输入,
  // 不是 stale。Signal 1 (roster.sessionId mismatch) 已能覆盖 waiting 状态下的
  // bg slot reuse 误判。
  test('P0 regression: blocked + JSONL mtime newer than state.json + no roster → keep waiting', async () => {
    // 真实数据模式(2026-06-17 用户截图):
    //   state.json: blocked + needs, mtime 1h 前
    //   JSONL: mtime 1min 前(被 daemon settle 触摸,不是 bg write)
    //   roster: null(没有 Signal 1 信号)
    //   期望: status=waiting(signal 2 不应在 waiting 上 fire)
    readRosterMock.mockImplementation(() => null);
    const daemonTouchedJsonl = join(tmpJsonlDir, 'daemon-touched.jsonl');
    writeFileSync(daemonTouchedJsonl, '[]');  // mtime = now (just touched by daemon settle)
    const now = Date.now();
    const oneHourAgoMs = now - 60 * 60 * 1000;
    mockJobs([makeEnv({
      state: 'blocked', needs: '需要我把修改整理成一个 patch 文件,或者帮你做更细致的二次验证吗?',
      name: 'Review AI coding lines attribution design',
      linkScanPath: daemonTouchedJsonl,
      mtimeMs: oneHourAgoMs,  // state.json 1h 前被写 (bg ask 时)
      resumeSessionId: 'aaaaaaa1-1111-1111-1111-111111111111',
    })]);
    const r = await AgentSnapshotFetcher.fetch();
    expect(r.ok).toBe(true); if (!r.ok) return;
    const s = r.sessions[0];
    // 关键:Signal 2 不应在 waiting 状态上 fire
    expect(s.status).toBe('waiting');
    expect(s.waitingFor).toBe('需要我把修改整理成一个 patch 文件,或者帮你做更细致的二次验证吗?');
  });
});
