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

import { config } from '../../utils/config';
import { loadRoutes, listRoutes, setRouteDisabled } from '../routes';
import { cleanupOldCache } from '../server';
import { readRecentLogLines } from './log-parser';
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

  const allowed = ['console_enabled', 'upstream_timeout_ms', 'stream_idle_timeout_ms'] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }
  if (Object.keys(updates).length === 0) return jsonError(400, 'E_CONSOLE_BAD_REQUEST', 'no valid keys');

  // 写回 ctx.configPath(atomic)。ctx.configPath 必须已 expandPath 成绝对路径
  // (readFileSync 不识别 '~');cli 在 Task 9 接线时会用 expandPath(CONFIG_PATH)。
  let current: any = {};
  try {
    current = parse(readFileSync(ctx.configPath, 'utf8'));
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `读 config.toml 失败: ${err}`);
  }
  current.img_proxy = { ...(current.img_proxy ?? {}), ...updates };

  try {
    const tmp = ctx.configPath + '.tmp';
    writeFileSync(tmp, stringify(current), { mode: 0o600 });
    renameSync(tmp, ctx.configPath);
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `写 config.toml 失败: ${err}`);
  }

  // 热 reload(config singleton 重新读 ctx.configPath 同源 — 生产环境 cli 传的就是
  // CONFIG_PATH,所以 reload 读到的是同一个文件;test 里 ctx.configPath 是 tmp,
  // reload 会读到 CONFIG_PATH — 这时只影响内存中的 img_proxy,不破坏本次写)。
  try {
    config.reload();
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_CONFIG_WRITE_FAILED', `reload 失败: ${err}`);
  }

  audit('config_update', { applied: updates }, ctx.logPath);
  return jsonOk({ ok: true, applied: updates });
}

async function handleGetRoutes(): Promise<Response> {
  const routes = listRoutes().map((r): RouteListEntry => ({
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
    const msg = (err as Error).message;
    if (msg.startsWith('unknown alias')) return jsonError(404, 'E_CONSOLE_UNKNOWN_ALIAS', msg);
    return jsonError(500, 'E_CONSOLE_ROUTES_LOCK_FAILED', msg);
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
    const msg = (err as Error).message;
    if (msg.startsWith('unknown alias')) return jsonError(404, 'E_CONSOLE_UNKNOWN_ALIAS', msg);
    return jsonError(500, 'E_CONSOLE_ROUTES_LOCK_FAILED', msg);
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

  try {
    if (path === '/admin/api/stats' && method === 'GET') return await handleStats(ctx.stats);
    if (path === '/admin/api/log' && method === 'GET') return await handleLog(url, ctx.logPath);
    if (path === '/admin/api/config' && method === 'GET') return await handleGetConfig();
    if (path === '/admin/api/config' && method === 'POST') return await handlePostConfig(req, ctx);
    if (path === '/admin/api/routes' && method === 'GET') return await handleGetRoutes();
    if (path === '/admin/api/routes/disable' && method === 'POST') return await handlePostDisable(req, ctx);
    if (path === '/admin/api/routes/enable' && method === 'POST') return await handlePostEnable(req, ctx);
    if (path === '/admin/api/cache/clear' && method === 'POST') return await handlePostCacheClear(ctx);
    if (path === '/admin/api/health' && method === 'GET') return await handleHealth(ctx.stats, ctx);
    return jsonError(404, 'E_CONSOLE_NOT_FOUND', `unknown endpoint: ${method} ${path}`);
  } catch (err) {
    return jsonError(500, 'E_CONSOLE_INTERNAL', (err as Error).message);
  }
}