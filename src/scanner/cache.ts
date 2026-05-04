import { readFileSync, writeFileSync, existsSync } from 'fs';
import { SCAN_CACHE_PATH } from '../utils/paths';

export type FileCache = Map<string, number>;

export function loadCache(cachePath?: string): FileCache {
  const path = cachePath ?? SCAN_CACHE_PATH;
  if (!existsSync(path)) return new Map();

  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return new Map(Object.entries(data).map(([k, v]) => [k, v as number]));
  } catch {
    return new Map();
  }
}

export function saveCache(cache: FileCache, cachePath?: string): void {
  const path = cachePath ?? SCAN_CACHE_PATH;
  const obj = Object.fromEntries(cache);
  writeFileSync(path, JSON.stringify(obj, null, 2), { mode: 0o600 });
}
