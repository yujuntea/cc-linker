/**
 * 平台无关的 user state 接口契约
 * 抽象基类 PlatformUserManager 声明所有方法签名；具体实现在 feishu/mapping.ts 与 wecom/mapping.ts
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §3.2 v1.1 + §4.1
 *
 * **类型定义位置（M1 修复 v1.2.1）**：
 * 物理定义在 `./mapping-types.ts`，feishu/mapping.ts 通过 type alias 保留老名字（~30 import 方零改动）
 * 这样 platform/ 不再反向依赖 feishu/，PR 2 wecom/mapping.ts 可以直接 import 本文件
 */
import type {
  PlatformMappingEntry,
  PlatformMappingEntryType,
  PlatformUserMapping,
  PlatformClaimPendingResult,
} from './mapping-types';

// === 类型 re-export（保持 feishu/mapping.ts alias 兼容 + 单一来源在 mapping-types.ts）===
export type {
  PlatformMappingEntry,
  PlatformMappingEntryType,
  PlatformUserMapping,
} from './mapping-types';

export type ClaimPendingResult = PlatformClaimPendingResult;

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