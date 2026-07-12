// tests/unit/img-proxy/server-sse-cap.test.ts
//
// 2026-07-10 配套 P2-1:测 processChunkForUsage(从 TransformStream 抽出的 helper)。
// 主要覆盖 sseBuf 4MB cap 的截断行为 — 防上游畸形 SSE event OOM。

import { describe, it, expect, beforeEach } from 'bun:test';
import { processChunkForUsage, type UsageAccum } from '../../../src/img-proxy/server';

function emptyState() {
  return {
    sseBuf: '',
    truncated: false,
    utf8: new TextDecoder(),
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } as UsageAccum,
  };
}

describe('processChunkForUsage', () => {
  it('accumulates lines and extracts usage (normal case)', () => {
    const state = emptyState();
    processChunkForUsage(
      new TextEncoder().encode('data: {"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n'),
      state,
    );
    expect(state.usage.inputTokens).toBe(100);
    expect(state.usage.outputTokens).toBe(50);
  });

  it('keeps incomplete last line in sseBuf for next chunk', () => {
    const state = emptyState();
    // 第一 chunk 末尾无换行 → 留在 sseBuf
    processChunkForUsage(
      new TextEncoder().encode('data: {"usage":{"prompt_tokens":10'),
      state,
    );
    expect(state.sseBuf).toBe('data: {"usage":{"prompt_tokens":10');
    expect(state.usage.inputTokens).toBe(0);  // 没换行不解析
    // 第二 chunk 补完整
    processChunkForUsage(
      new TextEncoder().encode('0,"completion_tokens":5}}\n\n'),
      state,
    );
    expect(state.usage.inputTokens).toBe(100);
    expect(state.usage.outputTokens).toBe(5);
  });

  it('truncates sseBuf when it exceeds MAX_SSE_BUF_BYTES (4MB) and stops tracking usage', () => {
    const state = emptyState();
    // 先喂一个正常的 chunk,确认 usage tracking 工作
    processChunkForUsage(
      new TextEncoder().encode('data: {"usage":{"prompt_tokens":1}}\n'),
      state,
    );
    expect(state.usage.inputTokens).toBe(1);
    // 现在喂一个 5MB 的 chunk (> 4MB cap)
    const bigChunk = new Uint8Array(5 * 1024 * 1024);
    let truncateCalls = 0;
    processChunkForUsage(bigChunk, state, () => { truncateCalls++; });
    // 截断后 sseBuf 被清空,truncated 标记
    expect(state.truncated).toBe(true);
    expect(state.sseBuf).toBe('');
    // 2026-07-10 P1-1: onTruncate 回调被调一次(observability 钩子)
    expect(truncateCalls).toBe(1);
    // 后续 chunk 不再 tracking usage
    processChunkForUsage(
      new TextEncoder().encode('data: {"usage":{"prompt_tokens":99999}}\n'),
      state,
    );
    // usage 仍是 1(之前的 1),不增
    expect(state.usage.inputTokens).toBe(1);
  });

  it('handles chunk split mid-line (TextDecoder stream:true is a Bun guarantee)', () => {
    // 简化版:把一个 SSE line 切成两半喂,验证 helper 能跨 chunk 累积。
    // 真正的 multi-byte UTF-8 边界处理依赖 TextDecoder stream:true,
    // 由 Bun 实现保证,这里不重复测。
    const state = emptyState();
    const full = 'data: {"usage":{"prompt_tokens":42,"completion_tokens":7}}\n\n';
    const bytes = new TextEncoder().encode(full);
    const mid = Math.floor(bytes.length / 2);
    processChunkForUsage(bytes.slice(0, mid), state);
    expect(state.usage.inputTokens).toBe(0);  // 还没 newline
    processChunkForUsage(bytes.slice(mid), state);
    expect(state.usage.inputTokens).toBe(42);
    expect(state.usage.outputTokens).toBe(7);
  });

  it('passes through non-usage lines without affecting usage state', () => {
    const state = emptyState();
    processChunkForUsage(
      new TextEncoder().encode('event: message_start\n\n'),
      state,
    );
    expect(state.usage.inputTokens).toBe(0);
    expect(state.usage.outputTokens).toBe(0);
  });
});
