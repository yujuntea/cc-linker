// src/img-proxy/server.ts
//
// Phase 1 / Task 5: Bun.serve 反向代理
//   - 路由 /<alias>/<rest> → 上游(以 filename stem 为 alias)
//   - POST /<alias>/v1/messages: 解析 JSON body → stripImagesToPaths → 上游
//   - GET/HEAD: 不消费 body
//   - 其他方法: stream 透传
//   - 未知 alias → 502;上游不可达 → 502
//   - 响应 body 流式透传(SSE 等)
//   - 启动时清一次过期缓存 + 每小时清理
//   - 控制台路由(/)前置(Phase 1 consoleEnabled=false 不触发)
//   - 返回 ProxyServer { port, hostname, stop, stats };stats 内存计数,Phase 2 控制台读
//
// v2 stream-level instrumentation:
//   - TransformStream 包 upstreamResp.body → 统计 chunk/byte
//   - pipeTo().catch 检测 upstream mid-stream error
//   - req.signal.addEventListener('abort') 检测 client 主动断开
//   - 可选 stream_idle_timeout 检测 stalled upstream
//   - 增强 INFO log: chunks / bytes / stream_status / client_aborted / upstream_error_msg
//     / headers_to_first_chunk_ms
//   - req.signal 转发给 upstream fetch(client 断开 → cancel upstream,不浪费 token)
//   - upstreamResp.body === null 防护(204/205/304 响应)

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { getUpstreamByAlias } from './routes';
import { stripImagesToPaths } from './transform';
import { IMG_PROXY_LOG_FILE } from '../utils/paths';

export interface ProxyServerOptions {
  port: number;
  hostname: string;
  cacheDir: string;
  routesPath: string;
  promptTemplate: string;
  consoleEnabled: boolean;
  cacheMaxAgeHours: number;
  // v2: 测试可注入 logPath(默认 IMG_PROXY_LOG_FILE)
  logPath?: string;
  // v2: upstream fetch 整体超时(ms);0 = 不超时(默认)。
  // 上游卡死时保护 proxy 不挂死。client 端 SDK timeout 是另一码事,本配置管不到。
  upstreamTimeoutMs?: number;
  // v2: 距最后 chunk 超过 N ms 判 stalled 并主动 cancel upstream(0 = 不检测)
  // 区分"upstream 慢但还在跑" vs "upstream 完全卡死"
  streamIdleTimeoutMs?: number;
}

export interface ProxyServer {
  port: number;
  hostname: string;
  stop: (force?: boolean) => void;
  stats: { totalRequests: number; strippedImages: number };  // 内存计数(Phase 2 控制台读)
}

/** 从 pathname 提取第一段作 alias。空段返回 null。
 *  不做"已知路径"denylist —— 让 `getUpstreamByAlias` 当唯一 gate:
 *  路由表里没有就 502 'unknown alias',而不是 blanket 拒绝整个段。
 *  这样 `v1.json`/`api.json` 等用户起的 provider 文件名也能正确路由(只要 install 过)。
 */
export function parseAliasFromPath(pathname: string): string | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0];
  return seg && seg.length > 0 ? seg : null;
}

/** 写一条日志到 logPath。
 *  注意:不 mkdirSync 每条都调(高 QPS 时浪费 syscall),由 startProxyServer 一次性建好目录。
 */
