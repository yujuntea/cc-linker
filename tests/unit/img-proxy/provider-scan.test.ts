import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { _testHooks } from '../../../src/img-proxy/provider-scan';
import { scanProviderFiles, hasCcSwitch } from '../../../src/img-proxy/provider-scan';

describe('provider-scan with cc-switch', () => {
  let workDir: string;
  let manualDir: string;
  let autoDir: string;
  let ccDbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'img-proxy-scan-'));
    manualDir = join(workDir, 'manual');
    autoDir = join(workDir, 'auto');
    ccDbPath = join(workDir, 'cc-switch.db');
  });

  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  function seedCcSwitch(rows: Array<{ name: string; settings_config: object }>): void {
    const db = new Database(ccDbPath);
    try {
      db.exec(`CREATE TABLE providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        app_type TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        sort_index INTEGER NOT NULL DEFAULT 0
      )`);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        db.prepare(`INSERT INTO providers (name, app_type, settings_config, sort_index) VALUES (?, ?, ?, ?)`)
          .run(r.name, 'claude', JSON.stringify(r.settings_config), i);
      }
    } finally {
      db.close();
    }
  }

  function seedManual(alias: string, baseUrl: string): void {
    writeFileSync(join(manualDir, `${alias}.json`), JSON.stringify({
      model: 'opus',
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: 'glm-5.2[1m]' },
    }), { mode: 0o600 });
  }

  describe('hasCcSwitch', () => {
    it('returns false when db does not exist', () => {
      expect(hasCcSwitch(ccDbPath)).toBe(false);  // ccDbPath 不存在(未 seed)
    });

    it('returns true when db exists', () => {
      seedCcSwitch([{ name: 'a', settings_config: { env: { ANTHROPIC_BASE_URL: 'x' } } }]);
      expect(hasCcSwitch(ccDbPath)).toBe(true);
    });
  });

  describe('syncCcSwitchToAutoProviders (test hook)', () => {
    it('writes one JSON per claude provider to auto-providers dir', () => {
      seedCcSwitch([
        { name: 'byte', settings_config: { env: { ANTHROPIC_BASE_URL: 'https://ark.../api/plan' } } },
        { name: 'qwen', settings_config: { alias: 'qwen-custom', env: { ANTHROPIC_BASE_URL: 'https://qwen.../api' } } },
      ]);

      _testHooks.syncCcSwitchToAutoProviders(ccDbPath, autoDir);

      const files = readdirSync(autoDir);
      expect(files).toContain('byte.json');
      expect(files).toContain('qwen-custom.json');  // 用了 explicit alias
      expect(files.length).toBe(2);
    });

    it('skips non-claude app_type entries', () => {
      // 直接 mock 一个非 claude 的 entry,验证 app_type filter
      const db = new Database(ccDbPath);
      try {
        db.exec(`CREATE TABLE providers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          app_type TEXT NOT NULL,
          settings_config TEXT NOT NULL,
          sort_index INTEGER NOT NULL DEFAULT 0
        )`);
        db.prepare(`INSERT INTO providers (name, app_type, settings_config, sort_index) VALUES (?, ?, ?, ?)`)
          .run('codex', 'codex', JSON.stringify({ env: { OPENAI_BASE_URL: 'x' } }), 0);
        db.prepare(`INSERT INTO providers (name, app_type, settings_config, sort_index) VALUES (?, ?, ?, ?)`)
          .run('claude-only', 'claude', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'y' } }), 1);
      } finally {
        db.close();
      }

      _testHooks.syncCcSwitchToAutoProviders(ccDbPath, autoDir);

      const files = readdirSync(autoDir);
      expect(files).toEqual(['claude-only.json']);
    });

    it('handles alias collision with -2/-3 suffix', () => {
      seedCcSwitch([
        { name: 'dup', settings_config: { alias: 'same', env: { ANTHROPIC_BASE_URL: 'a' } } },
        { name: 'dup2', settings_config: { alias: 'same', env: { ANTHROPIC_BASE_URL: 'b' } } },
      ]);

      _testHooks.syncCcSwitchToAutoProviders(ccDbPath, autoDir);

      const files = readdirSync(autoDir).sort();
      expect(files).toEqual(['same-2.json', 'same.json']);
    });

    it('is idempotent: second call with same DB does not rewrite', async () => {
      seedCcSwitch([{ name: 'a', settings_config: { env: { ANTHROPIC_BASE_URL: 'x' } } }]);
      _testHooks.syncCcSwitchToAutoProviders(ccDbPath, autoDir);
      const firstMtime = (await import('fs')).statSync(join(autoDir, 'a.json')).mtimeMs;

      // 等几毫秒再调,确保 mtime 不会巧合相同
      // (注:bun 的 mtime 精度通常是 ms,理论上两次几乎同时调可能相同;
      //  我们的 mtime 检查是 dirStat >= dbStat,只要 auto 目录 mtime >= db 就不重写)
      await new Promise(r => setTimeout(r, 5));
      _testHooks.syncCcSwitchToAutoProviders(ccDbPath, autoDir);
      const secondMtime = (await import('fs')).statSync(join(autoDir, 'a.json')).mtimeMs;
      expect(secondMtime).toBe(firstMtime);  // 文件没被重写
    });

    it('silently skips corrupt DB', () => {
      // 写垃圾内容到 DB 路径
      writeFileSync(ccDbPath, 'not a sqlite db');
      // 不应 throw,也不应写任何 auto-providers 文件
      expect(() => _testHooks.syncCcSwitchToAutoProviders(ccDbPath, autoDir)).not.toThrow();
      expect(existsSync(autoDir)).toBe(false);
    });

    it('silently skips invalid individual records', () => {
      const db = new Database(ccDbPath);
      try {
        db.exec(`CREATE TABLE providers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          app_type TEXT NOT NULL,
          settings_config TEXT NOT NULL,
          sort_index INTEGER NOT NULL DEFAULT 0
        )`);
        db.prepare(`INSERT INTO providers (name, app_type, settings_config, sort_index) VALUES (?, ?, ?, ?)`)
          .run('bad', 'claude', 'not json{', 0);  // 损坏的 settings_config
        db.prepare(`INSERT INTO providers (name, app_type, settings_config, sort_index) VALUES (?, ?, ?, ?)`)
          .run('good', 'claude', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'x' } }), 1);
      } finally {
        db.close();
      }

      _testHooks.syncCcSwitchToAutoProviders(ccDbPath, autoDir);

      expect(readdirSync(autoDir)).toEqual(['good.json']);  // 跳过 bad,只留 good
    });
  });
});