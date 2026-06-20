import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { RegistryManager } from '../../src/registry';
import { mkdtempSync, rmSync, existsSync, readdirSync, unlinkSync, lstatSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('RegistryManager', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-linker-registry-test-'));
    registry = new RegistryManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates empty registry on init', () => {
    expect(registry.sessions).toEqual({});
    expect(existsSync(join(tmpDir, 'registry.json'))).toBe(true);
  });

  it('upsert creates new session', async () => {
    registry.upsert('test-uuid-1', {
      origin: 'cli',
      cwd: '/test',
      title: 'Test Session',
    });

    expect(registry.has('test-uuid-1')).toBe(true);
    expect(registry.get('test-uuid-1')?.title).toBe('Test Session');
    expect(registry.get('test-uuid-1')?.origin).toBe('cli');
  });

  it('upsert updates existing session', async () => {
    registry.upsert('test-uuid-1', { title: 'Original' });
    registry.upsert('test-uuid-1', { title: 'Updated' });

    expect(registry.get('test-uuid-1')?.title).toBe('Updated');
  });

  it('findByPrefix finds unique match', async () => {
    registry.upsert('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec', { title: 'Test' });

    const match = registry.findByPrefix('b21d6d04');
    expect(match).not.toBeNull();
    expect(match![0]).toBe('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec');
  });

  it('findByPrefix returns null on multiple matches', async () => {
    registry.upsert('b21d6d04-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { title: 'A' });
    registry.upsert('b21d6d04-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { title: 'B' });

    const result = registry.findByPrefix('b21d6d04');
    expect(result).toBeNull();
  });

  it('findByPrefix returns null for no match', async () => {
    expect(registry.findByPrefix('nonexistent')).toBeNull();
  });

  it('remove deletes session', async () => {
    registry.upsert('test-uuid-1', { title: 'Test' });
    await registry.remove('test-uuid-1');

    expect(registry.has('test-uuid-1')).toBe(false);
  });

  it('creates backup on save', async () => {
    registry.upsert('test-uuid-1', { title: 'Test' });
    await registry.flush();

    const backupDir = join(tmpDir, 'backups');
    expect(existsSync(backupDir)).toBe(true);

    const backups = readdirSync(backupDir).filter(f => f.startsWith('registry.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('keeps max 3 backups', async () => {
    for (let i = 0; i < 5; i++) {
      registry.upsert(`uuid-${i}`, { title: `Session ${i}` });
      await registry.flush();
    }

    const backupDir = join(tmpDir, 'backups');
    const backups = readdirSync(backupDir).filter(f => f.startsWith('registry.'));
    expect(backups.length).toBeLessThanOrEqual(3);
  });

  it('replaces dangling .bak symlink during backup rotation', async () => {
    registry.upsert('uuid-1', { title: 'Session 1' });
    await registry.flush();

    const backupDir = join(tmpDir, 'backups');
    const existingBackup = readdirSync(backupDir).find(f => f.startsWith('registry.'));
    expect(existingBackup).toBeDefined();
    unlinkSync(join(backupDir, existingBackup!));

    registry.upsert('uuid-2', { title: 'Session 2' });
    await registry.flush();

    const bakPath = join(tmpDir, 'registry.json.bak');
    expect(lstatSync(bakPath).isSymbolicLink()).toBe(true);
  });

  it('upsert does not overwrite existing values with undefined', () => {
    registry.upsert('test-uuid-1', {
      origin: 'feishu',
      title: 'Original Title',
      cwd: '/Users/test',
    });

    // Update with partial data - should not clear title
    registry.upsert('test-uuid-1', {
      last_active: '2026-06-01T10:00:00Z',
      message_count: 42,
    });

    const entry = registry.get('test-uuid-1');
    expect(entry?.title).toBe('Original Title');
    expect(entry?.origin).toBe('feishu');
    expect(entry?.message_count).toBe(42);
    expect(entry?.last_active).toBe('2026-06-01T10:00:00Z');
  });

  it('upsert allows intentional null values (e.g., clearing jsonl_path)', () => {
    registry.upsert('test-uuid-1', {
      origin: 'feishu',
      jsonl_path: '/path/to/file.jsonl',
    });

    // Clear stale mapping by setting to null
    registry.upsert('test-uuid-1', {
      jsonl_path: null,
    });

    const entry = registry.get('test-uuid-1');
    expect(entry?.jsonl_path).toBeNull();
  });

  it('upsert preserves non-overwritten fields', () => {
    registry.upsert('test-uuid-1', {
      origin: 'cli',
      cwd: '/Users/test/project',
      title: 'My Project',
      message_count: 10,
    });

    // Only update message_count
    registry.upsert('test-uuid-1', {
      message_count: 15,
    });

    const entry = registry.get('test-uuid-1');
    expect(entry?.title).toBe('My Project');
    expect(entry?.origin).toBe('cli');
    expect(entry?.cwd).toBe('/Users/test/project');
    expect(entry?.message_count).toBe(15);
  });

  it('merges concurrent writes from different managers without losing sessions', async () => {
    const registry1 = new RegistryManager(tmpDir);
    const registry2 = new RegistryManager(tmpDir);

    registry1.upsert('uuid-a', { title: 'Session A' });
    registry2.upsert('uuid-b', { title: 'Session B' });

    await Promise.all([registry1.flush(), registry2.flush()]);

    const finalRegistry = new RegistryManager(tmpDir);
    expect(finalRegistry.get('uuid-a')?.title).toBe('Session A');
    expect(finalRegistry.get('uuid-b')?.title).toBe('Session B');
  });

  it('merges concurrent field updates on the same session', async () => {
    registry.upsert('shared-uuid', {
      title: 'Original',
      cwd: '/Users/test/project',
    });
    await registry.flush();

    const registry1 = new RegistryManager(tmpDir);
    const registry2 = new RegistryManager(tmpDir);

    registry1.upsert('shared-uuid', { message_count: 10 });
    registry2.upsert('shared-uuid', { last_message_preview: 'Latest preview' });

    await Promise.all([registry1.flush(), registry2.flush()]);

    const finalRegistry = new RegistryManager(tmpDir);
    const entry = finalRegistry.get('shared-uuid');
    expect(entry?.title).toBe('Original');
    expect(entry?.message_count).toBe(10);
    expect(entry?.last_message_preview).toBe('Latest preview');
  });

  // PR 6 Task 6.7: listActive() 返回 status==='active' 的 sessions
  // 历史: list-refresh card action 需要刷新活跃 session 列表,
  //   旧实现 stub 只发 sendMessage 兜底, 实际不拉列表
  // 修法: RegistryManager 加 listActive() 方法, 基于 sessions map 过滤
  it('PR 6 Task 6.7: listActive 返回 status==="active" 的 sessions (过滤掉其他状态)', async () => {
    // 准备: 写 2 active + 1 archived + 1 provisioning
    registry.upsert('uuid-active-1', { title: 'Active 1', status: 'active' });
    registry.upsert('uuid-active-2', { title: 'Active 2', status: 'active' });
    registry.upsert('uuid-archived-1', { title: 'Archived 1', status: 'archived' });
    registry.upsert('uuid-provisioning-1', { title: 'Provisioning 1', status: 'provisioning' });

    // 验证 listActive 存在且返回 2 个 active
    const active = await registry.listActive();
    expect(active).toHaveLength(2);
    const activeIds = active.map(s => {
      // SessionEntry shape: origin/cwd/.../status
      const id = Object.entries(registry.sessions).find(([, v]) => v === s)?.[0];
      return id;
    });
    expect(activeIds).toContain('uuid-active-1');
    expect(activeIds).toContain('uuid-active-2');
  });

  it('PR 6 Task 6.7: listActive 包含默认 status (upsert 不传 status 时默认 active)', async () => {
    // upsert 不传 status → buildSessionEntry 给默认 'active' (registry.ts:439)
    registry.upsert('uuid-default-1', { title: 'Default 1' });
    registry.upsert('uuid-default-2', { title: 'Default 2' });

    const active = await registry.listActive();
    expect(active).toHaveLength(2);
  });

  it('PR 6 Task 6.7: listActive 在 sessions 为空时返回空数组', async () => {
    const active = await registry.listActive();
    expect(active).toEqual([]);
  });
});
