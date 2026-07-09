import type { AliasStats, RecentEntry } from './types';

export function updateByAlias(
  stats: { byAlias: Record<string, AliasStats> },
  alias: string,
  m: { requests: number; stripped: number; bytes: number; chunks: number; durationMs: number }
): void {
  const a = stats.byAlias[alias] ??= { requests: 0, stripped: 0, bytes: 0, chunks: 0, avgDurationMs: 0, lastAt: 0 };
  const prevRequests = a.requests;
  a.requests += m.requests;
  a.stripped += m.stripped;
  a.bytes += m.bytes;
  a.chunks += m.chunks;
  // 增量平均:(旧avg × 旧n + 新duration × 新n) / 新n
  a.avgDurationMs = (a.avgDurationMs * prevRequests + m.durationMs * m.requests) / a.requests;
  a.lastAt = Date.now();
}

export function pushRecent(
  stats: { recent: RecentEntry[] },
  entry: RecentEntry
): void {
  stats.recent.unshift(entry);
  if (stats.recent.length > 200) stats.recent.length = 200;
}