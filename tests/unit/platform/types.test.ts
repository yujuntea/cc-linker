import { describe, it, expect } from 'bun:test';
import {
  feishuMessageEventToPlatform,
  aibotMessageToPlatform,
  type FeishuMessageEvent,
  type AibotMessageEvent,
} from '../../../src/platform/types';

describe('feishuMessageEventToPlatform', () => {
  it('converts p2p text message', () => {
    const feishuEvent: FeishuMessageEvent = {
      open_id: 'ou_abc',
      message_id: 'om_xyz',
      content: 'hello',
      chat_type: 'p2p',
      message_type: 'text',
    };
    const result = feishuMessageEventToPlatform(feishuEvent);
    expect(result).toEqual({
      platform: 'feishu',
      userId: 'ou_abc',
      chatType: 'p2p',
      chatId: 'ou_abc',
      messageId: 'om_xyz',
      text: 'hello',
      timestamp: expect.any(Number),
      raw: feishuEvent,
    });
  });

  it('converts group message with chat_id', () => {
    const feishuEvent: FeishuMessageEvent = {
      open_id: 'ou_abc',
      message_id: 'om_xyz',
      content: 'group hello',
      chat_type: 'group',
      message_type: 'text',
      chat_id: 'oc_group123',
    };
    const result = feishuMessageEventToPlatform(feishuEvent);
    expect(result.chatId).toBe('oc_group123');
    expect(result.chatType).toBe('group');
  });

  it('preserves raw content string (JSON parse happens downstream in bot.ts)', () => {
    const feishuEvent: FeishuMessageEvent = {
      open_id: 'ou_abc',
      message_id: 'om_xyz',
      content: '{"text":"hello"}',
      chat_type: 'p2p',
      message_type: 'text',
    };
    const result = feishuMessageEventToPlatform(feishuEvent);
    expect(result.text).toBe('{"text":"hello"}');
  });

  it('falls back to open_id when chat_id is absent in p2p', () => {
    const feishuEvent: FeishuMessageEvent = {
      open_id: 'ou_abc',
      message_id: 'om_xyz',
      content: 'hi',
      chat_type: 'p2p',
      message_type: 'text',
    };
    const result = feishuMessageEventToPlatform(feishuEvent);
    expect(result.chatId).toBe('ou_abc');
  });
});

describe('aibotMessageToPlatform', () => {
  it('converts single chat text message', () => {
    const aibotEvent: AibotMessageEvent = {
      externalUserId: 'wmu_abc',
      chatId: 'wmu_abc',
      chatType: 'single',
      messageId: 'msg_xyz',
      text: 'hello',
    };
    const result = aibotMessageToPlatform(aibotEvent);
    expect(result).toEqual({
      platform: 'wecom',
      userId: 'wmu_abc',
      chatType: 'p2p',
      chatId: 'wmu_abc',
      messageId: 'msg_xyz',
      text: 'hello',
      timestamp: expect.any(Number),
      raw: aibotEvent,
    });
  });

  it('converts group chat message', () => {
    const aibotEvent: AibotMessageEvent = {
      externalUserId: 'wmu_abc',
      chatId: 'wrg_group456',
      chatType: 'group',
      messageId: 'msg_xyz',
      text: 'group hello',
    };
    const result = aibotMessageToPlatform(aibotEvent);
    expect(result.chatType).toBe('group');
    expect(result.chatId).toBe('wrg_group456');
  });

  // PR 6.8.2 followup: aibotMessageToPlatform 必须透传 inboundFrame
  // 历史 bug: aibot-client.ts:122 已写入 inboundFrame: msg (ws 整包, 含 headers.req_id),
  //   但 aibotMessageToPlatform 不传 → handleMessage.bot.ts:765 拿到 msg.inboundFrame=undefined
  //   → spool metadata 缺 inboundFrame → handleChat 永远 missing inboundFrame, requeue 60s 循环
  it('透传 event.inboundFrame 到 PlatformMessage.inboundFrame (PR 6.8.2)', () => {
    const inboundFrame = {
      headers: { req_id: 'test-req-123' },
      body: { msgid: 'm1', chattype: 'single' },
    };
    const aibotEvent: AibotMessageEvent = {
      externalUserId: 'WuYuJun',
      chatId: 'm1',
      chatType: 'single',
      messageId: 'm1',
      text: 'hi',
      inboundFrame,
    };
    const result = aibotMessageToPlatform(aibotEvent);
    expect(result.inboundFrame).toBe(inboundFrame);
    expect(result.inboundFrame?.headers?.req_id).toBe('test-req-123');
  });

  it('缺 event.inboundFrame 时, result.inboundFrame undefined (向后兼容)', () => {
    const aibotEvent: AibotMessageEvent = {
      externalUserId: 'WuYuJun',
      chatId: 'm1',
      chatType: 'single',
      messageId: 'm1',
      text: 'hi',
    };
    const result = aibotMessageToPlatform(aibotEvent);
    expect(result.inboundFrame).toBeUndefined();
  });
});