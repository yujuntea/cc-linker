import type { AliasStats, RecentEntry } from './types';

export interface ByAliasDelta {
  requests: number;
  stripped: number;
  bytes: number;
  chunks: number;
  durationMs: number;
  // 单次请求的最终 token 值(由 server.ts TransformStream 的 max-of 累加得出)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function updateByAlias(
  stats: { byAlias: Record<string, AliasStats> },
  alias: string,
  m: ByAliasDelta,
): void {
  const a = stats.byAlias[alias] ??= {
    requests: 0, stripped: 0, bytes: 0, chunks: 0, avgDurationMs: 0, lastAt: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  };
  const prevRequests = a.requests;
  a.requests += m.requests;
  a.stripped += m.stripped;
  a.bytes += m.bytes;
  a.chunks += m.chunks;
  a.inputTokens += m.inputTokens;
  a.outputTokens += m.outputTokens;
  a.cacheReadTokens += m.cacheReadTokens;
  a.cacheCreationTokens += m.cacheCreationTokens;
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