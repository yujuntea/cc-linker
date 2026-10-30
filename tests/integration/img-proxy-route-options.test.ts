// tests/integration/img-proxy-route-options.test.ts
//
// 路由级能力(inject_headers / request_transform)端到端验证:
//   - inject_headers: 客户端不带头时上游收到注入头;客户端带同名头时以路由表为准(不可覆盖)
//   - request_transform='openai-dialect-normalizer': POST chat/completions body
//     被 max_output_tokens→max_tokens + 剥思考方言改写;GET /v1/models body 不动
//   - 未配置选项的路由行为不变(不注入、不改写)
//
// 背景: OpenCode Go 网关(zen/go)强制 x-opencode-session(缺失 400)且
// 只认标准 max_tokens / reasoning_effort(方言字段 503)—— 2026-10-30 实测。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { startProxyServer } from '../../src/img-proxy/server';
import { saveRoutes } from '../../src/img-proxy/routes';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('img-proxy server route options', () => {
  let cacheDir: string, routesPath: string, logPath: string, workDir: string;
  let upstreamPort: number, upstreamServer: any;
  let proxyPort: number, proxyServer: any;
  let lastHeaders: any, lastBody: any, lastPath: string, lastMethod: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-opts-cache-'));
    workDir = mkdtempSync(join(tmpdir(), 'img-proxy-opts-'));
    routesPath = join(workDir, 'routes.json');
    logPath = join(workDir, 'img-proxy.log');

    upstreamServer = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        lastPath = new URL(req.url).pathname;
        lastMethod = req.method;
        lastHeaders = Object.fromEntries(req.headers.entries());
        if (req.method === 'POST') {
          try { lastBody = await req.json(); } catch { lastBody = null; }
        } else {
          lastBody = null;
        }
        return Response.json({ ok: true });
      },
    });
    upstreamPort = upstreamServer.port;
    const upstream = `http://127.0.0.1:${upstreamPort}`;

    await saveRoutes(routesPath, {
      version: 1,
      routes: {
        // 带全套路由级能力的路由(OpenCode Go 形态)
        opencode: {
          alias: 'opencode', upstream,
          provider_path: '/manual/opencode.json',
          original_base_url: upstream,
          installed_at: '2026-10-30T00:00:00.000Z',
          inject_headers: { 'x-opencode-session': 'test-session-fixed' },
          request_transform: 'openai-dialect-normalizer',
        },
        // 无选项的普通路由(回归保护:行为不变)
        plain: {
          alias: 'plain', upstream,
          provider_path: '/fake/plain.json',
          original_base_url: upstream,
          installed_at: '2026-10-30T00:00:00.000Z',
        },
      },
    });

    proxyServer = await startProxyServer({
      port: 0, hostname: '127.0.0.1', cacheDir, routesPath,
      promptTemplate: '[img: {path}]', consoleEnabled: false, cacheMaxAgeHours: 1,
      logPath,
    });
    proxyPort = proxyServer.port;
  });

  afterAll(() => {
    proxyServer?.stop(true);
    upstreamServer?.stop(true);
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => { lastHeaders = undefined; lastBody = undefined; lastPath = ''; lastMethod = ''; });

  it('inject_headers: 客户端未带时上游收到注入头', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/opencode/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sk-t' },
      body: JSON.stringify({ model: 'gemini-4-argon', messages: [], max_tokens: 1, stream: true }),
    });
    expect(resp.status).toBe(200);
    expect(lastHeaders['x-opencode-session']).toBe('test-session-fixed');
  });

  it('inject_headers: 客户端带同名头时以路由表为准(不可覆盖)', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/opencode/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opencode-session': 'evil-client-override',
      },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(lastHeaders['x-opencode-session']).toBe('test-session-fixed');
  });

  it('request_transform: chat/completions body 方言被归一化(ZCode 四方言实测形态)', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/opencode/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-4-argon', messages: [{ role: 'user', content: 'hi' }],
        stream: true, stream_options: { include_usage: true },
        thinking: { type: 'enabled' }, enable_thinking: true,
        reasoning_effort: 'low', reasoning: { effort: 'low' },
        max_output_tokens: 1,
      }),
    });
    expect(lastBody).toBeTruthy();
    expect(lastBody.max_tokens).toBe(1);
    expect(lastBody.max_output_tokens).toBeUndefined();
    expect(lastBody.thinking).toBeUndefined();
    expect(lastBody.enable_thinking).toBeUndefined();
    expect(lastBody.reasoning).toBeUndefined();
    expect(lastBody.reasoning_effort).toBe('low');
    // (glm 首审 P2-7)messages 数组深度不被动 —— 归一化只许动顶层标量字段
    expect(lastBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(lastBody.stream_options).toEqual({ include_usage: true });  // 其余顶层字段同样原样
    // 改写进 INFO log(dialect_changed 字段)
    const logTail = readFileSync(logPath, 'utf8');
    expect(logTail).toContain('dialect_changed');
  });

  it('request_transform: 非 chat/completions 路径 body 不动(GET models 透传)', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/opencode/v1/models`);
    expect(resp.status).toBe(200);
    expect(lastMethod).toBe('GET');
    expect(lastPath).toBe('/v1/models');
  });

  it('普通路由回归: 不注入、不改写(无选项时行为与旧版一致)', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/plain/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_output_tokens: 5, thinking: { type: 'enabled' }, messages: [] }),
    });
    expect(lastHeaders['x-opencode-session']).toBeUndefined();
    expect(lastBody.max_output_tokens).toBe(5);       // 未配置 transform → 原样透传
    expect(lastBody.thinking).toEqual({ type: 'enabled' });
  });
});
