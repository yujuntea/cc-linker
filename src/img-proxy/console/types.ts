/** Per-alias 聚合(stats.byAlias[k] 的值类型) */
export interface AliasStats {
  requests: number;
  stripped: number;
  bytes: number;
  chunks: number;
  avgDurationMs: number;
  lastAt: number;
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