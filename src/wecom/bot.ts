/**
 * WecomBot — 企微智能机器人主类
 * 集成 SpoolQueue + ClaudeSessionManager（可注入）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2 / §5
 * 参考 src/feishu/bot.ts:325-356 (enqueue 模式) + 359-401 (dispatch worker pool)
 */
import { aibotMessageToPlatform, type PlatformMessage } from '../platform/types';
import { isCommandMessage, parseCommand } from '../platform/command-handler';
import { logger } from '../utils/logger';
import { AibotClient } from './aibot-client';
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
  sessionManager?: any;
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
    this.spoolQueue = config.spoolQueue ?? (globalThis as any).__wecom_spoolQueue ?? new SpoolQueue();
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.client.onMessage((event) => {
      const platformMsg = aibotMessageToPlatform(event);
      this.handleMessage(platformMsg).catch(err => {
        logger.error(`[wecom-bot] handleMessage failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

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
   * 把入站消息归一化 + 派生 serialKey + 入 SpoolQueue
   * 参考 feishu/bot.ts:325-345 (enqueue 模式)
   *
   * **SpoolMessage 字段策略（PR 1 v1.2 兼容）**：
   * - openId / text: 写空串（企微侧永远不读这两个字段，但保留必填约束以兼容 46 个飞书调用方）
   * - userId / platform: 写 wecom 真值（spec §3.3 兼容策略）
   */
  private async handleMessage(msg: PlatformMessage): Promise<void> {
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
    };

    const enqueued = await this.spoolQueue.enqueue(spoolMsg);
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
  private async handleCardAction(event: { externalUserId: string; messageId: string; actionTag: string; actionValue: any }): Promise<void> {
    logger.info(`[wecom-bot] card action: userId=${event.externalUserId}, actionTag=${event.actionTag}`);

    // 1. 5s 内 replyWelcome 发占位卡片
    const placeholderCard = WecomCardBuilder.textNotice({
      title: '处理中...',
      content: `执行 ${event.actionTag}...`,
    });
    try {
      await this.client.sdk.replyWelcome(
        { headers: { req_id: event.messageId } } as any,
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

  private async executeCardAction(event: { externalUserId: string; messageId: string; actionTag: string; actionValue: any }): Promise<void> {
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
