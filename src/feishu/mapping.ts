import { USER_MAPPING_PATH } from '../utils/paths';
import { config } from '../utils/config';
import { withLock } from '../utils/lock';
import { logger } from '../utils/logger';

// === PR 2 v1.2.1 (C5 修复): 6 个公共方法下沉到 PlatformUserManager 基类 ===
// UserManager 继承基类，只保留飞书特有的 compareAndSwap + claimPendingNewSession（CAS 模式）
import { PlatformUserManager } from '../platform/user-state';
import {
  PLATFORM_PENDING_CLAIMED_TIMEOUT_MS,
  type PlatformMappingEntryType,
  type PlatformMappingEntry,
  type PlatformUserMapping,
  type PlatformClaimPendingResult,
} from '../platform/mapping-types';

// === 类型别名 re-export（保留 ~30 个调用方的老名字）===
export type MappingEntryType = PlatformMappingEntryType;
export type MappingEntry = PlatformMappingEntry;
export type UserMapping = PlatformUserMapping;
export type ClaimPendingResult = PlatformClaimPendingResult;
export const PENDING_CLAIMED_TIMEOUT_MS = PLATFORM_PENDING_CLAIMED_TIMEOUT_MS;

export class UserManager extends PlatformUserManager {
  protected override readonly mappingPath: string;

  constructor(mappingPath?: string) {
    super();
    this.mappingPath = mappingPath ?? USER_MAPPING_PATH;
  }

  override validateOwner(openId: string): boolean {
    const ownerOpenId = config.get<string>('feishu_bot.owner_open_id', '');
    if (!ownerOpenId) return true;  // 历史：飞书侧未配 owner 放行（与启动 WARN 配合）
    return openId === ownerOpenId;
  }

  /**
   * Compare-And-Swap: atomically update an openId's entry.
   * 飞书特有：CAS token 防止 ABA race
   */
  async compareAndSwap(
    openId: string,
    expected: MappingEntry | null,
    newValue: MappingEntry | null,
  ): Promise<boolean> {
    if (!this.validateOwner(openId)) {
      return false;
    }

    let result = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId] ?? null;

      if (!entriesMatch(current, expected)) {
        result = false;
        return;
      }

      if (newValue) {
        if (!newValue.casToken) {
          newValue.casToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        }
        mapping.entries[openId] = {
          ...newValue,
          lastActiveAt: newValue.lastActiveAt ?? new Date().toISOString(),
        };
      } else {
        delete mapping.entries[openId];
      }

      mapping.version++;
      this.saveMapping(mapping);
      result = true;
    });

    return result;
  }

  async claimPendingNewSession(openId: string, messageId: string): Promise<ClaimPendingResult> {
    if (!this.validateOwner(openId)) {
      return { status: 'unauthorized', version: this.getVersion() };
    }

    let outcome: ClaimPendingResult = { status: 'no_pending', entry: null, version: this.getVersion() };

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId] ?? null;

      if (!current || (current.type !== 'pending_new_session' && current.type !== 'pending_new_session_claimed')) {
        outcome = { status: 'no_pending', entry: current, version: mapping.version };
        return;
      }

      if (current.type === 'pending_new_session_claimed') {
        outcome = { status: 'creating', entry: current, version: mapping.version };
        return;
      }

      const now = new Date().toISOString();
      const claimedEntry: MappingEntry = {
        ...current,
        type: 'pending_new_session_claimed',
        claimedByMessageId: messageId,
        claimedAt: now,
        lastActiveAt: now,
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };

      mapping.entries[openId] = claimedEntry;
      mapping.version++;
      this.saveMapping(mapping);
      outcome = { status: 'claimed', entry: claimedEntry, version: mapping.version };
    });

    return outcome;
  }
}

/** Check if two entries match (for CAS validation) */
function entriesMatch(
  a: MappingEntry | null,
  b: MappingEntry | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;
  if (a.sessionUuid !== b.sessionUuid) return false;
  if ((a.cwd ?? '') !== (b.cwd ?? '')) return false;
  const tokenA = a.casToken || '';
  const tokenB = b.casToken || '';
  if (tokenA !== tokenB) return false;
  if (a.type === 'pending_new_session_claimed' && b.type === 'pending_new_session_claimed') {
    if (a.claimedByMessageId !== b.claimedByMessageId) return false;
    if ((a.claimedAt ?? '') !== (b.claimedAt ?? '')) return false;
  }
  return true;
}

export const userManager = new UserManager();
