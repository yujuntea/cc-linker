import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { USER_MAPPING_PATH } from '../utils/paths';
import { config } from '../utils/config';
import { withLock } from '../utils/lock';
import { logger } from '../utils/logger';

// === platform/ 抽象基类的飞书实现 (v1.2 PR 1 重构) ===
// PlatformUserManager 在 src/platform/user-state.ts 是抽象基类
// UserManager 已经满足 PlatformUserManager 所有方法签名
// 这里用 type-only import 做编译期断言，不重复定义类
import type { PlatformUserManager } from '../platform/user-state';

// 验证 UserManager 实例满足 PlatformUserManager 契约（编译期断言）
// 注意：UserManager 的私有字段（mappingPath/initialized）与抽象类的 protected readonly mappingPath
// 在结构上不兼容（private vs protected + 字段 vs abstract readonly），所以这里逐方法做
// extends 结构比较，只校验公开方法签名
type _GetEntryCheck = InstanceType<typeof UserManager>['getEntry'] extends PlatformUserManager['getEntry'] ? true : never;
type _GetVersionCheck = InstanceType<typeof UserManager>['getVersion'] extends PlatformUserManager['getVersion'] ? true : never;
type _CASCheck = InstanceType<typeof UserManager>['compareAndSwap'] extends PlatformUserManager['compareAndSwap'] ? true : never;
type _ClaimCheck = InstanceType<typeof UserManager>['claimPendingNewSession'] extends PlatformUserManager['claimPendingNewSession'] ? true : never;
type _RollbackCheck = InstanceType<typeof UserManager>['rollbackClaim'] extends PlatformUserManager['rollbackClaim'] ? true : never;
type _BindCheck = InstanceType<typeof UserManager>['bindSessionToClaim'] extends PlatformUserManager['bindSessionToClaim'] ? true : never;
type _TimedOutCheck = InstanceType<typeof UserManager>['rollbackTimedOutClaims'] extends PlatformUserManager['rollbackTimedOutClaims'] ? true : never;
type _ValidateOwnerCheck = InstanceType<typeof UserManager>['validateOwner'] extends PlatformUserManager['validateOwner'] ? true : never;
type _AllEntriesCheck = InstanceType<typeof UserManager>['allEntries'] extends PlatformUserManager['allEntries'] ? true : never;

type _AssertImplements =
  [_GetEntryCheck, _GetVersionCheck, _CASCheck, _ClaimCheck, _RollbackCheck, _BindCheck, _TimedOutCheck, _ValidateOwnerCheck, _AllEntriesCheck];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assert: _AssertImplements = [true, true, true, true, true, true, true, true, true];
void _assert; // suppress unused

// === 类型定义委托给 platform/mapping-types.ts (M1 修复 v1.2.1) ===
// 历史原因 ~30 个文件 import 本文件的 MappingEntry/MappingEntryType/UserMapping/ClaimPendingResult
// 这里用 type alias 保留老名字，避免 ~30 个 import 方级联改
import {
  PLATFORM_PENDING_CLAIMED_TIMEOUT_MS,
  type PlatformMappingEntryType,
  type PlatformMappingEntry,
  type PlatformUserMapping,
  type PlatformClaimPendingResult,
} from '../platform/mapping-types';

export type MappingEntryType = PlatformMappingEntryType;
export type MappingEntry = PlatformMappingEntry;
export type UserMapping = PlatformUserMapping;
export type ClaimPendingResult = PlatformClaimPendingResult;

// re-export 常量保持原名（~5 个文件 import 这个常量）
export const PENDING_CLAIMED_TIMEOUT_MS = PLATFORM_PENDING_CLAIMED_TIMEOUT_MS;

// DEFAULT_MAPPING 保留在 feishu/mapping.ts（它是 UserMapping 实例，不属于纯类型）
const DEFAULT_MAPPING: PlatformUserMapping = {
  version: 0,
  entries: {},
};

export class UserManager {
  private mappingPath: string;
  private initialized = false;

  constructor(mappingPath?: string) {
    this.mappingPath = mappingPath ?? USER_MAPPING_PATH;
  }

