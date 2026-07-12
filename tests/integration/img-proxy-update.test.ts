import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { Database } from 'bun:sqlite';

// e2e: 子进程跑 `bun run src/index.ts img-proxy update --all --yes --mode dumb`,
// env 注入 HOME/CC_LINKER_DIR 到 tmpDir。构造假 cc-switch.db + auto-providers 文件。
// --all --yes --mode dumb 绕过 inquirer (见 imgProxyInstall 的 targets 选择逻辑)。

let tmpHome: string;
let ccSwitchDir: string;
let ccLinkerDir: string;
let autoProvidersDir: string;
let routesPath: string;
let dbPath: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'update-e2e-'));
  ccSwitchDir = join(tmpHome, '.cc-switch');
  ccLinkerDir = join(tmpHome, '.cc-linker');
  autoProvidersDir = join(ccLinkerDir, 'auto-providers');
  routesPath = join(ccLinkerDir, 'img-proxy', 'routes.json');
  dbPath = join(ccSwitchDir, 'cc-switch.db');
  // addRoute 通过 proper-lockfile 需要 img-proxy/ 目录存在 (写 .routes.lock sentinel)。
  // 预先建好避免依赖 proper-lockfile 的隐式 dir 创建 (时序敏感, 不可靠)。
  mkdirSync(join(ccLinkerDir, 'img-proxy'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function setupDb(providers: Array<{ id: string; name: string; settings_config: object }>): void {
  mkdirSync(ccSwitchDir, { recursive: true });
  const db = new Database(dbPath);
  db.run(`CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, is_current BOOLEAN NOT NULL DEFAULT 0,
    sort_index INTEGER, PRIMARY KEY (id, app_type)
  )`);
  providers.forEach((p, i) => {
    db.run(
      `INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [p.id, 'claude', p.name, JSON.stringify(p.settings_config), 0, i],
    );
  });
  db.close();
}

/** 写 auto-providers 文件。baseUrl='proxy' 表示已装, 'upstream' 表示未装。 */
function writeAutoProvider(name: string, baseUrl: string): void {
  mkdirSync(autoProvidersDir, { recursive: true });
  writeFileSync(
    join(autoProvidersDir, `${name}.json`),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl }, name, alias: name }, null, 2),
  );
}

function runUpdate(): { stdout: string; exitCode: number } {
  try {
    const out = execSync('bun run src/index.ts img-proxy update --all --yes --mode dumb', {
      cwd: process.cwd(),
      env: { ...process.env, HOME: tmpHome, CC_LINKER_DIR: ccLinkerDir },
      encoding: 'utf-8',
    });
    return { stdout: out, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', exitCode: err.status ?? -1 };
  }
}

describe('img-proxy update (e2e)', () => {
  test('未装 auto provider + cc-switch 有配置 -> 新装 (BASE_URL 改成 proxy)', () => {
    setupDb([{ id: 'id-1', name: 'X', settings_config: { env: { ANTHROPIC_BASE_URL: 'https://x.com' } } }]);
    writeAutoProvider('X', 'https://x.com');  // 未装 (上游 URL)

    const { stdout, exitCode } = runUpdate();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('新装');

    // 验证 auto-providers 文件 BASE_URL 改成 proxy
    const updated = JSON.parse(readFileSync(join(autoProvidersDir, 'X.json'), 'utf8'));
    expect(updated.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/X');
  });

  test('已装 auto provider + cc-switch 改了 token -> 刷新 token, BASE_URL 保持 proxy', () => {
    setupDb([{ id: 'id-1', name: 'X', settings_config: { env: { ANTHROPIC_BASE_URL: 'https://x.com', ANTHROPIC_AUTH_TOKEN: 'new-token' } } }]);
    writeAutoProvider('X', 'http://127.0.0.1:8765/X');  // 已装 (proxy URL)
    // 备份 .bak (install 时会建, 这里手动建模拟)
    writeFileSync(join(autoProvidersDir, 'X.json.bak'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://x.com' } }));

    const { stdout, exitCode } = runUpdate();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('已刷新');

    const updated = JSON.parse(readFileSync(join(autoProvidersDir, 'X.json'), 'utf8'));
    expect(updated.env.ANTHROPIC_AUTH_TOKEN).toBe('new-token');
    expect(updated.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/X');
  });

  // P1 fix 验证: 真实删除路径 (db mtime 最新 -> sync cleanup 预删 .json)
  // -> update 循环看不到 X -> orphan-route 扫描触发 uninstall 提示。
  // 构造顺序: 先写 X.json/Y.json/routes.json, 最后 setupDb([Y]) 让 db mtime 最新.
  test('cc-switch 已删 (真实路径) -> sync 预删 .json, orphan-route 扫描触发 uninstall 提示', () => {
    // 模拟两个已装的 provider: X 和 Y
    writeAutoProvider('X', 'http://127.0.0.1:8765/X');
    writeAutoProvider('Y', 'http://127.0.0.1:8765/Y');
    writeFileSync(join(autoProvidersDir, 'X.json.bak'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://x-original.com' } }));
    writeFileSync(join(autoProvidersDir, 'Y.json.bak'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://y-original.com' } }));
    // routes.json 同时记录 X 和 Y (X 是 orphan, Y 正常)
    writeFileSync(routesPath, JSON.stringify({
      version: 1,
      routes: {
        'X': { alias: 'X', upstream: 'https://x-original.com', provider_path: join(autoProvidersDir, 'X.json'), original_base_url: 'https://x-original.com', installed_at: '2026-01-01T00:00:00.000Z' },
        'Y': { alias: 'Y', upstream: 'https://y-original.com', provider_path: join(autoProvidersDir, 'Y.json'), original_base_url: 'https://y-original.com', installed_at: '2026-01-01T00:00:00.000Z' },
      },
    }));
    // db 最后建: 只有 Y (X 已被 cc-switch 删除) — db mtime 最新 -> sync cleanup 运行
    setupDb([{ id: 'id-y', name: 'Y', settings_config: { env: { ANTHROPIC_BASE_URL: 'https://y.com', ANTHROPIC_AUTH_TOKEN: 'y-new-token' } } }]);

    const { stdout, exitCode } = runUpdate();
    expect(exitCode).toBe(0);

    // sync cleanup 已删 X.json (X 不在 db)
    expect(existsSync(join(autoProvidersDir, 'X.json'))).toBe(false);
    // X.json.bak 保留 (sync 只清 .json, 不动 .bak)
    expect(existsSync(join(autoProvidersDir, 'X.json.bak'))).toBe(true);

    // P1: orphan-route 扫描对 X 触发警告
    expect(stdout).toContain('uninstall --providers X');
    expect(stdout).toContain('已删');  // "provider 文件已删 (cc-switch 移除?)"
    expect(stdout).toContain('孤立 route');  // 完成行 "1 孤立 route"

    // Y 被刷新 (token 更新, BASE_URL 保持 proxy)
    expect(stdout).toContain('Y');
    expect(stdout).toContain('已刷新');
    const updatedY = JSON.parse(readFileSync(join(autoProvidersDir, 'Y.json'), 'utf8'));
    expect(updatedY.env.ANTHROPIC_AUTH_TOKEN).toBe('y-new-token');
    expect(updatedY.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/Y');

    // X.json.bak 是孤儿 (sync 不清 .bak); routes.json 里 X route 还在 (orphan 扫描建议 uninstall 清)
  });
});