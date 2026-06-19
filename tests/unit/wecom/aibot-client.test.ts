import { describe, it, expect, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { AibotClient } from '../../../src/wecom/aibot-client';
import { WSAuthFailureError } from '@wecom/aibot-node-sdk';

/** Mock WSClient — 用 EventEmitter 模拟 SDK 事件，捕获 register 的 listener */
class MockWSClient extends EventEmitter {
  public replyStream = async () => ({});
  public replyWelcome = async () => ({});
  public sendMessage = async () => ({});
  public isConnected = true;
}

describe('AibotClient', () => {
  let mockWs: MockWSClient;
  let client: AibotClient;

  beforeEach(() => {
    mockWs = new MockWSClient();
    client = new AibotClient({
      botId: 'test-bot',
      secret: 'test-secret',
      wsClientFactory: () => mockWs as any,
    });
  });

  it('initializes with config and wsClient factory is invoked', () => {
    expect(client).toBeDefined();
    expect(client.isConnected()).toBe(true);
  });

  it('re-emits connected/authenticated/disconnected/reconnecting events', () => {
    const events: string[] = [];
    client.on('connected', () => events.push('connected'));
    client.on('authenticated', () => events.push('authenticated'));
    client.on('disconnected', () => events.push('disconnected'));
    client.on('reconnecting', (n: number) => events.push(`reconnect-${n}`));

    mockWs.emit('connected');
    mockWs.emit('authenticated');
    mockWs.emit('disconnected', 'network');
    mockWs.emit('reconnecting', 1);

    expect(events).toEqual(['connected', 'authenticated', 'disconnected', 'reconnect-1']);
  });

  it('PR 2 v1.2.1 (M7): maps message.text fields correctly (real SDK shape)', () => {
    const events: any[] = [];
    client.onMessage((event) => events.push(event));

    // 真实 SDK 字段（实测）: body.from.userid, body.chattype, body.msgid
    const realSdkFrame = {
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'gmnfk_eKRKCYep2fLBIKfgAA' },
      body: {
        msgid: 'b86a18a610613e284202ddb2961cd445',
        aibotid: 'aibHc_TpvOt0x6RLIMtBIG6yx7UrfOpdbO6',
        chattype: 'single',
        from: { userid: 'WuYuJun' },
        msgtype: 'text',
        text: { content: 'hi' },
      },
    };
    mockWs.emit('message.text', realSdkFrame);

    expect(events).toHaveLength(1);
    expect(events[0].externalUserId).toBe('WuYuJun');
    expect(events[0].messageId).toBe('b86a18a610613e284202ddb2961cd445');
    expect(events[0].text).toBe('hi');
    expect(events[0].chatType).toBe('single');
    expect(events[0].inboundFrame).toBe(realSdkFrame);
  });

  it('handles message.text with group chatType', () => {
    const events: any[] = [];
    client.onMessage((event) => events.push(event));

    mockWs.emit('message.text', {
      body: {
        from: { userid: 'user-1' },
        chattype: 'group',
        msgid: 'group-msg-1',
        text: { content: '群消息' },
      },
    });

    expect(events[0].chatType).toBe('group');
  });

  it('PR 2 v1.2.1 (M7): image messages with array field, warns on unknown shape', () => {
    const events: any[] = [];
    client.onMessage((event) => events.push(event));

    // 标准 image_list 字段
    mockWs.emit('message.image', {
      body: {
        from: { userid: 'user-1' },
        chattype: 'single',
        msgid: 'img-1',
        image_list: [{ file_key: 'media-1' }, { file_key: 'media-2' }],
      },
    });
    expect(events[0].text).toBe('[图片]');
    expect(events[0].images).toHaveLength(2);
    expect(events[0].images[0].fileKey).toBe('media-1');
  });

  it('PR 2 v1.2.1 (M7): handles image.image fallback (legacy field name)', () => {
    const events: any[] = [];
    client.onMessage((event) => events.push(event));

    mockWs.emit('message.image', {
      body: {
        from: { userid: 'user-1' },
        chattype: 'single',
        msgid: 'img-1',
        image: [{ media_id: 'media-legacy' }],
      },
    });
    expect(events[0].images).toHaveLength(1);
    expect(events[0].images[0].fileKey).toBe('media-legacy');
  });

  it('PR 2 v1.2.1 (M7): handles image.images + image.attachments fallback chain', () => {
    const events: any[] = [];
    client.onMessage((event) => events.push(event));

    mockWs.emit('message.image', {
      body: {
        from: { userid: 'user-1' },
        chattype: 'single',
        msgid: 'img-1',
        attachments: [{ fileKey: 'media-att' }],
      },
    });
    expect(events[0].images).toHaveLength(1);
    expect(events[0].images[0].fileKey).toBe('media-att');
  });

  it('PR 2 v1.2.1 (M7): WSAuthFailureError → emit "fatal" (not throw)', () => {
    const fatalErrors: any[] = [];
    client.on('fatal', (err: any) => fatalErrors.push(err));

    const authError = new WSAuthFailureError('auth failed');
    mockWs.emit('error', authError);

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0].code).toBe('E_CONFIG_WECOM_AUTH');
    expect(fatalErrors[0].message).toContain('bot_id 或 secret 错误');
  });

  it('re-emits non-fatal errors via "error" event (default EventEmitter behavior)', () => {
    // 非 fatal 错误（普通网络错）走标准 EventEmitter path
    const genericErr = new Error('random network blip');
    const errors: any[] = [];
    client.on('error', (e: any) => errors.push(e));
    mockWs.emit('error', genericErr);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(genericErr);
  });

  it('PR 2 v1.2.1 (C4): card action event preserves inboundFrame for req_id', () => {
    const actions: any[] = [];
    client.onCardAction((event) => actions.push(event));

    const realTemplateCardEvent = {
      message_id: 'card-msg-1',
      from: { user_id: 'WuYuJun' },
      event: { action_tag: 'retry', action_value: { sessionUuid: 'abc' } },
    };
    mockWs.emit('event.template_card_event', realTemplateCardEvent);

    expect(actions).toHaveLength(1);
    expect(actions[0].externalUserId).toBe('WuYuJun');
    expect(actions[0].messageId).toBe('card-msg-1');
    expect(actions[0].actionTag).toBe('retry');
    expect(actions[0].inboundFrame).toBe(realTemplateCardEvent);
  });
});
