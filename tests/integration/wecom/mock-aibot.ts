/**
 * Mock aibot WSS server + SDK
 * 不真连企业微信，模拟 SDK 接收 / 发送的事件，并记录 SDK 调用历史
 */
import { EventEmitter } from 'node:events';

export type SdkCallRecord = {
  method: string;
  args: any[];
  timestamp: number;
};

export class MockAibotServer extends EventEmitter {
  public sdkCalls: SdkCallRecord[] = [];

  /** 模拟 SDK replyStream / replyWelcome / sendMessage / updateTemplateCard 等调用 */
  recordSdkCall(method: string, args: any[]): void {
    this.sdkCalls.push({ method, args, timestamp: Date.now() });
  }

  /** 模拟 aibot 发送 text 消息给用户 */
  simulateTextMessage(opts: { externalUserId: string; chatId: string; text: string; chatType?: 'single' | 'group' }): void {
    // emit 真实 AibotMessageEvent shape（aibotMessageToPlatform 适配器期待）
    // 不是原始 aibot SDK 事件（那需要 AibotClient 内部 listener 来转换）
    this.emit('message.text', {
      externalUserId: opts.externalUserId,
      chatId: opts.chatId,
      chatType: opts.chatType ?? 'single',
      messageId: `mock_msg_${Date.now()}`,
      text: opts.text,
    });
  }

  /** 模拟按钮回调事件 */
  simulateTemplateCardEvent(opts: { externalUserId: string; messageId: string; actionTag: string; actionValue: any }): void {
    this.emit('event.template_card_event', {
      message_id: opts.messageId,
      from: { user_id: opts.externalUserId },
      event: { action_tag: opts.actionTag, action_value: opts.actionValue },
    });
  }

  /** 模拟 WSS 断线 */
  simulateDisconnect(reason: string): void {
    this.emit('disconnected', reason);
  }

  /** 构造 mock SDK 客户端（注入到 AibotClient） */
  buildMockSdk(): any {
    const record = (method: string) => (...args: any[]) => {
      this.recordSdkCall(method, args);
      return Promise.resolve({});
    };
    return {
      replyStream: record('replyStream'),
      replyStreamWithCard: record('replyStreamWithCard'),
      replyWelcome: record('replyWelcome'),
      replyTemplateCard: record('replyTemplateCard'),
      updateTemplateCard: record('updateTemplateCard'),
      sendMessage: record('sendMessage'),
      isConnected: true,
      on: (event: string, handler: any) => {
        this.on(event, handler);
      },
    };
  }
}
