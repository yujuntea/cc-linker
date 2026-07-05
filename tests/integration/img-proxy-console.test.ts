// tests/integration/img-proxy-console.test.ts
//
// Task 6: console api endpoints 集成测试。
//
// 关键设计:
// - 每个 it 用独立 tmpDir(避免 routes/config 状态污染下一个 test)
// - configPath 传 workDir 下的临时 config.toml,不污染 ~/.cc-linker/config.toml
//   (readFileSync 不识 '~')
// - console_enabled=true 通过 config.setRuntimeOverride 设置,让 handleConsoleRequest
//   的 gate 通过(否则会返 404)。afterAll 还原为 false。
// - 调 handleConsoleRequest(req, url, ctx) 直接走 handler 树,不走 server.ts 的
//   fetch 分发(server.ts 的 console 路由 mount 是 Task 8 的范围,Task 6 只交付
//   handler 本身)。这样测试聚焦"handler 行为",不依赖 Task 8 的 server 改造。
// - "disable 后 proxy 返 502" 用 getUpstreamByAlias 验证,不走真实 HTTP
//   (同上,proxy 入口在 server.ts,而 disable 走 console handler)。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { handleConsoleRequest } from '../../src/img-proxy/console/api';
import { saveRoutes, getUpstreamByAlias } from '../../src/img-proxy/routes';
import { config } from '../../src/utils/config';

describe('img-proxy console api', () => {
  let workDir: string;
  let cacheDir: string;
  let routesPath: string;
  let logPath: string;
  let configPath: string;
  let upstreamUrl: string;

  // 让 handleConsoleRequest 的 console_enabled gate 通过(默认 false → 404)
  beforeAll(() => {
    config.setRuntimeOverride('img_proxy.console_enabled', true);
  });
  // 测试结束后还原,避免污染其他 test 文件的全局 config 状态
  afterAll(() => {
    config.setRuntimeOverride('img_proxy.console_enabled', false);
  });

  // 每个 test 拿独立的 tmpDir(避免 routes/config 残留)
  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'console-int-'));
    cacheDir = join(workDir, 'cache');
    routesPath = join(workDir, 'routes.json');
    logPath = join(workDir, 'img-proxy.log');
    configPath = join(workDir, 'config.toml');
    upstreamUrl = 'http://127.0.0.1:9999';

    await saveRoutes(routesPath, {
      version: 1,
      routes: {
        'glm-5.2': {
          alias: 'glm-5.2',
          upstream: upstreamUrl,
          provider_path: '/fake.json',
          original_base_url: upstreamUrl,
          installed_at: '2026-07-05T00:00:00Z',
        },
      },
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // helper: 调 handleConsoleRequest + 默认 ctx
  function ctxWith(extra: Partial<{ configPath: string; routesPath: string; cacheDir: string; logPath: string; stats: any }> = {}) {
    return {
      configPath, routesPath, cacheDir, logPath,
      stats: { totalRequests: 0, strippedImages: 0 },
      ...extra,
    };
  }

  function makeReq(path: string, init?: RequestInit): { req: Request; url: URL } {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, init);
    return { req, url };
  }

  it('GET /admin/api/stats 返 stats JSON', async () => {
    const { req, url } = makeReq('/admin/api/stats');
    const r = await handleConsoleRequest(req, url, ctxWith({
      stats: { totalRequests: 7, strippedImages: 3 },
    }));
    expect(r.status).toBe(200);
    const stats = await r.json();
    expect(stats.totalRequests).toBe(7);
    expect(stats.strippedImages).toBe(3);
  });

  it('POST /admin/api/routes/disable 写入 disabled + proxy 视为未知 alias;enable 后恢复', async () => {
    // disable
    {
      const { req, url } = makeReq('/admin/api/routes/disable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'glm-5.2' }),
      });
      const r = await handleConsoleRequest(req, url, ctxWith());
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toHaveProperty('ok', true);
    }
    // proxy 此时应该视 glm-5.2 为未知 alias → upstream lookup 返 null
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBeNull();

    // enable
    {
      const { req, url } = makeReq('/admin/api/routes/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: 'glm-5.2' }),
      });
      const r = await handleConsoleRequest(req, url, ctxWith());
      expect(r.status).toBe(200);
    }
    // 恢复 → upstream 重新可达
    expect(getUpstreamByAlias(routesPath, 'glm-5.2')).toBe(upstreamUrl);
  });

  it('GET /admin/api/health 返 health info', async () => {
    const { req, url } = makeReq('/admin/api/health');
    const r = await handleConsoleRequest(req, url, ctxWith());
    expect(r.status).toBe(200);
    const h = await r.json();
    expect(h).toHaveProperty('uptimeMs');
    expect(h).toHaveProperty('pid', process.pid);
    expect(h).toHaveProperty('routeCount', 1);   // 1 route saved in beforeEach
    expect(h).toHaveProperty('cacheFiles');
    expect(h).toHaveProperty('cacheBytes');
  });

  it('POST /admin/api/cache/clear 返 ok + removed (1 个文件)', async () => {
    // 预先建 cacheDir 并放一个 10-byte 文件
    // 注:cleanupOldCache 用 `>` 比较;刚 writeFileSync 的文件 mtime ≈ now,
    // `now - mtimeMs > 0` 在同毫秒内可能为 false。utimes 把 mtime 拨到 1 秒前
    // 避免这条边界。生产场景下用户点 Clear 时文件至少几毫秒~几小时,无此问题。
    mkdirSync(cacheDir, { recursive: true });
    const f = join(cacheDir, 'test.png');
    writeFileSync(f, Buffer.alloc(10));
    utimesSync(f, new Date(Date.now() - 1_000), new Date(Date.now() - 1_000));
    const { req, url } = makeReq('/admin/api/cache/clear', { method: 'POST' });
    const r = await handleConsoleRequest(req, url, ctxWith());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toHaveProperty('ok', true);
    expect(body).toHaveProperty('removed', 1);
    // 验证 cacheDir 已空
    if (existsSync(cacheDir)) {
      expect(readdirSync(cacheDir).length).toBe(0);
    }
  });

  it('POST /admin/api/routes/disable 未知 alias 返 404 E_CONSOLE_UNKNOWN_ALIAS', async () => {
    const { req, url } = makeReq('/admin/api/routes/disable', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 'nope-not-installed' }),
    });
    const r = await handleConsoleRequest(req, url, ctxWith());
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body).toHaveProperty('code', 'E_CONSOLE_UNKNOWN_ALIAS');
  });
});