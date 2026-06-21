/**
 * PR 7.5.21: /list 加 AI 最后消息预览 + 运行中 badge (对齐飞书)
 *
 * 飞书 buildListCard 已有:
 *   - 🤖 last_assistant_preview (AI 摘要, scanner populate)
 *   - 🔴 运行中 (从 sessionManager.activeProcesses 拿)
 *
 * WeCom 此前 (PR 7.5.20) 缺这两个字段. PR 7.5.21 补齐:
 *   - 新增 _formatAIPreview() helper (esc markdown + 限 60 字符)
 *   - _syncHandleList 拿 sessionManager.listSessions() 构建 runningUuids 集合
 *
 * 测试覆盖:
 *   1. AI preview line 渲染 (含 🤖 + 实际文本)
 *   2. running badge 渲染 (含 🔴 **运行中**)
 *   3. AI preview 截断到 60 字符 (含 '...')
 *   4. AI preview 转义 markdown 特殊字符 (* _ [ ] `)
 *   5. AI preview 取第一非空行 (跳过前导空白行)
 *   6. running 缺失时无 🔴 (不破坏无 sessionManager 的场景)
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

describe('PR 7.5.21: /list AI 预览 + 运行中 badge', () => {
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
      getEntry: mock((_uid: string) => ({ type: 'session', sessionUuid: 'uuid-cur', cwd: '/tmp/proj' })),
      setSession: mock(async () => {}),
      touchSession: mock(async () => {}),
      rollbackTimedOutClaims: mock(async () => {}),
    };

    bot = new WecomBot({
      botId: 'test',
      secret: 'test',
      userMappingPath: '/tmp/test-pr7521.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      userManager: mockUserManager as any,
      completeCardSender: mockCardSender,
    });
  });

  it('PR 7.5.21: /list shows AI preview line when last_assistant_preview present', async () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const registryManager = {
      sessions: {
        'uuid-with-ai': {
          status: 'active',
          title: 'PR 7.5.21 测试会话',
          message_count: 100,
          last_active: fiveMinAgo,
          project_name: 'cc-linker',
          cwd: '/tmp/proj',
          last_assistant_preview: 'PR 7.5.21 已部署, 继续验证. 用户反馈良好, 飞书 /list 对齐完成.',
        },
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
      inboundFrame: { headers: { req_id: 'r1' }, body: { msgid: 'msg-1' } },
    });

    expect(handled).toBe(true);
    expect(mockClient.sdk.replyStream).toHaveBeenCalledTimes(1);
    const md = mockClient.sdk.replyStream.mock.calls[0][2] as string;

    // AI preview line should appear with 🤖 prefix
    expect(md).toContain('🤖');
    expect(md).toContain('PR 7.5.21');
    // 单 backslash (escaped properly), 不应该是双 backslash
    expect(md).not.toContain('\\\\');
  });

  it('PR 7.5.21: /list shows 🔴 running badge when sessionManager.listSessions has session', async () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const registryManager = {
      sessions: {
        'uuid-running': {
          status: 'active',
          title: 'Running Session',
          message_count: 50,
          last_active: fiveMinAgo,
          project_name: 'test',
          cwd: '/tmp/running',
        },
      },
    };
    (bot as any).registryManager = registryManager;
    // mock sessionManager.listSessions() 返回 active session
    (bot as any).sessionManager = {
      listSessions: () => [
        {
          sessionId: 'uuid-running',
          pid: 123,
          cwd: '/tmp/running',
          createdAt: 0,
          lastOutputAt: 0,
          isNew: false,
        },
      ],
    };

    const handled = await (bot as any).handleCommandSynchronously({
      platform: 'wecom',
      userId: 'wmu_user',
      chatType: 'p2p',
      chatId: 'wmu_user',
      messageId: 'msg-1',
      text: '/list',
      timestamp: Date.now(),
      raw: {},
      inboundFrame: { headers: { req_id: 'r1' }, body: { msgid: 'msg-1' } },
    });

    expect(handled).toBe(true);
    const md = mockClient.sdk.replyStream.mock.calls[0][2] as string;

    expect(md).toContain('🔴 **运行中**');
  });

  it('PR 7.5.21: /list NO running badge when sessionManager.listSessions empty', async () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const registryManager = {
      sessions: {
        'uuid-idle': {
          status: 'active',
          title: 'Idle Session',
          message_count: 50,
          last_active: fiveMinAgo,
          project_name: 'test',
          cwd: '/tmp/idle',
        },
      },
    };
    (bot as any).registryManager = registryManager;
    (bot as any).sessionManager = {
      listSessions: () => [], // empty → no running
    };

    const handled = await (bot as any).handleCommandSynchronously({
      platform: 'wecom',
      userId: 'wmu_user',
      chatType: 'p2p',
      chatId: 'wmu_user',
      messageId: 'msg-1',
      text: '/list',
      timestamp: Date.now(),
      raw: {},
      inboundFrame: { headers: { req_id: 'r1' }, body: { msgid: 'msg-1' } },
    });

    expect(handled).toBe(true);
    const md = mockClient.sdk.replyStream.mock.calls[0][2] as string;
    expect(md).not.toContain('🔴 **运行中**');
  });

  it('PR 7.5.21: AI preview truncated to 60 chars with "..."', () => {
    const longText = 'a'.repeat(100);
    const formatted = (bot as any)._formatAIPreview(longText);
    expect(formatted.length).toBeLessThanOrEqual(60);
    expect(formatted.endsWith('...')).toBe(true);
  });

  it('PR 7.5.21: AI preview escapes markdown special chars', () => {
    const formatted = (bot as any)._formatAIPreview('测试 *bold* 和 _italic_ 还有 `code` 和 [link]');
    expect(formatted).toContain('\\*');
    expect(formatted).toContain('\\_');
    expect(formatted).toContain('\\`');
    expect(formatted).toContain('\\[');
    expect(formatted).toContain('\\]');
  });

  it('PR 7.5.21: AI preview 取第一非空行 (跳过前导空白)', () => {
    const multi = '\n\n   \n第一行内容\n第二行';
    const formatted = (bot as any)._formatAIPreview(multi);
    expect(formatted).toBe('第一行内容');
  });

  it('PR 7.5.21: AI preview 短文本 (< 60 字符) 不截断', () => {
    const short = '简短预览';
    const formatted = (bot as any)._formatAIPreview(short);
    expect(formatted).toBe('简短预览');
    expect(formatted).not.toContain('...');
  });

  it('PR 7.5.21: 无 sessionManager 注入时 /list 不抛错', async () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const registryManager = {
      sessions: {
        'uuid-no-sm': {
          status: 'active',
          title: 'No SM',
          message_count: 10,
          last_active: fiveMinAgo,
          project_name: 'test',
          cwd: '/tmp',
        },
      },
    };
    (bot as any).registryManager = registryManager;
    // 不设 sessionManager

    const handled = await (bot as any).handleCommandSynchronously({
      platform: 'wecom',
      userId: 'wmu_user',
      chatType: 'p2p',
      chatId: 'wmu_user',
      messageId: 'msg-1',
      text: '/list',
      timestamp: Date.now(),
      raw: {},
      inboundFrame: { headers: { req_id: 'r1' }, body: { msgid: 'msg-1' } },
    });

    expect(handled).toBe(true);
    const md = mockClient.sdk.replyStream.mock.calls[0][2] as string;
    expect(md).not.toContain('🔴 **运行中**');
  });
});