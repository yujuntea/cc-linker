/**
 * v2.6: bot 启动时,扫 user-mapping.json,把 type='session' 或
 * type='pending_agent_reply' 的 sessionUuid 翻译到活 fork(如有)。
 *
 * 触发:bot 启动一次,跑在 startupReconcile 之后,restoreExpectedReplyStates 之前。
 *
 * 边界:
 * - 找不到 fork:不动,保持原 sessionUuid(用户可能想跟一个老 session)
 * - session 死了但有 fork:把 entry.sessionUuid 改成 fork 的
 * - pending_agent_reply 的 startedAt / casToken 保留(不影响超时/CAS)
 */

import type { UserManager, MappingEntry } from '../feishu/mapping';
import { resolveLiveSession } from './fork-resolver';
import { logger } from '../utils/logger';

export interface MigrateOptions {
  /** 测试 override;默认 ~/.claude/jobs */
  jobsDir?: string;
  /** 测试 override;默认 ~/.claude/daemon/roster.json */
  rosterPath?: string;
}

export async function migrateUserMappingSessions(
  userManager: UserManager,
  opts: MigrateOptions = {},
): Promise<{
  scanned: number;
  migrated: number;
}> {
  let scanned = 0;
  let migrated = 0;
  const all = await userManager.allEntries();
  for (const [openId, entry] of all) {
    if (entry.type !== 'session' && entry.type !== 'pending_agent_reply') continue;
    if (!entry.sessionUuid) continue;
    scanned++;
    try {
      const r = await resolveLiveSession(entry.sessionUuid, opts);
      if (r?.hasLiveFork && r.liveFork) {
        const newEntry: MappingEntry = { ...entry, sessionUuid: r.liveFork.fullUuid };
        // 同时更新 shortId 字段(pending_agent_reply 类型才有)
        if (entry.type === 'pending_agent_reply' && 'shortId' in entry) {
          (newEntry as any).shortId = r.liveFork.short;
        }
        const ok = await userManager.compareAndSwap(openId, entry, newEntry);
        if (ok) {
          migrated++;
          logger.info(
            `user-mapping migrate: ${openId.slice(0, 8)} ${entry.sessionUuid.slice(0, 8)} → ${r.liveFork.short}`,
          );
        } else {
          logger.warn(
            `user-mapping migrate CAS conflict: ${openId.slice(0, 8)} (skipped, user is editing)`,
          );
        }
      }
    } catch (err: any) {
      logger.warn(`user-mapping migrate failed for ${openId}: ${err?.message ?? err}`);
    }
  }
  return { scanned, migrated };
}
