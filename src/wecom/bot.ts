/**
 * WecomBot — 企微智能机器人主类
 * 集成 SpoolQueue + ClaudeSessionManager（可注入）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2 / §5
 * 参考 src/feishu/bot.ts:325-356 (enqueue 模式) + 359-401 (dispatch worker pool)
 */
import { aibotMessageToPlatform, type PlatformMessage } from '../platform/types';
import { isCommandMessage, parseCommand } from '../platform/command-handler';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { AibotClient, type AibotMessageHandler } from './aibot-client';
import { WecomStreamUpdater } from './stream-updater';
import { WecomUserManager } from './mapping';
import { WecomCardBuilder } from './card';
import { SpoolQueue, type SpoolMessage, type TargetSnapshot } from '../queue/spool';
import type { ClaudeSessionManager } from '../proxy/session';
import type { StreamChunk } from '../proxy/stream-parser';

export type WecomBotConfig = {
  botId: string;
  secret: string;
  userMappingPath?: string;
  throttleMs?: number;
  /** 可注入依赖 - 默认用真实实现 */
  client?: AibotClient;
  spoolQueue?: SpoolQueue;
  /**
   * PR 2 v1.2.1 final (F9 修复): 可选 userManager 注入点
   * 默认 new WecomUserManager(userMappingPath)，测试场景可注入 mock
   */
  userManager?: WecomUserManager;
  /**
   * PR 4.1: ClaudeSessionManager 注入点。
   * - 注入 → handleChat 真接 Claude 流式 (replyStream 流式 patch)
   * - 未注入 → handleChat 走 PoC echo 路径 (向后兼容单测 / wecom-only staging)
   *
   * 仿飞书侧 createSessionFromPromptStreaming 模板
   * @see src/feishu/bot.ts:2600-2700
   */
  sessionManager?: ClaudeSessionManager;
};

export class WecomBot {
  private client: AibotClient;
  private updater: WecomStreamUpdater;
  private userManager: WecomUserManager;
  private spoolQueue: SpoolQueue;
  /**
   * PR 4.1: 可选 ClaudeSessionManager 注入。未注入时 handleChat 走 PoC echo 路径。
   */
  private sessionManager?: ClaudeSessionManager;
  private running = false;

