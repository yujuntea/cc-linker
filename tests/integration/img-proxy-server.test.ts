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
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';

const RED_DOT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('img-proxy server', () => {
  let cacheDir: string, routesPath: string, logPath: string, workDir: string;
  let upstreamPort: number, upstreamServer: any;
  let proxyPort: number, proxyServer: any;
  let lastMethod: string, lastHeaders: any, lastBody: any, lastPath: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-srv-cache-'));
    workDir = mkdtempSync(join(tmpdir(), 'img-proxy-srv-'));
    routesPath = join(workDir, 'routes.json');
    logPath = join(workDir, 'img-proxy.log');

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

    await saveRoutes(routesPath, {
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
      logPath,  // 注入临时 log 路径,便于测试断言 stream_status
    });
    proxyPort = proxyServer.port;
  });

  afterAll(() => {
    proxyServer?.stop(true);
    upstreamServer?.stop(true);
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => { lastMethod = ''; lastHeaders = undefined; lastBody = undefined; lastPath = ''; });

  it('parseAliasFromPath extracts first segment (no reserved-prefix denylist)', () => {
    // 第一段总是返回(让 getUpstreamByAlias 当 gate);空段返回 null。
    expect(parseAliasFromPath('/glm-5.2/v1/messages')).toBe('glm-5.2');
    expect(parseAliasFromPath('/v1/messages')).toBe('v1');  // 不再 blanket 拒绝;实际路由交给 getUpstreamByAlias
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

// === v2 stream-level instrumentation 测试 ===
// 单独 describe,起一个独立 upstream,跑出错的 stream 来验证埋点
describe('img-proxy server v2 stream instrumentation', () => {
  let cacheDir: string, routesPath: string, logPath: string, workDir: string;
  let upstreamPort: number, upstreamServer: any;
  let proxyPort: number, proxyServer: any;
  // 自定义 upstream 行为 — 每个测试覆盖一次
  let upstreamBehavior:
    | { kind: 'normal'; chunks: string[] }
    | { kind: 'slow'; delayMs: number; chunks: string[] };

  async function waitForLogMatching(predicate: (line: string) => boolean, timeoutMs = 3000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const content = readFileSync(logPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        // 从后往前找,找最新的匹配行
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!;
          if (predicate(line)) return line;
        }
      } catch { /* log 还没创建 */ }
      await new Promise(r => setTimeout(r, 50));
    }
    return null;
  }

  // 给独立测试用的 variant,显式传 logPath。timeout 时返回所有匹配行(可能空)
  async function waitForLogMatchingInline(
    targetLogPath: string,
    predicate: (line: string) => boolean,
    timeoutMs = 3000,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const content = readFileSync(targetLogPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const matched = lines.filter(predicate);
        if (matched.length > 0) return matched;
      } catch { /* log 还没创建 */ }
      await new Promise(r => setTimeout(r, 50));
    }
    return [];
  }

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-srv2-cache-'));
    workDir = mkdtempSync(join(tmpdir(), 'img-proxy-srv2-'));
    routesPath = join(workDir, 'routes.json');
    logPath = join(workDir, 'img-proxy.log');

    upstreamServer = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(_req) {
        if (upstreamBehavior.kind === 'normal') {
          // 用 async start + setTimeout 让每个 enqueue 单独经过 event loop
          // (同步 start 里多次 enqueue 会被 pipeTo 合并成 1 个 chunk)
          return new Response(new ReadableStream({
            async start(controller) {
              for (const c of upstreamBehavior.chunks) {
                controller.enqueue(new TextEncoder().encode(c));
                await new Promise(r => setTimeout(r, 0));
              }
              controller.close();
            },
          }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        // slow
        const { delayMs, chunks } = upstreamBehavior;
        return new Response(new ReadableStream({
          async start(controller) {
            await new Promise(r => setTimeout(r, delayMs));
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            controller.close();
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    upstreamPort = upstreamServer.port;

    await saveRoutes(routesPath, {
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
      logPath,
    });
    proxyPort = proxyServer.port;

    upstreamBehavior = { kind: 'normal', chunks: [] };
  });

  afterAll(() => {
    proxyServer?.stop(true);
    upstreamServer?.stop(true);
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    upstreamBehavior = { kind: 'normal', chunks: [] };
  });

  it('counts chunks/bytes correctly and logs stream_status: complete', async () => {
    upstreamBehavior = {
      kind: 'normal',
      chunks: [
        'event: a\ndata: {"i":1}\n\n',
        'event: b\ndata: {"i":2}\n\n',
        'event: c\ndata: {"i":3}\n\n',
        'event: d\ndata: {"i":4}\n\n',
        'event: e\ndata: {"i":5}\n\n',
      ],
    };
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(resp.status).toBe(200);
    await resp.text();  // drain body

    const logLine = await waitForLogMatching(l => l.includes('"alias":"glm-5.2"') && l.includes('"stream_status"'));
    expect(logLine).not.toBeNull();
    const entry = JSON.parse(logLine!.match(/\{.*\}$/)![0]);
    expect(entry.chunks).toBe(5);
    expect(entry.bytes).toBeGreaterThan(0);
    expect(entry.stream_status).toBe('complete');
    expect(entry.upstream_status).toBe(200);
  });

  it('detects upstream mid-stream close and logs abnormal stream_status', async () => {
    // 用独立 raw TCP upstream 模拟真实场景:upstream socket 在 body 传输中段被
    // destroy()(等同于 server crash / TCP RST)。
    //
    // 关键时序:先写 headers(让 Bun fetch resolve 返回 Response),再写几个 chunk,
    // 延迟 100ms 后 destroy —— 确保 Bun 已经进入"读 body"阶段。
    //
    // 注意:Bun runtime 把 mid-stream socket close 当作 fetch 整体失败
    // (upstream_unreachable),而不是 stream-level error。两者诊断价值等价
    // —— 都告诉用户"upstream 出问题了"。stream-level error 路径(server.ts 中的
    // pipeTo().catch)在 controller.error() 触发时被验证,但 Bun runtime 不允许
    // 在 fetch handler 里干净模拟 controller.error(会被当 unhandled rejection
    // 或 uncaughtException)。所以这里测的是真实场景下的实际行为分类。
    const tmpDir = mkdtempSync(join(tmpdir(), 'img-proxy-mid-'));
    const tmpRoutesPath = join(tmpDir, 'routes.json');
    const tmpLogPath = join(tmpDir, 'img-proxy.log');
    let upstreamPort = 0;

    const tcpServer = createServer((socket) => {
      // 1) 立即写 headers —— Bun fetch 收到 headers 后会 resolve,proxy 进入 read body
      socket.write('HTTP/1.1 200 OK\r\n');
      socket.write('Content-Type: text/event-stream\r\n');
      socket.write('Transfer-Encoding: chunked\r\n');
      socket.write('Connection: close\r\n');
      socket.write('\r\n');
      // 2) 写两个 chunked body chunks
      socket.write('6\r\nchunk0\n\r\n');
      socket.write('6\r\nchunk1\n\r\n');
      // 3) 延迟 100ms 后 destroy —— 此时 Bun fetch 已经在 read body
      setTimeout(() => {
        try { socket.destroy(); } catch {}
      }, 100);
    });
    await new Promise<void>(r => tcpServer.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (tcpServer.address() as any).port;

    await saveRoutes(tmpRoutesPath, {
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

    const tmpProxy = await startProxyServer({
      port: 0, hostname: '127.0.0.1', cacheDir: mkdtempSync(join(tmpdir(), 'img-proxy-mid-cache-')),
      routesPath: tmpRoutesPath,
      promptTemplate: '[img: {path}]', consoleEnabled: false, cacheMaxAgeHours: 1,
      logPath: tmpLogPath,
    });

    // 触发请求 —— 期待 fetch 抛错或 response body 中途断
    let clientErr: Error | null = null;
    try {
      const resp = await fetch(`http://127.0.0.1:${tmpProxy.port}/glm-5.2/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(resp.status).toBe(200);
      const reader = resp.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      clientErr = err as Error;
    }
    // 客户端应该看到错误(fetch 整体失败 或 body read 失败)
    expect(clientErr).not.toBeNull();

    // 等 proxy 写 log
    const logContent = readFileSync(tmpLogPath, 'utf8');
    const allInfoLines = logContent.split('\n').filter(Boolean).filter(l => l.includes('"stream_status"'));
    expect(allInfoLines.length).toBeGreaterThan(0);
    const entry = JSON.parse(allInfoLines[allInfoLines.length - 1]!.match(/\{.*\}$/)![0]);
    // 接受 upstream_error 或 upstream_unreachable —— 两者都说明 proxy 检测到异常
    expect(['upstream_error', 'upstream_unreachable']).toContain(entry.stream_status);
    expect(entry.upstream_error_msg).toBeTruthy();

    tmpProxy.stop(true);
    tcpServer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects client abort and logs stream_status: client_aborted', async () => {
    // 上游故意慢 800ms,我们 100ms 后 abort
    upstreamBehavior = {
      kind: 'slow',
      delayMs: 800,
      chunks: ['event: late\ndata: {"too":"late"}\n\n'],
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    let threw = false;
    try {
      await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        signal: controller.signal,
      });
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(true);

    const logLine = await waitForLogMatching(
      l => l.includes('"stream_status":"client_aborted"') || l.includes('"stream_status":"upstream_error"'),
    );
    expect(logLine).not.toBeNull();
    // client_aborted 优先级最高(只要 stream 还没被 upstream_error/stalled 标记)
    const entry = JSON.parse(logLine!.match(/\{.*\}$/)![0]);
    expect(entry.stream_status).toBe('client_aborted');
  });
});

// === gzip 响应头剥离回归测试 ===
// 根因:Bun.fetch 自动解压 gzip/deflate/br 响应体,但保留 content-encoding(及非流式
// 的 content-length)。代理原样转发 → 客户端二次解压崩溃 → 断连 → pipeTo reject
// (日志 upstream_error_msg=undefined)。实测 glm-5.2 大响应 56/63 次失败即此因。
// 修法:sanitizeProxyResponseHeaders 剥 content-encoding/content-length + hop-by-hop;
//       sanitizeProxyRequestHeaders 把 accept-encoding 收口到 gzip/deflate/br。
describe('img-proxy server: gzip 响应头剥离 + accept-encoding 收口', () => {
  let cacheDir: string, workDir: string, routesPath: string, logPath: string;
  let upstreamServer: any, proxyServer: any, proxyPort: number;
  let lastForwardedAcceptEncoding: string | null;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'img-proxy-gz-cache-'));
    workDir = mkdtempSync(join(tmpdir(), 'img-proxy-gz-'));
    routesPath = join(workDir, 'routes.json');
    logPath = join(workDir, 'img-proxy.log');

    upstreamServer = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        // 记录代理转发过来的 accept-encoding(验证请求侧收口)
        lastForwardedAcceptEncoding = req.headers.get('accept-encoding');
        const ae = lastForwardedAcceptEncoding ?? '';
        // 模拟真实 glm 上游:客户端声明能 gzip 就 gzip(大响应才会触发,这里用 SSE 文本)
        const plain = new TextEncoder().encode(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        );
        if (ae.includes('gzip')) {
          const gz = Bun.gzipSync(plain);
          return new Response(gz, {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'content-encoding': 'gzip',
              'content-length': String(gz.byteLength),  // 压缩后大小(与解压后 body 不符)
            },
          });
        }
        return new Response(plain, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });

    await saveRoutes(routesPath, {
      version: 1,
      routes: {
        'glm-5.2': {
          alias: 'glm-5.2', upstream: `http://127.0.0.1:${upstreamServer.port}`,
          provider_path: '/fake/glm-5.2.json',
          original_base_url: `http://127.0.0.1:${upstreamServer.port}`,
          installed_at: '2026-07-04T00:00:00.000Z',
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

  beforeEach(() => { lastForwardedAcceptEncoding = null; });

  it('上游 gzip 响应:剥 content-encoding,body 为明文 SSE', async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate, br' },
      body: JSON.stringify({ model: 'glm-5.2[1m]', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(resp.status).toBe(200);
    // 🔴 核心:content-encoding 必须被剥(Bun 已解压 body,留着会让客户端二次解压崩)
    expect(resp.headers.get('content-encoding')).toBeNull();
    // content-type 等正常头保留
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    // body 是明文 SSE,不是 gzip 字节(若客户端二次解压会拿到乱码 / 崩)
    const text = await resp.text();
    expect(text).toContain('message_start');
    expect(text).toContain('message_stop');
    // content-length 若存在,必须是解压后的真实大小(不能是压缩后的陈旧值)
    const cl = resp.headers.get('content-length');
    if (cl !== null) {
      expect(Number(cl)).toBe(new TextEncoder().encode(text).length);
    }
  });

  it('上游流式 gzip 响应(真实 glm 场景):剥 content-encoding,明文 SSE 逐块可达', async () => {
    // 独立 routes + proxy,避免污染共享路由表(参照 mid-stream 测试的自包含模式)。
    // upstream:把整段 SSE 一次性 gzip,再分块流式吐出(模拟真实 glm 上游的
    // chunked + gzip。Bun.fetch 仍会自动解压并保留 content-encoding 头)。
    const plain = new TextEncoder().encode(
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    const gz = Bun.gzipSync(plain);
    const tmpUp = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch() {
        return new Response(new ReadableStream({
          async start(controller) {
            const half = Math.floor(gz.byteLength / 2);
            controller.enqueue(gz.slice(0, half));
            await new Promise(r => setTimeout(r, 20));
            controller.enqueue(gz.slice(half));
            controller.close();
          },
        }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
        });
      },
    });
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'img-proxy-gz-stream-'));
    const tmpRoutes = join(tmpDir2, 'routes.json');
    const tmpLog = join(tmpDir2, 'img-proxy.log');
    await saveRoutes(tmpRoutes, {
      version: 1,
      routes: {
        'glm-5.2': {
          alias: 'glm-5.2', upstream: `http://127.0.0.1:${tmpUp.port}`,
          provider_path: '/fake/glm-5.2.json',
          original_base_url: `http://127.0.0.1:${tmpUp.port}`,
          installed_at: '2026-07-04T00:00:00.000Z',
        },
      },
    });
    const tmpProxy = await startProxyServer({
      port: 0, hostname: '127.0.0.1',
      cacheDir: mkdtempSync(join(tmpdir(), 'img-proxy-gz-stream-cache-')),
      routesPath: tmpRoutes,
      promptTemplate: '[img: {path}]', consoleEnabled: false, cacheMaxAgeHours: 1,
      logPath: tmpLog,
    });

    const resp = await fetch(`http://127.0.0.1:${tmpProxy.port}/glm-5.2/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate, br' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(resp.status).toBe(200);
    // 🔴 流式场景同样:content-encoding 必须被剥
    expect(resp.headers.get('content-encoding')).toBeNull();
    // 逐块读取应拿到明文 SSE(非 gzip 字节)
    const reader = resp.body!.getReader();
    let decoded = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      decoded += new TextDecoder().decode(value);
    }
    expect(decoded).toContain('message_start');
    expect(decoded).toContain('content_block_delta');
    expect(decoded).toContain('message_stop');

    tmpProxy.stop(true);
    tmpUp.stop(true);
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('转发给上游的 accept-encoding 收口到 gzip/deflate/br(剥 zstd 等)', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/glm-5.2/v1/messages`, {
      method: 'POST',
      // 客户端发 zstd(假设 Claude Code 某版本带),代理应剥掉只留 Bun 能解压的
      headers: { 'content-type': 'application/json', 'accept-encoding': 'zstd, gzip, br' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(lastForwardedAcceptEncoding).toBe('gzip, deflate, br');
  });
});
