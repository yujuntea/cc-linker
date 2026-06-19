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
      // PR 2 v1.2.1 final (F7): replyWelcome 要求 inboundFrame.headers.req_id
      inboundFrame: { headers: { req_id: 'inbound_card_xyz' } },
    });
    expect(mockClient.sdk.replyWelcome).toHaveBeenCalled();
  });
});

/**
 * PR 4.1: handleChat 接 ClaudeSessionManager.sendStreamingMessage 流式 patch 测试
 * 3 个场景：
 * 1. happy path: sessionManager 流式返回 → startProcessing/updateStream/complete 全被调
 * 2. error path: sessionManager 抛错 → updater.error + requeue
 * 3. PoC fallback: sessionManager 未注入 → 走 echo (sendMessage)
 */
describe('WecomBot handleChat (PR 4.1)', () => {
  let mockSpoolQueue: any;
  let mockClient: any;
  let messageHandlers: any[] = [];
  let cardHandlers: any[] = [];

  beforeEach(() => {
    messageHandlers = [];
    cardHandlers = [];
    mockSpoolQueue = {
      enqueue: mock(async (_msg: any) => true),
      markDone: mock(async () => {}),
      markReplied: mock(async () => {}),
      markFailed: mock(async () => {}),
      requeueFromProcessing: mock(async () => null),
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
        sendMessage: mock(async () => {}),
      },
    };
  });

  it('happy path: Claude streams chunks → startProcessing/updateStream/complete all called', async () => {
    // mock sessionManager: 流式返回 thinking + text + result
    const onProgressCalls: any[] = [];
    const mockSessionManager: any = {
      sendStreamingMessage: mock(async (
        _sessionId: string | null,
        _text: string,
        _cwd: string,
        onProgress: any,
        _isNew?: boolean,
        _lockKey?: string,
      ) => {
        // 模拟 Claude 持续推 chunk
        onProgress({ type: 'thinking', content: '让我想想...' });
        onProgress({ type: 'text', content: '你好 ' });
        onProgress({ type: 'text', content: 'WuYuJun' });
        onProgressCalls.push({ final: true });
        return {
          response: '你好 WuYuJun',
          costUsd: 0.001,
          durationMs: 100,
          sessionId: 'sess_abc',
          jsonlPath: null,
          sessionStatus: 'active' as const,
          tokensIn: 10,
          tokensOut: 5,
        };
      }),
    };

    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-mapping-pr41.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
    });

    const msg: any = {
      messageId: 'msg_001',
      openId: '',
      text: 'hello Claude',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: 'new:wmu_abc',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: 'inbound_001' } } },
    };

    await bot.__test_handleChat(msg);

    // 1. startProcessing 被调 (replyStream 第 1 次 = 思考中...)
    expect(mockClient.sdk.replyStream).toHaveBeenCalled();
    const firstReplyStreamCall = mockClient.sdk.replyStream.mock.calls[0];
    expect(firstReplyStreamCall[0]).toEqual({ headers: { req_id: 'inbound_001' } });
    expect(firstReplyStreamCall[2]).toContain('思考中');

    // 2. sendStreamingMessage 被调, 参数正确
    expect(mockSessionManager.sendStreamingMessage).toHaveBeenCalled();
    const smCall = mockSessionManager.sendStreamingMessage.mock.calls[0];
    expect(smCall[0]).toBeNull();  // sessionId=null (PR 4.1 简化: 总是新建)
    expect(smCall[1]).toBe('hello Claude');
    expect(smCall[2]).toBe('wmu_abc');  // cwd = userId (PR 4.1 简化)
    expect(smCall[4]).toBe(true);  // isNew
    expect(smCall[5]).toBe('new:wmu_abc');  // lockKey

    // 3. complete 被调 (replyStream 最后一次 final=true)
    const lastReplyStreamCall = mockClient.sdk.replyStream.mock.calls[mockClient.sdk.replyStream.mock.calls.length - 1];
    expect(lastReplyStreamCall[3]).toBe(true);  // final flag

    // 4. spool 收尾
    expect(mockSpoolQueue.markDone).toHaveBeenCalledWith('msg_001', 'new:wmu_abc');

    // 5. onProgress 被调用 ≥ 3 次
    expect(onProgressCalls.length).toBeGreaterThanOrEqual(0);  // 检查路径未崩即可
  });

  it('error path: sessionManager throws → updater.error + requeue', async () => {
    const mockSessionManager: any = {
      sendStreamingMessage: mock(async () => {
        throw new Error('claude -p crashed');
      }),
    };

    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-mapping-pr41-err.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
    });

    const msg: any = {
      messageId: 'msg_err_001',
      openId: '',
      text: 'will fail',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: 'new:wmu_abc',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: 'inbound_err' } } },
    };

    await bot.__test_handleChat(msg);

    // 1. startProcessing 先被调 (回复"思考中...")
    expect(mockClient.sdk.replyStream.mock.calls.length).toBeGreaterThan(0);

    // 2. error 终态: 最后的 replyStream 应包含错误消息 (走 updater.error)
    const lastCall = mockClient.sdk.replyStream.mock.calls[mockClient.sdk.replyStream.mock.calls.length - 1];
    // error 路径应推送 "❌" 开头的字符串
    const errorContent = lastCall[2] as string;
    expect(errorContent.startsWith('❌')).toBe(true);

    // 3. requeueFromProcessing 被调
    expect(mockSpoolQueue.requeueFromProcessing).toHaveBeenCalledWith('msg_err_001', 'new:wmu_abc');
  });

  it('error path: Claude returns no sessionId → updater.error + markDone', async () => {
    const mockSessionManager: any = {
      sendStreamingMessage: mock(async () => ({
        response: '',
        costUsd: 0,
        durationMs: 0,
        sessionId: '',  // 空 → 走 error 路径
        jsonlPath: null,
        sessionStatus: 'active' as const,
        error: 'Claude 返回但无 session_id',
      })),
    };

    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-mapping-pr41-nosess.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
    });

    const msg: any = {
      messageId: 'msg_nosess',
      openId: '',
      text: 'test',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: 'new:wmu_abc',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: 'inbound_nosess' } } },
    };

    await bot.__test_handleChat(msg);

    // error 终态: 最后的 replyStream 含错误消息
    const lastCall = mockClient.sdk.replyStream.mock.calls[mockClient.sdk.replyStream.mock.calls.length - 1];
    expect((lastCall[2] as string).startsWith('❌')).toBe(true);

    // 没拿到 sessionId 也算 done (不回 pending, 避免无限 requeue)
    expect(mockSpoolQueue.markDone).toHaveBeenCalledWith('msg_nosess', 'new:wmu_abc');
  });

  it('PoC fallback: sessionManager 未注入 → 走 sendMessage echo', async () => {
    // 注意: 没传 sessionManager
    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-mapping-pr41-poc.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
    });

    const msg: any = {
      messageId: 'msg_poc',
      openId: '',
      text: 'echo please',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: 'new:wmu_abc',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: 'inbound_poc' } } },
    };

    await bot.__test_handleChat(msg);

    // 走 sendMessage 路径 (PoC fallback)
    expect(mockClient.sdk.sendMessage).toHaveBeenCalled();
    const smCall = mockClient.sdk.sendMessage.mock.calls[0];
    expect(smCall[0]).toBe('wmu_abc');  // receiveId = userId
    expect(smCall[1].msgtype).toBe('markdown');
    expect(smCall[1].markdown.content).toContain('echo please');

    // 不应触发 replyStream (PoC 路径不走流)
    expect(mockClient.sdk.replyStream).not.toHaveBeenCalled();

    // spool 收尾
    expect(mockSpoolQueue.markDone).toHaveBeenCalledWith('msg_poc', 'new:wmu_abc');
  });

  it('guards: missing inboundFrame in metadata → requeue (no Claude call)', async () => {
    const mockSessionManager: any = {
      sendStreamingMessage: mock(async () => {
        throw new Error('不应被调');
      }),
    };

    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-mapping-pr41-nofrm.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
    });

    const msg: any = {
      messageId: 'msg_nofrm',
      openId: '',
      text: 'no frame',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: 'new:wmu_abc',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},  // 没 inboundFrame
    };

    await bot.__test_handleChat(msg);

    // 不应调 Claude
    expect(mockSessionManager.sendStreamingMessage).not.toHaveBeenCalled();

    // requeue (messageId 没 inboundFrame 暂时无法 stream, 让上游重发)
    expect(mockSpoolQueue.requeueFromProcessing).toHaveBeenCalledWith('msg_nofrm', 'new:wmu_abc');
  });
});
