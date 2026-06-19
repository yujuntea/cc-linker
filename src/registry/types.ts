import { z } from 'zod';

export const OriginSchema = z.enum(['cli', 'feishu']);
export type Origin = z.infer<typeof OriginSchema>;

export const StatusSchema = z.enum(['provisioning', 'active', 'archived', 'degraded', 'corrupted']);
export type Status = z.infer<typeof StatusSchema>;

export const SessionEntrySchema = z.object({
  origin: OriginSchema,

  cwd: z.string(),
  project_name: z.string().nullable(),
  jsonl_path: z.string().nullable(),
  project_dir: z.string().nullable(),

  pending_jsonl_resolve: z.boolean().optional(),
  last_error: z.string().nullable().optional(),

  feishu_session_id: z.string().nullable().optional(),
  feishu_user_id: z.string().nullable().optional(),

  created_at: z.string(),
  last_active: z.string(),

  title: z.string().nullable(),
  message_count: z.number(),
  last_message_preview: z.string(),                    // 100 字符 raw markdown（CLI / bot 多处复用，保留向后兼容）
  last_user_preview: z.string().max(80).optional(),     // 80 字符 raw user prompt（向后兼容）
  last_assistant_preview: z.string().max(240).optional(),// 240 字符 cleaned（去 ##/**/`/``` 后，bot 概览卡片专用）
  status: StatusSchema.optional(),
  lastKnownProvider: z.string().nullable().optional(), // Display-only: what model was used when session was created
  // v0.4.1: scanner 检测到 JSONL 含 `isSidechain: true` 条目时标 true —— 这些是
  // Task tool 派生的 subagent sessions。/list 按此过滤(复用 Agent View 的
  // filterUserDispatched 模式)。老 entry 没这个字段 = 视作 false(下次扫描会补)。
  is_subagent: z.boolean().optional(),

  // v5: PR 3 企微通道 — 区分 feishu / wecom 来源（默认 'feishu' 兼容老 entry）
  platform: z.enum(['feishu', 'wecom']).default('feishu'),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export const RegistrySchema = z.object({
  version: z.literal(5),
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
export type Registry = z.infer<typeof RegistrySchema>;
