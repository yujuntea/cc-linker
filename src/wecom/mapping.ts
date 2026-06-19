/**
 * 企微 UserManager — 与 feishu/mapping.ts 并存
 * 独立文件 + 独立 user-mapping-wecom.json + 独立 owner 验证 (读 wecom.owner_external_user_id)
 *
 * **设计决策（M1 fix 后的选择）**：
 * 不 extend PlatformUserManager 抽象基类——抽象基类需要所有 8 个方法签名匹配，
 * 但 UserManager 的 private 字段与抽象类的 protected abstract readonly 不兼容（PR 1 决定的），
 * wecom 侧同样如此。所以 wecom 侧**直接复制实现**，与 feishu UserManager 平行存在。
 * 这样保持 wecom 侧完全独立（不同 storage path、不同 owner 验证、不同未来扩展性）。
 *
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2 + §5.7
 */
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { withLock } from '../utils/lock';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import {
  PLATFORM_PENDING_CLAIMED_TIMEOUT_MS,
  type PlatformClaimPendingResult,
  type PlatformMappingEntry,
  type PlatformUserMapping,
} from '../platform/mapping-types';
import { USER_MAPPING_PATH } from '../utils/paths';

/** 企微 user-mapping 文件路径（与飞书 user-mapping.json 同目录） */
export const WECOM_USER_MAPPING_PATH = join(dirname(USER_MAPPING_PATH), 'user-mapping-wecom.json');

const DEFAULT_WECOM_MAPPING: PlatformUserMapping = {
  version: 0,
  entries: {},
};

export class WecomUserManager {
  private mappingPath: string;
  private initialized = false;

  constructor(mappingPath: string = WECOM_USER_MAPPING_PATH) {
    this.mappingPath = mappingPath;
  }

  /** Lazy file initialization */
  private ensureFile(): void {
    if (this.initialized) return;
    const dir = join(this.mappingPath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.mappingPath)) {
      this.saveMapping(DEFAULT_WECOM_MAPPING);
    }
    this.initialized = true;
  }

  private loadMapping(): PlatformUserMapping {
    try {
      const raw = readFileSync(this.mappingPath, 'utf8');
      return JSON.parse(raw) as PlatformUserMapping;
    } catch (err) {
      if (existsSync(this.mappingPath)) {
        logger.warn(`wecom user-mapping 解析失败: ${err}`);
      }
      return { ...DEFAULT_WECOM_MAPPING, entries: {} };
    }
  }

  private saveMapping(mapping: PlatformUserMapping): void {
    const tmp = this.mappingPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(mapping, null, 2), { mode: 0o600 });
    renameSync(tmp, this.mappingPath);
  }

  /** 文件路径 getter（用于测试 + bot 层调试） */
  get path(): string {
    return this.mappingPath;
  }

  getEntry(externalUserId: string): PlatformMappingEntry | undefined {
    this.ensureFile();
    return this.loadMapping().entries[externalUserId];
  }

  /**
   * Validate if an external_userid matches the configured wecom owner.
   * 飞书侧 UserManager.validateOwner 读 [feishu_bot] owner_open_id
   * 企微侧读 [wecom] owner_external_user_id
   * WARNING: 如果 owner_external_user_id 未配置，return true for ALL users（与飞书侧行为一致）
   */
  validateOwner(externalUserId: string): boolean {
    const ownerExternalUserId = config.get<string>('wecom.owner_external_user_id', '');
    if (!ownerExternalUserId) return true;
    return externalUserId === ownerExternalUserId;
  }

  async setPending(externalUserId: string, opts: { cwd?: string } = {}): Promise<void> {
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      mapping.entries[externalUserId] = {
        type: 'pending_new_session',
        sessionUuid: null,
        cwd: opts.cwd,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      mapping.version++;
      this.saveMapping(mapping);
    });
  }

  async claimPending(externalUserId: string, messageId: string): Promise<PlatformClaimPendingResult> {
    if (!this.validateOwner(externalUserId)) {
      return { status: 'unauthorized', version: this.getVersion() };
    }

    let outcome: PlatformClaimPendingResult = { status: 'no_pending', entry: null, version: this.getVersion() };

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[externalUserId] ?? null;

      if (!current || (current.type !== 'pending_new_session' && current.type !== 'pending_new_session_claimed')) {
        outcome = { status: 'no_pending', entry: current, version: mapping.version };
        return;
      }

      if (current.type === 'pending_new_session_claimed') {
        outcome = { status: 'creating', entry: current, version: mapping.version };
        return;
      }

      const now = new Date().toISOString();
      mapping.entries[externalUserId] = {
        ...current,
        type: 'pending_new_session_claimed',
        claimedByMessageId: messageId,
        claimedAt: now,
        lastActiveAt: now,
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      mapping.version++;
      this.saveMapping(mapping);
      outcome = { status: 'claimed', entry: mapping.entries[externalUserId], version: mapping.version };
    });

    return outcome;
  }

  async rollbackClaim(externalUserId: string, messageId: string): Promise<boolean> {
    let rolledBack = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[externalUserId];
      if (!current || current.type !== 'pending_new_session_claimed') {
        return;
      }
      if (current.claimedByMessageId !== messageId) {
        return;
      }

      mapping.entries[externalUserId] = {
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

  async bindSession(externalUserId: string, messageId: string, sessionUuid: string, cwd: string): Promise<boolean> {
    let bound = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[externalUserId];
      if (!current) return;

      const claimMatches =
        current.type === 'pending_new_session_claimed' &&
        current.claimedByMessageId === messageId;
      if (!claimMatches) return;

      mapping.entries[externalUserId] = {
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

  getVersion(): number {
    this.ensureFile();
    return this.loadMapping().version;
  }

  /** Roll back timed-out pending_new_session_claimed entries (与飞书 UserManager 行为一致) */
  async rollbackTimedOutClaims(): Promise<number> {
    let rolledBack = 0;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const now = Date.now();

      for (const [externalUserId, entry] of Object.entries(mapping.entries)) {
        if (entry.type === 'pending_new_session_claimed') {
          if (!entry.claimedAt) continue;
          const elapsed = now - new Date(entry.claimedAt).getTime();
          if (isNaN(elapsed)) continue;
          if (elapsed >= PLATFORM_PENDING_CLAIMED_TIMEOUT_MS) {
            logger.info(`wecom 回滚超时 claim: ${externalUserId} (超时 ${Math.round(elapsed / 1000)}s)`);
            entry.type = 'pending_new_session';
            delete entry.claimedByMessageId;
            delete entry.claimedAt;
            entry.casToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            rolledBack++;
          }
        }
      }

      if (rolledBack > 0) {
        mapping.version++;
        this.saveMapping(mapping);
      }
    });

    return rolledBack;
  }

  /** Read all entries (for R8 startup recovery). 不 acquire lock — 用于 bot startup 一次性快照读取 */
  async allEntries(): Promise<Array<[string, PlatformMappingEntry]>> {
    try {
      const raw = await readFile(this.mappingPath, 'utf8');
      const parsed = JSON.parse(raw) as PlatformUserMapping;
      return Object.entries(parsed.entries || {}) as Array<[string, PlatformMappingEntry]>;
    } catch {
      return [];
    }
  }
}

/** 全局单例 */
export const wecomUserManager = new WecomUserManager();
