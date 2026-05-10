import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { FeishuBot } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('FeishuBot', () => {
  let tmpDir: string;
  let bot: FeishuBot;
  let replies: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-test-'));

    replies = [];
    const replyFn = async (text: string): Promise<string | null> => {
      replies.push(text);
      return `reply-${replies.length}`;
    };

    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    const spoolQueue = new SpoolQueue(tmpDir);
    const sessionManager = new ClaudeSessionManager();

    bot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      sessionManager,
      replyFn,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores group messages', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: 'hello' }),
      chat_type: 'group',
      message_type: 'text',
    });

    expect(replies).toHaveLength(0);
  });

  it('processes /bridge help command', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/bridge help' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    // Dispatch to process
    await bot.dispatch();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.some(r => r.includes('help'))).toBe(true);
  });

  it('processes /bridge status command', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/bridge status' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.some(r => r.includes('状态'))).toBe(true);
  });

  it('processes /bridge list command', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/bridge list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.some(r => r.includes('会话'))).toBe(true);
  });

  it('rejects unknown commands', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/bridge unknown' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    expect(replies.some(r => r.includes('未知命令'))).toBe(true);
  });

  it('deduplicates messages by messageId', async () => {
    const event = {
      open_id: 'ou_user1',
      message_id: 'msg-dup',
      content: JSON.stringify({ text: '/bridge status' }),
      chat_type: 'p2p',
      message_type: 'text',
    };

    await bot.onMessage(event);
    await bot.onMessage(event); // duplicate

    await bot.dispatch();

    // Should only process once
    expect(replies.length).toBe(1);
  });
});
