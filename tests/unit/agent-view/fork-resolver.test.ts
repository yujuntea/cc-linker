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
          '0abb6d98': {
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
