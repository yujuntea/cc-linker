export type ModelKind = 'multimodal' | 'text-only' | 'unknown';

const MULTIMODAL_PATTERNS: RegExp[] = [
  // === Anthropic Claude ===
  /^claude-3/i, /^claude-opus/i, /^claude-sonnet/i, /^claude-haiku/i,
  // === OpenAI GPT-4 ===
  /^gpt-4/i,
  // === Google Gemini ===
  /^gemini-.*vision/i, /^gemini-1\.5-pro/i,
  // === Alibaba Qwen ===
  /^qwen.*-vl/i, /^qwen.*-omni/i,
  /^qwen3\.\d+(\.\d+)?-plus/i,
  // === Zhipu GLM(只有 -V 后缀变体)===
  /^glm-.*-?v/i,
  // === Moonshot Kimi ===
  /^kimi/i,
  // === MiniMax ===
  /^MiniMax-M3/i,
  // === Xiaomi MiMo(只有 base,不带 pro)===
  // 用 $ 锚定而非 (?!-pro) 负向 lookahead:pro 变体由下方 /mimo-.*-pro/ 显式拦截
  // spec 原版 (?!-pro) 有 bug —— backtrack 会跳过 pro 前缀,导致 mimo-v2.5-pro 被误判 multimodal
  /^mimo-v\d+(\.\d+)?$/i,
  // === ByteDance ===
  /^doubao.*-vision/i, /^seed.*-vision/i,
  // === Stepfun / Hunyuan / ERNIE ===
  /^step-1v/i, /^step.*-vision/i,
  /^hunyuan.*-vision/i, /^ernie-.*-vision/i,
  // === 通用 vision 标记 ===
  /-vision$/i, /-vl-/i, /-vlm/i,
];

const TEXT_ONLY_PATTERNS: RegExp[] = [
  // === GLM(NOT 4v/4.5v)===
  /^glm-\d+(\.\d+)?$/i,
  /^glm-4-(air|turbo)/i,
  // === DeepSeek ===
  /^deepseek/i,
  // === Qwen 文本变体 ===
  /^qwen-turbo/i, /^qwen-max/i, /^qwen-long/i, /^qwen-coder/i,
  /^qwen3.*-coder/i,
  /^qwen3\.\d+(\.\d+)?-max/i,
  // === Moonshot legacy ===
  /^moonshot-v1-/i,
  // === 国内 LLM 厂商(文本)===
  /^baichuan/i, /^yi-/i,
  // === MiniMax M2 ===
  /^MiniMax-M2/i, /^MiniMax-Text-/i, /^abab/i,
  // === Xiaomi MiMo Pro ===
  /^mimo-.*-pro/i,
  // === OpenAI 老版本 ===
  /^(gpt-3|gpt-3\.5)/i,
];

export function classifyModel(
  modelName: string,
  extra?: { visionPatterns?: string[]; textOnlyPatterns?: string[] }
): ModelKind {
  // 先剥掉尾部的 [quantifier]:[1m]、[256k] 等
  const baseName = modelName.replace(/\[[^\]]*\]\s*$/, '').trim();

  const multimodal = [
    ...MULTIMODAL_PATTERNS,
    ...(extra?.visionPatterns ?? []).map(p => new RegExp(p, 'i')),
  ];
  const textOnly = [
    ...TEXT_ONLY_PATTERNS,
    ...(extra?.textOnlyPatterns ?? []).map(p => new RegExp(p, 'i')),
  ];

  if (multimodal.some(p => p.test(baseName))) return 'multimodal';
  if (textOnly.some(p => p.test(baseName))) return 'text-only';
  return 'unknown';
}
