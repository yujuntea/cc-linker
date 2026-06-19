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
    this.userManager = new WecomUserManager(config.userMappingPath);
    this.spoolQueue = config.spoolQueue ?? new SpoolQueue();
  }

  start(): void {
    if (this.running) return;
    this.running = true;

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

  /** 暴露内部组件（用于集成测试 + 调试） */
  get updater_(): WecomStreamUpdater { return this.updater; }
  get userManager_(): WecomUserManager { return this.userManager; }

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
   */
  private startDispatchLoop(): void {
    let stopped = false;
    const loop = async () => {
      while (!stopped && this.running) {
        try {
          // 1. 重试卡在 processing 超时的消息（>60s 的丢回 pending）
          const processing = this.spoolQueue.listProcessing();
          for (const msg of processing) {
            const age = Date.now() - new Date(msg.updatedAt).getTime();
            if (age > 60_000) {
              logger.warn(`[wecom-bot] requeue stale processing: ${msg.messageId} (${Math.round(age / 1000)}s)`);
              this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
            }
          }

          // 2. 拉所有 pending → claim → handle
          const pending = this.spoolQueue.listPending();
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
        await new Promise(r => setTimeout(r, 500));
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
    try {
      await this.updater.startProcessing(msg.userId);
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

      // 用 SDK sendMessage 直接发（不走 stream 流式 patch）
      // 企微 single chat 时 chatId == externalUserId == msg.userId
      await this.client.sdk.sendMessage(msg.userId, {
        msgtype: 'markdown',
        markdown: { content: responseText },
      });
      logger.info(`[wecom-bot] sendMessage success for ${msg.messageId}`);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    } catch (err) {
      logger.error(`[wecom-bot] handleChat error: ${err instanceof Error ? err.message : String(err)}`);
      // 关键修复: 处理失败时把消息 requeueFromProcessing
      // 否则下一轮 claimNext(serialKey) 看 processing 有 active 就拒绝, 永远卡死
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
   * **SpoolMessage 字段策略（PR 1 v1.2 兼容）**：
   * - openId / text: 写空串（企微侧永远不读这两个字段，但保留必填约束以兼容 46 个飞书调用方）
   * - userId / platform: 写 wecom 真值（spec §3.3 兼容策略）
   */
  private async handleMessage(msg: PlatformMessage & { inboundFrame?: any }): Promise<void> {
    logger.info(`[wecom-bot] handleMessage entered: userId=${msg.userId}, text=${msg.text.slice(0, 50)}`);
    const isCommand = isCommandMessage(msg.text);
    const serialKey = isCommand
      ? `cmd:${msg.userId}:${msg.messageId}`
      : `new:${msg.userId}`;

    const target: TargetSnapshot = {
      type: 'new_session_claim',
      sessionUuid: undefined,
      openId: undefined,  // 飞书 alias，企微侧 undefined
      cwd: undefined,
    };

    const spoolMsg: SpoolMessage = {
      messageId: msg.messageId,
      // openId/text 保留为飞书必填 alias，企微侧空串
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
      // PR 2 v1.2.1 修复: 必须用 inboundFrame.headers.req_id（SDK 内部流标识）
      // 不能用 messageId（那是发给用户的原消息 ID），否则 SDK 服务端会拒收
      // 与 WecomStreamUpdater.setInboundFrame 同样的 846605 根因
      const reqId = event.inboundFrame?.headers?.req_id ?? event.messageId;
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
