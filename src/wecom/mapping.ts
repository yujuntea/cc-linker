/**
 * 企微 UserManager — 继承 PlatformUserManager 基类
 * 独立文件 + 独立 user-mapping-wecom.json + 独立 owner 验证
 *
 * **PR 2 v1.2.1 (C5 修复)**: 6 个公共方法（loadMapping/saveMapping/getEntry/getVersion/
 * rollbackClaim/bindSession/rollbackTimedOutClaims/allEntries）从 feishu/mapping.ts 复制
 * 下沉到 PlatformUserManager 基类；本类只保留企微特有的 setPending + claimPending
 *
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2 + §5.7
 */
import { dirname, join } from 'path';
import { withLock } from '../utils/lock';
import { config } from '../utils/config';
import { PlatformUserManager } from '../platform/user-state';
import type { PlatformMappingEntry } from '../platform/mapping-types';
import { USER_MAPPING_PATH } from '../utils/paths';

/** 企微 user-mapping 文件路径（与飞书 user-mapping.json 同目录） */
export const WECOM_USER_MAPPING_PATH = join(dirname(USER_MAPPING_PATH), 'user-mapping-wecom.json');

export class WecomUserManager extends PlatformUserManager {
  protected override readonly mappingPath: string;

  constructor(mappingPath: string = WECOM_USER_MAPPING_PATH) {
    super();
    this.mappingPath = mappingPath;
  }

  /**
   * Validate if an external_userid matches the configured wecom owner.
   * 飞书侧读 [feishu_bot] owner_open_id；企微侧读 [wecom] owner_external_user_id
   *
   * **PR 2 v1.2.1 (C6 修复)**: 保留 default true（与飞书侧行为一致，E2E/测试友好）
   * **启动 WARN**: createBotRuntime 在企微 Bot 启动时检查 owner_external_user_id 未配则 WARN
   * （与飞书侧 owner_open_id 未配 WARN 对称，spec §5.7 安全策略）
   */
  override validateOwner(externalUserId: string): boolean {
    const ownerExternalUserId = config.get<string>('wecom.owner_external_user_id', '');
    if (!ownerExternalUserId) return true;  // 未配时放行（与飞书侧行为一致）
    return externalUserId === ownerExternalUserId;
  }

  /** 企微特有：setPending 直接写（飞书侧用 CAS 模式无此方法） */
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

  /**
   * 企微特有 claimPending（与飞书 claimPendingNewSession 行为对齐：
   * pending → claimed 转换，命中 unauthorized/no_pending/creating/claimed 4 个状态）
   */
  async claimPending(externalUserId: string, messageId: string): Promise<import('../platform/mapping-types').PlatformClaimPendingResult> {
    if (!this.validateOwner(externalUserId)) {
      return { status: 'unauthorized', version: this.getVersion() };
    }

    let outcome: import('../platform/mapping-types').PlatformClaimPendingResult = { status: 'no_pending', entry: null, version: this.getVersion() };

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

  /**
   * PR 4.5: 简化版 setSession — 跳过 claim 直接 set session 映射
   *
   * 历史: bindSessionToClaim 要求先有 claimed 状态 (pending → claimed → session)，
   *   企微侧 PR 4.5 简化：Claude 流式完成直接 set session（新建场景）。
   *   飞书侧走 CAS 模式保留 bindSessionToClaim 不动。
   *
   * 修法: 写一份新的 entry, type='session', sessionUuid, cwd；保留 createdAt（如果存在），
   *   更新 lastActiveAt，刷新 casToken。
   *
   * @param externalUserId 企微 external_userid
   * @param sessionUuid Claude session UUID
   * @param cwd session 工作目录
   */
  async setSession(externalUserId: string, sessionUuid: string, cwd: string): Promise<void> {
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const now = new Date().toISOString();
      const existing = mapping.entries[externalUserId];
      mapping.entries[externalUserId] = {
        type: 'session',
        sessionUuid,
        cwd,
        createdAt: existing?.createdAt ?? now,
        lastActiveAt: now,
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      mapping.version++;
      this.saveMapping(mapping);
    });
  }

  /**
   * PR 4.5: 续聊时更新 lastActiveAt
   *
   * 历史: handleChat 续聊走 sessionManager.sendStreamingMessage 拿到 result.sessionId，
   *   但 session 没变, 不需要 setSession 整体覆盖；只刷 lastActiveAt 即可。
   *
   * 修法: 仅在 entry.type === 'session' 时更新 lastActiveAt + version；其他情况静默 no-op。
   *
   * @param externalUserId 企微 external_userid
   */
  async touchSession(externalUserId: string): Promise<void> {
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const entry = mapping.entries[externalUserId];
      if (entry?.type === 'session') {
        entry.lastActiveAt = new Date().toISOString();
        mapping.version++;
        this.saveMapping(mapping);
      }
    });
  }
}

/** 全局单例 */
export const wecomUserManager = new WecomUserManager();
