import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { migrateUserMappingSessions } from '../../../src/agent-view/user-mapping-migrator';
import { __resetResolverCache } from '../../../src/agent-view/fork-resolver';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('migrateUserMappingSessions', () => {
  let tmp: string;
  let jobsDir: string;
  let rosterPath: string;
  let userManager: any;

  beforeEach(() => {
    __resetResolverCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-test-'));
    jobsDir = path.join(tmp, 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    rosterPath = path.join(tmp, 'roster.json');
    userManager = makeMockUserManager();
  });

  function makeMockUserManager() {
    return {
      _entries: new Map<string, any>(),
      async allEntries() { return this._entries; },
      async compareAndSwap(openId: string, oldEntry: any, newEntry: any) {
        const cur = this._entries.get(openId);
        if (cur === oldEntry || (oldEntry === null && cur === undefined)) {
          this._entries.set(openId, newEntry);
          return true;
        }
        return false;
      },
      getEntry(openId: string) { return this._entries.get(openId) ?? null; },
    };
  }

  function setupStaleSession(openId: string, sessionUuid: string) {
    userManager._entries.set(openId, {
      type: 'session',
      sessionUuid,
      cwd: '/x',
      createdAt: new Date().toISOString(),
    });
  }

  function setupStalePendingReply(openId: string, sessionUuid: string, shortId: string) {
    userManager._entries.set(openId, {
      type: 'pending_agent_reply',
      sessionUuid,
      shortId,
      cwd: '/x',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      timeoutMs: 300_000,
      casToken: 'tok-1',
    });
  }

  function setupForkJobAndRoster(opts: {
    forkShort: string;
    forkSessionId: string;
    parentJsonl: string;
    parentUuid: string;
    forkOffset: number;
    pid: number;
  }) {
    const d = path.join(jobsDir, opts.forkShort);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({
      state: 'blocked',
      tempo: 'active',
      needs: '继续?',
      sessionId: opts.forkSessionId,
      resumeSessionId: opts.parentUuid,
      linkScanPath: opts.parentJsonl,
      linkScanOffset: opts.forkOffset,
      cwd: '/x',
    }));
    let roster = { workers: {} as any };
    if (fs.existsSync(rosterPath)) {
      roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    }
    roster.workers[opts.forkShort] = {
      pid: opts.pid,
      sessionId: opts.forkSessionId,
      cwd: '/x',
    };
    fs.writeFileSync(rosterPath, JSON.stringify(roster));
  }

  test('1.1 stale session 找到活 fork → 翻译到 fork 的 sessionId', async () => {
    const parentUuid = '00000001-0000-0000-0000-000000000001';
    const parentJsonl = `/x/${parentUuid}.jsonl`;  // 必须以 parent UUID 结尾,resolver 才匹配
    setupStaleSession('ou_aaa', parentUuid);
    setupForkJobAndRoster({
      forkShort: 'abcd1234',
      forkSessionId: 'abcd1234-fork-uuid-aaaa-bbbbccccdddd',
      parentJsonl, parentUuid,
      forkOffset: 5000, pid: 100,
    });

    const r = await migrateUserMappingSessions(userManager, {
      jobsDir, rosterPath,
    });
    expect(r.scanned).toBe(1);
    expect(r.migrated).toBe(1);
    const entry = userManager._entries.get('ou_aaa');
    expect(entry.sessionUuid).toBe('abcd1234-fork-uuid-aaaa-bbbbccccdddd');
  });

  test('1.2 stale pending_agent_reply 找到活 fork → 翻译 sessionId + shortId', async () => {
    const parentUuid = '00000002-0000-0000-0000-000000000002';
    const parentJsonl = `/x/${parentUuid}.jsonl`;
    setupStalePendingReply('ou_bbb', parentUuid, parentUuid.slice(0, 8));
    setupForkJobAndRoster({
      forkShort: 'ffff9999',
      forkSessionId: 'ffff9999-fork-uuid-eeee-ffff00001111',
      parentJsonl, parentUuid,
      forkOffset: 7000, pid: 200,
    });

    const r = await migrateUserMappingSessions(userManager, {
      jobsDir, rosterPath,
    });
    expect(r.scanned).toBe(1);
    expect(r.migrated).toBe(1);
    const entry = userManager._entries.get('ou_bbb');
    expect(entry.sessionUuid).toBe('ffff9999-fork-uuid-eeee-ffff00001111');
    expect(entry.shortId).toBe('ffff9999');
  });

  test('1.3 找不到 fork 的 entry → 不动', async () => {
    setupStaleSession('ou_ccc', '99999999-9999-9999-9999-999999999999');
    // 不创建任何 fork

    const r = await migrateUserMappingSessions(userManager, {
      jobsDir, rosterPath,
    });
    expect(r.scanned).toBe(1);
    expect(r.migrated).toBe(0);
    const entry = userManager._entries.get('ou_ccc');
    expect(entry.sessionUuid).toBe('99999999-9999-9999-9999-999999999999');  // 没变
  });

  test('1.4 混合:1 个 stale (有 fork) + 1 个 stale (无 fork) + 1 个非 session type', async () => {
    // #1: stale + 有 fork
    const parentUuid1 = '00000004-0000-0000-0000-000000000004';
    const parentJsonl1 = `/x/${parentUuid1}.jsonl`;
    setupStaleSession('ou_aaa', parentUuid1);
    setupForkJobAndRoster({
      forkShort: 'aaa00001',
      forkSessionId: 'aaa00001-fork-uuid-1',
      parentJsonl: parentJsonl1, parentUuid: parentUuid1,
      forkOffset: 1000, pid: 100,
    });

    // #2: stale + 无 fork
    setupStaleSession('ou_bbb', '00000005-0000-0000-0000-000000000005');

    // #3: pending_new_session(不是 session/pending_agent_reply,跳过)
    userManager._entries.set('ou_ccc', {
      type: 'pending_new_session',
      sessionUuid: 'whatever',
    });

    const r = await migrateUserMappingSessions(userManager, {
      jobsDir, rosterPath,
    });
    expect(r.scanned).toBe(2);  // ou_aaa + ou_bbb
    expect(r.migrated).toBe(1);  // only ou_aaa
    expect(userManager._entries.get('ou_aaa').sessionUuid).toBe('aaa00001-fork-uuid-1');
    expect(userManager._entries.get('ou_bbb').sessionUuid).toBe('00000005-0000-0000-0000-000000000005');
    expect(userManager._entries.get('ou_ccc').sessionUuid).toBe('whatever');  // 不动
  });

  test('1.5 CAS 失败(用户同时在改 entry) → skip + 不算 migrated', async () => {
    const parentUuid = '00000006-0000-0000-0000-000000000006';
    const parentJsonl = `/x/${parentUuid}.jsonl`;
    setupStaleSession('ou_aaa', parentUuid);
    setupForkJobAndRoster({
      forkShort: 'cas00001',
      forkSessionId: 'cas00001-fork-uuid',
      parentJsonl, parentUuid,
      forkOffset: 100, pid: 100,
    });

    // 模拟 CAS 失败:migrator 读到的 oldEntry 跟实际 compareAndSwap 时的不一样
    userManager.compareAndSwap = async (_openId: string, _old: any, _new: any) => {
      // 故意让 CAS 失败(返回 false,即使 entry 实际在)
      return false;
    };

    const r = await migrateUserMappingSessions(userManager, {
      jobsDir, rosterPath,
    });
    expect(r.scanned).toBe(1);
    expect(r.migrated).toBe(0);
  });
});
