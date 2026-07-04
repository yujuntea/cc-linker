import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { IMG_PROXY_ROUTES_PATH } from '../utils/paths';
import { lock as lockfileLock } from 'proper-lockfile';
import type { RouteTable, RouteEntry } from './types';

export function loadRoutes(path: string = IMG_PROXY_ROUTES_PATH): RouteTable {
  if (!existsSync(path)) return { version: 1, routes: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw && typeof raw === 'object' && raw.version === 1 && raw.routes) return raw as RouteTable;
  } catch {
    // 损坏当空表
  }
  return { version: 1, routes: {} };
}

/**
 * Normalize URL for comparison: strip trailing slash, lowercase host.
 * Returns original string if not parseable (defensive — bad URLs don't crash).
 */
export function normalizeUrlForCompare(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    let p = u.pathname.replace(/\/+$/, '');
    if (!p) p = '/';
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}${p}`;
  } catch {
    return url;
  }
}

/**
 * 跨进程序列化 routes.json 的写操作(已有 addRoute + 新 saveRoutes 都走这里)。
 * uses proper-lockfile。proper-lockfile 会把传入路径视作"要锁的目标"并自动在该
 * 路径旁创一个 lockfile;但用户给的 routes.json 还不存在时它会先把目标创建成空文件。
 * 为避免污染 routes.json 路径空间(以及不必要的 errno),我们传一个独立的 sentinel
 * 路径 '.lock' 作 lockfilePath + retries(避免锁文件被反复创建后残留)。
 */
async function withRoutesLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const dir = dirname(path);
  // 用一个独立 sentinel 文件做 lockfile 目标,proper-lockfile 会在它旁边写 .lock
  const lockfilePath = join(dir, '.routes.lock');
  if (!existsSync(lockfilePath)) {
    try { writeFileSync(lockfilePath, '', { mode: 0o600 }); } catch { /* 并发已存在,忽略 */ }
  }
  const release = await lockfileLock(lockfilePath, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function saveRoutes(path: string, table: RouteTable): Promise<void> {
  await withRoutesLock(path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(table, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  });
}

export async function addRoute(path: string, alias: string, upstream: string, providerPath: string): Promise<void> {
  await withRoutesLock(path, async () => {
    const table = loadRoutes(path);
    const existing = table.routes[alias];
    table.routes[alias] = {
      alias, upstream, provider_path: providerPath,
      original_base_url: upstream,
      installed_at: existing?.installed_at ?? new Date().toISOString(),
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(table, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  });
}

export async function removeRoute(path: string, alias: string): Promise<void> {
  await withRoutesLock(path, async () => {
    const table = loadRoutes(path);
    if (table.routes[alias]) {
      delete table.routes[alias];
      mkdirSync(dirname(path), { recursive: true });
      const tmp = path + '.tmp';
      writeFileSync(tmp, JSON.stringify(table, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    }
  });
}

// 重命名:resolveUpstream → getUpstreamByAlias(语义更清晰)
export function getUpstreamByAlias(path: string, alias: string): string | null {
  return loadRoutes(path).routes[alias]?.upstream ?? null;
}

// 新加:按 upstream 查 proxy URL(wrapper 调用)。比较前先规范化:
// 去掉末尾斜杠、小写 host —— 容忍 "https://x.com/api" vs "https://x.com/api/"
// 之类的小差异;这些差异过去会让 wrapper 静默绕过 img-proxy。写侧不做规范化
// (保留磁盘上的真实数据,Fix I-1 注释里写明)。
export function resolveProxyByUpstream(
  path: string,
  port: number,
  hostname: string,
  upstream: string
): string | null {
  const table = loadRoutes(path);
  const query = normalizeUrlForCompare(upstream);
  for (const [alias, entry] of Object.entries(table.routes)) {
    if (normalizeUrlForCompare(entry.upstream) === query) {
      return `http://${hostname}:${port}/${alias}`;
    }
  }
  return null;
}

export function listRoutes(path: string = IMG_PROXY_ROUTES_PATH): RouteEntry[] {
  return Object.values(loadRoutes(path).routes);
}
