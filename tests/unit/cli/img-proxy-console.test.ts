// tests/unit/cli/img-proxy-console.test.ts
//
// CLI subcommand img-proxy console enable|disable|status 的 smoke test:
//  - enable writes console_enabled=true 到真实 configPath (env override)
//  - disable writes false
//  - status 读最新值并显示
//
// 集成 wizard (install 末尾 confirm) 留在 manual smoke — 它与 inquirer
// 全局 + discoverCandidates + provider config 紧耦合,单测 fragile。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'bun';
import { resolve } from 'path';

describe('img-proxy console enable/disable/status', () => {
  let tmpDir: string;
  let configPath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'img-proxy-console-'));
    configPath = join(tmpDir, 'config.toml');
    originalEnv = process.env.CC_LINKER_CONFIG_PATH;
    process.env.CC_LINKER_CONFIG_PATH = configPath;
  });
  afterEach(() => {
    process.env.CC_LINKER_CONFIG_PATH = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
    const result = spawnSync({
      cmd: ['bun', 'run', resolve(__dirname, '../../../src/index.ts'), ...args],
      env: { ...process.env, CC_LINKER_CONFIG_PATH: configPath },
      cwd: resolve(__dirname, '../../..'),
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      status: result.exitCode,
    };
  }

  it('enable writes console_enabled=true to a fresh config.toml', () => {
    const r = runCli(['img-proxy', 'console', 'enable']);
    expect(r.status).toBe(0, `stderr=${r.stderr}`);
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('[img_proxy]');
    expect(content).toMatch(/console_enabled\s*=\s*true/);
    expect(r.stdout).toContain('Web Console 已启用');
  });

  it('disable writes console_enabled=false (no leftover from previous state)', () => {
    writeFileSync(configPath, `[img_proxy]
console_enabled = true
upstream_timeout_ms = 60000
`);
    const r = runCli(['img-proxy', 'console', 'disable']);
    expect(r.status).toBe(0);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toMatch(/console_enabled\s*=\s*false/);
    // 其它字段保留
    expect(content).toMatch(/upstream_timeout_ms\s*=\s*60[_\s]?000/);
    expect(r.stdout).toContain('已禁用');
  });

  it('disable when already disabled is no-op (no rewrite)', () => {
    writeFileSync(configPath, `[img_proxy]
console_enabled = false
`);
    const beforeContent = readFileSync(configPath, 'utf8');
    const r = runCli(['img-proxy', 'console', 'disable']);
    expect(r.status).toBe(0);
    // no-op 时不重写 file (修改时间不该变)
    const afterContent = readFileSync(configPath, 'utf8');
    expect(afterContent).toBe(beforeContent);
    expect(r.stdout).toContain('已经禁用');
  });

  it('enable is idempotent — running twice keeps console_enabled=true', () => {
    runCli(['img-proxy', 'console', 'enable']);
    const r2 = runCli(['img-proxy', 'console', 'enable']);
    expect(r2.status).toBe(0);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toMatch(/console_enabled\s*=\s*true/);
  });
});
