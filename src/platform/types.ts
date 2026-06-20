/**
 * 平台无关的消息 / 用户 / 卡片回调类型
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.1
 */

// === Feishu 原始事件类型（与 feishu/bot.ts:54-60 FeishuMessageEvent 对齐） ===
// chat_id 在 start.ts:437-443 的 SDK→FeishuMessageEvent 映射中提取（PR 3 改造项）
// p2p 模式下 chat_id 为空，chatId 默认用 open_id；group 模式下 chat_id 有值
export type FeishuMessageEvent = {
  open_id: string;
  message_id: string;
  content: string;
  chat_type: 'p2p' | 'group';
  message_type: 'text' | 'image';
  chat_id?: string;
};

// === 企微原始事件类型（来自 @wecom/aibot-node-sdk EventEmitter） ===
export type AibotMessageEvent = {
  externalUserId: string;
  chatId: string;
  chatType: 'single' | 'group';
  messageId: string;
  text: string;
  images?: Array<{ fileKey: string; url?: string }>;
  /**
   * PR 6.8.2: 企微 ws 原始消息整包 (含 headers.req_id 给 replyStream)
   * aibot-client.ts:122 / 158 / 169 已写入, 但类型之前漏声明 → aibotMessageToPlatform
   * 无法透传到 PlatformMessage → handleChat 永远 missing inboundFrame.
   */
  inboundFrame?: any;
};

// === 平台无关消息 ===
export type PlatformMessage = {
  platform: 'feishu' | 'wecom';
  userId: string;
  chatType: 'p2p' | 'group';
  chatId: string;
  messageId: string;
  text: string;
  images?: Array<{ fileKey: string; url?: string }>;
  timestamp: number;
  raw: unknown;
  /**
   * PR 6.8.2: 企微原始 ws 消息 (含 headers.req_id 给 replyStream)
   * 历史: aibotMessageToPlatform (PR 5.1 f1b5cbd 时代) 没透传 inboundFrame,
   *   handleMessage (bot.ts:728) 拿不到, handleChat 永远 missing inboundFrame,
   *   requeue 60s 循环. 生产 12:38 "hi" 消息复现.
   * 飞书侧不传 (CardUpdater 用 messageId, 不依赖 inboundFrame).
   */
  inboundFrame?: any;
};

// === 平台无关回复回调 ===
export type PlatformReplyFn = (text: string, opts?: {
  messageId?: string;
  replyTo?: string;
}) => Promise<string | null>;

// === 平台无关卡片回调（按钮点击） ===
export type PlatformCardAction = {
  userId: string;
  messageId: string;
  actionTag: string;
  actionValue: string | Record<string, unknown>;
};

// === 平台无关用户身份 ===
export type PlatformUserId = {
  platform: 'feishu' | 'wecom';
  platformUserId: string;
};

// === Feishu → Platform 适配器 ===
// 注意：content 直接透传（飞书 SDK content 是 JSON string）
// PlatformMessage.text 在飞书路径下是原始 content 字符串，由 bot.ts:302 下游 JSON.parse
// chat_id 在 p2p 模式下为空，此时 chatId 默认用 open_id
export function feishuMessageEventToPlatform(event: FeishuMessageEvent): PlatformMessage {
  return {
    platform: 'feishu',
    userId: event.open_id,
    chatType: event.chat_type,
    chatId: event.chat_id ?? event.open_id,
    messageId: event.message_id,
    text: event.content,
    timestamp: Date.now(),
    raw: event,
  };
}

// === Aibot → Platform 适配器 ===
export function aibotMessageToPlatform(event: AibotMessageEvent): PlatformMessage {
  return {
    platform: 'wecom',
    userId: event.externalUserId,
    chatType: event.chatType === 'single' ? 'p2p' : 'group',
    chatId: event.chatId,
    messageId: event.messageId,
    text: event.text,
    images: event.images,
    timestamp: Date.now(),
    raw: event,
    // PR 6.8.2: 透传 inboundFrame (aibot ws msg, 含 headers.req_id 供 replyStream)
    inboundFrame: event.inboundFrame,
  };
}