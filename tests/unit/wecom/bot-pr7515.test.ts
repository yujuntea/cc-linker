/**
 * PR 7.5.15 → PR 7.5.16: 命令同步直发 — onMessage 内 5s 窗口内
 *   replyTemplateCard (/list) / reply (/status /help /whoami markdown), 不走 SpoolQueue.
 *
 * 背景: 经过 15 个 PR 才锁定真根因 —
 *   aibot server 用 rendezvous 协议, inbound event 的 req_id 5s 后过期.
 *   SpoolQueue dispatch 1-3s + handleCommand 处理时间 → sendViaReply 时 req_id 已失效
 *   → errcode=846605 → markdown fallback.
 *
 *   PR 7.5.15 修法: 在 onMessage (fresh inbound frame) 同步调 replyWelcome, 5s 窗口内必中.
 *     仍失败 (errcode=846605) — SDK 文档明确 replyWelcome 仅 enter_chat 事件能调,
 *     不能用于普通 text 消息 (aibot_msg_callback). replyWelcome 走 WsCmd.RESPONSE_WELCOME
 *     = 'aibot_respond_welcome_msg', 仅 enter_chat 事件用. text 消息应走 WsCmd.RESPONSE
 *     = 'aibot_respond_msg' (= replyStream 用的同一协议).
 *
 *   PR 7.5.16 修法: sync 改用 replyTemplateCard (template_card 卡片) / reply (markdown/text)
 *     都走 WsCmd.RESPONSE 协议, 配 text 消息 req_id 5s 窗口内必中.
 *
 * 测试覆盖:
 * - /list 同步走 replyTemplateCard (WsCmd.RESPONSE + template_card)
 * - /status /help /whoami 同步走 reply (WsCmd.RESPONSE + markdown)
 * - 非命令 (普通 chat) → 返回 false, 走 enqueue 路径
 * - 失败时 → 返回 false, fallback enqueue
 * - sync 成功后 enqueue 不被调 (避免重复推卡)
 * - /switch /new 等需写状态的命令 → 返回 false, 走 enqueue
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { WecomBot } from '../../../src/wecom/bot';
import { promisify } from 'util';

// mock child_process (bot.ts handleCommandStop 动态 import)
const execFileMock = Object.assign(
  mock((_cmd: string, _args: string[], cb: (e: Error | null, so: string, se: string) => void) => {
    cb(null, '', '');
  }),
  {
    [promisify.custom]: (_cmd: string, _args: string[]): Promise<{ stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        execFileMock(_cmd, _args, (err, stdout, stderr) => {
          if (err) reject(err); else resolve({ stdout, stderr });
        });
      }),
  },
);
mock.module('node:child_process', () => ({ ...require('node:child_process'), execFile: execFileMock }));
mock.module('child_process', () => ({ ...require('child_process'), execFile: execFileMock }));

describe('PR 7.5.15: handleCommandSynchronously', () => {
  let mockSpoolQueue: any;
  let mockClient: any;
  let mockCardSender: any;
  let mockUserManager: any;
  let bot: WecomBot;

  beforeEach(() => {
    mockSpoolQueue = {
      enqueue: mock(async (_msg: any) => true),
      markDone: mock(async () => {}),
      markReplied: mock(async () => {}),
      markFailed: mock(async () => {}),
      requeueFromProcessing: mock(async () => null),
      listProcessing: mock(() => []),
    };
    mockClient = {
      onMessage: (_h: any) => {},
      onCardAction: (_h: any) => {},
      connect: mock(() => {}),
      disconnect: mock(() => {}),
      sdk: {
        replyStream: mock(async () => {}),
        reply: mock(async () => {}),
        replyWelcome: mock(async () => {}),
        updateTemplateCard: mock(async () => {}),
        replyTemplateCard: mock(async () => {}),
        sendMessage: mock(async () => {}),
      },
    };
    mockCardSender = {
      send: mock(async () => {}),
      sendViaReply: mock(async () => {}),
    };
    mockUserManager = {
      validateOwner: mock((_uid: string) => true),
      getEntry: mock((_uid: string) => ({ type: 'session', sessionUuid: 'uuid-1', cwd: '/tmp/proj' })),
      setSession: mock(async () => {}),
      touchSession: mock(async () => {}),
      rollbackTimedOutClaims: mock(async () => {}),
    };

    bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-pr7515.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      userManager: mockUserManager as any,
      completeCardSender: mockCardSender,
    });
  });

  describe('/list 命令同步直发', () => {
    it('sync /list 调用 replyTemplateCard (WsCmd.RESPONSE) 而不走 enqueue / sendViaReply', async () => {
      const registryManager = {
        sessions: {
          'uuid-a': { status: 'active', title: 'Project A', message_count: 10, last_active: '2026-06-21T10:00:00Z' },
          'uuid-b': { status: 'active', title: 'Project B', message_count: 5, last_active: '2026-06-21T09:00:00Z' },
        },
      };
      (bot as any).registryManager = registryManager;

      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/list',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'fresh-req-id' }, body: { msgid: 'msg-1' } },
      });

      expect(handled).toBe(true);
      // PR 7.5.16: /list sync 改用 replyTemplateCard (走 WsCmd.RESPONSE), 不再走 sendViaReply
      expect(mockClient.sdk.replyTemplateCard).toHaveBeenCalledTimes(1);
      // 验证传入的 frame 是 fresh 的 inboundFrame
      const callArgs = mockClient.sdk.replyTemplateCard.mock.calls[0];
      expect(callArgs[0]).toEqual({ headers: { req_id: 'fresh-req-id' }, body: { msgid: 'msg-1' } });
      // 验证 card 数据包含 active sessions (wire shape 后)
      const cardArg = callArgs[1];
      expect(cardArg).toBeDefined();
      expect(cardArg.card_type).toBeDefined();
      // sendViaReply 不再被 _syncHandleList 调用
      expect(mockCardSender.sendViaReply).not.toHaveBeenCalled();
    });

    it('sync /list 成功后 enqueue 不被调 (避免 dispatch 重复推卡)', async () => {
      const registryManager = {
        sessions: {
          'uuid-a': { status: 'active', title: 'A', message_count: 1, last_active: '2026-06-21T10:00:00Z' },
        },
      };
      (bot as any).registryManager = registryManager;

      // 模拟 onMessage handler
      let capturedHandler: any;
      mockClient.onMessage = (h: any) => { capturedHandler = h; };
      const mockHandleMessage = mock(async () => {});
      (bot as any).handleMessage = mockHandleMessage;

      bot.start();
      expect(capturedHandler).toBeDefined();

      await capturedHandler({
        externalUserId: 'wmu_user',
        chatId: 'wmu_user',
        chatType: 'single',
        messageId: 'msg-1',
        text: '/list',
        inboundFrame: { headers: { req_id: 'r1' } },
      });

      // 给 microtask 时间让 then chain 跑
      await new Promise(r => setTimeout(r, 50));

      expect(mockClient.sdk.replyTemplateCard).toHaveBeenCalledTimes(1);
      expect(mockSpoolQueue.enqueue).not.toHaveBeenCalled();
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    it('registryManager 未注入 → sync /list 返回 false, 走 enqueue', async () => {
      (bot as any).registryManager = undefined;

      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/list',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'r1' } },
      });

      expect(handled).toBe(false);
      expect(mockClient.sdk.replyTemplateCard).not.toHaveBeenCalled();
    });

    it('replyTemplateCard 失败 → sync /list 返回 false, 走 enqueue', async () => {
      const registryManager = {
        sessions: {
          'uuid-a': { status: 'active', title: 'A', message_count: 1, last_active: '2026-06-21T10:00:00Z' },
        },
      };
      (bot as any).registryManager = registryManager;
      mockClient.sdk.replyTemplateCard = mock(async () => { throw new Error('errcode=846605 invalid req_id'); });

      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/list',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'r1' } },
      });

      expect(handled).toBe(false);
    });
  });

  describe('/status /help /whoami 同步直发 (markdown)', () => {
    it('sync /status 调用 reply (markdown, WsCmd.RESPONSE)', async () => {
      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/status',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'r1' } },
      });
      expect(handled).toBe(true);
      // PR 7.5.16: text 消息 sync 改用 reply (WsCmd.RESPONSE), 不再 replyWelcome
      expect(mockClient.sdk.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.sdk.replyWelcome).not.toHaveBeenCalled();
      const callArgs = mockClient.sdk.reply.mock.calls[0];
      expect(callArgs[0]).toEqual({ headers: { req_id: 'r1' } });
      expect(callArgs[1].msgtype).toBe('markdown');
      expect(callArgs[1].markdown.content).toContain('📊');
    });

    it('sync /help 调用 reply (markdown)', async () => {
      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/help',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'r1' } },
      });
      expect(handled).toBe(true);
      expect(mockClient.sdk.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.sdk.replyWelcome).not.toHaveBeenCalled();
    });

    it('sync /whoami 调用 reply (markdown)', async () => {
      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/whoami',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'r1' } },
      });
      expect(handled).toBe(true);
      expect(mockClient.sdk.reply).toHaveBeenCalledTimes(1);
      expect(mockClient.sdk.replyWelcome).not.toHaveBeenCalled();
    });
  });

  describe('非命令 / 异步命令 → 走 enqueue 路径', () => {
    it('普通聊天消息 (不是命令) → sync 返回 false', async () => {
      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: 'hello world',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'r1' } },
      });
      expect(handled).toBe(false);
    });

    it('/switch 需写 user-mapping → sync 返回 false, 走 enqueue', async () => {
      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/switch uuid-a',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'r1' } },
      });
      expect(handled).toBe(false);
    });

    it('/new → sync 返回 false, 走 enqueue', async () => {
      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/new',
        timestamp: Date.now(),
        raw: {},
        inboundFrame: { headers: { req_id: 'r1' } },
      });
      expect(handled).toBe(false);
    });

    it('没 inboundFrame → sync 返回 false', async () => {
      const handled = await (bot as any).handleCommandSynchronously({
        platform: 'wecom',
        userId: 'wmu_user',
        chatType: 'p2p',
        chatId: 'wmu_user',
        messageId: 'msg-1',
        text: '/list',
        timestamp: Date.now(),
        raw: {},
        // 故意没 inboundFrame
      });
      expect(handled).toBe(false);
    });
  });

  describe('onMessage 集成', () => {
    it('start() 注册的 onMessage handler: /list → sync 成功 → enqueue 未调', async () => {
      const registryManager = {
        sessions: {
          'uuid-a': { status: 'active', title: 'A', message_count: 1, last_active: '2026-06-21T10:00:00Z' },
        },
      };
      (bot as any).registryManager = registryManager;

      let capturedHandler: any;
      mockClient.onMessage = (h: any) => { capturedHandler = h; };

      bot.start();
      expect(capturedHandler).toBeDefined();

      await capturedHandler({
        externalUserId: 'wmu_user',
        chatId: 'wmu_user',
        chatType: 'single',
        messageId: 'msg-1',
        text: '/list',
        inboundFrame: { headers: { req_id: 'fresh' }, body: { msgid: 'msg-1' } },
      });
      await new Promise(r => setTimeout(r, 50));

      expect(mockClient.sdk.replyTemplateCard).toHaveBeenCalledTimes(1);
      expect(mockSpoolQueue.enqueue).not.toHaveBeenCalled();
    });

    it('start() 注册的 onMessage handler: 普通消息 → 走 enqueue', async () => {
      let capturedHandler: any;
      mockClient.onMessage = (h: any) => { capturedHandler = h; };

      bot.start();

      await capturedHandler({
        externalUserId: 'wmu_user',
        chatId: 'wmu_user',
        chatType: 'single',
        messageId: 'msg-2',
        text: 'hi',
        inboundFrame: { headers: { req_id: 'r2' } },
      });
      await new Promise(r => setTimeout(r, 50));

      expect(mockSpoolQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('start() 注册的 onMessage handler: /list sync 失败 → fallback enqueue', async () => {
      const registryManager = {
        sessions: {
          'uuid-a': { status: 'active', title: 'A', message_count: 1, last_active: '2026-06-21T10:00:00Z' },
        },
      };
      (bot as any).registryManager = registryManager;
      mockClient.sdk.replyTemplateCard = mock(async () => { throw new Error('errcode=846605'); });

      let capturedHandler: any;
      mockClient.onMessage = (h: any) => { capturedHandler = h; };

      bot.start();

      await capturedHandler({
        externalUserId: 'wmu_user',
        chatId: 'wmu_user',
        chatType: 'single',
        messageId: 'msg-3',
        text: '/list',
        inboundFrame: { headers: { req_id: 'r3' } },
      });
      await new Promise(r => setTimeout(r, 50));

      expect(mockClient.sdk.replyTemplateCard).toHaveBeenCalledTimes(1);
      expect(mockSpoolQueue.enqueue).toHaveBeenCalledTimes(1);
    });
  });
});