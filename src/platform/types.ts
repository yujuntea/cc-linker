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
  };
}