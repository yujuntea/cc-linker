/**
 * PR 6.8.4: 续聊 session 的 /xxx 命令也走 handleCommand 而非 handleChat
 *
 * 背景: 14:49-14:50 真实验收发现
 * - 用户已有 active session (serialKey 是 `<sessionId>:<msgId>`, 不带 cmd: 前缀)
 * - 发 /list → 走 handleChat → Claude 把 /list 当 user prompt 处理, 返回 43 chars
 * - 期望: /list 应当走 handleCommand 显示 session 列表
 *
 * 修法: handleClaimed 在非 cmd:/new: 路径上, 先 parseCommand 判断是不是命令,
 *   是命令走 handleCommand, 否则走 handleChat
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { WecomBot } from '../../../src/wecom/bot';

// ── mock node:child_process (跟 bot.test.ts 同源, 避免真去跑 claude 子进程) ──
import { promisify } from 'util';
const execFileMock = Object.assign(
  mock((_cmd: string, _args: string[], cb: (e: Error | null, so: string, se: string) => void) => {
    cb(null, '', '');
  }),
  {
    [promisify.custom]: (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        execFileMock(cmd, args, (err, stdout, stderr) => {
          if (err) reject(err); else resolve({ stdout, stderr });
        });
      }),
  },
);
mock.module('node:child_process', () => ({ ...require('node:child_process'), execFile: execFileMock }));
mock.module('child_process', () => ({ ...require('node:child_process'), execFile: execFileMock }));

describe('PR 6.8.4: handleClaimed 续聊 session 路径识别 /xxx 命令', () => {
  let mockSpoolQueue: any;
  let mockClient: any;
  let mockUserManager: any;
  let bot: WecomBot;
  let handleCommandSpy: any;
  let handleChatSpy: any;

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
        replyWelcome: mock(async () => {}),
        updateTemplateCard: mock(async () => {}),
        replyTemplateCard: mock(async () => {}),
        sendMessage: mock(async () => {}),
      },
    };
    // PR 4.5: getEntry 返回续聊 session (PR 6.8.4 修法关键: session-based serialKey)
    mockUserManager = {
      validateOwner: mock((_uid: string) => true),
      getEntry: mock((_uid: string) => ({ type: 'session', sessionUuid: '460fc493-uuid', cwd: '/tmp/proj' })),
      setSession: mock(async () => {}),
      touchSession: mock(async () => {}),
      rollbackTimedOutClaims: mock(async () => {}),
    };

    bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-pr684.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      userManager: mockUserManager as any,
    });

    // 拦截 handleCommand + handleChat 调用
    handleCommandSpy = mock(async (_msg: any) => {});
    handleChatSpy = mock(async (_msg: any) => {});
    (bot as any).handleCommand = handleCommandSpy;
    (bot as any).handleChat = handleChatSpy;
  });

  it('续聊 session 的 /list 走 handleCommand (而非 handleChat)', async () => {
    // 续聊 session 的 serialKey 是 `<sessionId>:<msgId>`, 不带 cmd: 前缀
    // PR 6.8.4: 这种路径要 parseCommand 检查是不是命令, 是命令走 handleCommand
    const msg: any = {
      messageId: 'm_001',
      openId: '',
      text: '/list',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'session', sessionUuid: '460fc493-uuid', cwd: '/tmp/proj' },
      serialKey: '460fc493-uuid:m_001',  // 续聊 session 的 serialKey (无 cmd: 前缀)
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    await bot.__test_handleClaimed(msg);

    expect(handleCommandSpy).toHaveBeenCalled();
    expect(handleChatSpy).not.toHaveBeenCalled();
  });

  it('续聊 session 的 /status 也走 handleCommand', async () => {
    const msg: any = {
      messageId: 'm_002',
      openId: '',
      text: '/status',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'session', sessionUuid: '460fc493-uuid', cwd: '/tmp/proj' },
      serialKey: '460fc493-uuid:m_002',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    await bot.__test_handleClaimed(msg);

    expect(handleCommandSpy).toHaveBeenCalled();
    expect(handleChatSpy).not.toHaveBeenCalled();
  });

  it('续聊 session 的普通消息仍然走 handleChat (非命令)', async () => {
    const msg: any = {
      messageId: 'm_003',
      openId: '',
      text: 'continue the conversation',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'session', sessionUuid: '460fc493-uuid', cwd: '/tmp/proj' },
      serialKey: '460fc493-uuid:m_003',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    await bot.__test_handleClaimed(msg);

    expect(handleChatSpy).toHaveBeenCalled();
    expect(handleCommandSpy).not.toHaveBeenCalled();
  });

  it('cmd: serialKey 仍然走 handleCommand (回归测试)', async () => {
    // 保留原行为: 显式 cmd: 前缀的走 handleCommand
    const msg: any = {
      messageId: 'm_004',
      openId: '',
      text: '/list',
      userId: 'wmu_abc',
      platform: 'wecom',
      target: { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined },
      serialKey: 'cmd:wmu_abc:m_004',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    await bot.__test_handleClaimed(msg);

    expect(handleCommandSpy).toHaveBeenCalled();
    expect(handleChatSpy).not.toHaveBeenCalled();
  });
});