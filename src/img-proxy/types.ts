export interface RouteEntry {
  alias: string;              // 文件名 stem
  upstream: string;           // 真实上游 base URL
  provider_path: string;      // provider 文件绝对路径
  original_base_url: string;  // 改写前的 BASE_URL(仅展示/审计;还原读 .bak)
  installed_at: string;       // ISO 时间戳
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
