import { describe, it, expect } from 'bun:test';
import { updateByAlias, pushRecent } from '../../../../src/img-proxy/console/stats-helpers';
import type { AliasStats, RecentEntry } from '../../../../src/img-proxy/console/types';

describe('stats helpers', () => {
  it('updateByAlias: 增量更新 byAlias 聚合', () => {
    const stats = { byAlias: {} as Record<string, AliasStats> };
    updateByAlias(stats, 'glm-5.2', {
      requests: 1, stripped: 2, bytes: 100, chunks: 3, durationMs: 200,
      inputTokens: 50, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 5,
    });
    updateByAlias(stats, 'glm-5.2', {
      requests: 1, stripped: 0, bytes: 200, chunks: 5, durationMs: 400,
      inputTokens: 70, outputTokens: 30, cacheReadTokens: 40, cacheCreationTokens: 10,
    });
    expect(stats.byAlias['glm-5.2']).toEqual({
      requests: 2, stripped: 2, bytes: 300, chunks: 8, avgDurationMs: 300, lastAt: expect.any(Number),
      inputTokens: 120, outputTokens: 50, cacheReadTokens: 70, cacheCreationTokens: 15,
    });
  });

  it('updateByAlias: 首次 alias 创建 entry', () => {
    const stats = { byAlias: {} as Record<string, AliasStats> };
    updateByAlias(stats, 'byte-agent', {
      requests: 1, stripped: 0, bytes: 50, chunks: 1, durationMs: 100,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    expect(stats.byAlias['byte-agent']).toBeDefined();
    expect(stats.byAlias['byte-agent']!.requests).toBe(1);
  });

  it('pushRecent: unshift + 200 cap', () => {
    const stats: { recent: RecentEntry[] } = { recent: [] };
    for (let i = 0; i < 250; i++) pushRecent(stats, { ts: i, alias: 'x', status: 200, stream_status: 'complete', chunks: 0, bytes: 0, duration_ms: 0, stripped: 0 });
    expect(stats.recent.length).toBe(200);
    expect(stats.recent[0]!.ts).toBe(249); // 最新在头部
    expect(stats.recent[199]!.ts).toBe(50); // 最旧在尾部
  });
});