import { describe, it, expect } from 'bun:test';
import { applyUsageLine, type UsageAccum } from '../../../src/img-proxy/server';

function emptyAcc(): UsageAccum {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

describe('applyUsageLine', () => {
  it('extracts Anthropic message_start usage (input + output + cache)', () => {
    const acc = emptyAcc();
    applyUsageLine(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1234,"output_tokens":1,"cache_read_input_tokens":800,"cache_creation_input_tokens":200}}}',
      acc,
    );
    expect(acc).toEqual({ inputTokens: 1234, outputTokens: 1, cacheReadTokens: 800, cacheCreationTokens: 200 });
  });

  it('Anthropic message_delta overrides output_tokens (max-of)', () => {
    // message_start 通常报 output_tokens=1 (只是"开始"),message_delta 才是终值
    const acc = emptyAcc();
    applyUsageLine(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1234,"output_tokens":1}}}',
      acc,
    );
    applyUsageLine(
      'data: {"type":"message_delta","usage":{"output_tokens":567}}',
      acc,
    );
    // input_tokens 不被覆盖,output_tokens 取终值
    expect(acc.inputTokens).toBe(1234);
    expect(acc.outputTokens).toBe(567);
  });

  it('extracts OpenAI-compat usage (prompt + completion)', () => {
    const acc = emptyAcc();
    applyUsageLine(
      'data: {"id":"cmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
      acc,
    );
    expect(acc).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it('handles non-streaming single JSON body (no "data: " prefix)', () => {
    // glm 等 OpenAI-compat API 的非流式响应:整 body 一个 JSON object,没换行
    const acc = emptyAcc();
    applyUsageLine(
      '{"id":"cmpl-1","usage":{"prompt_tokens":200,"completion_tokens":80}}',
      acc,
    );
    expect(acc).toEqual({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it('skips [DONE] terminator (OpenAI stream end marker)', () => {
    const acc = emptyAcc();
    applyUsageLine('data: [DONE]', acc);
    expect(acc).toEqual(emptyAcc());
  });

  it('skips "event: ..." lines (no data payload)', () => {
    const acc = emptyAcc();
    applyUsageLine('event: message_start', acc);
    applyUsageLine('event: content_block_delta', acc);
    expect(acc).toEqual(emptyAcc());
  });

  it('skips empty / whitespace-only lines', () => {
    const acc = emptyAcc();
    applyUsageLine('', acc);
    applyUsageLine('   ', acc);
    applyUsageLine('\t', acc);
    expect(acc).toEqual(emptyAcc());
  });

  it('silently skips malformed JSON (no throw, no partial update)', () => {
    const acc = emptyAcc();
    // 半截 JSON
    applyUsageLine('data: {"usage":{"input_tokens":', acc);
    // 完整但语法错
    applyUsageLine('data: {not json}', acc);
    // 顶层是 array
    applyUsageLine('data: [1,2,3]', acc);
    expect(acc).toEqual(emptyAcc());
  });

  it('max-of is monotonic (re-asserting same value does not regress)', () => {
    // 上游偶尔会重复声明同一数值(同一字段在 message_start 与 message_stop 各发一次)
    const acc = emptyAcc();
    applyUsageLine('data: {"message":{"usage":{"input_tokens":1000,"output_tokens":50}}}', acc);
    applyUsageLine('data: {"message":{"usage":{"input_tokens":1000,"output_tokens":50}}}', acc);
    expect(acc).toEqual({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it('max-of prevents regression on re-delivery of stale value', () => {
    // 防御性:即使上游以乱序 / 重复声明给出较小值,最终值也不应回退
    const acc = emptyAcc();
    applyUsageLine('data: {"message":{"usage":{"input_tokens":1000,"output_tokens":500}}}', acc);
    applyUsageLine('data: {"message":{"usage":{"input_tokens":1000,"output_tokens":50}}}', acc);  // 旧值
    expect(acc.outputTokens).toBe(500);  // 保留 max
  });

  it('cache fields use max-of across multiple events', () => {
    // Anthropic cache_read 在 message_start 报一次,之后不再变
    // 防御性:即使重复声明,也不回退
    const acc = emptyAcc();
    applyUsageLine('data: {"message":{"usage":{"cache_read_input_tokens":800,"cache_creation_input_tokens":200}}}', acc);
    applyUsageLine('data: {"message":{"usage":{"cache_read_input_tokens":800}}}', acc);
    expect(acc.cacheReadTokens).toBe(800);
    expect(acc.cacheCreationTokens).toBe(200);
  });

  it('tolerates extra "data: " whitespace (data:   {...})', () => {
    const acc = emptyAcc();
    applyUsageLine('data:    {"usage":{"prompt_tokens":10,"completion_tokens":5}}', acc);
    expect(acc).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it('missing usage field is a no-op', () => {
    const acc = emptyAcc();
    applyUsageLine('data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}', acc);
    expect(acc).toEqual(emptyAcc());
  });

  it('usage with non-numeric fields is ignored (does not NaN-out the accum)', () => {
    const acc = emptyAcc();
    applyUsageLine('data: {"usage":{"input_tokens":"1234","output_tokens":null}}', acc);
    // 字符串 / null 不应覆盖 number 字段
    expect(acc.inputTokens).toBe(0);
    expect(acc.outputTokens).toBe(0);
  });

  it('mixes Anthropic and OpenAI-compat across calls in same accum (one request, two formats)', () => {
    // 极少见但可能:某些代理把上游 SSE 重新序列化时混了格式
    const acc = emptyAcc();
    applyUsageLine('data: {"message":{"usage":{"input_tokens":100,"output_tokens":10}}}', acc);
    applyUsageLine('data: {"usage":{"prompt_tokens":200,"completion_tokens":20}}', acc);
    // max-of:input 取 200,output 取 20
    expect(acc.inputTokens).toBe(200);
    expect(acc.outputTokens).toBe(20);
  });
});
