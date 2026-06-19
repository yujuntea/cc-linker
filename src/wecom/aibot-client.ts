/**
 * 企微智能机器人 (aibot) WSClient 封装
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2
 */
import { EventEmitter } from 'node:events';
import {
  WSClient,
  type Logger,
  type WsFrame,
  WSAuthFailureError,
  WSReconnectExhaustedError,
} from '@wecom/aibot-node-sdk';
import { CCLinkerError } from '../utils/errors';
import { logger as defaultLogger } from '../utils/logger';

export type AibotClientConfig = {
  botId: string;
  secret: string;
  wsUrl?: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
  requestTimeout?: number;
};

export type AibotMessageHandler = (event: {
  externalUserId: string;
  chatId: string;
  chatType: 'single' | 'group';
  messageId: string;
  text: string;
  images?: Array<{ fileKey: string; url?: string }>;
  /** inbound frame — replyStream 需要用它的 headers.req_id */
  inboundFrame: any;
}) => void;

export type AibotCardActionHandler = (event: {
  externalUserId: string;
  messageId: string;
  actionTag: string;
  actionValue: string | Record<string, unknown>;
  inboundFrame?: any;
}) => void;

export class AibotClient extends EventEmitter {
  private wsClient: WSClient;
  private messageHandlers: AibotMessageHandler[] = [];
  private cardActionHandlers: AibotCardActionHandler[] = [];

  constructor(config: AibotClientConfig) {
    super();
    const sdkLogger: Logger = {
      debug: (...args: any[]) => defaultLogger.debug('[aibot] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')),
      info: (...args: any[]) => defaultLogger.info('[aibot] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')),
      warn: (...args: any[]) => defaultLogger.warn('[aibot] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')),
      error: (...args: any[]) => defaultLogger.error('[aibot] ' + args.map(a => a instanceof Error ? a.stack ?? a.message : (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    };

    this.wsClient = new WSClient({
      botId: config.botId,
      secret: config.secret,
      wsUrl: config.wsUrl ?? 'wss://openws.work.weixin.qq.com',
      reconnectInterval: config.reconnectInterval ?? 1000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? -1,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
      requestTimeout: config.requestTimeout ?? 10000,
      logger: sdkLogger,
    });

    this.setupListeners();
  }

  private setupListeners(): void {
    this.wsClient.on('connected', () => this.emit('connected'));
    this.wsClient.on('authenticated', () => this.emit('authenticated'));
    this.wsClient.on('disconnected', (reason: any) => this.emit('disconnected', reason));
    this.wsClient.on('reconnecting', (attempt: number) => this.emit('reconnecting', attempt));

    this.wsClient.on('error', (err: Error) => {
      defaultLogger.error(`[aibot] ws error: ${err.message}` + (err.stack ? `\n${err.stack}` : ''));
      // ⚠️ 不在 listener 内 throw —— EventEmitter 回调里的 throw 是 uncaught exception，
      // 会绕过 bot 层的 handleError 流程。改为 emit 结构化 fatal 事件，由 bot.ts 监听并
      // 调 handleError(err) 走标准退出路径（errors.ts 的 suggestions 也能生效）。
      if (err instanceof WSAuthFailureError) {
        // botId/secret 错 → 不可恢复 → fatal
        const ccErr = new CCLinkerError('E_CONFIG_WECOM_AUTH', '企微智能机器人认证失败: bot_id 或 secret 错误');
        this.emit('fatal', ccErr);
        return;
      }
      if (err instanceof WSReconnectExhaustedError) {
        // 网络持续不可达 → 触发 A3 进程自杀
        const ccErr = new CCLinkerError('E_CONFIG_WECOM_NETWORK', '企微 WSS 重连耗尽');
        this.emit('fatal', ccErr);
        return;
      }
      this.emit('error', err);
    });

    this.wsClient.on('message.text', (msg: any) => {
      defaultLogger.info(`[aibot] message.text received: ${JSON.stringify(msg).slice(0, 500)}`);
      // SDK 实际字段: msg.body.from.userid (无下划线), msg.body.chattype, msg.body.msgid
      const body = msg.body ?? msg;
      const event = {
        externalUserId: body.from?.userid ?? body.from?.user_id ?? '',
        chatId: body.msgid ?? body.chat_id ?? body.from?.chat_id ?? '',
        chatType: body.chattype === 'group' || body.chat_type === 'group' ? 'group' as const : 'single' as const,
        messageId: body.msgid ?? body.message_id ?? '',
        text: body.text?.content ?? '',
        // 保留 inbound frame, 给 replyStream 用作 req_id
        inboundFrame: msg,
      };
      this.messageHandlers.forEach(h => h(event));
    });

    this.wsClient.on('message.image', (msg: any) => {
      defaultLogger.info(`[aibot] message.image received: ${JSON.stringify(msg).slice(0, 500)}`);
      const body = msg.body ?? msg;
      const event = {
        externalUserId: body.from?.userid ?? body.from?.user_id ?? '',
        chatId: body.msgid ?? body.chat_id ?? body.from?.chat_id ?? '',
        chatType: body.chattype === 'group' || body.chat_type === 'group' ? 'group' as const : 'single' as const,
        messageId: body.msgid ?? body.message_id ?? '',
        text: '[图片]',
        images: body.image?.map((img: any) => ({ fileKey: img.media_id, url: img.url })),
        inboundFrame: msg,
      };
      this.messageHandlers.forEach(h => h(event));
    });

    this.wsClient.on('event.template_card_event', (evt: any) => {
      const actionEvent = {
        externalUserId: evt.from?.user_id ?? '',
        messageId: evt.message_id,
        actionTag: evt.event?.action_tag ?? '',
        actionValue: evt.event?.action_value ?? {},
        inboundFrame: evt,
      };
      this.cardActionHandlers.forEach(h => h(actionEvent));
    });
  }

  connect(): this {
    try {
      this.wsClient.connect();
    } catch (err) {
      defaultLogger.error(`[aibot] connect failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    return this;
  }

  disconnect(): void {
    this.wsClient.disconnect();
  }

  isConnected(): boolean {
    return this.wsClient.isConnected;
  }

  onMessage(handler: AibotMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onCardAction(handler: AibotCardActionHandler): void {
    this.cardActionHandlers.push(handler);
  }

  /** 暴露 SDK 给 stream-updater / bot 使用 */
  get sdk(): WSClient {
    return this.wsClient;
  }
}
