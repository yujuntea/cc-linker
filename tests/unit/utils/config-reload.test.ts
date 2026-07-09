import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('config.reload()', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cfg-reload-'));
    configPath = join(tmpDir, 'config.toml');
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('reload 后 img_proxy section 更新', async () => {
    writeFileSync(configPath, `
[img_proxy]
console_enabled = true
upstream_timeout_ms = 60000
`);
    const { ConfigManager } = await import('../../../src/utils/config');
    const cfg = new ConfigManager(configPath);
    // Constructor 读取并 merge 文件,所以 console_enabled 已经是 true
    expect(cfg.get('img_proxy.console_enabled')).toBe(true);
    cfg.reload();
    // reload 之后仍然 true(同文件内容)
    expect(cfg.get('img_proxy.console_enabled')).toBe(true);
    expect(cfg.get('img_proxy.upstream_timeout_ms')).toBe(60000);
  });

  it('reload 用 DEFAULTS 作底：用户删字段后 reset', async () => {
    writeFileSync(configPath, `
[img_proxy]
console_enabled = true
`);
    const { ConfigManager } = await import('../../../src/utils/config');
    const cfg = new ConfigManager(configPath);
    cfg.reload();
    expect(cfg.get('img_proxy.console_enabled')).toBe(true);

    // 改文件:删 console_enabled,加 upstream_timeout_ms
    writeFileSync(configPath, `
[img_proxy]
upstream_timeout_ms = 30000
`);
    cfg.reload();
    expect(cfg.get('img_proxy.console_enabled')).toBe(false); // 删了 → DEFAULTS
    expect(cfg.get('img_proxy.upstream_timeout_ms')).toBe(30000);
  });

  it('reload 不重置其他 section（如 feishu_bot）', async () => {
    writeFileSync(configPath, `
[img_proxy]
console_enabled = true

[feishu_bot]
app_id = "test-app-id"
`);
    const { ConfigManager } = await import('../../../src/utils/config');
    const cfg = new ConfigManager(configPath);
    expect(cfg.get('feishu_bot.app_id')).toBe('test-app-id');
    cfg.reload();
    expect(cfg.get('feishu_bot.app_id')).toBe('test-app-id'); // 不变
    expect(cfg.get('img_proxy.console_enabled')).toBe(true); // 改了
  });
});