  constructor(config: WecomBotConfig) {
    this.client = config.client ?? new AibotClient({
      botId: config.botId,
      secret: config.secret,
    });
    this.updater = new WecomStreamUpdater(this.client.sdk, {
      throttleMs: config.throttleMs ?? 2000,
    });
    this.userManager = config.userManager ?? new WecomUserManager(config.userMappingPath);
    this.spoolQueue = config.spoolQueue ?? new SpoolQueue();
    this.sessionManager = config.sessionManager;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // PR 4.1: 启动日志 — Claude 流式已接通 (PR 2/3 PoC 模式正式转正)
    // 历史: PR 2 v1.2.1 final (C-1) 标 3 行 PoC WARN，避免 review 同事误用。
    //   846605 invalid req_id 根因已在 M-3 + F7 修复（必传 inboundFrame.headers.req_id）。
    //   handleChat 真接 ClaudeSessionManager.sendStreamingMessage。
    if (this.sessionManager) {
      logger.info('[wecom-bot] handleChat → ClaudeSessionManager 流式模式 (replyStream 必传 inboundFrame)');
    } else {
      logger.warn('[wecom-bot] sessionManager 未注入，handleChat 走 PoC echo 路径（仅用于 staging/单测）');
    }

    this.client.onMessage((event) => {
      logger.info(`[wecom-bot] onMessage received: ${JSON.stringify(event).slice(0, 300)}`);
      const platformMsg = aibotMessageToPlatform(event);
      logger.info(`[wecom-bot] platformMsg: ${JSON.stringify(platformMsg)}`);
      this.handleMessage(platformMsg).catch(err => {
        logger.error(`[wecom-bot] handleMessage failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    // PR 2 v1.2.1 E2E staging: 启动 dispatch worker loop
    // PR 3 会重构为共享 FeishuBot.dispatch 的实现
    this.startDispatchLoop();

    this.client.onCardAction((event) => {
      this.handleCardAction(event).catch(err => {
        logger.error(`[wecom-bot] handleCardAction failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    this.client.connect();
    logger.info('[wecom-bot] started, connecting to WSS...');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.client.disconnect();
    logger.info('[wecom-bot] stopped');
  }

  /**
   * PR 2 v1.2.1 E2E staging: dispatch worker loop
   * PR 3 会重构为共享 FeishuBot.dispatch 的实现
   *
   * **当前 E2E 简化**：从 SpoolQueue 拉消息 → handleChat → replyStream 推回
   * Claude 集成（sessionManager.sendStreamingMessage）需要 init ClaudeSessionManager
   * 是更大的工作，PR 3 Task 3.6 做；本 task 只验证 SDK replyStream 真能发
   *
   * **重试机制**：处理失败时 requeueFromProcessing 让消息回 pending
   * 否则下一轮 claimNext(serialKey) 看到 processing 还有 active 就拒绝
   *
   * **PR 2 v1.2.1 (M1 修复)**: 轮询周期 500ms → 2000ms，与飞书侧 bot.dispatch 对齐
   * 减少 fs 全表扫描 IO（每秒 4 次 → 1 次）；PR 3 共享 FeishuBot.dispatch 后会变事件驱动
   */
  private startDispatchLoop(): void {
    let stopped = false;
    const loop = async () => {
      while (!stopped && this.running) {
        try {
          // 0. PR 2 v1.2.1 final (M-6): 同步回滚 user-mapping 中过时的 claim
          // 历史 bug: spool 60s 重新入队但 user-mapping.pending_new_session_claimed
          //   仍卡 10min，导致用户后续消息在 claimPending 阶段被 `creating` 状态挡住。
          // 修法: 每次 tick 调一次 rollbackTimedOutClaims()，默认 10 分钟超时
          //   （虽然慢于 60s spool requeue，但确保不永久卡 user-mapping）。
          await this.userManager.rollbackTimedOutClaims();

          // 1. 重试卡在 processing 超时的消息（>60s 的丢回 pending）
          // PR 2 v1.2.1 final (M-4): 传 'wecom' 过滤自己平台的消息，避免共享 SpoolQueue 时
          //   误处理飞书 worker 的卡住消息
          const processing = this.spoolQueue.listProcessing('wecom');
          for (const msg of processing) {
            const age = Date.now() - new Date(msg.updatedAt).getTime();
            if (age > 60_000) {
              logger.warn(`[wecom-bot] requeue stale processing: ${msg.messageId} (${Math.round(age / 1000)}s)`);
              this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
            }
          }

          // 2. 拉所有 pending → claim → handle
          // PR 2 v1.2.1 final (M-4): 传 'wecom' 过滤（同 listProcessing 注释）
          const pending = this.spoolQueue.listPending('wecom');
          for (const msg of pending) {
            const claimed = this.spoolQueue.claimNext(msg.serialKey);
            if (claimed) {
              this.handleClaimed(claimed).catch(err => {
                logger.error(`[wecom-bot] handleClaimed failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          }
        } catch (err) {
          logger.error(`[wecom-bot] dispatch loop error: ${err instanceof Error ? err.message : String(err)}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    loop();
  }

  /**
   * PR 2 v1.2.1 E2E staging: handleClaimed
   * 简化版：命令 vs 普通消息分路径
   * 命令暂时 echo back; 普通消息直接 handleChat
   */
  private async handleClaimed(msg: SpoolMessage): Promise<void> {
    logger.info(`[wecom-bot] handleClaimed: serialKey=${msg.serialKey}, text=${msg.text.slice(0, 50)}`);
    // 命令直接 echo（完整命令处理是 PR 3 Task 3.6）
    if (msg.serialKey.startsWith('cmd:')) {
      await this.handleCommand(msg);
      return;
    }
    // 普通聊天: 走 handleChat
    await this.handleChat(msg);
  }

  private async handleCommand(msg: SpoolMessage): Promise<void> {
    // PR 4.5 C: 命令路由 — 仿飞书侧命令处理，但用 sendMessage 推回 (没 CardUpdater)
    // 历史: PR 2/3/4.1 阶段命令只 echo back (set up stub 收命令 E2E), 真实路由 PR 4.5+ 实现
    // 简化版: 只支持 /new /list /status /help; /switch /resume /bridge /agents 推 PR 5+ 实现
    const parsed = parseCommand(msg.text);
    if (!parsed) {
      logger.warn(`[wecom-bot] handleCommand: parseCommand failed for "${msg.text.slice(0, 50)}", skipping`);
      return;
    }

    logger.info(`[wecom-bot] handleCommand: cmd=/${parsed.cmd} args=${JSON.stringify(parsed.args)} userId=${msg.userId}`);

    let responseText: string;
    try {
      switch (parsed.cmd) {
        case 'new':
          responseText = await this.handleCommandNew(msg.userId, parsed.args);
          break;
        case 'list':
          responseText = await this.handleCommandList(msg.userId, parsed.args);
          break;
        case 'status':
          responseText = await this.handleCommandStatus(msg.userId);
          break;
        case 'help':
          responseText = this.handleCommandHelp();
          break;
        default:
          responseText = `❌ 未知命令: /${parsed.cmd}\n\n可用命令: /new /list /status /help\n\n_(PR 4.5 简化版, 更多命令 PR 5+ 实现)_`;
      }
    } catch (err) {
      logger.error(`[wecom-bot] handleCommand /${parsed.cmd} error: ${err instanceof Error ? err.message : String(err)}`);
      responseText = `❌ 命令执行失败: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 推回 (用 sendMessage 不用 WecomStreamUpdater, 因为命令响应是终态文本不走流)
    try {
      await this.client.sdk.sendMessage(msg.userId, {
        msgtype: 'markdown',
        markdown: { content: responseText },
      });
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    } catch (err) {
      logger.error(`[wecom-bot] handleCommand sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
      } catch (requeueErr) { /* ignore */ }
    }
  }

  /**
   * PR 4.5 C: /new 命令 - 强制新建 session (调 setPending, 下条消息走 handleChat 新建路径)
   */
  private async handleCommandNew(userId: string, args: string[]): Promise<string> {
    const cwd = args[0] ?? '/tmp';
    await this.userManager.setPending(userId, { cwd });
    return `✅ 已创建 pending session (cwd=${cwd})\n\n下条消息将走新建 session 路径`;
  }

  /**
   * PR 4.5 C: /list 命令 - 列出用户当前 session 状态
   */
  private handleCommandList(userId: string, _args: string[]): string {
    const entry = this.userManager.getEntry(userId);
    if (!entry) {
      return '📭 当前无 active session, 发送任意消息走新建 session 路径';
    }
    if (entry.type === 'session') {
      return `📋 当前 session:\n  sessionUuid: ${entry.sessionUuid}\n  cwd: ${entry.cwd ?? '(unknown)'}\n  lastActiveAt: ${entry.lastActiveAt ?? '(unknown)'}`;
    }
    if (entry.type === 'pending_new_session') {
      return '⏳ 等待下条消息触发新建 session';
    }
    if (entry.type === 'pending_new_session_claimed') {
      return '⏳ 新 session 创建中 (claimed), 请稍候';
    }
    return `📋 当前状态: ${entry.type}`;
  }

  /**
   * PR 4.5 C: /status 命令 - 显示 bot 配置状态
   */
  private handleCommandStatus(_userId: string): string {
    const ownerExternalUserId = config.get<string>('wecom.owner_external_user_id', '');
    const botId = config.get<string>('wecom.bot_id', '');
    return `📊 Wecom Bot 状态:\n  bot_id: ${botId || '(未配置)'}\n  owner_configured: ${!!ownerExternalUserId}\n  claude_streaming: ${this.sessionManager ? 'enabled' : 'PoC echo'}\n  user_mapping_path: ${this.userManager.path}`;
  }

  /**
   * PR 4.5 C: /help 命令 - 列出可用命令
   */
  private handleCommandHelp(): string {
    return `🤖 cc-linker wecom Bot 命令:\n  /new [cwd]  - 强制新建 session\n  /list       - 列出当前 session\n  /status     - 显示 bot 状态\n  /help       - 显示本帮助\n\n(PR 4.5 简化版, /switch /resume /bridge /agents 推 PR 5+)`;
  }

  private async handleChat(msg: SpoolMessage): Promise<void> {
    logger.info(`[wecom-bot] handleChat: userId=${msg.userId}, text=${msg.text.slice(0, 50)}`);

    // PR 4.1: PoC fallback — sessionManager 未注入时走 sendMessage echo 路径
    // 用于 staging / 单测 (确保向后兼容未升级的 wecom-only 启动)
    if (!this.sessionManager) {
      logger.warn(`[wecom-bot] handleChat: sessionManager 未注入, 走 PoC echo 路径 (messageId=${msg.messageId})`);
      try {
        const responseText = `✅ 收到! 你是 WuYuJun, 我已收到你的消息: "${msg.text}"\n\n_(PR 2 E2E staging, sessionManager 未注入)_`;
        const receiveId = (msg.metadata as any)?.chatId ?? msg.userId;
        await this.client.sdk.sendMessage(receiveId, {
          msgtype: 'markdown',
          markdown: { content: responseText },
        });
        this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      } catch (err) {
        logger.error(`[wecom-bot] handleChat (PoC) error: ${err instanceof Error ? err.message : String(err)}`);
        try {
          this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
        } catch (requeueErr) { /* ignore */ }
      }
      return;
    }

    // PR 4.1: 真接 Claude 流式 (仿飞书侧 createSessionFromPromptStreaming 模板)
    // @see src/feishu/bot.ts:2600-2700
    const inboundFrame = msg.metadata?.inboundFrame as any;
    if (!inboundFrame) {
      logger.error(`[wecom-bot] handleChat: missing inboundFrame in metadata, cannot stream (messageId=${msg.messageId})`);
      try {
        this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
      } catch (requeueErr) { /* ignore */ }
      return;
    }

    const startTime = Date.now();
    let thinking = '';
    let text = '';

    try {
      // 1. 启动 replyStream 流（必传 inboundFrame — M-7 修复后 fail-fast）
      await this.updater.startProcessing(msg.userId, inboundFrame);

      // 2. PR 4.5 B: 接续聊 — 查 user-mapping 拿现有 sessionUuid + cwd
      // 历史: PR 4.1 简化总是 sessionId=null 新建, 用户续聊失效 (claude 永远开新 session)
      // 修法: 读 WecomUserManager.getEntry → 有 session 走 resume (sessionId 传 existing-uuid);
      //        没 session 走新建 (sessionId=null + cwd fallback /tmp)
      // 防御: sessionUuid 为空串/falsy 视同"无 session", 走新建 (避免 claude -p --resume '' 出错)
      //
      // B1 修复: /new 命令 (handleCommandNew) 调 setPending 创建 pending_new_session
      //   状态，handleChat 这里也检查 pending 状态 — 用 pending.cwd 强制走 new 路径。
      //   修前: pending 状态被忽略, setSession 立即覆盖 → /new 实际是 no-op
      //   修后: pending 状态被识别, 用 pending.cwd 走 new + 保留 pending 信息
      const existingEntry = this.userManager.getEntry(msg.userId);
      const isPending = existingEntry?.type === 'pending_new_session';
      const existingSessionUuid = existingEntry?.type === 'session' && existingEntry.sessionUuid
        ? existingEntry.sessionUuid
        : null;
      // B1: pending 状态强制 new; 有 session 续聊; 都没走 new
      const isNewSession = !existingSessionUuid || isPending;
      const sessionId: string | null = isNewSession ? null : existingSessionUuid;
      // B1: pending 状态用 pending 里的 cwd; 有 session 续聊用 existingCwd; 都没用 /tmp
      const cwd: string = isPending
        ? (existingEntry?.cwd ?? '/tmp')
        : isNewSession
          ? '/tmp'
          : (existingEntry?.cwd ?? '/tmp');
      const lockKey: string = isNewSession ? `new:${msg.userId}` : existingSessionUuid!;

      // 3. 调 ClaudeSessionManager 流式 — onProgress 累加 thinking/text + throttle patch
      const result = await this.sessionManager.sendStreamingMessage(
        sessionId, msg.text, cwd,
        (chunk: StreamChunk) => {
          if (chunk.type === 'thinking') thinking += chunk.content;
          else if (chunk.type === 'text') text += chunk.content;
          const elapsed = Date.now() - startTime;
          this.updater.updateStream(thinking, text, elapsed).catch(e =>
            logger.warn(`[wecom-bot] updateStream failed: ${e instanceof Error ? e.message : String(e)}`)
          );
        },
        isNewSession, lockKey,
      );

      // 4. 终态: sessionId 缺失 → error, 成功 → complete
      if (!result.sessionId) {
        await this.updater.error(result.error ?? 'Claude 未返回 session_id');
        this.spoolQueue.markDone(msg.messageId, msg.serialKey);
        return;
      }

      // 5. PR 4.5 B: 持久化 session 映射
      // - 新建场景: 调 setSession 直接 set (跳过 claim 流程, 企微侧简化)
      // - 续聊场景: session 没变, 调 touchSession 刷 lastActiveAt
      if (isNewSession) {
        await this.userManager.setSession(msg.userId, result.sessionId, cwd);
        logger.info(`[wecom-bot] handleChat: 新建 session 已持久化 userId=${msg.userId} sessionUuid=${result.sessionId}`);
      } else {
        await this.userManager.touchSession(msg.userId);
      }

      await this.updater.complete(text, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    } catch (err) {
      logger.error(`[wecom-bot] handleChat Claude flow error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        await this.updater.error(err instanceof Error ? err.message : String(err));
      } catch (e2) { /* ignore */ }
      try {
        this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
      } catch (requeueErr) { /* ignore */ }
    }
  }

  /**
   * 把入站消息归一化 + 派生 serialKey + 入 SpoolQueue
   * 参考 feishu/bot.ts:325-345 (enqueue 模式)
   *
   * **PR 2 v1.2.1 (M2 修复)**: target.type 根据 WecomUserManager.getEntry(userId).sessionUuid
   * 动态选 existing_session vs new_session_claim，避免续聊消息被强制走新会话路径
   *
   * **SpoolMessage 字段策略（PR 1 v1.2 兼容）**：
   * - openId / text: 写空串（企微侧永远不读这两个字段，但保留必填约束以兼容 ~70 个飞书调用方 grep msg.openId/spoolMsg.openId）
   * - userId / platform: 写 wecom 真值（spec §3.3 兼容策略）
   */
  private async handleMessage(msg: PlatformMessage & { inboundFrame?: any }): Promise<void> {
    logger.info(`[wecom-bot] handleMessage entered: userId=${msg.userId}, text=${msg.text.slice(0, 50)}`);
    const isCommand = isCommandMessage(msg.text);

    // 查 user-mapping 看是否有活跃 session
    const existingEntry = this.userManager.getEntry(msg.userId);
    const existingSessionUuid = existingEntry?.type === 'session' ? existingEntry.sessionUuid : null;

    // PR 2 v1.2.1 final (F10 修复): serialKey 决策表 — 重构掉嵌套三元
    const serialKey = this.deriveSerialKey(msg, isCommand, existingSessionUuid);
    const target: TargetSnapshot = existingSessionUuid
      ? { type: 'session', sessionUuid: existingSessionUuid, cwd: existingEntry?.cwd }
      : { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined };

    const spoolMsg: SpoolMessage = {
      messageId: msg.messageId,
      // PR 2 v1.2.1: openId 保留为飞书必填 alias (string 类型不能改 nullable)
      // 企微侧写空串，飞书侧 reader 应先判 msg.platform === 'wecom' 走 msg.userId 路径
      // 而不是误用 openId=''（参见 feishu/bot.ts 大量 msg.openId 使用）
      openId: '',
      text: msg.text,
      // userId/platform: 平台无关真值（spec §3.3）
      userId: msg.userId,
      platform: 'wecom',
      target,
      serialKey,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // PR 2 v1.2.1 修复: inboundFrame 存到 metadata 而不是 responseText
      // 避免语义破坏（responseText 在飞书侧是 AI 回复）+ 敏感信息（response_url）落地到 SpoolQueue
      metadata: msg.inboundFrame ? { inboundFrame: msg.inboundFrame } : undefined,
    };

    logger.info(`[wecom-bot] enqueue attempt: serialKey=${serialKey}`);
    const enqueued = await this.spoolQueue.enqueue(spoolMsg);
    logger.info(`[wecom-bot] enqueue result: ${enqueued} for messageId=${msg.messageId}`);
    if (!enqueued) {
      logger.warn(`[wecom-bot] enqueue failed: ${msg.messageId}`);
    }

    if (isCommand) {
      const parsed = parseCommand(msg.text);
      logger.debug(`[wecom-bot] command parsed: ${JSON.stringify(parsed)}`);
      // 命令执行由 PR 3 集成到 handleClaimed 时实现
    }
  }

  /**
   * PR 2 v1.2.1 final (F10 修复): serialKey 决策表
   * 4 种 case：
   * 1. 有 session + 命令 → session serialKey（命令附在 session 上）
   * 2. 有 session + 聊天 → session serialKey（续聊）
   * 3. 无 session + 命令 → cmd: serialKey
   * 4. 无 session + 聊天 → new: serialKey
   */
  private deriveSerialKey(msg: PlatformMessage, isCommand: boolean, existingSessionUuid: string | null): string {
    if (existingSessionUuid) {
      // 有 session: 无论命令/聊天都走 session serialKey
      return `${existingSessionUuid}:${msg.messageId}`;
    }
    if (isCommand) {
      return `cmd:${msg.userId}:${msg.messageId}`;
    }
    return `new:${msg.userId}`;
  }

  /**
   * 卡片按钮回调: 5s 占位 + 异步处理
   * 参考 spec §5.4 + sdk replyWelcome 5s 窗口约束
   */
  private async handleCardAction(event: {
    externalUserId: string;
    messageId: string;
    actionTag: string;
    actionValue: any;
    inboundFrame?: any;  // SDK callback 事件，含 headers.req_id
  }): Promise<void> {
    logger.info(`[wecom-bot] card action: userId=${event.externalUserId}, actionTag=${event.actionTag}`);

    // 1. 5s 内 replyWelcome 发占位卡片
    const placeholderCard = WecomCardBuilder.textNotice({
      title: '处理中...',
      content: `执行 ${event.actionTag}...`,
    });
    try {
      // PR 2 v1.2.1 final (F7 修复): 拒绝 fallback 到 messageId（那是发给用户的原消息 ID，
      // 不是 SDK 内部流标识 — fallback 复现 846605 "invalid req_id" 根因）
      const reqId = event.inboundFrame?.headers?.req_id;
      if (!reqId) {
        logger.error(`[wecom-bot] handleCardAction: missing inboundFrame.headers.req_id, cannot replyWelcome`);
        return;
      }
      await this.client.sdk.replyWelcome(
        { headers: { req_id: reqId } } as any,
        { msgtype: 'template_card', template_card: placeholderCard as any },
      );
    } catch (err) {
      logger.warn(`[wecom-bot] replyWelcome failed (5s window may have passed): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 2. 异步执行实际动作
    setImmediate(() => {
      this.executeCardAction(event).catch(err => {
        logger.error(`[wecom-bot] executeCardAction failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  private async executeCardAction(event: {
    externalUserId: string;
    messageId: string;
    actionTag: string;
    actionValue: any;
    inboundFrame?: any;
  }): Promise<void> {
    switch (event.actionTag) {
      case 'retry':
      case 'confirm-stop':
      case 'list-refresh':
      case 'stop':
        // 真实动作由 PR 3 集成 handleClaimed + ClaudeSessionManager 时实现
        logger.debug(`[wecom-bot] action ${event.actionTag} queued for execution`);
        await this.client.sdk.sendMessage(event.externalUserId, {
          msgtype: 'markdown',
          markdown: { content: `✅ 已执行: ${event.actionTag}` },
        });
        break;
      default:
        logger.warn(`[wecom-bot] unknown card action: ${event.actionTag}`);
    }
  }

  /**
   * PR 4.1: 测试 seam — 暴露 handleChat 给单测直接调用。
   * 生产路径是 startDispatchLoop → handleClaimed → handleChat；
   * 单测里不想跑 2s tick + SpoolQueue 文件 IO 时直接调它。
   * @internal
   */
  public async __test_handleChat(msg: SpoolMessage): Promise<void> {
    return this.handleChat(msg);
  }

  /**
   * PR 4.5 C: 测试 seam — 暴露 handleCommand 给单测直接调用。
   * @internal
   */
  public async __test_handleCommand(msg: SpoolMessage): Promise<void> {
    return this.handleCommand(msg);
  }
}
