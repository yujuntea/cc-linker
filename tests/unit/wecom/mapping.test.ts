import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WecomUserManager, WECOM_USER_MAPPING_PATH } from '../../../src/wecom/mapping';

describe('WecomUserManager', () => {
  let dir: string;
  let manager: WecomUserManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-mapping-'));
    manager = new WecomUserManager(join(dir, 'mapping-wecom.json'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses wecom-specific file path (different from feishu)', () => {
    expect(manager.path).toMatch(/mapping-wecom\.json$/);
    expect(manager.path).not.toContain('user-mapping.json');  // 飞书路径
  });

  it('default WECOM_USER_MAPPING_PATH is sibling of feishu', () => {
    expect(WECOM_USER_MAPPING_PATH).toMatch(/user-mapping-wecom\.json$/);
  });

  it('stores entry by external_userid', async () => {
    await manager.setPending('external-user-1', { cwd: '/tmp' });
    const entry = manager.getEntry('external-user-1');
    expect(entry?.type).toBe('pending_new_session');
  });

  it('different from feishu mapping (independent files)', async () => {
    await manager.setPending('wecom-user', { cwd: '/tmp' });
    expect(manager.getEntry('wecom-user')).toBeDefined();
    expect(manager.getEntry('feishu-user')).toBeUndefined();
  });

  it('claimPending transitions pending → claimed', async () => {
    await manager.setPending('ext-1', { cwd: '/tmp' });
    const result = await manager.claimPending('ext-1', 'msg-1');
    expect(result.status).toBe('claimed');
    const entry = manager.getEntry('ext-1');
    expect(entry?.type).toBe('pending_new_session_claimed');
  });

  it('bindSessionToClaim transitions claimed → session', async () => {
    await manager.setPending('ext-2', { cwd: '/tmp' });
    await manager.claimPending('ext-2', 'msg-2');
    const bound = await manager.bindSessionToClaim('ext-2', 'msg-2', 'uuid-xyz', '/tmp');
    expect(bound).toBe(true);
    const entry = manager.getEntry('ext-2');
    expect(entry?.type).toBe('session');
    expect(entry?.sessionUuid).toBe('uuid-xyz');
  });

  it('rollbackClaim transitions claimed → pending', async () => {
    await manager.setPending('ext-3', { cwd: '/tmp' });
    await manager.claimPending('ext-3', 'msg-3');
    const rolled = await manager.rollbackClaim('ext-3', 'msg-3');
    expect(rolled).toBe(true);
    const entry = manager.getEntry('ext-3');
    expect(entry?.type).toBe('pending_new_session');
  });

  // PR 4.1 final: 0 字节 user-mapping 文件自愈测试
  it('PR 4.1 final: 0 字节 user-mapping 文件自愈', async () => {
    // 模拟历史 daemon 异常退出留 0 字节文件
    const mappingPath = join(dir, 'mapping-wecom.json');
    writeFileSync(mappingPath, '');  // 0 字节
    expect(readFileSync(mappingPath, 'utf8')).toBe('');

    // 触发 ensureFile → 应自愈写默认值
    const fresh = new WecomUserManager(mappingPath);
    const entry = fresh.getEntry('ext-selfheal');
    expect(entry).toBeUndefined();

    // 文件不再是 0 字节, 内容是合法 JSON
    const content = readFileSync(mappingPath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('PR 4.1 final: loadMapping 直接读 0 字节返回空 mapping', () => {
    // 直接测 loadMapping (用 access protected method via cast)
    const mappingPath = join(dir, 'mapping-wecom.json');
    writeFileSync(mappingPath, '');
    const fresh = new WecomUserManager(mappingPath);
    // 通过 getEntry 验证 loadMapping 自愈
    expect(fresh.getEntry('any-user')).toBeUndefined();
  });

  // PR 4.5: setSession (简化版, 不需 claim) + touchSession
  describe('PR 4.5: setSession + touchSession', () => {
    it('setSession: writes session entry directly (no claim required)', async () => {
      await manager.setSession('ext-new', 'uuid-abc-123', '/tmp');
      const entry = manager.getEntry('ext-new');
      expect(entry?.type).toBe('session');
      expect(entry?.sessionUuid).toBe('uuid-abc-123');
      expect(entry?.cwd).toBe('/tmp');
      expect(entry?.createdAt).toBeDefined();
      expect(entry?.lastActiveAt).toBeDefined();
      expect(entry?.casToken).toBeDefined();
    });

    it('setSession: overwrites existing entry (replace mode)', async () => {
      // 已有 pending 状态, setSession 直接覆盖
      await manager.setPending('ext-rep', { cwd: '/old' });
      await manager.setSession('ext-rep', 'uuid-new', '/new');
      const entry = manager.getEntry('ext-rep');
      expect(entry?.type).toBe('session');
      expect(entry?.sessionUuid).toBe('uuid-new');
      expect(entry?.cwd).toBe('/new');
    });

    it('setSession: creates entry even when user-mapping file is missing', async () => {
      const freshDir = mkdtempSync(join(tmpdir(), 'wecom-fresh-'));
      const fresh = new WecomUserManager(join(freshDir, 'mapping-wecom.json'));
      await fresh.setSession('ext-fresh', 'uuid-fresh', '/var');
      expect(fresh.getEntry('ext-fresh')?.sessionUuid).toBe('uuid-fresh');
      rmSync(freshDir, { recursive: true, force: true });
    });

    it('setSession: 显式清理 claimedByMessageId + claimedAt (C-4 修复)', async () => {
      // 模拟历史 daemon 异常退出后, entry 带 claimed 残留
      const mappingPath = join(dir, 'mapping-wecom-c4.json');
      writeFileSync(mappingPath, JSON.stringify({
        version: 1,
        entries: {
          'ext-c4': {
            type: 'pending_new_session_claimed',
            sessionUuid: null,
            cwd: '/old',
            claimedByMessageId: 'orphan-msg',
            claimedAt: new Date(Date.now() - 600_000).toISOString(),  // 10 min ago
            lastActiveAt: new Date(Date.now() - 600_000).toISOString(),
            casToken: 'old',
          },
        },
      }));
      const fresh = new WecomUserManager(mappingPath);
      await fresh.setSession('ext-c4', 'uuid-new', '/new');
      const entry = fresh.getEntry('ext-c4');
      expect(entry?.type).toBe('session');
      expect(entry?.sessionUuid).toBe('uuid-new');
      // 关键断言: claimed 字段必须清掉
      expect((entry as any)?.claimedByMessageId).toBeUndefined();
      expect((entry as any)?.claimedAt).toBeUndefined();
    });

    it('touchSession: updates lastActiveAt on existing session', async () => {
      await manager.setSession('ext-touch', 'uuid-touch', '/tmp');
      const before = manager.getEntry('ext-touch');
      const beforeLast = before?.lastActiveAt;

      // 等 10ms 保证时间戳差异
      await new Promise(r => setTimeout(r, 10));
      await manager.touchSession('ext-touch');

      const after = manager.getEntry('ext-touch');
      expect(after?.lastActiveAt).not.toBe(beforeLast);
      expect(after?.sessionUuid).toBe('uuid-touch');  // sessionUuid 不变
    });

    it('touchSession: no-op when entry is not a session', async () => {
      // pending 状态 → touch 不应报错, 也不应变更 entry
      await manager.setPending('ext-pending', { cwd: '/tmp' });
      await manager.touchSession('ext-pending');
      const entry = manager.getEntry('ext-pending');
      // entry 仍是 pending, lastActiveAt 可能被 setPending 更新了，但 touchSession 不破坏 type
      expect(entry?.type).toBe('pending_new_session');
    });

    it('touchSession: no-op when entry does not exist', async () => {
      // 不存在的用户 → 静默成功
      await manager.touchSession('nonexistent-user');
      expect(manager.getEntry('nonexistent-user')).toBeUndefined();
    });
  });

  // PR 7 Task 7.6 (m-8): mapping.ts lockKey (setPending/setSession/touchSession) JSDoc
  // 解释 userId vs openId 语义差异。
  // 历史: 飞书侧 lockKey = openId (飞书 user identifier),
  //   企微侧 lockKey = userId (企微 external_userid 字段, 跟飞书的 openId 等价但命名不同)。
  //   单仓 2 套命名, 新人 review 时常混淆。
  // 修法: mapping.ts 三个方法 setPending/setSession/touchSession 加 JSDoc 注释。
  it('m-8: setPending/setSession/touchSession 有 lockKey userId vs openId JSDoc', () => {
    const { readFileSync } = require('fs');
    const src = readFileSync(
      require('path').resolve(__dirname, '../../../src/wecom/mapping.ts'),
      'utf8',
    );

    // 三个方法都要有 lockKey userId vs openId JSDoc 注释
    // 关键词: 飞书, 企微, openId, userId 至少出现 1 次
    expect(src).toMatch(/飞书.*openId|openId.*飞书/s);
    expect(src).toMatch(/企微.*userId|userId.*企微/s);

    // 每个方法都有 lockKey 解释
    expect(src).toMatch(/setPending[\s\S]{0,2000}lockKey/s);
    expect(src).toMatch(/setSession[\s\S]{0,2000}lockKey/s);
    expect(src).toMatch(/touchSession[\s\S]{0,2000}lockKey/s);
  });
});
