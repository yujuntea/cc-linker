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
//   - 控制台路由(/ 和 /admin/*)总是 mount;console_enabled gate 由 handler 内部读 config
//     (spec §7.3 "方案 A",让 console_enabled 热开关不需要重启 daemon)
//   - 返回 ProxyServer { port, hostname, stop, stats };stats 含 byStatus / byAlias / recent
//     / startedAt,Phase 2 控制台读
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
//
// Task 8: 3-branch stats 写入 — catch / no_body / piping.finally 各 ++ 一次,
//   totalRequests = 真实总请求数(成功 + 失败 + no_body)且各分支只写一次 stats。

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { getUpstreamByAlias } from './routes';
import { stripImagesToPaths } from './transform';
import { handleConsoleRequest } from './console/api';
import { updateByAlias, pushRecent } from './console/stats-helpers';
import type { AliasStats, RecentEntry } from './console/types';
import { CONFIG_PATH, IMG_PROXY_LOG_FILE, expandPath } from '../utils/paths';

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
  // Task 8: config.toml 绝对路径(已 expandPath)。console handler 用它写回 config。
  // 默认 CONFIG_PATH(已绝对化);cli 接线时应显式 expand 一次传过来。
  configPath?: string;
}

export interface ProxyServer {
  port: number;
  hostname: string;
  stop: (force?: boolean) => void;
  stats: {
    totalRequests: number;
    strippedImages: number;
    startedAt: number;
    byStatus: Record<string, number>;
    byAlias: Record<string, AliasStats>;
    recent: RecentEntry[];
  };
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

/** hop-by-hop 头(RFC 7230 §6.1)—— 代理不应转发,否则可能与 Bun 自己的传输层冲突。 */
const HOP_BY_HOP_HEADERS = [
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-authenticate', 'proxy-authorization',
] as const;

/**
 * 反向代理**响应头**清理。
 *
 * 🔴 关键 bug 修复:Bun.fetch 会自动解压 gzip/deflate/br 响应体,但 **不会** 从
 * `upstreamResp.headers` 里移除 `content-encoding`(以及非流式响应的 `content-length`
 * —— 那是压缩后的大小)。原样转发这两个头给客户端 → 客户端(Claude Code)看到
 * `content-encoding: gzip` 后对"已被 Bun 解压过的明文"再 gunzip → 流解析器崩 →
 * 断开连接 → proxy 的 pipeTo 以 undefined reject(日志记 upstream_error)。
 *
 * 实测日志(1401 行):63 次 stream_status=upstream_error 全部 upstream_error_msg=undefined,
 * 其中 56 次发生在 glm-5.2(open.bigmodel.cn 对大响应 gzip);每次都是 upstream_status=200、
 * 传了 11KB–253KB 后中段失败。卸载代理直连正常 → 确认是代理转发"过期编码头"所致。
 *
 * 既然 body 已被 Bun 解压成明文,content-encoding / content-length 必须剥掉
 * (content-length 是压缩后大小,已与解压后 body 不符;流式响应本就无 content-length,
 * 删了让 Bun 自行 chunked 即可)。
 */
function sanitizeProxyResponseHeaders(src: Headers): Headers {
  const h = new Headers(src);
  h.delete('content-encoding');
  h.delete('content-length');
  for (const name of HOP_BY_HOP_HEADERS) h.delete(name);
  return h;
}

/**
 * 反向代理**请求头**清理。
 *
 * - host / content-length:fetch 会自己算,不能透传客户端的(已在用,此处收口)。
 * - accept-encoding:收口到 Bun.fetch 能自动解压的 gzip/deflate/br。客户端
 *   (Claude Code / reqwest)可能带 zstd 等编码,若上游真的回了 zstd 而 Bun 不解压,
 *   响应侧剥 content-encoding 就会误伤(客户端拿到无法识别的原始 zstd 字节)。
 *   统一限定到 Bun 已知能解压的集合 —— 既保留压缩省带宽,又保证响应侧剥头逻辑安全。
 *   (客户端不发送 accept-encoding 时不强行加,保持其 identity 偏好。)
 * - hop-by-hop 头:不转发(同 sanitizeProxyResponseHeaders)。
 */
function sanitizeProxyRequestHeaders(src: Headers): Headers {
  const h = new Headers(src);
  h.delete('host');
  h.delete('content-length');
  if (h.has('accept-encoding')) {
    h.set('accept-encoding', 'gzip, deflate, br');
  }
  for (const name of HOP_BY_HOP_HEADERS) h.delete(name);
  return h;
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
  const configPath = opts.configPath;
  const stats = {
    totalRequests: 0,
    strippedImages: 0,
    startedAt: Date.now(),
    byStatus: {} as Record<string, number>,
    byAlias: {} as Record<string, AliasStats>,
    recent: [] as RecentEntry[],
  };

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
    async fetch(req, server) {
      const url = new URL(req.url);

      // Task 8: 总是接管 console 路由(即使 console_enabled=false),handler 内检查开关
      // (spec §7.3 "方案 A")。这样 daemon 启动后改 console_enabled=true 下一请求立即生效,
      // 不需要重启。
      //
      // bug fix (review): 不能用 startsWith('/admin') — 会贪心匹配
      // /admin-foo/v1/messages 这种用户装的 alias 路径,把 proxy 请求吃掉。
      // 只匹配精确的 /admin 或 /admin/... (下一段必有 '/' 或整段就 '/admin')。
      const p = url.pathname;
      const isConsolePath = p === '/' || p === '/admin' || p.startsWith('/admin/');
      if (isConsolePath) {
        return handleConsoleRequest(req, url, {
          // configPath 必须是已 expandPath 的绝对路径(readFileSync 不识 '~')。
          // cli 接线时已 expand,test 里直接传绝对路径;兜底用 CONFIG_PATH(也是绝对路径)。
          configPath: expandPath(configPath ?? CONFIG_PATH),
          routesPath,
          cacheDir,
          logPath,
          stats,
        });
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

      // Fix(idleTimeout): Bun.serve 默认 idleTimeout=10s,在响应流式传输期间如果
      // 超过 10s 没有数据发送,Bun 会直接关闭 client TCP 连接(connection reset)。
      // LLM API 的 SSE 流式响应在 extended thinking / tool execution / 长 token 生成
      // 期间很容易超过 10s 静默期 → client 看到 "Connection closed mid-response"。
      // 对 POST /v1/messages 禁用 idleTimeout(Bun 官方推荐做法)。
      // 其他请求(502 / console / HEAD 健康检查)保持默认 10s 保护。
      if (isMessagesPost) {
        server.timeout(req, 0);  // 0 = 禁用此请求的 idle timeout
      }

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

      // 转发:清理后的请求头(详见 sanitizeProxyRequestHeaders)。
      // 关键:accept-encoding 收口 + 删 host/content-length/hop-by-hop。
      const headers = sanitizeProxyRequestHeaders(req.headers);

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
        const errDuration = Date.now() - startedAt;
        appendLog(`INFO ${JSON.stringify({
          time: new Date().toISOString(), alias, method: req.method, path: url.pathname,
          stripped, upstream_status: 0,
          duration_ms: errDuration,
          chunks: 0, bytes: 0,
          stream_status: finalStatus,
          upstream_error_msg: upstreamErrorMsg,
        })}`, logPath);
        // Task 8: 写 stats(fetch 抛错路径,totalRequests = 真实总请求数)
        stats.totalRequests++;
        stats.byStatus[finalStatus] = (stats.byStatus[finalStatus] ?? 0) + 1;
        updateByAlias(stats, alias, { requests: 1, stripped, bytes: 0, chunks: 0, durationMs: errDuration });
        pushRecent(stats, { ts: Date.now(), alias, status: 0, stream_status: finalStatus, chunks: 0, bytes: 0, duration_ms: errDuration, stripped });
        if (isAbort) {
          // Client 主动断开,response 无意义,499 = nginx convention "client closed request"
          return new Response(null, { status: 499 });
        }
        return new Response(`cc-linker img-proxy: 上游不可达 (${upstream}): ${err}`, { status: 502 });
      }

      const headersToFirstChunk = Date.now() - startedAt;
      // 注:totalRequests 不在这里 ++;每个请求在 catch / no_body / piping.finally
      // 三个分支之一 ++ 一次,确保 totalRequests = 真实总请求数(成功 + 失败 + no_body)
      // 且各 branch 的 byAlias / byStatus / recent 也只写一次。

      // === 改动 #3: body null 防护(204/205/304 响应可能 body === null,直接传会崩) ===
      if (!upstreamResp.body) {
        appendLog(`INFO ${JSON.stringify({
          time: new Date().toISOString(), alias, method: req.method, path: url.pathname,
          stripped, upstream_status: upstreamResp.status,
          duration_ms: headersToFirstChunk, chunks: 0, bytes: 0,
          stream_status: 'no_body',
        })}`, logPath);
        // Task 8: 写 stats(body === null 路径,headers 已收,body 为空)
        stats.totalRequests++;
        stats.byStatus.no_body = (stats.byStatus.no_body ?? 0) + 1;
        updateByAlias(stats, alias, { requests: 1, stripped, bytes: 0, chunks: 0, durationMs: headersToFirstChunk });
        pushRecent(stats, { ts: Date.now(), alias, status: upstreamResp.status, stream_status: 'no_body', chunks: 0, bytes: 0, duration_ms: headersToFirstChunk, stripped });
        return new Response(null, {
          status: upstreamResp.status,
          headers: sanitizeProxyResponseHeaders(upstreamResp.headers),
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
      // 分类要点:不能无条件写 upstream_error ——
      //   1. 若 onClientAbort 已把 streamStatus 标成 client_aborted(req.signal abort
      //      在 catch 前触发),不要覆盖。
      //   2. pipeTo 在 readable 被取消(客户端断开)时 reject 的 reason 常是 undefined
      //      (流取消不带 reason),靠 err instanceof Error 判会误判成 upstream_error。
      //   所以先看 req.signal.aborted:是 → client_aborted;否 → 真上游错误。
      //   (修复前:1401 行日志里 63 次 stream_status=upstream_error 全是
      //    upstream_error_msg=undefined,实为客户端因 gzip 二次解压崩溃后断连,被误分类。)
      const piping = upstreamResp.body.pipeTo(writable).catch((err) => {
        if (streamStatus === 'client_aborted' || req.signal.aborted) {
          streamStatus = 'client_aborted';
          return;
        }
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
      // 已知 limitation (review): 此路径是 async 的 — daemon 收到 SIGKILL
      // 时 piping + finally 都不会执行,该请求的 stats + log entry 会丢失。
      // daemon `cc-linker img-proxy stop` 走 SIGTERM(event loop 自然 drain),
      // 不影响。SIGKILL 通过 pkill -9 / OOM 等极端路径触发,生产极少。
      // 修复:同步 (catch / no_body) 路径不丢;只 piping.finally 路径受影响。
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
        // Task 8: 写 stats(成功 stream 路径)
        stats.totalRequests++;
        stats.byStatus[streamStatus] = (stats.byStatus[streamStatus] ?? 0) + 1;
        updateByAlias(stats, alias, { requests: 1, stripped, bytes, chunks, durationMs: duration });
        pushRecent(stats, { ts: Date.now(), alias, status: upstreamResp.status, stream_status: streamStatus, chunks, bytes, duration_ms: duration, stripped });
      }).catch(() => { /* piping 已 reject 过,这里 swallow */ });

      // 透传 response(status + 清理后的 headers);body 用 TransformStream 的 readable,带埋点。
      // 关键:响应头走 sanitizeProxyResponseHeaders —— 剥 content-encoding/content-length
      // (Bun.fetch 自动解压后这俩头已过期,原样转发会让客户端二次解压崩溃)。
      return new Response(readable, {
        status: upstreamResp.status,
        headers: sanitizeProxyResponseHeaders(upstreamResp.headers),
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