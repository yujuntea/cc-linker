// src/img-proxy/console/api.ts
//
// Task 5+6: 9 个 console api endpoint handler + handleConsoleRequest 主入口。
//
//   GET  /admin/api/stats           - 返回 stats 快照
//   GET  /admin/api/log             - 按 alias/status/streamStatus/sinceMs filter log 行
//   GET  /admin/api/config          - 当前生效 img_proxy 三个 runtime 字段
//   POST /admin/api/config          - atomic write 到 ctx.configPath + config.reload()
//   GET  /admin/api/routes          - 列出 routes.json 所有 route
//   POST /admin/api/routes/disable  - setRouteDisabled(true)
//   POST /admin/api/routes/enable   - setRouteDisabled(false)
//   POST /admin/api/cache/clear     - cleanupOldCache + resetHealthCache
//   GET  /admin/api/health          - uptimeMs / pid / routeCount / cacheFiles / cacheBytes
//
// 写操作 (POST) 全部走 audit log helper append 一行到 ctx.logPath。
// console_enabled gate 在 handleConsoleRequest 第一行:false 直接 404。

import { existsSync, readdirSync, statSync, writeFileSync, renameSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse, stringify } from '@iarna/toml';

import { config, DEFAULTS } from '../../utils/config';
import { CCLinkerError } from '../../utils/errors';
import { loadRoutes, listRoutes, setRouteDisabled } from '../routes';
import { cleanupOldCache } from '../server';
import { readRecentLogLines } from './log-parser';
import { INDEX_HTML } from './html';
import { setConsoleEnabled } from './config-writer';
import type { HealthStats, RouteListEntry } from './types';

// === health cache (Task 5):5s TTL module singleton,避免 /health 每次 statSync N 个文件 ===
const CACHE_TTL_MS = 5000;
let _cacheBytesCache: { value: number; computedAt: number } = { value: 0, computedAt: 0 };

export function getCacheBytes(cacheDir: string): number {
  if (Date.now() - _cacheBytesCache.computedAt < CACHE_TTL_MS) {
    return _cacheBytesCache.value;
  }
  let total = 0;
  if (existsSync(cacheDir)) {
    for (const f of readdirSync(cacheDir)) {
      try { total += statSync(join(cacheDir, f)).size; } catch {}
    }
  }
  _cacheBytesCache = { value: total, computedAt: Date.now() };
  return total;
}

export function resetHealthCache(): void {
  _cacheBytesCache = { value: 0, computedAt: 0 };
}

// === audit log helper ===
// 写一条 INFO 行(JSON payload)到 ctx.logPath,供事后回溯 console 写操作。
// writeFileSync fail 不抛(console 写操作不应该因 audit log 失败回滚业务写)。
//
// 设计说明 (review): 这里有意 **不走** src/utils/logger.ts:
//   - logger.ts 格式 "[YYYY-MM-DD HH:mm:ss] [INFO] message" 与 img-proxy log 不同
//   - log-parser.ts:4 的正则 "^\\[([^\\]]+)\\] (?:INFO|WARN|ERROR) (.+)$" 是
//     为 img-proxy 的 ISO timestamp + JSON body 格式设计,与 logger 不兼容
//   - 混合会让 Log tab 的 filter/alerts 漏判一半条目
// 所以 audit + appendLog 是 **img-proxy log 专属 writer**,与 src/utils/logger.ts
// 是两个并行体系。如未来要让 console 写入 logger,需要重写 log-parser regex。
function audit(action: string, data: Record<string, unknown>, logPath: string): void {
  try {
    const payload = JSON.stringify({ time: new Date().toISOString(), console_action: action, ...data, trigger: 'console' });
    appendLog(`INFO ${payload}`, logPath);
  } catch {}
}

/** 与 server.ts:70 appendLog 等价的 helper,共用相同 log 行格式。
 *  独立 export 是为了 test(以及不依赖 server.ts 的 audit log 入口)。 */
