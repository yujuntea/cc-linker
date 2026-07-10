// tests/unit/cli/img-proxy-console-library.test.ts
//
// 2026-07-10 回归:imgProxyConsoleEnable / imgProxyConsoleDisable /
// imgProxyCurrentUrl 改 library 化,throw 而不是 process.exit。
//
// 历史:sibling 函数 imgProxyStart / imgProxyDaemonInstall 修了后,这三处仍保留
// process.exit(1) — 同 launchd child 自杀 bug 的源模式(失败时把 wizard / 任何
// wrap 它的 caller 进程杀掉)。CLAUDE.md memory "review-audit-siblings" 已记录:
// 修一类 bug 后必 audit 兄弟函数,2026-07-10 review 找到这 3 处。
//
// 直接测:spy process.exit + 跑函数,验证任何路径都不调 process.exit(成功 / 失败
// 都要 throw 或 return,不能 exit)。
//
// 实现细节:用 spawnSync 跑 child bun 进程,因为 CONFIG_PATH + CLAUDE_SETTINGS_PATH
// 都是 module-load 早绑常量。子进程 import 从 src/cli/commands/img-proxy.ts 直接
// (src/index.ts 会跑 commander parseAsync,会触发 onAction,不能直接 import)。
//
// 判定:child stdout 里 JSON 的 exitCalled 字段:
// - null → library 没调 process.exit (good)
// - 数字 → library 调了 process.exit,bug 没修
// child 自身不在 success/throw 路径上 process.exit (否则 spy 抓不到 library 错误)。

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve as resolvePath } from 'path';
import { spawnSync } from 'bun';

const IMG_PROXY_MODULE = resolvePath(__dirname, '../../../src/cli/commands/img-proxy.ts');