  /** Lazy file initialization to avoid constructor throw on import */
  private ensureFile(): void {
    if (this.initialized) return;
    const dir = join(this.mappingPath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.mappingPath)) {
      this.saveMapping(DEFAULT_MAPPING);
    }
    this.initialized = true;
  }

  private loadMapping(): UserMapping {
    try {
      const raw = readFileSync(this.mappingPath, 'utf8');
      return JSON.parse(raw) as UserMapping;
    } catch (err) {
      if (existsSync(this.mappingPath)) {
        logger.warn(`user-mapping 解析失败: ${err}`);
      }
      return { ...DEFAULT_MAPPING, entries: {} };
    }
  }

  private saveMapping(mapping: UserMapping): void {
    const tmp = this.mappingPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(mapping, null, 2), { mode: 0o600 });
    renameSync(tmp, this.mappingPath);
  }

  /** Get entry for an openId (non-atomic, for read-only use) */
  getEntry(openId: string): MappingEntry | undefined {
    this.ensureFile();
    const mapping = this.loadMapping();
    return mapping.entries[openId];
  }

  getVersion(): number {
    this.ensureFile();
    return this.loadMapping().version;
  }

  /**
   * Compare-And-Swap: atomically update an openId's entry.
   */
  async compareAndSwap(
    openId: string,
    expected: MappingEntry | null,
    newValue: MappingEntry | null
  ): Promise<boolean> {
    // C1: Owner validation before acquiring lock (fast reject)
    if (!this.validateOwner(openId)) {
      return false;
    }

    let result = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId] ?? null;

      // Validate expected value
      if (!entriesMatch(current, expected)) {
        result = false;
        return;
      }

      // Apply the swap
      if (newValue) {
        // I3: Auto-generate CAS token if not provided
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

      // Increment version to prevent ABA
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

  async rollbackClaim(openId: string, messageId: string): Promise<boolean> {
    let rolledBack = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId];
      if (!current || current.type !== 'pending_new_session_claimed') {
        return;
      }
      if (current.claimedByMessageId !== messageId) {
        return;
      }

      mapping.entries[openId] = {
        ...current,
        type: 'pending_new_session',
        sessionUuid: null,
        lastActiveAt: new Date().toISOString(),
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        claimedByMessageId: undefined,
        claimedAt: undefined,
      };
      mapping.version++;
      this.saveMapping(mapping);
      rolledBack = true;
    });

    return rolledBack;
  }

  async bindSessionToClaim(openId: string, messageId: string, sessionUuid: string, cwd: string): Promise<boolean> {
    let bound = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[openId];
      if (!current) {
        return;
      }

      const claimMatches =
        current.type === 'pending_new_session_claimed' &&
        current.claimedByMessageId === messageId;

      if (!claimMatches) {
        return;
      }

      mapping.entries[openId] = {
        ...current,
        type: 'session',
        sessionUuid,
        cwd,
        createdAt: current.createdAt,
        lastActiveAt: new Date().toISOString(),
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      mapping.version++;
      this.saveMapping(mapping);
      bound = true;
    });

    return bound;
  }

  /**
   * Roll back timed-out pending_new_session_claimed entries.
   */
  async rollbackTimedOutClaims(): Promise<number> {
    let rolledBack = 0;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const now = Date.now();

      for (const [openId, entry] of Object.entries(mapping.entries)) {
        if (entry.type === 'pending_new_session_claimed') {
          // I5: Guard against missing claimedAt
          if (!entry.claimedAt) continue;
          const elapsed = now - new Date(entry.claimedAt).getTime();
          if (isNaN(elapsed)) continue;
          if (elapsed >= PENDING_CLAIMED_TIMEOUT_MS) {
            logger.info(`回滚超时 claim: ${openId} (超时 ${Math.round(elapsed / 1000)}s)`);
            entry.type = 'pending_new_session';
            delete entry.claimedByMessageId;
            delete entry.claimedAt;
            // I3: Generate new CAS token on rollback
            entry.casToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            rolledBack++;
          }
        }
      }

      // I1: Single version increment for all rolled-back entries
      if (rolledBack > 0) {
        mapping.version++;
        this.saveMapping(mapping);
      }
    });

    return rolledBack;
  }

  /** Validate if an openId matches the configured owner.
   *  WARNING: If owner_open_id is not configured, this returns true for ALL users.
   *  A startup warning is emitted in createBotRuntime() when this happens.
   */
  validateOwner(openId: string): boolean {
    const ownerOpenId = config.get<string>('feishu_bot.owner_open_id', '');
    if (!ownerOpenId) return true;
    return openId === ownerOpenId;
  }

  /**
   * Read all entries from user-mapping.json (raw, for R8 startup recovery).
   * Returns array of [openId, entry] tuples. Empty array if file doesn't
   * exist or is corrupt. Does NOT acquire the lock — this is a one-shot
   * snapshot read used only at bot startup before any handlers run.
   */
  async allEntries(): Promise<Array<[string, MappingEntry]>> {
    try {
      const raw = await readFile(this.mappingPath, 'utf8');
      const parsed = JSON.parse(raw) as UserMapping;
      return Object.entries(parsed.entries || {}) as Array<[string, MappingEntry]>;
    } catch {
      return [];
    }
  }
}

/** Check if two entries match (for CAS validation) */
function entriesMatch(
  a: MappingEntry | null,
  b: MappingEntry | null
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.type !== b.type) return false;
  if (a.sessionUuid !== b.sessionUuid) return false;
  if ((a.cwd ?? '') !== (b.cwd ?? '')) return false;
  // I3: Compare CAS token — treat both undefined/empty as matching (backward compat)
  const tokenA = a.casToken || '';
  const tokenB = b.casToken || '';
  if (tokenA !== tokenB) return false;
  // For claimed entries, also verify claimedBy and claimedAt
  if (a.type === 'pending_new_session_claimed' && b.type === 'pending_new_session_claimed') {
    if (a.claimedByMessageId !== b.claimedByMessageId) return false;
    if ((a.claimedAt ?? '') !== (b.claimedAt ?? '')) return false;
  }
  // Note: defaultProvider is intentionally NOT compared — it's a user preference, not session state
  return true;
}

export const userManager = new UserManager();
