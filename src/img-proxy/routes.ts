import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { IMG_PROXY_ROUTES_PATH } from '../utils/paths';
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

export function saveRoutes(path: string, table: RouteTable): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(table, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function addRoute(path: string, alias: string, upstream: string, providerPath: string): void {
  const table = loadRoutes(path);
  table.routes[alias] = {
    alias, upstream, provider_path: providerPath,
    original_base_url: upstream, installed_at: new Date().toISOString(),
  };
  saveRoutes(path, table);
}

export function removeRoute(path: string, alias: string): void {
  const table = loadRoutes(path);
  if (table.routes[alias]) {
    delete table.routes[alias];
    saveRoutes(path, table);
  }
}

// 重命名:resolveUpstream → getUpstreamByAlias(语义更清晰)
export function getUpstreamByAlias(path: string, alias: string): string | null {
  return loadRoutes(path).routes[alias]?.upstream ?? null;
}

// 新加:按 upstream 查 proxy URL(wrapper 调用)
export function resolveProxyByUpstream(
  path: string,
  port: number,
  hostname: string,
  upstream: string
): string | null {
  const table = loadRoutes(path);
  for (const [alias, entry] of Object.entries(table.routes)) {
    if (entry.upstream === upstream) {
      return `http://${hostname}:${port}/${alias}`;
    }
  }
  return null;
}

export function listRoutes(path: string = IMG_PROXY_ROUTES_PATH): RouteEntry[] {
  return Object.values(loadRoutes(path).routes);
}
