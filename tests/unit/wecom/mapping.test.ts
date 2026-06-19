import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
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
});
