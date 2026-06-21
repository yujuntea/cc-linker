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

  /**
   * 企微特有：setPending 直接写（飞书侧用 CAS 模式无此方法）
   *
   * **PR 7 m-8 JSDoc 补全 — lockKey 语义解释**：
   * - 飞书侧 lockKey = openId (飞书 user identifier, 从 im.message 事件来)
   * - 企微侧 lockKey = userId (这里的 externalUserId, 即企微 external_userid 字段)
   * - 新 session 场景 lockKey = `new:${userId}` (e.g. `new:wmu_abc`), 跟飞书侧 `new:${openId}` 同模式
   * - setPending 是企微侧 skip CAS 直写入口, 因为企微侧没 claim 流程 (PR 4.5 简化)
   *
   * @param externalUserId 企微 external_userid, 锁文件粒度 (跟飞书侧 openId 同角色)
   */
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
   * PR 7.5.1 Task 1.3: 写用户级 defaultProvider (跨 session 保留的 /model 配置)
   *
   * 背景: 平台无关字段 PlatformMappingEntry.defaultProvider (platform/mapping-types.ts:33)
   *   已存在, 飞书侧 handleSelectModel/doSelectModel 走类似路径持久化 user-level 默认 model.
   *   企微侧本 PR 新增本方法, 让 doSelectModel 写 /model 命令的 alias 选择.
   * 设计: 同 userId 多次 /model 后, 最新 alias 覆盖, 跨 session 保留 (跟飞书侧行为对齐).
   * 防御: 当 user 尚无 entry 时, 先建一个 pending_new_session 占位 (跟 setPending 同样的
   *   占位策略), 避免首次 /model 就跳过用户注册流程. 实际生产中 setPending 总在
   *   setDefaultProvider 之前被调, 但兜底逻辑防 undefined entry 崩.
   *
   * @param externalUserId 企微 external_userid (跟 setPending 锁文件粒度一致)
   * @param alias model alias 字符串 (e.g. "opus" / "sonnet" / "haiku")
   */
  async setDefaultProvider(externalUserId: string, alias: string): Promise<void> {
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const now = new Date().toISOString();
      const existing = mapping.entries[externalUserId];
      mapping.entries[externalUserId] = {
        // 无 entry 时给一个 pending_new_session 占位 (type 后续 /new 流程覆盖)
        type: existing?.type ?? 'pending_new_session',
        sessionUuid: existing?.sessionUuid ?? null,
        createdAt: existing?.createdAt ?? now,
        cwd: existing?.cwd,
        lastActiveAt: now,
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        defaultProvider: alias,
      };
      mapping.version++;
      this.saveMapping(mapping);
    });
  }

  /**
   * PR 7.5.1 Task 1.3: 清用户级 defaultProvider (对应飞书侧 doClearModel / "默认" 选项)
   *
   * 背景: /model 命令菜单有 "默认" 选项, 让用户清除 custom alias 回退到系统默认.
   *   飞书侧 doClearModel 走类似路径. 企微侧本 PR 新增本方法.
   * 设计: 用解构删 defaultProvider 字段 (而非设为 undefined) — 这样 saveMapping 后
   *   loadMapping 拿到的 entry 完全没有这个 key, entry?.defaultProvider === undefined 行为
   *   更干净 (TypeScript optional field delete semantics). 跟 setSession 已用 explicit
   *   undefined 清理 claimed 字段的 2 套风格兼容 (本方法用 destructure 更显式).
   * 防御: 无 entry 时静默 no-op, 不创建空 entry (clear 语义不该产生副作用).
   *
   * @param externalUserId 企微 external_userid
   */
  async clearDefaultProvider(externalUserId: string): Promise<void> {
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[externalUserId];
      if (!current) return;  // 无 entry: no-op, clear 不该创建副作用
      if (current.defaultProvider === undefined) return;  // 已无 defaultProvider: 跳过写盘
      const { defaultProvider, ...rest } = current;
      // destructure 后 rest 不含 defaultProvider; 但仍需刷 lastActiveAt/casToken/version
      //   表达 "此 entry 被访问过" 的痕迹 (跟 touchSession 风格一致)
      mapping.entries[externalUserId] = {
        ...rest,
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
   *
   * @deprecated 当前 PoC/E2E 简化版（PR 4.5+ 走 setSession 直写），
   *   handleChat 不调本方法，dispatch loop 不调本方法，
   *   全仓 0 生产调用点（验证: grep claimPending src/ 排除 test 后仅返回本定义）。
   *   保留 4 个测试 + 完整实现，PR 6+ 接通飞书侧 claimPendingNewSession 等价流程时
   *   重新启用（届时去掉 @deprecated 并在 handleChat 调 claimPending 取代直接读 pending 状态）。
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
   * **PR 7 m-8 JSDoc 补全 — lockKey 语义解释**：
   * - 飞书侧 setSession/bindSessionToClaim 入参是 openId, 锁文件粒度
   * - 企微侧 setSession 入参是 externalUserId (= userId), 跟飞书侧 openId 同角色
   * - 续聊场景 lockKey = sessionUuid (用户跨 message 共享同一 session), 跟飞书侧对齐
   * - 区别: 飞书侧走 CAS 模式 (bindSessionToClaim), 企微侧直接 set (本方法)
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
      // PR 5 合并后 (C-4 修复): explicit 清理 claimed 字段, 防 claimPending 未来接通后
      //   setSession 接管 claimed 状态时这两个字段残留导致 rollbackTimedOutClaims 误判超时
      mapping.entries[externalUserId] = {
        type: 'session',
        sessionUuid,
        cwd,
        createdAt: existing?.createdAt ?? now,
        lastActiveAt: now,
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        claimedByMessageId: undefined,
        claimedAt: undefined,
      };
      mapping.version++;
      this.saveMapping(mapping);
    });
  }

  /**
   * PR 6.22: 真 CAS 修 TOCTOU bug (review Issue #4)
   *
   * 历史: handleChat spawn Claude 期间用户可能新发 /new 覆盖 pending, 老版 setSession
   *   无 CAS 检查直接覆盖 entry, 会冲掉用户的最新 /new. 旧版简单 cwd 比较有 race:
   *   getEntry 和 setSession 之间还有时间窗, 多次 /new cwd 相同时假阳性.
   * 修法: 用 entry.casToken 做严格 CAS — spawn 时记 token, setSession 前再读一次
   *   entry 验证 token 没变才 set. 失败返回 false (caller 跳过 setSession).
   *
   * 防御: 当 expectedCasToken 不匹配时, 跳过 setSession — 让用户后续消息走最新 mapping,
   *   而不是覆盖最新 /new.
   */
  async trySetSession(
    externalUserId: string,
    expectedCasToken: string,
    sessionUuid: string,
    cwd: string,
  ): Promise<boolean> {
    let ok = false;
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[externalUserId];
      // CAS: 当前 entry casToken 必须 === expected, 否则 race (用户并发 /new)
      if (!current || current.casToken !== expectedCasToken) {
        ok = false;
        return;
      }
      const now = new Date().toISOString();
      mapping.entries[externalUserId] = {
        type: 'session',
        sessionUuid,
        cwd,
        createdAt: current.createdAt ?? now,
        lastActiveAt: now,
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        claimedByMessageId: undefined,
        claimedAt: undefined,
      };
      mapping.version++;
      this.saveMapping(mapping);
      ok = true;
    });
    return ok;
  }

  /**
   * PR 4.5: 续聊时更新 lastActiveAt
   *
   * 历史: handleChat 续聊走 sessionManager.sendStreamingMessage 拿到 result.sessionId，
   *   但 session 没变, 不需要 setSession 整体覆盖；只刷 lastActiveAt 即可。
   *
   * 修法: 仅在 entry.type === 'session' 时更新 lastActiveAt + version；其他情况静默 no-op。
   *
   * **PR 7 m-8 JSDoc 补全 — lockKey 语义解释**：
   * - 飞书侧 touchSession 入参是 openId (飞书 user identifier)
   * - 企微侧 touchSession 入参是 externalUserId (= userId, 企微 external_userid 字段)
   * - lockKey 在 touch 时仍按 userId 锁定 entry, 不区分 session 还是 pending (静默 no-op)
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