function runChild(
  configPath: string,
  fakeHome: string | null,
  inner: 'enable' | 'disable' | 'current-url-success' | 'current-url-parse-fail',
): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CC_LINKER_CONFIG_PATH: configPath,
  };
  if (fakeHome) env.HOME = fakeHome;

  const childScript = `
import { spyOn } from 'bun:test';
let exitCalled = null;
const exitSpy = spyOn(process, 'exit').mockImplementation((code) => {
  exitCalled = code;
  throw new Error('process.exit was called — library should throw/return, not exit');
});
try {
  const mod = await import('${IMG_PROXY_MODULE}');
  const fn = ${inner.startsWith('current-url') ? 'mod.imgProxyCurrentUrl' : inner === 'enable' ? 'mod.imgProxyConsoleEnable' : 'mod.imgProxyConsoleDisable'};
  await fn();
  process.stdout.write(JSON.stringify({ exitCalled }) + '\\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ exitCalled, error: err.message }) + '\\n');
}
`;

  const tmpScript = join(tmpdir(), `ccl-console-lib-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(tmpScript, childScript);
  try {
    const result = spawnSync({
      cmd: ['bun', 'run', tmpScript],
      env,
      cwd: resolvePath(__dirname, '../../..'),
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      status: result.exitCode ?? -1,
    };
  } finally {
    rmSync(tmpScript, { force: true });
  }
}

function parseChildJson(stdout: string): { exitCalled: unknown; error?: string } {
  const lastJson = stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
  if (!lastJson) return { exitCalled: 'NO_JSON', error: 'no JSON in child stdout' };
  try {
    return JSON.parse(lastJson);
  } catch {
    return { exitCalled: 'PARSE_FAIL', error: 'failed to parse child JSON' };
  }
}

describe('imgProxyConsoleEnable/Disable/CurrentUrl library contract (no process.exit)', () => {
  describe('imgProxyConsoleEnable', () => {
    it('never calls process.exit on success path (fresh config)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'img-proxy-console-lib-'));
      try {
        const configPath = join(tmpDir, 'config.toml');
        const r = runChild(configPath, null, 'enable');
        const json = parseChildJson(r.stdout);
        if (json.exitCalled !== null) console.log('CHILD STDOUT:', r.stdout, '\nCHILD STDERR:', r.stderr);
        // 核心断言:library 没调 process.exit
        expect(json.exitCalled).toBe(null);
        expect(json.error).toBeUndefined();
        expect(existsSync(configPath)).toBe(true);
        expect(readFileSync(configPath, 'utf8')).toMatch(/console_enabled\s*=\s*true/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws (does not exit) when setConsoleEnabled fails (read-only parent dir)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'img-proxy-console-lib-'));
      try {
        const configPath = join(tmpDir, 'config.toml');
        writeFileSync(configPath, '');
        // 让 tmpDir 只读 → setConsoleEnabled 的 writeFileSync(config.toml.tmp) 失败
        chmodSync(tmpDir, 0o500);
        try {
          const r = runChild(configPath, null, 'enable');
          const json = parseChildJson(r.stdout);
          if (json.exitCalled !== null) console.log('CHILD STDOUT:', r.stdout, '\nCHILD STDERR:', r.stderr);
          // library throw → child catch 接到 → exitCalled 仍 null (没调 process.exit)
          // 同时 json.error 应有内容(throw 的 message)
          expect(json.exitCalled).toBe(null);
          expect(json.error).toBeDefined();
        } finally {
          chmodSync(tmpDir, 0o700);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('imgProxyConsoleDisable', () => {
    it('never calls process.exit on success path (was enabled)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'img-proxy-console-lib-'));
      try {
        const configPath = join(tmpDir, 'config.toml');
        writeFileSync(configPath, `[img_proxy]\nconsole_enabled = true\n`);
        const r = runChild(configPath, null, 'disable');
        const json = parseChildJson(r.stdout);
        if (json.exitCalled !== null) console.error('CHILD FAIL:', { stdout: r.stdout, stderr: r.stderr });
        expect(json.exitCalled).toBe(null);
        expect(readFileSync(configPath, 'utf8')).toMatch(/console_enabled\s*=\s*false/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('never calls process.exit on no-op (already disabled)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'img-proxy-console-lib-'));
      try {
        const configPath = join(tmpDir, 'config.toml');
        writeFileSync(configPath, `[img_proxy]\nconsole_enabled = false\n`);
        const r = runChild(configPath, null, 'disable');
        const json = parseChildJson(r.stdout);
        if (json.exitCalled !== null) console.error('CHILD FAIL:', { stdout: r.stdout, stderr: r.stderr });
        expect(json.exitCalled).toBe(null);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('imgProxyCurrentUrl', () => {
    // CLAUDE_SETTINGS_PATH = join(HOME, '.claude', 'settings.json') — 用 fake HOME 注入
    it('throws (does not exit) when settings.json parse fails', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'img-proxy-console-lib-'));
      try {
        const configPath = join(tmpDir, 'config.toml');
        const fakeHome = join(tmpDir, 'fakehome');
        mkdirSync(join(fakeHome, '.claude'), { recursive: true });
        writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{ invalid json :::');
        const r = runChild(configPath, fakeHome, 'current-url-parse-fail');
        const json = parseChildJson(r.stdout);
        if (json.exitCalled !== null) console.error('CHILD FAIL:', { stdout: r.stdout, stderr: r.stderr });
        expect(json.exitCalled).toBe(null);
        expect(json.error).toContain('settings.json');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('never calls process.exit on success path (URL found)', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'img-proxy-console-lib-'));
      try {
        const configPath = join(tmpDir, 'config.toml');
        const fakeHome = join(tmpDir, 'fakehome');
        mkdirSync(join(fakeHome, '.claude'), { recursive: true });
        writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify({
          env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/byte-agent-glm' },
        }));
        const r = runChild(configPath, fakeHome, 'current-url-success');
        const json = parseChildJson(r.stdout);
        if (json.exitCalled !== null) console.error('CHILD FAIL:', { stdout: r.stdout, stderr: r.stderr });
        expect(json.exitCalled).toBe(null);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});