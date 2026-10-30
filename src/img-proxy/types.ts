export interface RouteEntry {
  alias: string;              // 文件名 stem
  upstream: string;           // 真实上游 base URL
  provider_path: string;      // provider 文件绝对路径
  original_base_url: string;  // 改写前的 BASE_URL(仅展示/审计;还原读 .bak)
  installed_at: string;       // ISO 时间戳
  disabled?: boolean;         // console 临时禁用 setRouteDisabled(true) 后存在;enable 时被删除
  // ---- 可选路由级能力(2026-10-30 加;缺省 = 原纯透传行为不变) ----
  /** 转发上游时附加的请求头(在 sanitizeProxyRequestHeaders 之后注入,
   *  同名头以路由表为准 —— 客户端无法覆盖/剥除,适合网关强制的
   *  x-opencode-session 这类凭证性头)。 */
  inject_headers?: Record<string, string>;
  /** 命名请求体改写器。目前仅 'openai-dialect-normalizer':
   *  max_output_tokens/max_completion_tokens → max_tokens,
   *  剥 thinking/enable_thinking/reasoning 方言(见 src/img-proxy/openai-dialect.ts)。
   *  仅作用于 POST …/chat/completions;其余路径 body 不动。 */
  request_transform?: 'openai-dialect-normalizer';
}

export interface RouteTable {
  version: 1;
  routes: Record<string, RouteEntry>;  // key = 文件名 stem
}

export interface TransformResult {
  messages: unknown[];
  savedImages: string[];
  strippedCount: number;
}

export interface ProviderFileInfo {
  alias: string;    // 文件名 stem
  path: string;     // 绝对路径
  baseUrl: string;  // env.ANTHROPIC_BASE_URL
  model: string;    // env.ANTHROPIC_MODEL(展示用)
}
