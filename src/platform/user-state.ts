/**
 * 平台无关的 user state 接口契约
 * 抽象基类 PlatformUserManager 声明所有方法签名；具体实现在 feishu/mapping.ts 与 wecom/mapping.ts
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §3.2 v1.1 + §4.1
 *
 * 为什么用抽象基类而不是从零实现：feishu/mapping.ts:55 UserManager 已有 8 个方法 + 30 个 import 方
 * 重写代价远高于抽象；本文件只承担"跨平台契约"职责
 */
import type { UserMapping, MappingEntry, MappingEntryType, ClaimPendingResult as FeishuClaimResult } from '../feishu/mapping';

// === 类型 re-export（保持 feishu/mapping.ts 单一来源）===
export type PlatformMappingEntry = MappingEntry;
export type PlatformMappingEntryType = MappingEntryType;
export type PlatformUserMapping = UserMapping;
export type ClaimPendingResult = FeishuClaimResult;

/** 平台无关用户身份 */
export interface PlatformUserId {
  platform: 'feishu' | 'wecom';
  platformUserId: string;
}

/**
 * 抽象基类：声明 8 个方法签名
 * feishu/mapping.ts 的 UserManager 已经全部实现；wecom/mapping.ts PR 2 实现
 * 子类必须 override validateOwner()（不同平台读不同 config key）
 */
export abstract class PlatformUserManager {
  protected abstract readonly mappingPath: string;

  abstract getEntry(userId: string): PlatformMappingEntry | undefined;
  abstract getVersion(): number;
  abstract compareAndSwap(
    userId: string,
    expected: PlatformMappingEntry | null,
    newValue: PlatformMappingEntry | null,
  ): Promise<boolean>;
  abstract claimPendingNewSession(userId: string, messageId: string): Promise<ClaimPendingResult>;
  abstract rollbackClaim(userId: string, messageId: string): Promise<boolean>;
  abstract bindSessionToClaim(userId: string, messageId: string, sessionUuid: string, cwd: string): Promise<boolean>;
  abstract rollbackTimedOutClaims(): Promise<number>;
  abstract validateOwner(userId: string): boolean;
  abstract allEntries(): Promise<Array<[string, PlatformMappingEntry]>>;
}