/**
 * 平台无关的用户状态基类
 * 抽象基类 PlatformUserManager 提供 6 个公共方法实现 + 强制子类实现 validateOwner + mappingPath
 * 飞书 UserManager (src/feishu/mapping.ts) 与 企微 WecomUserManager (src/wecom/mapping.ts) 继承本类
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §3.2 v1.1 + §4.1
 *
 * **PR 2 v1.2.1 修复 (C5)**:
 * 历史: feishu/mapping.ts 与 wecom/mapping.ts 各 250+ 行重复（loadMapping/saveMapping/getEntry/
 * rollbackClaim/bindSession/rollbackTimedOutClaims/allEntries 6 个方法逐行复制）
 * 现在: 6 个公共方法下沉到本基类，validateOwner + mappingPath 由子类提供
 * 飞书 UserManager 仅保留 compareAndSwap + claimPendingNewSession（CAS 模式特有）
 * 企微 WecomUserManager 仅保留 setPending + claimPending（企微 setPending 特有）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { withLock } from '../utils/lock';
import { logger } from '../utils/logger';
import { PLATFORM_PENDING_CLAIMED_TIMEOUT_MS } from './mapping-types';
import type {
  PlatformMappingEntry,
  PlatformMappingEntryType,
  PlatformUserMapping,
  PlatformClaimPendingResult,
} from './mapping-types';

export type {
  PlatformMappingEntry,
  PlatformMappingEntryType,
  PlatformUserMapping,
} from './mapping-types';

export type ClaimPendingResult = PlatformClaimPendingResult;

export interface PlatformUserId {
  platform: 'feishu' | 'wecom';
  platformUserId: string;
}

/** 抽象基类 — 模板方法模式 */
export abstract class PlatformUserManager {
  /** 子类提供 storage 路径 */
  protected abstract readonly mappingPath: string;

  /** 子类提供 owner 验证 — 不同平台读不同 config key */
  abstract validateOwner(userId: string): boolean;

  /** 子类是否启用 owner 验证（默认 true，wecom 侧可覆盖为 false 等 PR 3 配置） */
  protected get ownerValidationEnabled(): boolean {
    return true;
  }

  // ======== 文件 IO 工具方法（子类可访问以支持 CAS 模式特例）========

  private initialized = false;

  protected ensureFile(): void {
    if (this.initialized) return;
    const dir = join(this.mappingPath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.mappingPath)) {
      this.saveMapping({ version: 0, entries: {} });
    }
    this.initialized = true;
  }

  protected loadMapping(): PlatformUserMapping {
    try {
      const raw = readFileSync(this.mappingPath, 'utf8');
      return JSON.parse(raw) as PlatformUserMapping;
    } catch (err) {
      if (existsSync(this.mappingPath)) {
        logger.warn(`user-mapping 解析失败: ${err}`);
      }
      return { version: 0, entries: {} };
    }
  }

  protected saveMapping(mapping: PlatformUserMapping): void {
    const tmp = this.mappingPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(mapping, null, 2), { mode: 0o600 });
    renameSync(tmp, this.mappingPath);
  }

  // ======== 公共方法（飞书 + 企微共享）========

  /** 文件路径 getter（用于测试 + bot 层调试） */
  get path(): string {
    return this.mappingPath;
  }

  getEntry(userId: string): PlatformMappingEntry | undefined {
    this.ensureFile();
    return this.loadMapping().entries[userId];
  }

  getVersion(): number {
    this.ensureFile();
    return this.loadMapping().version;
  }

  async rollbackClaim(userId: string, messageId: string): Promise<boolean> {
    let rolledBack = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[userId];
      if (!current || current.type !== 'pending_new_session_claimed') return;
      if (current.claimedByMessageId !== messageId) return;

      mapping.entries[userId] = {
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

  async bindSessionToClaim(
    userId: string,
    messageId: string,
    sessionUuid: string,
    cwd: string,
  ): Promise<boolean> {
    let bound = false;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[userId];
      if (!current) return;

      const claimMatches =
        current.type === 'pending_new_session_claimed' &&
        current.claimedByMessageId === messageId;
      if (!claimMatches) return;

      mapping.entries[userId] = {
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

  /** Roll back timed-out pending_new_session_claimed entries */
  async rollbackTimedOutClaims(): Promise<number> {
    let rolledBack = 0;

    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const now = Date.now();

      for (const [userId, entry] of Object.entries(mapping.entries)) {
        if (entry.type === 'pending_new_session_claimed') {
          if (!entry.claimedAt) continue;
          const elapsed = now - new Date(entry.claimedAt).getTime();
          if (isNaN(elapsed)) continue;
          if (elapsed >= PLATFORM_PENDING_CLAIMED_TIMEOUT_MS) {
            logger.info(`回滚超时 claim: ${userId} (超时 ${Math.round(elapsed / 1000)}s)`);
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

  /** Read all entries (R8 startup recovery). 不 acquire lock — bot startup 一次性快照 */
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
