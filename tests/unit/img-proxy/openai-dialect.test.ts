// tests/unit/img-proxy/openai-dialect.test.ts
//
// openai-dialect-normalizer 单测:OpenCode Go 网关方言归一化
// (max_output_tokens→max_tokens / 剥 thinking 方言 / fail-open)。
// 实证依据见 src/img-proxy/openai-dialect.ts 头注(2026-10-30 逐项实测)。

import { describe, it, expect } from 'bun:test';
import { normalizeOpenAIDialectBody } from '../../../src/img-proxy/openai-dialect';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('normalizeOpenAIDialectBody', () => {
  it('max_output_tokens → max_tokens(网关 503 主雷,ZCode/ai-sdk 实际发的字段名)', () => {
    const r = normalizeOpenAIDialectBody(enc('{"model":"gemini-4-argon","max_output_tokens":1,"messages":[]}'));
    const parsed = JSON.parse(new TextDecoder().decode(r.body));
    expect(parsed.max_tokens).toBe(1);
    expect(parsed.max_output_tokens).toBeUndefined();
    expect(r.changed).toContain('max_output_tokens->max_tokens');
  });

  it('max_completion_tokens → max_tokens(另一别名,优先级次之)', () => {
    const r = normalizeOpenAIDialectBody(enc('{"max_completion_tokens":128,"messages":[]}'));
    const parsed = JSON.parse(new TextDecoder().decode(r.body));
    expect(parsed.max_tokens).toBe(128);
    expect(parsed.max_completion_tokens).toBeUndefined();
  });

  it('已有标准 max_tokens 时不从别名搬运(不覆盖用户显式值)', () => {
    const r = normalizeOpenAIDialectBody(enc('{"max_tokens":64,"max_output_tokens":999}'));
    const parsed = JSON.parse(new TextDecoder().decode(r.body));
    expect(parsed.max_tokens).toBe(64);
    // 别名字段仍被剥(它就是 503 触发器,不能留)
    expect(parsed.max_output_tokens).toBeUndefined();
  });

  it('剥 thinking / enable_thinking / reasoning 对象方言,保留 reasoning_effort', () => {
    // ZCode 3.17.1 实测 body 形态(四方言齐发)
    const r = normalizeOpenAIDialectBody(enc(JSON.stringify({
      model: 'gemini-4-argon', messages: [], stream: true,
      thinking: { type: 'enabled' }, enable_thinking: true,
      reasoning_effort: 'low', reasoning: { effort: 'low' },
    })));
    const parsed = JSON.parse(new TextDecoder().decode(r.body));
    expect(parsed.thinking).toBeUndefined();
    expect(parsed.enable_thinking).toBeUndefined();
    expect(parsed.reasoning).toBeUndefined();
    expect(parsed.reasoning_effort).toBe('low');  // 唯一受支持的思考档位字段,保留
    expect(r.changed).toContain('drop thinking');
    expect(r.changed).toContain('drop enable_thinking');
    expect(r.changed).toContain('drop reasoning');
  });

  it('P1-1 双别名同时在场: 全部剥除,值搬运仅一次(glm 首审发现)', () => {
    // 形态一: 标准 max_tokens 缺席 → 首别名搬值,次别名纯剥
    const r1 = normalizeOpenAIDialectBody(enc('{"max_output_tokens":1,"max_completion_tokens":2,"messages":[]}'));
    const p1 = JSON.parse(new TextDecoder().decode(r1.body));
    expect(p1.max_tokens).toBe(1);
    expect(p1.max_output_tokens).toBeUndefined();
    expect(p1.max_completion_tokens).toBeUndefined();
    // 形态二: 标准 max_tokens 在场 → 双别名都纯剥,不覆盖显式值
    const r2 = normalizeOpenAIDialectBody(enc('{"max_tokens":64,"max_output_tokens":1,"max_completion_tokens":2}'));
    const p2 = JSON.parse(new TextDecoder().decode(r2.body));
    expect(p2.max_tokens).toBe(64);
    expect(p2.max_output_tokens).toBeUndefined();
    expect(p2.max_completion_tokens).toBeUndefined();
    expect(r2.changed).toEqual(['drop max_output_tokens', 'drop max_completion_tokens']);
  });

  it('K3 P2-1 null 组合: 先剔 null 再搬别名值,有效值不被误吞', () => {
    // 形态一: max_tokens:null + 别名有值 → null 先剔,别名值搬入
    const r1 = normalizeOpenAIDialectBody(enc('{"max_tokens":null,"max_output_tokens":128,"messages":[]}'));
    const p1 = JSON.parse(new TextDecoder().decode(r1.body));
    expect(p1.max_tokens).toBe(128);
    expect(p1.max_output_tokens).toBeUndefined();
    // 形态二: 双别名,首别名 null 次别名有值 → 首别名纯剥,次别名搬值
    const r2 = normalizeOpenAIDialectBody(enc('{"max_output_tokens":null,"max_completion_tokens":128}'));
    const p2 = JSON.parse(new TextDecoder().decode(r2.body));
    expect(p2.max_tokens).toBe(128);
    // 形态三: 单别名 null → 不产生自相矛盾的 move+drop 日志
    const r3 = normalizeOpenAIDialectBody(enc('{"max_output_tokens":null}'));
    const p3 = JSON.parse(new TextDecoder().decode(r3.body));
    expect('max_tokens' in p3).toBe(false);
    expect(r3.changed).toEqual(['drop max_output_tokens']);
  });

  it('max_tokens: null 剔除', () => {
    const r = normalizeOpenAIDialectBody(enc('{"max_tokens":null,"messages":[]}'));
    const parsed = JSON.parse(new TextDecoder().decode(r.body));
    expect('max_tokens' in parsed).toBe(false);
    expect(r.changed).toContain('drop max_tokens:null');
  });

  it('标准形态 body 字节级原样返回(幂等,不重序列化)', () => {
    const raw = enc('{"model":"m","max_tokens":100,"reasoning_effort":"high","messages":[]}');
    const r = normalizeOpenAIDialectBody(raw);
    expect(r.changed).toEqual([]);
    expect(Buffer.compare(Buffer.from(r.body), Buffer.from(raw))).toBe(0);
  });

  it('fail-open: 非 JSON body 原字节透传', () => {
    const raw = enc('not-json-at-all');
    const r = normalizeOpenAIDialectBody(raw);
    expect(r.changed).toEqual([]);
    expect(Buffer.compare(Buffer.from(r.body), Buffer.from(raw))).toBe(0);
  });

  it('fail-open: JSON 数组/标量原样透传(不是 chat 请求对象)', () => {
    for (const s of ['[1,2,3]', '"str"', '42', 'null']) {
      const raw = enc(s);
      const r = normalizeOpenAIDialectBody(raw);
      expect(r.changed).toEqual([]);
      expect(Buffer.compare(Buffer.from(r.body), Buffer.from(raw))).toBe(0);
    }
  });
});
