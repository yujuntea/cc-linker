import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { getCurrentCcSwitchProvider, getCcSwitchProviderConfigByName } from '../../../src/img-proxy/cc-switch-current';

let tmpHome: string;
let ccSwitchDir: string;
let autoProvidersDir: string;
let dbPath: string;
let ccSwitchSettingsPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ccs-current-'));
  ccSwitchDir = join(tmpHome, '.cc-switch');
  autoProvidersDir = join(tmpHome, '.cc-linker', 'auto-providers');
  dbPath = join(ccSwitchDir, 'cc-switch.db');
  ccSwitchSettingsPath = join(ccSwitchDir, 'settings.json');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** 建 cc-switch.db，插入一个 provider 行。返回插入的 id。 */
function setupDb(providers: Array<{ id: string; name: string; app_type?: string; is_current?: 0 | 1; settings_config?: object }>): void {
  mkdirSync(ccSwitchDir, { recursive: true });
  const db = new Database(dbPath);
  db.run(`CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0,
    sort_index INTEGER, PRIMARY KEY (id, app_type)
  )`);
  for (const p of providers) {
    db.run(
      `INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [p.id, p.app_type ?? 'claude', p.name, JSON.stringify(p.settings_config ?? { env: { ANTHROPIC_BASE_URL: 'https://x.com' } }), p.is_current ?? 0, 0],
    );
  }
  db.close();
}

function writeAutoProvider(name: string, baseUrl: string): void {
  mkdirSync(autoProvidersDir, { recursive: true });
  writeFileSync(
    join(autoProvidersDir, `${name}.json`),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl }, name, alias: name }, null, 2),
  );
}

describe('getCurrentCcSwitchProvider', () => {
  test('ok: currentProviderClaude id -> name -> auto-providers 文件 -> status ok', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'id-1' }));
    writeAutoProvider('Byte-glm-agent', 'http://127.0.0.1:8765/Byte-glm-agent');
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.provider.name).toBe('Byte-glm-agent');
      expect(result.provider.settingsFile).toBe(join(autoProvidersDir, 'Byte-glm-agent.json'));
      expect(result.provider.baseUrl).toBe('http://127.0.0.1:8765/Byte-glm-agent');
    }
  });

  test('no-ccswitch: ~/.cc-switch/ 不存在', () => {
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-ccswitch' });
  });

  test('no-current: currentProviderClaude 空且无 is_current=1', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 0 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: '' }));
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-current' });
  });

  test('no-current: currentProviderClaude 空 + 无 settings.json -> fallback is_current=1 命中', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 1 }]);
    // 无 cc-switch/settings.json
    writeAutoProvider('X', 'http://127.0.0.1:8765/X');
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result.status).toBe('ok');
  });

  test('no-current: id 在 db 找不到', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 1 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'nonexistent-id' }));
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-current' });
  });

  test('no-file: auto-providers/<name>.json 不存在', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'id-1' }));
    // 不写 auto-providers 文件
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-file', name: 'Byte-glm-agent' });
  });

  test('no-current: db 损坏(非 sqlite 文件)统一归并', () => {
    mkdirSync(ccSwitchDir, { recursive: true });
    writeFileSync(dbPath, 'not a sqlite file');
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'id-1' }));
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result).toEqual({ status: 'no-current' });
  });

  test('name 带空格 "Kimi For Coding" -> 正确拼路径', () => {
    setupDb([{ id: 'id-1', name: 'Kimi For Coding', is_current: 1 }]);
    writeFileSync(ccSwitchSettingsPath, JSON.stringify({ currentProviderClaude: 'id-1' }));
    writeAutoProvider('Kimi For Coding', 'http://127.0.0.1:8765/Kimi For Coding');
    const result = getCurrentCcSwitchProvider(ccSwitchDir, autoProvidersDir);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.provider.settingsFile).toBe(join(autoProvidersDir, 'Kimi For Coding.json'));
    }
  });
});

describe('getCcSwitchProviderConfigByName', () => {
  test('name 存在 -> 返回 settingsConfig', () => {
    const cfg = { env: { ANTHROPIC_BASE_URL: 'https://ark.com', ANTHROPIC_AUTH_TOKEN: 'new-token' } };
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1, settings_config: cfg }]);
    const result = getCcSwitchProviderConfigByName('Byte-glm-agent', ccSwitchDir);
    expect(result).not.toBeNull();
    expect(result!.settingsConfig).toEqual(cfg);
  });

  test('name 不存在 -> 返回 null', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 1 }]);
    const result = getCcSwitchProviderConfigByName('Nonexistent', ccSwitchDir);
    expect(result).toBeNull();
  });

  test('无 cc-switch -> 返回 null', () => {
    const result = getCcSwitchProviderConfigByName('X', ccSwitchDir);
    expect(result).toBeNull();
  });

  test('name 带空格 -> 正确查询', () => {
    const cfg = { env: { ANTHROPIC_BASE_URL: 'https://kimi.com' } };
    setupDb([{ id: 'id-1', name: 'Kimi For Coding', is_current: 1, settings_config: cfg }]);
    const result = getCcSwitchProviderConfigByName('Kimi For Coding', ccSwitchDir);
    expect(result).not.toBeNull();
    expect(result!.settingsConfig).toEqual(cfg);
  });
});