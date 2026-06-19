/**
 * 平台无关的 user-mapping 类型定义
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §3.2 v1.1 + §4.1
 *
 * **设计意图（M1 修复）**：
 * 类型定义物理放在 platform/（不是 feishu/），让：
 *   - feishu/mapping.ts 通过 type alias re-export 保留老名字（~30 import 方零改动）
 *   - wecom/mapping.ts (PR 2) 直接 import platform/ 的类型，无需走 feishu 间接依赖
 *
 * **类型字段归属**：
 * - `pending_agent_reply` / `last_agent_list_card` 来自 Agent View 改动，是飞书特有行为
 *   但作为"用户状态"的一部分，对企微没有意义时企微侧忽略即可（type union 是开放的）
 * - `attachedAt`（v2.4.x Attach path）是飞书 rendezvous 概念，企微 v1 不做 Agent View，忽略
 * - 企微侧如有自己特有的 type（如 `pending_wecom_image`），扩展 PlatformMappingEntryType 即可
 */

export type PlatformMappingEntryType =
  | 'session'
  | 'pending_new_session'
  | 'pending_new_session_claimed'
  | 'pending_agent_reply'         // 飞书 Agent View — 企微 v1 忽略
  | 'last_agent_list_card';       // 飞书 Agent View — 企微 v1 忽略

export interface PlatformMappingEntry {
  type: PlatformMappingEntryType;
  sessionUuid: string | null;
  createdAt: string;
  casToken?: string; // CAS token to prevent ABA race (auto-generated)
  cwd?: string; // Working directory for new sessions (set by /new)
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
  defaultProvider?: string; // User's default model alias (user-level config)
  // ===== Agent View 新增字段 (飞书特有，企微 v1 忽略) =====
  shortId?: string;
  startedAt?: string;
  timeoutMs?: number;
  cardMessageId?: string;
  updatedAt?: string;
  // v2.4.x Attach path (飞书特有，企微 v1 忽略)
  attachedAt?: string;
}

export interface PlatformUserMapping {
  version: number;
  ownerOpenId?: string; // 飞书用；企微侧对应 ownerExternalUserId（实际为 ownerUserId 字段在 PlatformUserMapping 通用化时考虑）
  entries: Record<string, PlatformMappingEntry>;
}

export type PlatformClaimPendingResult =
  | { status: 'claimed'; entry: PlatformMappingEntry; version: number }
  | { status: 'creating'; entry: PlatformMappingEntry; version: number }
  | { status: 'no_pending'; entry: PlatformMappingEntry | null; version: number }
  | { status: 'unauthorized'; version: number };

export const PLATFORM_PENDING_CLAIMED_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
