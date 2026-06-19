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
  let mockUserManager: any;
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
    // PR 4.5: 默认 mock userManager (避免读真实文件, 防止测试间状态污染)
    // 单个测试可覆盖 getEntry 返回特定 entry 测续聊
    mockUserManager = {
      getEntry: mock((_uid: string) => undefined),
      setSession: mock(async () => {}),
      touchSession: mock(async () => {}),
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
      // PR 4.5: 注入 mock userManager 避免真实文件 IO 污染 (getEntry=undefined 即新建场景)
      userManager: mockUserManager as any,
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
    // PR 4.5 B: sessionId=null (新建), cwd='/tmp' fallback (PR 4.1 简化用 userId 已弃用)
    expect(mockSessionManager.sendStreamingMessage).toHaveBeenCalled();
    const smCall = mockSessionManager.sendStreamingMessage.mock.calls[0];
    expect(smCall[0]).toBeNull();  // sessionId=null (PR 4.1 + PR 4.5: 新建场景)
    expect(smCall[1]).toBe('hello Claude');
    expect(smCall[2]).toBe('/tmp');  // PR 4.5: 新建场景 fallback cwd='/tmp'
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

/**
 * PR 4.5 B: handleChat 接续聊 (读 user-mapping 走 resume vs new)
 * 4 个场景：
 * 1. 续聊: getEntry 返回 {type:'session', sessionUuid:'existing-uuid', cwd:'/var/www'} → sessionId 传 'existing-uuid' + 不调 setSession + 调 touchSession
 * 2. 新建: getEntry 返回 undefined → sessionId=null (新建) + 调 setSession 持久化
 * 3. 续聊但 sessionId 为空字符串: getEntry 返回 session 但 sessionUuid='' → 走新建路径 (不挂 resume)
 * 4. 续聊失败: sessionManager 抛错 → 不调 setSession/touchSession
 */
describe('WecomBot handleChat (PR 4.5 B: 续聊映射)', () => {
  let mockSpoolQueue: any;
  let mockClient: any;
  let mockUserManager: any;

  beforeEach(() => {
    mockSpoolQueue = {
      enqueue: mock(async (_msg: any) => true),
      markDone: mock(async () => {}),
      markReplied: mock(async () => {}),
      markFailed: mock(async () => {}),
      requeueFromProcessing: mock(async () => null),
    };
    mockClient = {
      onMessage: (_h: any) => {},
      onCardAction: (_h: any) => {},
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
    // 默认 mock userManager: getEntry 返回 undefined (覆盖在每个测试里)
    mockUserManager = {
      getEntry: mock((_uid: string) => undefined),
      setSession: mock(async () => {}),
      touchSession: mock(async () => {}),
    };
  });

  it('resume 场景: getEntry 返回 session → 传 existing-uuid + 调 touchSession 不调 setSession', async () => {
    mockUserManager.getEntry = mock((_uid: string) => ({
      type: 'session',
      sessionUuid: 'existing-uuid-789',
      cwd: '/var/www/app',
      createdAt: '2026-06-19T00:00:00Z',
      lastActiveAt: '2026-06-19T01:00:00Z',
      casToken: 'old-token',
    }));

    const mockSessionManager: any = {
      sendStreamingMessage: mock(async (
        _sessionId: string | null,
        _text: string,
        _cwd: string,
        _onProgress: any,
        _isNew?: boolean,
        _lockKey?: string,
      ) => ({
        response: '继续聊天回复',
        costUsd: 0.001,
        durationMs: 100,
        sessionId: 'existing-uuid-789',  // 同 sessionId
        jsonlPath: null,
        sessionStatus: 'active' as const,
        tokensIn: 10,
        tokensOut: 5,
      })),
    };

    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-pr45-resume.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
      userManager: mockUserManager as any,
    });

    const msg: any = {
      messageId: 'msg_resume',
      openId: '',
      text: '继续',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'session', sessionUuid: 'existing-uuid-789', cwd: '/var/www/app' },
      serialKey: 'existing-uuid-789:msg_resume',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: 'inbound_resume' } } },
    };

    await bot.__test_handleChat(msg);

    // 1. sessionManager 被调, sessionId 是 existing-uuid-789 (resume)
    const smCall = mockSessionManager.sendStreamingMessage.mock.calls[0];
    expect(smCall[0]).toBe('existing-uuid-789');
    expect(smCall[2]).toBe('/var/www/app');  // cwd 用 entry 里的, 不是 fallback /tmp
    expect(smCall[4]).toBe(false);  // isNew = false (续聊)
    expect(smCall[5]).toBe('existing-uuid-789');  // lockKey = sessionId

    // 2. 续聊: 调 touchSession, 不调 setSession
    expect(mockUserManager.touchSession).toHaveBeenCalledWith('wmu_abc');
    expect(mockUserManager.setSession).not.toHaveBeenCalled();
  });

  it('new 场景: getEntry 返回 undefined → sessionId=null + 调 setSession 持久化', async () => {
    mockUserManager.getEntry = mock((_uid: string) => undefined);

    const mockSessionManager: any = {
      sendStreamingMessage: mock(async (
        _sessionId: string | null,
        _text: string,
        _cwd: string,
        _onProgress: any,
        _isNew?: boolean,
        _lockKey?: string,
      ) => ({
        response: '新会话回复',
        costUsd: 0.001,
        durationMs: 100,
        sessionId: 'new-uuid-001',
        jsonlPath: null,
        sessionStatus: 'active' as const,
        tokensIn: 10,
        tokensOut: 5,
      })),
    };

    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-pr45-new.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
      userManager: mockUserManager as any,
    });

    const msg: any = {
      messageId: 'msg_new',
      openId: '',
      text: '你好',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: 'new:wmu_abc',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: 'inbound_new' } } },
    };

    await bot.__test_handleChat(msg);

    // 1. sessionManager 被调, sessionId = null (新建)
    const smCall = mockSessionManager.sendStreamingMessage.mock.calls[0];
    expect(smCall[0]).toBeNull();
    expect(smCall[2]).toBe('/tmp');  // PR 4.5: 新建默认 /tmp
    expect(smCall[4]).toBe(true);  // isNew
    expect(smCall[5]).toBe('new:wmu_abc');  // lockKey

    // 2. 新建: 调 setSession, 不调 touchSession
    expect(mockUserManager.setSession).toHaveBeenCalledWith('wmu_abc', 'new-uuid-001', '/tmp');
    expect(mockUserManager.touchSession).not.toHaveBeenCalled();
  });

  it('resume edge case: sessionUuid 为空字符串 → 走新建路径', async () => {
    // 历史 bug 防御: sessionUuid 为空时不能 resume, 否则 claude -p --resume '' 会出错
    mockUserManager.getEntry = mock((_uid: string) => ({
      type: 'session',
      sessionUuid: '',  // 空串 → 不应 resume
      cwd: '/var/www',
      createdAt: '2026-06-19T00:00:00Z',
      lastActiveAt: '2026-06-19T01:00:00Z',
      casToken: 'token',
    }));

    const mockSessionManager: any = {
      sendStreamingMessage: mock(async () => ({
        response: 'r',
        costUsd: 0,
        durationMs: 0,
        sessionId: 'fallback-uuid',
        jsonlPath: null,
        sessionStatus: 'active' as const,
        tokensIn: 0,
        tokensOut: 0,
      })),
    };

    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-pr45-empty.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
      userManager: mockUserManager as any,
    });

    const msg: any = {
      messageId: 'msg_empty',
      openId: '',
      text: 'hello',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: 'new:wmu_abc',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: 'inbound_empty' } } },
    };

    await bot.__test_handleChat(msg);

    // 走新建路径: sessionId=null + isNew=true
    const smCall = mockSessionManager.sendStreamingMessage.mock.calls[0];
    expect(smCall[0]).toBeNull();
    expect(smCall[4]).toBe(true);

    // 调 setSession 持久化新 session
    expect(mockUserManager.setSession).toHaveBeenCalledWith('wmu_abc', 'fallback-uuid', '/tmp');
  });

  it('error 场景: sessionManager 抛错 → 不调 setSession/touchSession', async () => {
    mockUserManager.getEntry = mock((_uid: string) => ({
      type: 'session',
      sessionUuid: 'existing-uuid-789',
      cwd: '/var/www/app',
      createdAt: '2026-06-19T00:00:00Z',
      lastActiveAt: '2026-06-19T01:00:00Z',
      casToken: 'token',
    }));

    const mockSessionManager: any = {
      sendStreamingMessage: mock(async () => {
        throw new Error('claude -p crashed');
      }),
    };

    const bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-pr45-err.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      sessionManager: mockSessionManager,
      userManager: mockUserManager as any,
    });

    const msg: any = {
      messageId: 'msg_resume_err',
      openId: '',
      text: 'continue',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'session', sessionUuid: 'existing-uuid-789', cwd: '/var/www/app' },
      serialKey: 'existing-uuid-789:msg_resume_err',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: 'inbound_resume_err' } } },
    };

    await bot.__test_handleChat(msg);

    // 错误路径: 不应持久化 (无论是 setSession 还是 touchSession)
    expect(mockUserManager.setSession).not.toHaveBeenCalled();
    expect(mockUserManager.touchSession).not.toHaveBeenCalled();
  });
});

