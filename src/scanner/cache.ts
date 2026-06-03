import { readFileSync, writeFileSync, existsSync } from 'fs';
import { SCAN_CACHE_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export type FileCache = Map<string, number>;
export type FileCacheMeta = { schemaVersion: number };
export type FileCacheFile = { meta: FileCacheMeta; cache: Record<string, number> };

const CURRENT_SCHEMA_VERSION = 4;

export function loadCache(cachePath?: string): FileCache {
  const path = cachePath ?? SCAN_CACHE_PATH;
  if (!existsSync(path)) return new Map();

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FileCacheFile;
    // 关键：schemaVersion 缺失或不匹配时返回空 cache，触发 scanner 全量重扫
    if (parsed.meta?.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      logger.info(
        `scan_cache schemaVersion=${parsed.meta?.schemaVersion ?? 'missing'}，` +
        `当前要求=${CURRENT_SCHEMA_VERSION}，丢弃 cache 全量重扫`
      );
      return new Map();
    }
    return new Map(Object.entries(parsed.cache ?? {}));
  } catch {
    return new Map();
  }
}

export function saveCache(cache: FileCache, cachePath?: string): void {
  const path = cachePath ?? SCAN_CACHE_PATH;
  const data: FileCacheFile = {
    meta: { schemaVersion: CURRENT_SCHEMA_VERSION },
    cache: Object.fromEntries(cache),
  };
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}
