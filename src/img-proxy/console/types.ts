/** Per-alias 聚合(stats.byAlias[k] 的值类型) */
export interface AliasStats {
  requests: number;
  stripped: number;
  bytes: number;
  chunks: number;
  avgDurationMs: number;
  lastAt: number;
  // 2026-07-10: 加 model-side token 统计(从 upstream 响应 SSE/JSON 的 usage 字段解析)
  // 累加策略是 max-of:同一请求里 message_start 报 input_tokens=1234 后,
  // message_delta 报 output_tokens=567 不会改写 input,只取 max 保证最终值。
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** 环形 buffer 元素(stats.recent[] 元素类型) */
export interface RecentEntry {
  ts: number;
  alias: string;
  status: number;
  stream_status: string;
  chunks: number;
  bytes: number;
  duration_ms: number;
  stripped: number;
  // 同上,per-request 维度的 token 快照(单次请求的最终值,不是累加)
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Log 文件解析后条目(Task 4 用) */
export interface ParsedLogEntry {
  alias: string;
  method: string;
  path: string;
  stripped: number;
  upstream_status: number;
  duration_ms: number;
  headers_to_first_chunk_ms?: number;
  chunks?: number;
  bytes?: number;
  stream_status: string;
  upstream_error_msg?: string | null;
  // log 写入时由 server.ts piping.finally 一起 append,Log tab filter 可用
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface LogEntry {
  /** Date.parse(ISO timestamp from log line prefix) → ms timestamp */
  ts: number;
  /** 原始行 */
  raw: string;
  parsed: ParsedLogEntry | null;
}

export interface ReadRecentOpts {
  logPath: string;
  limit?: number;
  alias?: string;
  status?: number;
  streamStatus?: string;
  sinceMs?: number;
}

/** GET /admin/api/health 响应(Task 6 用) */
export interface HealthStats {
  uptimeMs: number;
  pid: number;
  routeCount: number;
  cacheFiles: number;
  cacheBytes: number;
}

/** GET /admin/api/routes 响应(Task 6 用) */
export interface RouteListEntry {
  alias: string;
  upstream: string;
  installed_at: string;
  disabled: boolean;
}