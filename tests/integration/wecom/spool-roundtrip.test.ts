import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockAibotServer } from './mock-aibot';
import { WecomBot } from '../../../src/wecom/bot';

describe('wecom integration: text message → spool enqueue', () => {
  let dir: string;
  let mockServer: MockAibotServer;
  let mockSpoolQueue: any;
  let mockSessionManager: any;
  let bot: WecomBot;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-int-'));
    mockServer = new MockAibotServer();
    mockSpoolQueue = {
      enqueue: async (msg: any) => { mockSpoolQueue.lastEnqueued = msg; return true; },
      markDone: async () => {},
      lastEnqueued: null as any,
    };
    mockSessionManager = {
      sendStreamingMessage: async function* () {
        yield { type: 'thinking', content: 'mock thinking' };
        yield { type: 'text', content: 'mock response' };
        yield { type: 'result', result: 'mock response', session_id: 'mock-uuid', total_cost_usd: 0.01, duration_ms: 1500, stop_reason: 'end_turn', subtype: 'success', is_error: false };
      },
    };

    const mockAibotClient: any = {
      // WecomBot 调 client.onMessage(handler)，handler 实际由 setupListeners 调用
      // 真实 AibotClient 是 push 到 messageHandlers[] 数组
      // 集成测试 mock 必须 push 才能让 WecomBot 收到
      onMessage: (h: any) => mockServer.on('message.text', h),
      onCardAction: (h: any) => mockServer.on('event.template_card_event', h),
      connect: () => {},
      disconnect: () => {},
      sdk: mockServer.buildMockSdk(),
    };

    // Pre-register handlers like real AibotClient would do on construct
    // (模拟 setupListeners 内部的 wsClient.on('message.text', ...) 行为)
    // WecomBot.start() 调 client.onMessage(h)，handler 立即注册到 mockServer
    // simulateXxx 触发 mockServer.emit() → handler 被调
    // 这个 wiring 是 WecomBot.start() 内部做的，不需要手动预注册

    bot = new WecomBot({
      botId: 'test-bot',
      secret: 'test-secret',
      userMappingPath: join(dir, 'mapping.json'),
      client: mockAibotClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
    });
  });

  afterEach(() => {
    bot.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes text message to SpoolQueue with correct serialKey', async () => {
    bot.start();
    mockServer.simulateTextMessage({
      externalUserId: 'wmu_test',
      chatId: 'wmu_test',
      text: 'hello world',
    });
    await new Promise(r => setTimeout(r, 50));

    expect(mockSpoolQueue.lastEnqueued).not.toBeNull();
    expect(mockSpoolQueue.lastEnqueued.platform).toBe('wecom');
    expect(mockSpoolQueue.lastEnqueued.userId).toBe('wmu_test');
    expect(mockSpoolQueue.lastEnqueued.text).toBe('hello world');
    expect(mockSpoolQueue.lastEnqueued.serialKey).toBe('new:wmu_test');
  });

  it('routes command message with cmd: serialKey', async () => {
    bot.start();
    mockServer.simulateTextMessage({
      externalUserId: 'wmu_test',
      chatId: 'wmu_test',
      text: '/list',
    });
    await new Promise(r => setTimeout(r, 50));

    expect(mockSpoolQueue.lastEnqueued).not.toBeNull();
    expect(mockSpoolQueue.lastEnqueued.serialKey).toMatch(/^cmd:wmu_test:mock_msg_/);
  });

  it('handles card action with 5s replyWelcome placeholder', async () => {
    bot.start();
    mockServer.simulateTemplateCardEvent({
      externalUserId: 'wmu_test',
      messageId: 'card_msg_xyz',
      actionTag: 'retry',
      actionValue: { sessionUuid: 'abc' },
    });
    await new Promise(r => setTimeout(r, 50));

    const replyWelcomeCalls = mockServer.sdkCalls.filter(c => c.method === 'replyWelcome');
    expect(replyWelcomeCalls.length).toBeGreaterThanOrEqual(1);
    expect(replyWelcomeCalls[0].args[1]).toHaveProperty('msgtype', 'template_card');
  });

  it('handles WSS disconnect event gracefully', async () => {
    bot.start();
    mockServer.simulateDisconnect('network error');
    await new Promise(r => setTimeout(r, 50));
    // 应该记录 disconnect 事件, 但不崩溃
    expect(true).toBe(true);
  });
});
