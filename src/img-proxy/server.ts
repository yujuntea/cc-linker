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

import { existsSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { resolveUpstream } from './routes';
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
}

export interface ProxyServer {
  port: number;
  hostname: string;
  stop: (force?: boolean) => void;
  stats: { totalRequests: number; strippedImages: number };  // 内存计数(Phase 2 控制台读)
}

/** 从 pathname 提取第一段作 alias。无段或为保留前缀返回 null。
 *  保留前缀:Anthropic/OpenAI API 路径段(`v1`、`v2` 等),这些是上游 endpoint 段,
 *  不是 cc-linker 的 provider alias。例如 `/v1/messages` → null,`/glm-5.2/v1/messages` → "glm-5.2"。
 */
const RESERVED_PREFIXES = new Set(['v1', 'v2', 'v3', 'api', 'health', 'healthz', 'metrics']);
export function parseAliasFromPath(pathname: string): string | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0];
  if (!seg || seg.length === 0) return null;
  if (RESERVED_PREFIXES.has(seg.toLowerCase())) return null;
  return seg;
}

function appendLog(line: string): void {
  try {
    mkdirSync(dirname(IMG_PROXY_LOG_FILE), { recursive: true });
    appendFileSync(IMG_PROXY_LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
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
      if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); cleaned++; }
    } catch {}
  }
  return cleaned;
}

export async function startProxyServer(opts: ProxyServerOptions): Promise<ProxyServer> {
  const { port, hostname, cacheDir, routesPath, promptTemplate, consoleEnabled } = opts;
  const stats = { totalRequests: 0, strippedImages: 0 };

  // 启动清一次过期缓存 + 每小时清
  cleanupOldCache(cacheDir, opts.cacheMaxAgeHours);
  const cleanupTimer = setInterval(() => {
    const n = cleanupOldCache(cacheDir, opts.cacheMaxAgeHours);
    if (n > 0) appendLog(`INFO cleanup removed ${n} cached images`);
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
      const upstream = resolveUpstream(routesPath, alias);
      if (!upstream) {
        appendLog(`WARN alias=${alias} path=${url.pathname} unresolved`);
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

      let upstreamResp: Response;
      try {
        upstreamResp = await fetch(targetUrl, { method: req.method, headers, body: outBody });
      } catch (err) {
        appendLog(`ERROR alias=${alias} upstream=${upstream} ${err}`);
        return new Response(`cc-linker img-proxy: 上游不可达 (${upstream}): ${err}`, { status: 502 });
      }

      stats.totalRequests++;
      appendLog(`INFO ${JSON.stringify({
        time: new Date().toISOString(), alias, method: req.method, path: url.pathname,
        stripped, upstream_status: upstreamResp.status, duration_ms: Date.now() - startedAt,
      })}`);

      // 流式透传响应(SSE 等)
      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: new Headers(upstreamResp.headers),
      });
    },
  });

  appendLog(`INFO img-proxy listening on http://${hostname}:${server.port}`);
  return {
    port: server.port ?? 0,
    hostname,
    stop: (force?: boolean) => { clearInterval(cleanupTimer); server.stop(force); },
    stats,
  };
}
