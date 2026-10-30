// src/img-proxy/openai-dialect.ts
//
// OpenAI 请求体"方言归一化"改写器(命名: openai-dialect-normalizer)。
//
// 背景(2026-10-30 实测定案,OpenCode Go 网关 https://opencode.ai/zen/go):
// 部分客户端(Vercel ai-sdk 系,如 ZCode 3.17.1 provider-utils)对 OpenAI 兼容
// 端点发出的字段名不在网关白名单里,三个独立的雷、任一命中都是网关层
// 503 {"error":{"type":"server_error","message":"Upstream request failed:
// Endpoint is unavailable."}}(逐项实测,对照组 reasoning_effort 单独发送 200):
//
//   1) max_output_tokens / max_completion_tokens —— 网关只认标准 max_tokens
//   2) thinking (Anthropic 方言) —— 503
//   3) enable_thinking (vLLM/Qwen 方言) —— 503
//   4) reasoning: {effort} (对象方言) —— 503;reasoning_effort(OpenAI 标准)才是唯一受支持的思考档位字段
//   5) max_tokens: null —— 顺带剔除(非法值)
//
// 设计原则:fail-open —— body 非 JSON / 非 object / 解析失败一律原字节透传,
// 改写器绝不成为转发的阻塞点。changed 数组供调用方写日志(observability)。

/** 归一化结果:改写后的 body + 人类可读的变更清单(空 = 未改写,原字节返回)。 */
export interface DialectNormalizeResult {
  body: Uint8Array;
  changed: string[];
}

/** 网关不认、需要剥除的思考参数方言字段(保留 reasoning_effort)。 */
const DROPPED_THINKING_FIELDS = ['thinking', 'enable_thinking', 'reasoning'] as const;

/** max_tokens 的两种方言别名,按此优先级归一到 max_tokens。 */
const MAX_TOKENS_ALIASES = ['max_output_tokens', 'max_completion_tokens'] as const;

/**
 * 归一化 OpenAI 兼容 chat/completions 请求体。
 *
 * 幂等:已是标准形态的 body 原样返回(不重序列化,保持字节级不变);
 * 只有发生实际改写时才重新序列化(JSON.stringify 紧凑形态)。
 */
export function normalizeOpenAIDialectBody(raw: Uint8Array): DialectNormalizeResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  } catch {
    return { body: raw, changed: [] };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { body: raw, changed: [] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { body: raw, changed: [] };
  }
  const o = obj as Record<string, unknown>;
  const changed: string[] = [];

  // 1) 先剔 max_tokens: null —— 必须在别名搬运之前,否则
  //    {max_tokens:null, max_output_tokens:128} 会因 null "在场"阻断 128 的搬运
  //    (K3 终审 P2-1:旧顺序下有效值被误吞)
  if ('max_tokens' in o && o.max_tokens === null) {
    delete o.max_tokens;
    changed.push('drop max_tokens:null');
  }
  // 2) max_output_tokens / max_completion_tokens 别名字段总是剥除(它们本身
  //    就是 503 触发器);仅当标准 max_tokens 缺席且别名值非 null/undefined 时
  //    才把值搬运过去(不覆盖显式值、不搬空值)。两个别名同时在场时全部剥 ——
  //    值搬运只做一次。
  //    (glm 首审 P1-1:旧版循环首中即 break,双别名场景第二个残留出体仍 503)
  let moved = false;
  for (const src of MAX_TOKENS_ALIASES) {
    if (src in o) {
      const v = o[src];
      if (!moved && !('max_tokens' in o) && v !== null && v !== undefined) {
        o.max_tokens = v;
        moved = true;
        changed.push(`${src}->max_tokens`);
      } else {
        changed.push(`drop ${src}`);
      }
      delete o[src];
    }
  }
  // 3) 剥思考方言字段(保留 reasoning_effort)
  for (const bad of DROPPED_THINKING_FIELDS) {
    if (bad in o) {
      delete o[bad];
      changed.push(`drop ${bad}`);
    }
  }

  if (changed.length === 0) return { body: raw, changed: [] };
  return { body: new TextEncoder().encode(JSON.stringify(o)), changed };
}
