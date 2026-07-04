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

  it('install rewrites BASE_URL to 127.0.0.1/<alias>, keeps token and other fields', () => {
    const p = makeProviderFile(workDir, 'byte-agent-glm', 'https://ark.cn-beijing.volces.com/api/plan');
    installProvider({ providerPath: p, alias: 'byte-agent-glm', routesPath, port: 8765, hostname: '127.0.0.1' });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765/byte-agent-glm');
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret');
    expect(after.env.ANTHROPIC_MODEL).toBe('glm-5.2[1m]');
    expect(after.model).toBe('opus');
  });

  it('install writes .bak with original content', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const bak = JSON.parse(readFileSync(p + '.bak', 'utf8'));
    expect(bak.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('install registers route', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const r = loadRoutes(routesPath).routes['glm-5.2'];
    expect(r).toBeDefined();
    expect(r!.upstream).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(r!.provider_path).toBe(p);
  });

  it('install is idempotent: second install does NOT overwrite .bak', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // 改 token 后再 install(幂等分支)
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_AUTH_TOKEN = 'sk-rotated';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    const bak = JSON.parse(readFileSync(p + '.bak', 'utf8'));
    expect(bak.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret');  // 原始备份未被覆盖
    // 当前文件的 token 保留(幂等分支不写文件)
    expect(JSON.parse(readFileSync(p, 'utf8')).env.ANTHROPIC_AUTH_TOKEN).toBe('sk-rotated');
  });

  it('isProviderInstalled detects installed state', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    expect(isProviderInstalled(p, 8765, '127.0.0.1')).toBe(false);
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    expect(isProviderInstalled(p, 8765, '127.0.0.1')).toBe(true);
  });

  it('uninstall restores BASE_URL, keeps current token, removes route, deletes .bak', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // install 后用户轮换 token
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_AUTH_TOKEN = 'sk-rotated';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');  // 从 .bak 还原
    expect(after.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-rotated');  // 当前 token 保留
    expect(loadRoutes(routesPath).routes['glm-5.2']).toBeUndefined();
    expect(existsSync(p + '.bak')).toBe(false);  // .bak 删除
  });

  it('uninstall when BASE_URL already upstream (looksProxied=false) cleans route+bak, leaves file', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    // 用户手动把 BASE_URL 改回上游
    const cur = JSON.parse(readFileSync(p, 'utf8'));
    cur.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
    writeFileSync(p, JSON.stringify(cur, null, 2), { mode: 0o600 });
    uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath });
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');  // 不动
    expect(loadRoutes(routesPath).routes['glm-5.2']).toBeUndefined();  // 清路由
    expect(existsSync(p + '.bak')).toBe(false);  // 清 .bak
  });

  it('uninstall on never-installed provider is a no-op', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    expect(() => uninstallProvider({ providerPath: p, alias: 'glm-5.2', routesPath })).not.toThrow();
    expect(JSON.parse(readFileSync(p, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(existsSync(p + '.bak')).toBe(false);
  });

  it('install idempotent branch throws if .bak missing (prevents self-referential upstream)', () => {
    const p = makeProviderFile(workDir, 'glm-5.2', 'https://open.bigmodel.cn/api/anthropic');
    installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' });
    rmSync(p + '.bak');  // 模拟 .bak 丢失
    expect(() => installProvider({ providerPath: p, alias: 'glm-5.2', routesPath, port: 8765, hostname: '127.0.0.1' }))
      .toThrow(/\.bak 丢失/);
  });
});