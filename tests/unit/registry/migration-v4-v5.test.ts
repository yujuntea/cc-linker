import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../../src/registry';
import type { SessionEntry } from '../../../src/registry';

describe('migrateV4toV5 (SessionEntry.platform)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'registry-v5-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRegistry(version: 4 | 5, sessions: Record<string, Partial<SessionEntry>> = {}): void {
    const data = {
      version,
      updated_at: new Date().toISOString(),
      sessions,
    };
    writeFileSync(join(tmpDir, 'registry.json'), JSON.stringify(data, null, 2));
  }

  function makeV4Entry(overrides: Partial<SessionEntry> = {}): Partial<SessionEntry> {
    return {
      origin: 'cli',
      cwd: '/tmp/proj',
      project_name: 'proj',
      jsonl_path: '/tmp/proj/.jsonl',
      project_dir: 'proj',
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Test',
      message_count: 5,
      last_message_preview: 'preview',
      ...overrides,
    };
  }

  it('migrates v4 entry without platform to v5 with default platform="feishu"', () => {
    // 飞书历史 v4 entry 没 platform 字段（PR 3 之前不存在）。
    // v4→v5 迁移必须给所有 v4 entry 补 platform='feishu'（向后兼容）。
    writeRegistry(4, {
      'session-1': makeV4Entry({ origin: 'feishu' }),
    });

    const manager = new RegistryManager(tmpDir);
    const entry = manager.sessions['session-1'];
    expect(entry.platform).toBe('feishu');
  });

  it('migrates multiple v4 entries (cli + feishu) all to platform="feishu"', () => {
    writeRegistry(4, {
      'cli-session': makeV4Entry({ origin: 'cli' }),
      'feishu-session': makeV4Entry({ origin: 'feishu', feishu_user_id: 'ou_abc' }),
    });

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions['cli-session'].platform).toBe('feishu');
    expect(manager.sessions['feishu-session'].platform).toBe('feishu');
  });

  it('migrateV4toV5 is idempotent (v4 → v5 → v5 yields same data)', () => {
    writeRegistry(4, {
      'session-1': makeV4Entry({ origin: 'feishu' }),
    });

    const first = new RegistryManager(tmpDir);
    const firstRaw = JSON.stringify(first.sessions['session-1']);

    const second = new RegistryManager(tmpDir);
    const secondRaw = JSON.stringify(second.sessions['session-1']);

    expect(secondRaw).toBe(firstRaw);
    expect(second.sessions['session-1'].platform).toBe('feishu');
  });

  it('preserves existing platform="wecom" without overwriting', () => {
    // 异常路径保护：万一磁盘上 v5 entry 已经写了 platform='wecom'，
    // migrateV4toV5 不应该盲改成 'feishu'。当前 spec 只在 v4→v5 转换时跑
    // 迁移，所以走的是 v4→v5 分支；但我们用 v4 输入 + 注入 platform='wecom'
    // 来验证迁移函数本身的健壮性：只补缺，不覆盖已有值。
    writeRegistry(4, {
      'wecom-session': {
        ...makeV4Entry({ origin: 'feishu' }),
        platform: 'wecom' as any,
      },
    });

    const manager = new RegistryManager(tmpDir);
    // 迁移后 platform 仍是 'wecom'（迁移不覆盖已有非空值）
    expect(manager.sessions['wecom-session'].platform).toBe('wecom');
  });

  it('createEmpty returns v5 registry when file missing', () => {
    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions).toEqual({});
    // Verify on-disk version is v5 after createEmpty
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(5);
  });

  it('load() persists the upgraded v5 file to disk', () => {
    // 模仿 v3→v4 持久化测试：构造 v4 输入 → load() 必须迁移 + 持久化 v5 到磁盘。
    writeRegistry(4, {
      'session-1': makeV4Entry({ origin: 'feishu' }),
    });

    new RegistryManager(tmpDir);

    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(5);
    expect(raw.sessions['session-1']).toBeDefined();
    expect(raw.sessions['session-1'].platform).toBe('feishu');
    expect(raw.sessions['session-1'].message_count).toBe(5);
    // Backup rotated
    expect(existsSync(join(tmpDir, 'backups'))).toBe(true);
  });

  it('reload() persists v4→v5 migration to disk', async () => {
    writeRegistry(4, {
      's1': makeV4Entry({ origin: 'feishu' }),
    });

    const m = new RegistryManager(tmpDir);
    expect(m.sessions['s1'].platform).toBe('feishu');

    // Sanity: on-disk is v5 (constructor persisted)
    let raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(5);

    // Manually rewrite v4 to simulate stale on-disk file
    writeRegistry(4, {
      's1': makeV4Entry({ origin: 'feishu' }),
    });
    raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);

    // Reload must migrate and persist v5
    await m.reload();

    raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(5);
    expect(raw.sessions['s1'].platform).toBe('feishu');
  });

  it('v3 input migrates through v3→v4→v5 chain (legacy data preserved)', () => {
    // 迁移链路：migrateV3toV4 跑完后 parsed.version=4，然后 migrateV4toV5 接手
    // 补 platform 字段 + bumped 到 v5。所以 v3 输入经过两步迁移完整保留。
    // 这比 v3→v4 测试中"v2 走 createEmpty"的优雅降级更好——v3 数据不丢。
    const v3 = {
      version: 3,
      updated_at: new Date().toISOString(),
      sessions: {
        'legacy-session': {
          origin: 'cli',
          cwd: '/tmp/legacy',
          project_name: null,
          jsonl_path: null,
          project_dir: null,
          created_at: '2025-01-01T00:00:00Z',
          last_active: '2025-01-02T00:00:00Z',
          title: 'Legacy',
          message_count: 10,
          last_message_preview: 'old preview',
        },
      },
    };
    writeFileSync(join(tmpDir, 'registry.json'), JSON.stringify(v3, null, 2));

    const manager = new RegistryManager(tmpDir);
    // v3 数据完整保留 + platform 字段被补 'feishu'
    const entry = manager.sessions['legacy-session'];
    expect(entry).toBeDefined();
    expect(entry.title).toBe('Legacy');
    expect(entry.message_count).toBe(10);
    expect(entry.platform).toBe('feishu');
    // on-disk 已升级到 v5
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(5);
    expect(raw.sessions['legacy-session'].platform).toBe('feishu');
  });

  it('recovers from corrupted v4 file via createEmpty (v5 empty)', () => {
    writeFileSync(join(tmpDir, 'registry.json'), '{ invalid json');

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions).toEqual({});
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(5);
  });

  it('v5 entry with platform="wecom" round-trips unchanged', () => {
    // 写入 v5 entry (带 platform='wecom') → load → 内存中 platform 仍为 'wecom'
    writeRegistry(5, {
      'wecom-1': makeV4Entry({ origin: 'feishu' }),
    });
    // Manually patch platform on disk (since writeRegistry defaults to origin-based fill,
    // we need to overwrite with wecom)
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    raw.sessions['wecom-1'].platform = 'wecom';
    writeFileSync(join(tmpDir, 'registry.json'), JSON.stringify(raw, null, 2));

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions['wecom-1'].platform).toBe('wecom');
  });

  it('migrateV4toV5 sets platform="feishu" for entries with all optional fields', () => {
    // v4 entry 缺所有 optional 字段 (pending_jsonl_resolve / last_error / etc.)
    // → migrateV4toV5 只补 platform，其他字段保持 undefined
    writeRegistry(4, {
      'opt-fields-session': makeV4Entry({ origin: 'feishu' }),
      // 故意不写 pending_jsonl_resolve / last_error / feishu_user_id / lastKnownProvider
    });

    const manager = new RegistryManager(tmpDir);
    const entry = manager.sessions['opt-fields-session'];
    expect(entry.platform).toBe('feishu');
    expect(entry.last_user_preview).toBeUndefined();
    expect(entry.last_assistant_preview).toBeUndefined();
    expect(entry.pending_jsonl_resolve).toBeUndefined();
    expect(entry.last_error).toBeUndefined();
    expect(entry.feishu_user_id).toBeUndefined();
    expect(entry.lastKnownProvider).toBeUndefined();
  });
});