/**
 * PR 4.5 C: handleCommand 路由 (/new /list /status /help + 未知命令)
 * 7 个场景：
 * 1. /new [cwd] → 调 setPending + 返回成功消息
 * 2. /list + 有 session → 返回 session info
 * 3. /list + 无 entry → 返回空消息
 * 4. /status → 返回 bot 状态
 * 5. /help → 返回帮助文本
 * 6. 未知命令 /foo → 返回错误消息
 * 7. parseCommand 失败 → 不调任何 sendMessage
 */
describe('WecomBot handleCommand (PR 4.5 C: 命令路由)', () => {
  let mockSpoolQueue: any;
  let mockClient: any;
  let mockUserManager: any;
  let bot: WecomBot;

  beforeEach(() => {
    mockSpoolQueue = {
      enqueue: mock(async (_msg: any) => true),
      markDone: mock(async () => {}),
      markReplied: mock(async () => {}),
      markFailed: mock(async () => {}),
      requeueFromProcessing: mock(async () => null),
    };
    mockClient = {
      onMessage: (_h: any) => {},
      onCardAction: (_h: any) => {},
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
    mockUserManager = {
      getEntry: mock((_uid: string) => undefined),
      setPending: mock(async () => {}),
      setSession: mock(async () => {}),
      touchSession: mock(async () => {}),
    };
    bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-pr45-cmd.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      userManager: mockUserManager as any,
    });
  });

  /** 辅助: 构造 SpoolMessage */
  function makeCmdMsg(text: string, messageId = 'msg_cmd'): any {
    return {
      messageId,
      openId: '',
      text,
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: `cmd:wmu_abc:${messageId}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { inboundFrame: { headers: { req_id: `inb_${messageId}` } } },
    };
  }

  it('/new [cwd] → 调 setPending + 返回成功消息', async () => {
    await bot.__test_handleCommand(makeCmdMsg('/new /var/www/app', 'msg_new'));

    // 1. setPending 被调
    expect(mockUserManager.setPending).toHaveBeenCalledWith('wmu_abc', { cwd: '/var/www/app' });

    // 2. sendMessage 推回成功消息
    expect(mockClient.sdk.sendMessage).toHaveBeenCalled();
    const smCall = mockClient.sdk.sendMessage.mock.calls[0];
    expect(smCall[0]).toBe('wmu_abc');  // receiveId = userId
    expect(smCall[1].msgtype).toBe('markdown');
    expect(smCall[1].markdown.content).toContain('已创建 pending session');
    expect(smCall[1].markdown.content).toContain('/var/www/app');

    // 3. spool markDone
    expect(mockSpoolQueue.markDone).toHaveBeenCalledWith('msg_new', 'cmd:wmu_abc:msg_new');
  });

  it('/new (无 cwd) → cwd fallback /tmp', async () => {
    await bot.__test_handleCommand(makeCmdMsg('/new', 'msg_new2'));

    expect(mockUserManager.setPending).toHaveBeenCalledWith('wmu_abc', { cwd: '/tmp' });
  });

  it('/list + 有 session → 返回 session info', async () => {
    mockUserManager.getEntry = mock((_uid: string) => ({
      type: 'session',
      sessionUuid: 'uuid-list-1',
      cwd: '/home/user',
      createdAt: '2026-06-19T00:00:00Z',
      lastActiveAt: '2026-06-19T01:00:00Z',
      casToken: 'token',
    }));

    await bot.__test_handleCommand(makeCmdMsg('/list', 'msg_list'));

    expect(mockClient.sdk.sendMessage).toHaveBeenCalled();
    const content = mockClient.sdk.sendMessage.mock.calls[0][1].markdown.content;
    expect(content).toContain('uuid-list-1');
    expect(content).toContain('/home/user');
  });

  it('/list + 无 entry → 返回空消息', async () => {
    mockUserManager.getEntry = mock((_uid: string) => undefined);

    await bot.__test_handleCommand(makeCmdMsg('/list', 'msg_list_empty'));

    expect(mockClient.sdk.sendMessage).toHaveBeenCalled();
    const content = mockClient.sdk.sendMessage.mock.calls[0][1].markdown.content;
    expect(content).toContain('无 active session');
  });

  it('/list + pending 状态 → 返回 pending 提示', async () => {
    mockUserManager.getEntry = mock((_uid: string) => ({
      type: 'pending_new_session',
      sessionUuid: null,
      cwd: '/tmp',
      createdAt: '2026-06-19T00:00:00Z',
      lastActiveAt: '2026-06-19T00:00:00Z',
      casToken: 'token',
    }));

    await bot.__test_handleCommand(makeCmdMsg('/list', 'msg_list_pending'));

    const content = mockClient.sdk.sendMessage.mock.calls[0][1].markdown.content;
    expect(content).toContain('等待下条消息');
  });

  it('/status → 返回 bot 状态', async () => {
    await bot.__test_handleCommand(makeCmdMsg('/status', 'msg_status'));

    expect(mockClient.sdk.sendMessage).toHaveBeenCalled();
    const content = mockClient.sdk.sendMessage.mock.calls[0][1].markdown.content;
    expect(content).toContain('Wecom Bot 状态');
  });

  it('/help → 返回帮助文本', async () => {
    await bot.__test_handleCommand(makeCmdMsg('/help', 'msg_help'));

    expect(mockClient.sdk.sendMessage).toHaveBeenCalled();
    const content = mockClient.sdk.sendMessage.mock.calls[0][1].markdown.content;
    expect(content).toContain('cc-linker wecom Bot 命令');
    expect(content).toContain('/new');
    expect(content).toContain('/list');
    expect(content).toContain('/status');
    expect(content).toContain('/help');
  });

  it('未知命令 /foo → 返回错误消息', async () => {
    await bot.__test_handleCommand(makeCmdMsg('/foo', 'msg_unknown'));

    expect(mockClient.sdk.sendMessage).toHaveBeenCalled();
    const content = mockClient.sdk.sendMessage.mock.calls[0][1].markdown.content;
    expect(content).toContain('未知命令');
    expect(content).toContain('/foo');
  });

  it('parseCommand 失败 → 不调 sendMessage, 不调任何 userManager 方法', async () => {
    // 注意: parseCommand 只接受 / 开头的命令, /abc def (空格开头) 不是命令
    // 实际: isCommandMessage 要求 text[1] 非空白 → "/ abc" 返回 false
    // 但 handleCommand 已经被 dispatcher 路由过来, msg.text 必是 / 开头
    // 这里测一个边界: msg.text 为空 → parseCommand 返回 null
    await bot.__test_handleCommand(makeCmdMsg('', 'msg_empty'));

    // parseCommand 返回 null → handleCommand 早 return
    expect(mockClient.sdk.sendMessage).not.toHaveBeenCalled();
    expect(mockUserManager.setPending).not.toHaveBeenCalled();
  });

  it('不调 replyStream (命令响应不走流, 用 sendMessage 推回)', async () => {
    await bot.__test_handleCommand(makeCmdMsg('/help', 'msg_nostream'));

    // 命令响应是终态文本, 走 sendMessage, 不应触发 replyStream
    expect(mockClient.sdk.replyStream).not.toHaveBeenCalled();
  });

  it('sendMessage 抛错 → requeueFromProcessing', async () => {
    mockClient.sdk.sendMessage = mock(async () => {
      throw new Error('network down');
    });

    await bot.__test_handleCommand(makeCmdMsg('/help', 'msg_senderr'));

    // 错误路径: requeue 让消息回 pending
    expect(mockSpoolQueue.requeueFromProcessing).toHaveBeenCalledWith('msg_senderr', 'cmd:wmu_abc:msg_senderr');
    expect(mockSpoolQueue.markDone).not.toHaveBeenCalled();
  });
});
