import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { Database } from 'bun:sqlite';

// e2e: 子进程跑 `bun run src/index.ts img-proxy cc-switch-settings`,
// env 注入 HOME/CC_LINKER_DIR 到 tmpDir (子进程加载 paths.ts 前注入, 绕过模块常量固化)。
// 不用 mock.module (会污染其他测试文件 - 见 activity.test.ts 警告)。

let tmpHome: string;
let ccSwitchDir: string;
let ccLinkerDir: string;
let autoProvidersDir: string;
let dbPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ccs-e2e-'));
  ccSwitchDir = join(tmpHome, '.cc-switch');
  ccLinkerDir = join(tmpHome, '.cc-linker');
  autoProvidersDir = join(ccLinkerDir, 'auto-providers');
  dbPath = join(ccSwitchDir, 'cc-switch.db');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function setupDb(providers: Array<{ id: string; name: string; is_current?: 0 | 1; settings_config?: object }>): void {
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
      [p.id, 'claude', p.name, JSON.stringify(p.settings_config ?? { env: { ANTHROPIC_BASE_URL: 'https://x.com' } }), p.is_current ?? 0, 0],
    );
  }
  db.close();
}

function writeCcSwitchSettings(currentProviderClaude: string): void {
  writeFileSync(join(ccSwitchDir, 'settings.json'), JSON.stringify({ currentProviderClaude }));
}

function writeAutoProvider(name: string, baseUrl: string): void {
  mkdirSync(autoProvidersDir, { recursive: true });
  writeFileSync(
    join(autoProvidersDir, `${name}.json`),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl }, name, alias: name }, null, 2),
  );
}

function runCli(): { stdout: string; stderr: string; exitCode: number } {
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    const out = execSync('bun run src/index.ts img-proxy cc-switch-settings', {
      cwd: process.cwd(),
      env: { ...process.env, HOME: tmpHome, CC_LINKER_DIR: ccLinkerDir },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = { stdout: out.trim(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    result = {
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
      exitCode: err.status ?? -1,
    };
  }
  return result;
}

describe('img-proxy cc-switch-settings (e2e)', () => {
  test('ok + proxy URL -> stdout=path, exit 0', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeCcSwitchSettings('id-1');
    writeAutoProvider('Byte-glm-agent', 'http://127.0.0.1:8765/Byte-glm-agent');
    const { stdout, stderr, exitCode } = runCli();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(join(autoProvidersDir, 'Byte-glm-agent.json'));
    expect(stderr).toBe('');
  });

  test('ok + 上游 URL (没 install) -> stderr 含 "未装代理", exit 2', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeCcSwitchSettings('id-1');
    writeAutoProvider('Byte-glm-agent', 'https://ark.cn-beijing.volces.com/api/plan');
    const { stdout, stderr, exitCode } = runCli();
    expect(exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('未装代理');
    expect(stderr).toContain('install');
  });

  test('no-ccswitch -> stderr 含 "未检测到 CC Switch", exit 2', () => {
    // 不建 cc-switch 目录
    const { stderr, exitCode } = runCli();
    expect(exitCode).toBe(2);
    expect(stderr).toContain('未检测到 CC Switch');
  });

  test('no-current -> stderr 含 "未选中", exit 2', () => {
    setupDb([{ id: 'id-1', name: 'X', is_current: 0 }]);
    writeCcSwitchSettings('');
    const { stderr, exitCode } = runCli();
    expect(exitCode).toBe(2);
    expect(stderr).toContain('未选中');
  });

  test('no-file -> stderr 含 "未同步", exit 2', () => {
    setupDb([{ id: 'id-1', name: 'Byte-glm-agent', is_current: 1 }]);
    writeCcSwitchSettings('id-1');
    // 不写 auto-providers 文件
    const { stderr, exitCode } = runCli();
    expect(exitCode).toBe(2);
    expect(stderr).toContain('未同步');
    expect(stderr).toContain('Byte-glm-agent');
  });
});