function appendLog(line: string, logPath: string): void {
  try {
    writeFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' });
  } catch {}
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

// === endpoint handlers ===

async function handleStats(stats: unknown): Promise<Response> {
  return jsonOk(stats);
}

async function handleLog(url: URL, logPath: string): Promise<Response> {
  const opts = {
    logPath,
    limit: Number(url.searchParams.get('limit')) || 100,
    alias: url.searchParams.get('alias') ?? undefined,
    status: url.searchParams.get('status') ? Number(url.searchParams.get('status')) : undefined,
    streamStatus: url.searchParams.get('streamStatus') ?? undefined,
    sinceMs: url.searchParams.get('sinceMs') ? Number(url.searchParams.get('sinceMs')) : undefined,
  };
  const entries = await readRecentLogLines(opts);
  return jsonOk(entries);
}

async function handleGetConfig(): Promise<Response> {
  return jsonOk({
    console_enabled: config.get('img_proxy.console_enabled', false),
    upstream_timeout_ms: config.get('img_proxy.upstream_timeout_ms', 0),
    stream_idle_timeout_ms: config.get('img_proxy.stream_idle_timeout_ms', 0),
  });
}

async function handlePostConfig(req: Request, ctx: ConsoleContext): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch {
    return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'body 必须是 JSON');
  }
  // bug fix (review): body=null/primitive 会让 'key in body' 抛 TypeError
  // (ECMAScript `in` 要求右操作数是 Object)。不加 guard 外层 catch 把
  // 5xx E_CONSOLE_INTERNAL,语义错(本应是 400 E_CONSOLE_BAD_REQUEST),
  // 且 raw operator error message 透传到 client。sibling handlers
  // (handlePostDisable/Enable) 都用 `typeof X !== 'string'`,本 handler 之前漏了同一层校验。
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'body 必须是 JSON object');
  }

  const allowed = ['console_enabled', 'upstream_timeout_ms', 'stream_idle_timeout_ms'] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }
  if (Object.keys(updates).length === 0) return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'no valid keys');

  // console_enabled 用共用的 setConsoleEnabled helper — CLI img-proxy console enable
  // 走的是同一个原子写路径,避免 CLI 和 handler 各自实现一遍 → drift。
  if ('console_enabled' in updates && typeof updates.console_enabled === 'boolean') {
    try {
      setConsoleEnabled(ctx.configPath, updates.console_enabled);
    } catch (err) {
      return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', (err as Error).message);
    }
  }
  // upstream_timeout_ms / stream_idle_timeout_ms 仍走原 inline 逻辑
  // (这两个字段没有独立的 helper,直接在 handlePostConfig 里 atomic-write)
  const otherUpdates: Record<string, unknown> = {};
  for (const key of ['upstream_timeout_ms', 'stream_idle_timeout_ms'] as const) {
    if (key in updates) otherUpdates[key] = updates[key];
  }
  if (Object.keys(otherUpdates).length > 0) {
    let current: any = {};
    try {
      current = parse(readFileSync(ctx.configPath, 'utf8')) ?? {};
    } catch (err) {
      return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `读 config.toml 失败: ${err}`);
    }
    const existing = current.img_proxy;
    const baseImgProxy =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : { ...DEFAULTS.img_proxy };
    current.img_proxy = { ...baseImgProxy, ...otherUpdates };
    try {
      const tmp = ctx.configPath + '.tmp';
      writeFileSync(tmp, stringify(current), { mode: 0o600 });
      renameSync(tmp, ctx.configPath);
    } catch (err) {
      return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `写 config.toml 失败: ${err}`);
    }
    try {
      config.reload();
    } catch (err) {
      return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `reload 失败: ${err}`);
    }
  }

  audit('config_update', { applied: updates }, ctx.logPath);
  return jsonOk({ ok: true, applied: updates });
}

async function handleGetRoutes(ctx: ConsoleContext): Promise<Response> {
  // bug fix (review): 之前 listRoutes() 默认参数走 IMG_PROXY_ROUTES_PATH,
  // 而 handleHealth/handlePostDisable/handlePostEnable 都用 ctx.routesPath。
  // 今天 ctx === IMG_PROXY_ROUTES_PATH 时被掩盖;一旦 ctx.routesPath ≠ 默认路径
  // (test / 未来 --routes-path flag),GET 返生产 routes 但 POST 写测试文件,Routes tab
  // 与实际 proxy 状态失同步。
  const routes = listRoutes(ctx.routesPath).map((r): RouteListEntry => ({
    alias: r.alias,
    upstream: r.upstream,
    installed_at: r.installed_at,
    disabled: !!r.disabled,
  }));
  return jsonOk(routes);
}

async function handlePostDisable(req: Request, ctx: ConsoleContext): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch {
    return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'body 必须是 JSON');
  }
  const alias = body?.alias;
  if (typeof alias !== 'string') return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'alias 必填');

  try {
    await setRouteDisabled(ctx.routesPath, alias, true);
  } catch (err) {
    // bug fix (review): 用结构化 err.code 而非 msg.startsWith('unknown alias')
    // — 字符串匹配脆弱,任何文案重构会静默 broken。setRouteDisabled 现在抛
    // CCLinkerError('E_IMG_PROXY_UNKNOWN_ALIAS', ...)。
    if (err instanceof CCLinkerError && err.code === 'E_IMG_PROXY_UNKNOWN_ALIAS') {
      return jsonError(404, 'E_CONSOLE_UNKNOWN_ALIAS', err.message);
    }
    return jsonError(500, 'E_CONSOLE_ROUTES_LOCK_FAILED', (err as Error).message);
  }
  audit('routes_disable', { alias }, ctx.logPath);
  return jsonOk({ ok: true });
}

