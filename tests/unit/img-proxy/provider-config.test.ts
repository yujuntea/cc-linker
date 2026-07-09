import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installProvider, uninstallProvider, isProviderInstalled } from '../../../src/img-proxy/provider-config';
import { loadRoutes } from '../../../src/img-proxy/routes';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeProviderFile(dir: string, alias: string, baseUrl: string): string {
  const path = join(dir, `${alias}.json`);
  writeFileSync(path, JSON.stringify({
    model: 'opus',
    env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'sk-secret', ANTHROPIC_MODEL: 'glm-5.2[1m]' },
  }, null, 2), { mode: 0o600 });
  return path;
}

describe('provider-config', () => {
  let workDir: string, routesPath: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'img-proxy-prov-')); routesPath = join(workDir, 'routes.json'); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('install rewrites BASE_URL to 127.0.0.1/<alias>, keeps token and other fields', async () => {
    const p = makeProviderFile(workDir, 'byte-agent-glm', 'https://ark.cn-beijing.volces.com/api/plan');
    await installProvider({ providerPath: p, alias: 'byte-agent-glm', routesPath, port: 8765, hostname: '127.0.0.1' });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/byte-agent-glm');
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret');
    expect(after.env.ANTHROPIC_MODEL).toBe('glm-5.2[1m]');
    expect(after.model).toBe('opus');
  });

  it('install writes .bak with original content', async () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const bak = JSON.parse(readFileSync(p + '.bak', 'utf8'));
    expect(bak.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('install registers route', async () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const r = loadRoutes(routesPath).routes['glm-5.2'];
    expect(r).toBeDefined();
    expect(r!.upstream).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(r!.provider_path).toBe(p);
  });

  it('install is idempotent: second install does NOT overwrite .bak', async () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // 改 token 后再 install(幂等分支)
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_AUTH_TOKEN = 'sk-rotated';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const bak = JSON.parse(readFileSync(p + '.bak', 'utf8'));
    expect(bak.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret');  // 原始备份未被覆盖
    // 当前文件的 token 保留(幂等分支不写文件)
    expect(JSON.parse(readFileSync(p, 'utf8')).env.ANTHROPIC_AUTH_TOKEN).toBe('sk-rotated');
  });

  it('isProviderInstalled detects installed state', async () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    expect(isProviderInstalled(p, 8765, '127.0.0.1')).toBe(false);
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    expect(isProviderInstalled(p, 8765, '127.0.0.1')).toBe(true);
  });

  it('uninstall restores BASE_URL, keeps current token, removes route, deletes .bak', async () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // install 后用户轮换 token
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_AUTH_TOKEN = 'sk-rotated';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    await uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');  // 从 .bak 还原
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-rotated');  // 当前 token 保留
    expect(loadRoutes(routesPath).routes['glm-5.2']).toBeUndefined();
    expect(existsSync(p + '.bak')).toBe(false);  // .bak 删除
  });

  it('uninstall when user manually edited BASE_URL (not proxy URL): preserve edit, clean route+bak', async () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // 用户手动把 BASE_URL 改到别处(模拟用户做迁移)
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_BASE_URL = 'https://other-host.example/glm-5.2/api';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    await uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://other-host.example/glm-5.2/api');  // 保留用户手动编辑
    expect(loadRoutes(routesPath).routes['glm-5.2']).toBeUndefined();  // 清路由
    expect(existsSync(p + '.bak')).toBe(false);  // 清 .bak
  });

  it('uninstall on never-installed provider is a no-op', async () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    expect(JSON.parse(readFileSync(p, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(existsSync(p + '.bak')).toBe(false);
  });

  it('install idempotent branch throws if .bak missing (prevents self-referential upstream)', async () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    rmSync(p + '.bak');  // 模拟 .bak 丢失
    await expect(installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' }))
      .rejects.toThrow(/\.bak 丢失/);
  });

  it('install idempotent across port rotation: re-install with new port preserves routes upstream (no self-loop)', async () => {
    // Fix #2 场景:装了 8765 后用户改 config 到 8766 再 install,不能让 routes 的 upstream
    // 变成旧的 proxy URL 自己。
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // 此时 BASE_URL = http://127.0.0.1:8765/glm-5.2, routes upstream = https://open.bigmodel.cn/api/anthropic, .bak 保留原 upstream
    const beforeRoutes = loadRoutes(routesPath).routes['glm-5.2']!;
    expect(beforeRoutes.upstream).toBe('https://open.bigmodel.cn/api/anthropic');
    // 改 port, 重新 install
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8766, hostname: '127.0.0.1' });
    // BASE_URL 应更新到新端口
    expect(JSON.parse(readFileSync(p, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8766/glm-5.2');
    // routes 的 upstream 仍是真实上游,不是旧 proxy URL
    const afterRoutes = loadRoutes(routesPath).routes['glm-5.2']!;
    expect(afterRoutes.upstream).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(afterRoutes.upstream).not.toContain('127.0.0.1:8765');  // 不应是旧 proxy URL
    expect(afterRoutes.upstream).not.toContain('127.0.0.1:8766');  // 不应是新 proxy URL
    // .bak 没被覆盖
    const bak = JSON.parse(readFileSync(p + '.bak', 'utf8'));
    expect(bak.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('uninstall after port rotation (current BASE_URL is old proxy URL): restores from .bak to clean state', async () => {
    // Fix #1+#2 交叉场景:port 改过,用户没 re-install,直接 uninstall。
    // 此时 currentUrl 是旧的 proxy URL(`http://127.0.0.1:8765/glm-5.2`),
    // 仍匹配 isAnyProxyUrl → 走还原分支,把 BASE_URL 改回真实上游。
    // (用户主动 uninstall 的预期是"干净退出代理",不是保留 stale 状态。)
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    await installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // 模拟 port 改动后 uninstall
    await uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8766, hostname: '127.0.0.1' });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');  // 从 .bak 还原
    expect(loadRoutes(routesPath).routes['glm-5.2']).toBeUndefined();
    expect(existsSync(p + '.bak')).toBe(false);
  });
});
