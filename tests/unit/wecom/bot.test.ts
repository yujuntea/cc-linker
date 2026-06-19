import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { WecomBot } from '../../../src/wecom/bot';

describe('WecomBot', () => {
  let mockSpoolQueue: any;
  let mockClient: any;
  let messageHandlers: any[] = [];
  let cardHandlers: any[] = [];
  let bot: WecomBot;

  beforeEach(() => {
    messageHandlers = [];
    cardHandlers = [];
    mockSpoolQueue = {
      enqueue: mock(async (msg: any) => true),
      markDone: mock(async () => {}),
    };
    mockClient = {
      onMessage: (h: any) => { messageHandlers.push(h); },
      onCardAction: (h: any) => { cardHandlers.push(h); },
      connect: mock(() => {}),
      disconnect: mock(() => {}),
      sdk: {
        replyStream: mock(async () => {}),
        replyWelcome: mock(async () => {}),
        updateTemplateCard: mock(async () => {}),
        replyTemplateCard: mock(async () => {}),
      },
    };

    // 直接 mock AibotClient 构造, 不走真实 WSS
    bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-mapping.json',
      client: mockClient,  // 注入 mock client
      spoolQueue: mockSpoolQueue,
    });
  });

  it('routes incoming text message to SpoolQueue', async () => {
    bot.start();
    expect(messageHandlers).toHaveLength(1);
    await messageHandlers[0]({
      externalUserId: 'wmu_abc',
      chatId: 'wmu_abc',
      chatType: 'single',
      messageId: 'msg_xyz',
      text: 'hello',
    });
    await new Promise(r => setTimeout(r, 50));
    expect(mockSpoolQueue.enqueue).toHaveBeenCalled();
    const enqueuedMsg = mockSpoolQueue.enqueue.mock.calls[0][0];
    expect(enqueuedMsg.platform).toBe('wecom');
    expect(enqueuedMsg.userId).toBe('wmu_abc');
    expect(enqueuedMsg.text).toBe('hello');
  });

  it('uses cmd: serialKey for command messages', async () => {
    bot.start();
    await messageHandlers[0]({
      externalUserId: 'wmu_abc',
      chatId: 'wmu_abc',
      chatType: 'single',
      messageId: 'msg_xyz',
      text: '/list',
    });
    await new Promise(r => setTimeout(r, 50));
    const enqueuedMsg = mockSpoolQueue.enqueue.mock.calls[0][0];
    expect(enqueuedMsg.serialKey).toBe('cmd:wmu_abc:msg_xyz');
  });

  it('uses new: serialKey for new chat messages', async () => {
    bot.start();
    await messageHandlers[0]({
      externalUserId: 'wmu_abc',
      chatId: 'wmu_abc',
      chatType: 'single',
      messageId: 'msg_xyz',
      text: 'hello',
    });
    await new Promise(r => setTimeout(r, 50));
    const enqueuedMsg = mockSpoolQueue.enqueue.mock.calls[0][0];
    expect(enqueuedMsg.serialKey).toBe('new:wmu_abc');
  });

  it('card action handler calls replyWelcome within 5s', async () => {
    bot.start();
    expect(cardHandlers).toHaveLength(1);
    await cardHandlers[0]({
      externalUserId: 'wmu_abc',
      messageId: 'msg_card_xyz',
      actionTag: 'retry',
      actionValue: { sessionUuid: 'abc' },
    });
    expect(mockClient.sdk.replyWelcome).toHaveBeenCalled();
  });
});
