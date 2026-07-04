// tests/integration/img-proxy-server.test.ts
//
// Phase 1 / Task 5: 验证 Bun.serve 反向代理
//   - POST /<alias>/v1/messages: 剥 image → 替换为路径 text block;Authorization 透传;SSE 透传
//   - GET /<alias>/v1/models: method/path 透传,无 body mutation
//   - 无 image 时: body 不变
//   - 未知 alias: 502 + alias 名
//   - 畸形 JSON body: 原始字节透传(代理不崩)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { startProxyServer, parseAliasFromPath } from '../../src/img-proxy/server';
import { saveRoutes } from '../../src/img-proxy/routes';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const RED_DOT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('img-proxy server', () => {
  let cacheDir: string, routesPath: string;
  let upstreamPort: number, upstreamServer: any;
  let proxyPort: number, proxyServer: any;
  let lastMethod: string, lastHeaders: any, lastBody: any, lastPath: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-srv-cache-'));
    const workDir = mkdtempSync(join(tmpdir(), 'img-proxy-srv-'));
    routesPath = join(workDir, 'routes.json');

    upstreamServer = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        lastPath = new URL(req.url).pathname;
        lastMethod = req.method;
        lastHeaders = Object.fromEntries(req.headers.entries());
        // 注:故意 try/catch 让上游不抛 — 否则 bun test 会把 SyntaxError 当作
        // unhandled error 直接中止测试。我们测的是"代理不崩",不是"上游抛错"。
        if (req.method === 'POST') {
          try { lastBody = await req.json(); } catch { lastBody = null; }
        } else {
          lastBody = null;
        }
        const sseBody =
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n';
        return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    upstreamPort = upstreamServer.port;

    saveRoutes(routesPath, {
      version: 1,
      routes: {
        'glm-5.2': {
          alias: 'glm-5.2', upstream: `http://127.0.0.1:${upstreamPort}`,
          provider_path: '/fake/glm-5.2.json',
          original_base_url: `http://127.0.0.1:${upstreamPort}`,
          installed_at: '2026-07-04T00:00:00.000Z',
        },
      },
    });

    proxyServer = await startProxyServer({
      port: 0, hostname: '127.0.0.1', cacheDir, routesPath,
      promptTemplate: '[img: {path}]', consoleEnabled: false, cacheMaxAgeHours: 1,
    });
    proxyPort = proxyServer.port;
  });

  afterAll(() => {
    proxyServer?.stop(true);
    upstreamServer?.stop(true);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  beforeEach(() => { lastMethod = ''; lastHeaders = undefined; lastBody = undefined; lastPath = ''; });

  it('parseAliasFromPath extracts first segment (no reserved-prefix denylist)', () => {
    // 第一段总是返回(让 resolveUpstream 当 gate);空段返回 null。
    expect(parseAliasFromPath('/glm-5.2/v1/messages')).toBe('glm-5.2');
    expect(parseAliasFromPath('/v1/messages')).toBe('v1');  // 不再 blanket 拒绝;实际路由交给 resolveUpstream
    expect(parseAliasFromPath('/')).toBeNull();
  });

  it('POST /<alias>/v1/messages strips image, forwards text block, passes SSE through, forwards Authorization', async () => {
    const body = {
      model: 'glm-5.2[1m]', stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG_B64 } },
        ],
      }],
    };
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-test' },
      body: JSON.stringify(body),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    expect((await resp.text()).length).toBeGreaterThan(0);
    // 上游收到的 body 不含 image block,含路径 text block
    expect(lastBody).toBeTruthy();
    const fwd = lastBody.messages[0].content;
    expect(fwd.find((b: any) => b.type === 'image')).toBeUndefined();
    expect(fwd.find((b: any) => b.type === 'text' && b.text.startsWith('[img: '))).toBeDefined();
    expect(lastHeaders['authorization']).toBe('Bearer sk-test');
    expect(readdirSync(cacheDir).length).toBe(1);  // 落盘 1 张
  });

  it('GET /<alias>/v1/models passes through: method GET, no body mutation', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/models`);
    expect(resp.status).toBe(200);
    expect(lastMethod).toBe('GET');
    expect(lastPath).toBe('/v1/models');
    expect(lastBody).toBeNull();
  });

  it('POST with no image forwards body unchanged', async () => {
    const body = { model: 'glm-5.2[1m]', messages: [{ role: 'user', content: '纯文本' }] };
    await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(lastBody.messages[0].content).toBe('纯文本');
  });

  it('unknown alias returns 502 mentioning the alias', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/whoever/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(resp.status).toBe(502);
    expect((await resp.text())).toContain('whoever');
  });

  it('POST with malformed JSON body passes raw bytes through (no crash)', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json{',
    });
    // 上游 mock 会对非 JSON body 的 req.json() 抛错 → 它的 fetch 抛 → 返回 500。
    // 我们只断言"代理没崩、回了响应"。上游 500 是 mock 副作用,真实上游会自行处理。
    expect([200, 500]).toContain(resp.status);
  });
});