async function handlePostEnable(req: Request, ctx: ConsoleContext): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch {
    return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'body 必须是 JSON');
  }
  const alias = body?.alias;
  if (typeof alias !== 'string') return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'alias 必填');

  try {
    await setRouteDisabled(ctx.routesPath, alias, false);
  } catch (err) {
    // bug fix (review): 同 handlePostDisable — 用 err.code 而非字符串前缀。
    if (err instanceof CCLinkerError && err.code === 'E_IMG_PROXY_UNKNOWN_ALIAS') {
      return jsonError(404, 'E_CONSOLE_UNKNOWN_ALIAS', err.message);
    }
    return jsonError(500, 'E_CONSOLE_ROUTES_LOCK_FAILED', (err as Error).message);
  }
  audit('routes_enable', { alias }, ctx.logPath);
  return jsonOk({ ok: true });
}

async function handlePostCacheClear(ctx: ConsoleContext): Promise<Response> {
  // maxAgeHours=0 → 全部清(用户主动点 "Clear" 就是想要全部清空)
  const removed = cleanupOldCache(ctx.cacheDir, 0);
  // 让下次 /health 重算 cacheBytes(否则会返陈旧 TTL 内的旧值)
  resetHealthCache();
  audit('cache_clear', { removed }, ctx.logPath);
  return jsonOk({ ok: true, removed });
}

async function handleHealth(stats: { startedAt?: number }, ctx: ConsoleContext): Promise<Response> {
  const h: HealthStats = {
    // startedAt 是 Task 8 给 stats 加的字段;Task 6 阶段 stats 可能没有,
    // 此时 uptimeMs = NaN,但 typeof NaN === 'number',test toHaveProperty('uptimeMs') 仍 pass。
    uptimeMs: Date.now() - (stats.startedAt ?? Date.now()),
    pid: process.pid,
    routeCount: Object.keys(loadRoutes(ctx.routesPath).routes).length,
    cacheFiles: existsSync(ctx.cacheDir) ? readdirSync(ctx.cacheDir).length : 0,
    cacheBytes: getCacheBytes(ctx.cacheDir),
  };
  return jsonOk(h);
}

// === 主入口 ===

export interface ConsoleContext {
  /** 已 expandPath 的绝对路径(如 ~/... → /Users/you/...)。
   *  readFileSync 不识别 '~',所以必须是绝对路径。cli 在 Task 9 接线时展开。 */
  configPath: string;
  routesPath: string;
  cacheDir: string;
  logPath: string;
  /** ProxyServer['stats']。Task 8 会扩展字段(byStatus / byAlias / recent / startedAt),
   *  Task 6 阶段只用到 startedAt(可选)和 totalRequests / strippedImages。 */
  stats: { totalRequests?: number; strippedImages?: number; startedAt?: number; [k: string]: unknown };
}

export async function handleConsoleRequest(req: Request, url: URL, ctx: ConsoleContext): Promise<Response> {
  // console_enabled gate:false 直接 404(spec §7.3 — "方案 A 永远 mount,handler 内
  // 读最新 config")。这样 daemon 启动后改 console_enabled=true 下一请求立即生效,
  // 不需要重启。
  if (!config.get('img_proxy.console_enabled', false)) {
    return new Response('Console disabled. Set img_proxy.console_enabled=true in config.toml.', { status: 404 });
  }

  const path = url.pathname;
  const method = req.method;

  // bug fix (review): GET / returns the SPA HTML;前 plan / Task 6/7 漏接,
  // Task 8 接管 path 但 handler 没分支,导致 INDEX_HTML 不可达。
  if (path === '/' && method === 'GET') {
    return new Response(INDEX_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  try {
    if (path === '/admin/api/stats' && method === 'GET') return await handleStats(ctx.stats);
    if (path === '/admin/api/log' && method === 'GET') return await handleLog(url, ctx.logPath);
    if (path === '/admin/api/config' && method === 'GET') return await handleGetConfig();
    if (path === '/admin/api/config' && method === 'POST') return await handlePostConfig(req, ctx);
    if (path === '/admin/api/routes' && method === 'GET') return await handleGetRoutes(ctx);
    if (path === '/admin/api/routes/disable' && method === 'POST') return await handlePostDisable(req, ctx);
    if (path === '/admin/api/routes/enable' && method === 'POST') return await handlePostEnable(req, ctx);
    if (path === '/admin/api/cache/clear' && method === 'POST') return await handlePostCacheClear(ctx);
    if (path === '/admin/api/health' && method === 'GET') return await handleHealth(ctx.stats, ctx);
    return jsonError(404, 'E_CONSOLE_NOT_FOUND', `unknown endpoint: ${method} ${path}`);
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_INTERNAL', (err as Error).message);
  }
}