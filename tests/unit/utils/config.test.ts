import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '../../../src/utils/config';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ConfigManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cc-linker-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads default config when no file exists', () => {
    const config = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(config.get('feishu_bot.app_id', '')).toBe('');
  });

  it('loads config from TOML file', () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, '[feishu_bot]\napp_id = "test_app_id"');

    const config = new ConfigManager(configPath);
    expect(config.get('feishu_bot.app_id', '')).toBe('test_app_id');
  });

  it('returns fallback for missing keys', () => {
    const config = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(config.get('nonexistent.key', 'fallback')).toBe('fallback');
  });

  it('loads registry path from config file', () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, '[general]\nregistry_path = "/tmp/custom-registry.json"');

    const config = new ConfigManager(configPath);
    expect(config.get('general.registry_path', '')).toBe('/tmp/custom-registry.json');
  });

  it('does not leak nested config mutations between instances', () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, '[feishu_bot]\napp_id = "test_app_id"');

    const customized = new ConfigManager(configPath);
    expect(customized.get('feishu_bot.app_id', '')).toBe('test_app_id');

    const fresh = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(fresh.get('feishu_bot.app_id', '')).toBe('');
  });
});

describe('ConfigManager.setRuntimeOverride', () => {
  test('覆盖值优先于配置文件', () => {
    const cm = new ConfigManager();
    expect(cm.get('runtime.activity_cache_ttl_ms', 999)).toBe(10_000);  // 默认
    cm.setRuntimeOverride('runtime.activity_cache_ttl_ms', 5_000);
    expect(cm.get('runtime.activity_cache_ttl_ms', 999)).toBe(5_000);
  });

  test('boolean 覆盖可被 get 读取', () => {
    const cm = new ConfigManager();
    cm.setRuntimeOverride('runtime.cli_process_detection_enabled', false);
    // 不应抛错，内存覆盖成功
    expect(cm.get('runtime.cli_process_detection_enabled', true)).toBe(false);
  });
});
