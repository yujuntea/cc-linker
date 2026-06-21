/**
 * PR 7.5.20: /list 对齐飞书 buildListCard 信息密度 + 单一命令 code block
 *
 * 用户反馈 vs 飞书:
 *   WeCom (PR 7.5.19): 1) 缺 last_assistant_preview 2) 缺 status badge (🔴)
 *                      3) 缺 origin / project_name 4) ISO timestamp
 *                      5) msgs 而非 条 6) code block 含 /resume, 难单独 copy
 *   Feishu (bot.ts:1880+): 含 status badge / origin / project / 相对时间 / 条
 *
 * 修法:
 *   - 加 status badge + origin + project_name 信息行
 *   - 相对时间 formatTimeAgo (1分钟前, 17小时前)
 *   - msgs → 条
 *   - 单一命令 code block (用户只要 /switch, 不要 /resume)
 *
 * 测试覆盖:
 * - /list markdown 含飞书风格信息密度 (header + status 行 + cwd + 单 command block)
 * - /resume 不再出现在 /list 输出
 * - _formatTimeAgo 单元测试 (秒/分钟/小时)
 * - _formatOrigin 单元测试 (active→终端, undefined→未知)
 * - 空 session 走 replyStream 推空消息
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

describe('PR 7.5.20: /list 对齐飞书信息密度', () => {
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
      userMappingPath: '/tmp/test-pr7520.json',
      client: mockClient,
      spoolQueue: mockSpoolQueue,
      userManager: mockUserManager as any,
      completeCardSender: mockCardSender,
    });
  });

  it('PR 7.5.20: /list matches Feishu info density + one command per block', async () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const registryManager = {
      sessions: {
        'uuid-cur': { status: 'active', title: 'Research WeChat integration options', message_count: 254, last_active: fiveMinAgo, project_name: 'cc-linker' },
        'uuid-other': { status: 'active', title: 'Review AI attribution fix plan', message_count: 566, last_active: new Date(now.getTime() - 17 * 3600 * 1000).toISOString(), project_name: 'wt-pr1-platform' },
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
    const sentMarkdown = mockClient.sdk.replyStream.mock.calls[0][2] as string;

    // 1. Header with count + total (对齐飞书 "我的会话 (N/M)")
    expect(sentMarkdown).toContain('📋 我的会话（最近');
    expect(sentMarkdown).toContain('个，共');

    // 2. Numbered sessions
    expect(sentMarkdown).toContain('**1.');
    expect(sentMarkdown).toContain('**2.');

    // 3. Status info line: ID | msgs条 | time | origin | project
    expect(sentMarkdown).toMatch(/ID: `.{8}` \| \d+条 \|/);

    // 4. Current session badge (对齐飞书 ⭐ 当前)
    expect(sentMarkdown).toContain('⭐ **当前**');

    // 5. 📁 cwd path
    expect(sentMarkdown).toContain('📁 `');

    // 6. ONE command per code block, only /switch
    expect(sentMarkdown).toContain('切换:');
    expect(sentMarkdown).toMatch(/```\n\/switch uuid-cur\n```/);
    // /resume should NOT be in the output (PR 7.5.20 用户反馈删除)
    expect(sentMarkdown).not.toContain('/resume');
  });

  it('PR 7.5.20: /list 空 sessions 走 replyStream 推空消息', async () => {
    const registryManager = { sessions: {} };
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
      inboundFrame: { headers: { req_id: 'r1' } },
    });

    expect(handled).toBe(true);
    expect(mockClient.sdk.replyStream).toHaveBeenCalledTimes(1);
    const md = mockClient.sdk.replyStream.mock.calls[0][2] as string;
    expect(md).toContain('我的会话（最近 0 个）');
    expect(md).toContain('/new');
  });

  it('PR 7.5.20: _formatTimeAgo returns relative time', () => {
    const now = Date.now();
    expect((bot as any)._formatTimeAgo(new Date(now - 5000).toISOString())).toContain('秒前');
    expect((bot as any)._formatTimeAgo(new Date(now - 60000).toISOString())).toContain('分钟前');
    expect((bot as any)._formatTimeAgo(new Date(now - 3600000).toISOString())).toContain('小时前');
    expect((bot as any)._formatTimeAgo(new Date(now - 86400000).toISOString())).toContain('天前');
    expect((bot as any)._formatTimeAgo(new Date(now - 40 * 86400000).toISOString())).toContain('个月前');
  });

  it('PR 7.5.20: _formatTimeAgo 边界值: undefined / 无效字符串 → "?"', () => {
    expect((bot as any)._formatTimeAgo(undefined)).toBe('?');
    expect((bot as any)._formatTimeAgo('not-a-date')).toBe('?');
    expect((bot as any)._formatTimeAgo('')).toBe('?');
  });

  it('PR 7.5.20: _formatOrigin returns human-readable status', () => {
    expect((bot as any)._formatOrigin('active')).toBe('终端');
    expect((bot as any)._formatOrigin(undefined)).toBe('未知');
    expect((bot as any)._formatOrigin('corrupted')).toBe('corrupted');
    expect((bot as any)._formatOrigin('archived')).toBe('archived');
  });
});