function appendLog(line: string, logPath: string): void {
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

/** 清理 cacheDir 里超过 maxAgeHours 的文件。返回清理数。 */
export function cleanupOldCache(cacheDir: string, maxAgeHours: number): number {
  if (!existsSync(cacheDir)) return 0;
  const maxAgeMs = maxAgeHours * 3_600_000;
  const now = Date.now();
  let cleaned = 0;
  for (const f of readdirSync(cacheDir)) {
    const p = join(cacheDir, f);
    try {
      if (now - statSync(p).mtimeMs >= maxAgeMs) { unlinkSync(p); cleaned++; }
    } catch {}
  }
  return cleaned;
}

export async function startProxyServer(opts: ProxyServerOptions): Promise<ProxyServer> {
  const {
    port, hostname, cacheDir, routesPath, promptTemplate, consoleEnabled, cacheMaxAgeHours,
  } = opts;
  const logPath = opts.logPath ?? IMG_PROXY_LOG_FILE;
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? 0;
  const streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? 0;
  const stats = { totalRequests: 0, strippedImages: 0 };

  // 一次性建 log 目录(原本每条 log 都 mkdirSync,浪费)
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch {}

  // 启动清一次过期缓存 + 每小时清
  cleanupOldCache(cacheDir, cacheMaxAgeHours);
  const cleanupTimer = setInterval(() => {
    const n = cleanupOldCache(cacheDir, cacheMaxAgeHours);
    if (n > 0) appendLog(`INFO cleanup removed ${n} cached images`, logPath);
  }, 3_600_000);

  const server = Bun.serve({
    port, hostname,
    async fetch(req) {
      const url = new URL(req.url);

      // 控制台路由前置(Phase 1 consoleEnabled=false 不触发;Phase 2 在此挂 / 和 /admin/api/*)
      if (consoleEnabled && (url.pathname === '/' || url.pathname.startsWith('/admin'))) {
        return new Response('console not implemented (Phase 2)', { status: 501 });
      }

      const alias = parseAliasFromPath(url.pathname);
      if (!alias) {
        return new Response('cc-linker img-proxy: missing provider alias in path', { status: 502 });
      }
      // alias gate is `getUpstreamByAlias` only — no hardcoded reserved-prefix denylist.
      // 上游的 /v1/*, /health, /metrics 等路径若真存在,只需 install 对应的 provider
      // (alias = 文件名 stem);没 install 就 502 提示,而不是 blanket 拒绝整个段。
      const upstream = getUpstreamByAlias(routesPath, alias);
      if (!upstream) {
        appendLog(`WARN alias=${alias} path=${url.pathname} unresolved`, logPath);
        return new Response(
          `cc-linker img-proxy: 未知 provider alias "${alias}"。执行 cc-linker img-proxy install --providers ${alias} 后重试。`,
          { status: 502 },
        );
      }

      // 目标 URL = upstream + 去掉 alias 段后的 path + search
      const rest = url.pathname.replace(/^\/+/, '').split('/').slice(1).join('/');
      const targetUrl = `${upstream.replace(/\/+$/, '')}/${rest}${url.search}`;
      const startedAt = Date.now();

      const isMessagesPost = req.method === 'POST' && /\/v1\/messages(\/|$|\?)/.test(url.pathname);

      // 决定转发 body
      let outBody: BodyInit | null | undefined;
      let stripped = 0;
      if (isMessagesPost) {
        // 先 buffer 原始字节,再 parse;失败用原始字节透传(req.arrayBuffer 只能调一次)
        const rawBytes = new Uint8Array(await req.arrayBuffer());
        try {
          const payload = JSON.parse(new TextDecoder().decode(rawBytes));
          const result = await stripImagesToPaths(payload.messages ?? [], { cacheDir, promptTemplate });
          payload.messages = result.messages;
          stripped = result.strippedCount;
          outBody = JSON.stringify(payload);
          stats.strippedImages += stripped;
        } catch {
          outBody = rawBytes;  // 原始字节透传,绝不阻塞
        }
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        outBody = undefined;
      } else {
        outBody = req.body;  // 其它方法 stream 透传(未消费)
      }

      // 转发:透传 headers,删 host / content-length(让 fetch 重算)
      const headers = new Headers(req.headers);
      headers.delete('host');
      headers.delete('content-length');

      // === 改动 #2: 转发 req.signal + 可选 upstream_timeout ===
      // req.signal 让 client 断开能 cancel upstream 工作(不浪费 token / 不挂死 socket)
      // upstreamTimeoutMs 提供"upstream 整体超时"防御(默认关)
      const upstreamSignal: AbortSignal | undefined =
        upstreamTimeoutMs > 0
          ? AbortSignal.any([req.signal, AbortSignal.timeout(upstreamTimeoutMs)])
          : req.signal;

      // 注册 client abort 监听(在 fetch await 之前,这样 fetch 因 client abort 抛错时
      // streamStatus 已经是 client_aborted,可以记到 log)
      let streamStatus: 'complete' | 'upstream_error' | 'client_aborted' | 'stalled' | 'upstream_unreachable' = 'complete';
      let upstreamErrorMsg: string | null = null;
      const onClientAbort = () => {
        if (streamStatus === 'complete') streamStatus = 'client_aborted';
      };
      if (req.signal.aborted) {
        onClientAbort();
      } else {
        req.signal.addEventListener('abort', onClientAbort, { once: true });
      }

      let upstreamResp: Response;
      try {
        upstreamResp = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: outBody,
          signal: upstreamSignal,  // ← v2: 转发 client signal + 可选 upstream timeout
        });
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        // 区分 client_aborted(client 主动断开) vs upstream_unreachable(网络/上游挂)
        // 用 req.signal.aborted 直接判定,避免 TS narrow streamStatus 时的类型问题
        const finalStatus: 'client_aborted' | 'upstream_unreachable' =
          isAbort && req.signal.aborted ? 'client_aborted' : 'upstream_unreachable';
        upstreamErrorMsg = err instanceof Error ? err.message : String(err);
        appendLog(`INFO ${JSON.stringify({
          time: new Date().toISOString(), alias, method: req.method, path: url.pathname,
          stripped, upstream_status: 0,
          duration_ms: Date.now() - startedAt,
          chunks: 0, bytes: 0,
          stream_status: finalStatus,
          upstream_error_msg: upstreamErrorMsg,
        })}`, logPath);
        if (isAbort) {
          // Client 主动断开,response 无意义,499 = nginx convention "client closed request"
          return new Response(null, { status: 499 });
        }
        return new Response(`cc-linker img-proxy: 上游不可达 (${upstream}): ${err}`, { status: 502 });
      }

      const headersToFirstChunk = Date.now() - startedAt;
      stats.totalRequests++;

      // === 改动 #3: body null 防护(204/205/304 响应可能 body === null,直接传会崩) ===
      if (!upstreamResp.body) {
        appendLog(`INFO ${JSON.stringify({
          time: new Date().toISOString(), alias, method: req.method, path: url.pathname,
          stripped, upstream_status: upstreamResp.status,
          duration_ms: headersToFirstChunk, chunks: 0, bytes: 0,
          stream_status: 'no_body',
        })}`, logPath);
        return new Response(null, {
          status: upstreamResp.status,
          headers: new Headers(upstreamResp.headers),
        });
      }

      // === 改动 #1: TransformStream 包 upstream body,统计 chunk/byte ===
      let chunks = 0;
      let bytes = 0;
      let lastChunkAt = Date.now();
      // streamStatus / upstreamErrorMsg 在 fetch 之前的 abort listener 已声明并赋值
      // (client_aborted 可能已被标记;其他状态由下面的 pipeTo().catch 赋值)

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          chunks++;
          bytes += chunk.byteLength;
          lastChunkAt = Date.now();
          controller.enqueue(chunk);  // pass-through,无缓冲
        },
      });

      // pipeTo().catch 检测 upstream mid-stream error(controller.error / socket reset)
      const piping = upstreamResp.body.pipeTo(writable).catch((err) => {
        streamStatus = 'upstream_error';
        upstreamErrorMsg = (err instanceof Error ? err.message : String(err));
      });

      // === stream_idle_timeout 检测(默认关;非 0 时启用) ===
      let idleTimer: ReturnType<typeof setInterval> | null = null;
      if (streamIdleTimeoutMs > 0) {
        const tick = Math.max(1000, Math.floor(streamIdleTimeoutMs / 2));
        idleTimer = setInterval(() => {
          if (streamStatus !== 'complete') return;
          if (Date.now() - lastChunkAt > streamIdleTimeoutMs) {
            streamStatus = 'stalled';
            // 关 writable → pipeTo reject → catch 设 stream_status 仍 complete? 不,writable.close
            // 不会让 pipeTo reject(pipeTo 视正常结束)。改用 abort upstream fetch:已转发 signal,
            // 但 pipeTo 自己不能 abort。所以直接 close readable 让 client 看到 stream 截断。
            try { readable.cancel(); } catch {}
          }
        }, tick);
      }

      // === fire-and-forget log after stream settles ===
      // handler 已 return;piping 会继续在后台跑;event loop 保留 promise。
      piping.finally(() => {
        if (idleTimer !== null) clearInterval(idleTimer);
        const duration = Date.now() - startedAt;
        appendLog(`INFO ${JSON.stringify({
          time: new Date().toISOString(), alias, method: req.method, path: url.pathname,
          stripped, upstream_status: upstreamResp.status,
          duration_ms: duration,
          headers_to_first_chunk_ms: headersToFirstChunk,
          chunks, bytes,
          stream_status: streamStatus,
          upstream_error_msg: upstreamErrorMsg,
        })}`, logPath);
      }).catch(() => { /* piping 已 reject 过,这里 swallow */ });

      // 透传 response(headers + status);body 用 TransformStream 的 readable,带埋点
      return new Response(readable, {
        status: upstreamResp.status,
        headers: new Headers(upstreamResp.headers),
      });
    },
  });

  appendLog(`INFO img-proxy listening on http://${hostname}:${server.port}`, logPath);
  return {
    port: server.port ?? 0,
    hostname,
    stop: (force?: boolean) => { clearInterval(cleanupTimer); server.stop(force); },
    stats,
  };
}