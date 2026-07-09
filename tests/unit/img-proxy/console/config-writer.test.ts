// tests/unit/img-proxy/console/config-writer.test.ts
//
// setConsoleEnabled 是 CLI + console API 共用的 atomic write 路径,
// 单元测试覆盖 array/string guard + reload + 双调用幂等等核心行为。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setConsoleEnabled } from '../../../../src/img-proxy/console/config-writer';
import { config } from '../../../../src/utils/config';

describe('config-writer.setConsoleEnabled', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cfg-writer-'));
    configPath = join(tmpDir, 'config.toml');
    // reset any prior overrides (test isolation)
    const overrides = Array.from((config as any).runtimeOverrides.keys()) as string[];
    for (const k of overrides) {
      (config as any).runtimeOverrides.delete(k);
    }
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('writes console_enabled=true to a fresh config.toml', () => {
    const result = setConsoleEnabled(configPath, true);
    expect(result.previous).toBe(false);
    expect(result.applied).toBe(true);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('[img_proxy]');
    expect(content).toContain('console_enabled = true');
  });

  it('updates console_enabled from false to true without losing other sections', () => {
    writeFileSync(configPath, `[img_proxy]
console_enabled = false
upstream_timeout_ms = 60000
[feishu_bot]
app_id = "test"
`);
    const result = setConsoleEnabled(configPath, true);
    expect(result.previous).toBe(false);
    expect(result.applied).toBe(true);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('console_enabled = true');
    // 其它 field 应该保留 — @iarna/toml 可能用 60_000 digit separator (我们写 60000)。
    expect(content).toMatch(/upstream_timeout_ms\s*=\s*60[_\s]?000/);
    expect(content).toContain('[feishu_bot]');
    expect(content).toContain('app_id = "test"');
  });

  it('toggles console_enabled true→false→true idempotent w.r.t. final state', () => {
    setConsoleEnabled(configPath, true);
    let { previous, applied } = setConsoleEnabled(configPath, false);
    expect(previous).toBe(true);
    expect(applied).toBe(false);
    const result = setConsoleEnabled(configPath, true);
    expect(result.previous).toBe(false);  // 上一步是 false
    expect(result.applied).toBe(true);
  });

  it('does NOT corrupt TOML when img_proxy is an array (review bug fix #6)', () => {
    // 用户手改 config.toml 写成 array — 之前会 spread 出 garbage 覆盖,
    // 现在 guard 把它当作缺,fallback 到 DEFAULTS.img_proxy。
    writeFileSync(configPath, `img_proxy = ["a", "b", "c"]
[feishu_bot]
app_id = "test"
`);
    setConsoleEnabled(configPath, true);
    const content = readFileSync(configPath, 'utf8');
    // 应该写成合法的 object section
    expect(content).toContain('[img_proxy]');
    expect(content).toMatch(/console_enabled\s*=\s*true/);
    // 原本的 array 被替换成合法 object — 'feishu_bot' section 应该保留
    expect(content).toContain('app_id');
    // 但写完后 0="a" 这种 garbage 不应该出现
    expect(content).not.toMatch(/^[01]\s*=/m);
  });

  it('does NOT corrupt TOML when img_proxy is a string', () => {
    writeFileSync(configPath, `img_proxy = "broken"
`);
    setConsoleEnabled(configPath, true);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('[img_proxy]');
    expect(content).toMatch(/console_enabled\s*=\s*true/);
  });

  it('treats nonexistent configPath as empty (creates from defaults)', () => {
    // 不存在 → 写入空白 config + 仅 [img_proxy]console_enabled=true。
    // 这是 CLI 第一次 enable / 用户从未跑过 cc-linker setup 的常见场景。
    const result = setConsoleEnabled(configPath, true);
    expect(result.applied).toBe(true);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('[img_proxy]');
    expect(content).toContain('console_enabled = true');
  });
});
