// src/img-proxy/console/api.ts
// Task 5 stub: getCacheBytes + resetHealthCache with 5s TTL module-level cache.
// Task 6 will append the rest of the api.ts (handleConsoleRequest + endpoints).
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// === health cache ===
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