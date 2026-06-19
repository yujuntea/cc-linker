/**
 * WecomBot — 企微智能机器人主类
 * 集成 SpoolQueue + ClaudeSessionManager（可注入）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2 / §5
 * 参考 src/feishu/bot.ts:325-356 (enqueue 模式) + 359-401 (dispatch worker pool)
 */
import { aibotMessageToPlatform, type PlatformMessage } from '../platform/types';
import { isCommandMessage, parseCommand } from '../platform/command-handler';
import { logger } from '../utils/logger';
import { AibotClient, type AibotMessageHandler } from './aibot-client';
import { WecomStreamUpdater } from './stream-updater';
import { WecomUserManager } from './mapping';
import { WecomCardBuilder } from './card';
import { SpoolQueue, type SpoolMessage, type TargetSnapshot } from '../queue/spool';

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
  // PR 3: 接入 ClaudeSessionManager 之前，handleChat 走 echo back 路径
};

export class WecomBot {
  private client: AibotClient;
  private updater: WecomStreamUpdater;
  private userManager: WecomUserManager;
  private spoolQueue: SpoolQueue;
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
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // PR 2 v1.2.1 final (C-1 PoC 模式): 启动日志明确标注"框架已就绪，Claude 流式待 PR 4"
    // 历史: PR 2/3 commit 标题（"完整 CLI 路由"）让 review 同事误以为 wecom 通道
    //   对真用户功能可用，但 handleChat 仍写死 echo 字符串，没接 ClaudeSessionManager。
    // 修法: 启动时 WARN 标注 PoC 模式，避免误用。
    logger.warn('[wecom-bot] ⚠️  PoC MODE: handleChat 当前 echo 硬编码字符串，未接 Claude 流式');
    logger.warn('[wecom-bot] ⚠️  PoC MODE: 消息可接收、SDK 字段映射、SpoolQueue、dispatch loop 全部 OK');
    logger.warn('[wecom-bot] ⚠️  PoC MODE: 真实 AI 对话需等 PR 4（修 846605 invalid req_id 根因 + 接入 ClaudeSessionManager）');

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
    // PR 3 集成 handleCommand; 当前 E2E staging 只 echo back
    // PR 2 v1.2.1 final (F1 修复): 从 msg.metadata.inboundFrame 读取（handleMessage 已在 metadata 存好）
    // 不能空 — M4 修复要求 startProcessing 必传 inboundFrame，否则 throw → 命令 echo 永远发不出去
    const inboundFrame = msg.metadata?.inboundFrame as any;
    if (!inboundFrame) {
      logger.error(`[wecom-bot] handleCommand: missing inboundFrame in metadata, command ${msg.text} cannot be echoed back`);
      return;
    }
    try {
      await this.updater.startProcessing(msg.userId, inboundFrame);
      await this.updater.updateStream(`[E2E staging] 命令 ${msg.text} 暂未处理 (PR 3 集成)`, '', 100);
      await this.updater.complete(`✅ 已收到命令: ${msg.text}\n\n_(PR 2 E2E staging, 命令处理 PR 3 实现)_`, 0, 0, 0, 1);
    } catch (err) {
      logger.error(`[wecom-bot] handleCommand error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleChat(msg: SpoolMessage): Promise<void> {
    // PR 2 v1.2.2: 临时绕开 stream 流式 patch, 改用普通 sendMessage 推 markdown
    // 因为 SDK replyStream 流式 patch 报 errcode=846605 "invalid req_id"
    // (原因待 PR 3 调查, 可能是 SDK 服务端对 inbound frame.req_id 校验更严)
    // PR 3 会用 Claude 流式 + replyStream 重新接回
    logger.info(`[wecom-bot] handleChat: userId=${msg.userId}, text=${msg.text.slice(0, 50)}`);
    try {
      const responseText = `✅ 收到! 你是 WuYuJun, 我已收到你的消息: "${msg.text}"\n\n_(PR 2 E2E staging: 流式 patch 报 846605 暂用 sendMessage, Claude 集成待 PR 3)_`;

      // PR 2 v1.2.1 final (F13 修复): receive_id 选择
      // single chat: externalUserId 就是 receive_id
      // group chat: receive_id 必须是 chatId（群聊标识）而不是群成员 ID
      // 当前 msg 暂无 chatType 字段（SpoolMessage schema），PR 3 通过 metadata.chatType 传入
      // 暂用 userId（PR 2 E2E staging 全是 single chat，group chat 暂未支持）
      const receiveId = (msg.metadata as any)?.chatId ?? msg.userId;
      await this.client.sdk.sendMessage(receiveId, {
        msgtype: 'markdown',
        markdown: { content: responseText },
      });
      logger.info(`[wecom-bot] sendMessage success for ${msg.messageId}`);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    } catch (err) {
      logger.error(`[wecom-bot] handleChat error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
        logger.warn(`[wecom-bot] requeued message ${msg.messageId} after error`);
      } catch (requeueErr) {
        logger.error(`[wecom-bot] requeue failed: ${requeueErr instanceof Error ? requeueErr.message : String(requeueErr)}`);
      }
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
}
