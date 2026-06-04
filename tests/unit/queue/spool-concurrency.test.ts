import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SpoolQueue, SpoolMessage } from '../../../src/queue/spool';
import { config } from '../../../src/utils/config';

describe('SpoolQueue concurrency with cmd: serialKey (PR 2 pain point A core guarantee)', () => {
  let tmpDir: string;
  let spoolQueue: SpoolQueue;
  let originalMaxPending: number;

  function makeMsg(messageId: string, serialKey: string, text: string): SpoolMessage {
    return {
      messageId,
      openId: 'ou_user1',
      text,
      target: { type: 'no_target' as const, openId: 'ou_user1' },
      serialKey,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spool-concurrency-test-'));
    originalMaxPending = (config as any).data.queue.max_pending;
    (config as any).data.queue.max_pending = 100;
    spoolQueue = new SpoolQueue(tmpDir);
  });

  afterEach(() => {
    (config as any).data.queue.max_pending = originalMaxPending;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // 场景 A：两个不同 messageId 的 command 都能 claim（核心保证）
  it('two cmd: messages with different messageIds can be claimed concurrently', async () => {
    spoolQueue.enqueue(makeMsg('om_msg_001', 'cmd:ou_user1:om_msg_001', '/list'));
    spoolQueue.enqueue(makeMsg('om_msg_002', 'cmd:ou_user1:om_msg_002', '/status'));

    // claim 第一条 → 成功
    const claimed1 = await spoolQueue.claimNext('cmd:ou_user1:om_msg_001');
    expect(claimed1).not.toBeNull();
    expect(claimed1?.messageId).toBe('om_msg_001');

    // claim 第二条 → 也成功（不同 serialKey 不被 processing 中的第一条阻塞）
    const claimed2 = await spoolQueue.claimNext('cmd:ou_user1:om_msg_002');
    expect(claimed2).not.toBeNull();
    expect(claimed2?.messageId).toBe('om_msg_002');
  });

  // 场景 A 变体：session streaming + /list 并行（痛点 A 的真实场景）
  it('session streaming (sessionUuid serialKey) + cmd: /list can be claimed concurrently', async () => {
    spoolQueue.enqueue(makeMsg('om_session_msg', 'sess-abc-123', '继续工作'));
    spoolQueue.enqueue(makeMsg('om_list_msg', 'cmd:ou_user1:om_list_msg', '/list'));

    // session 消息被 claim，模拟正在 streaming
    const sessionClaimed = await spoolQueue.claimNext('sess-abc-123');
    expect(sessionClaimed).not.toBeNull();

    // /list 立即 claim 成功（不被 session processing 阻塞）
    const listClaimed = await spoolQueue.claimNext('cmd:ou_user1:om_list_msg');
    expect(listClaimed).not.toBeNull();
    expect(listClaimed?.text).toBe('/list');
  });

  // 场景 E：连续三条 /list 都快速返回
  it('three /list commands with different messageIds all claim successfully', async () => {
    spoolQueue.enqueue(makeMsg('om_list_1', 'cmd:ou_user1:om_list_1', '/list'));
    spoolQueue.enqueue(makeMsg('om_list_2', 'cmd:ou_user1:om_list_2', '/list'));
    spoolQueue.enqueue(makeMsg('om_list_3', 'cmd:ou_user1:om_list_3', '/list'));

    const c1 = await spoolQueue.claimNext('cmd:ou_user1:om_list_1');
    const c2 = await spoolQueue.claimNext('cmd:ou_user1:om_list_2');
    const c3 = await spoolQueue.claimNext('cmd:ou_user1:om_list_3');

    expect(c1?.messageId).toBe('om_list_1');
    expect(c2?.messageId).toBe('om_list_2');
    expect(c3?.messageId).toBe('om_list_3');
  });

  // 反向：相同 serialKey（同 messageId）第二条被阻塞
  it('same serialKey (same messageId) blocks second claim correctly', async () => {
    spoolQueue.enqueue(makeMsg('om_dup', 'cmd:ou_user1:om_dup', '/list'));

    const first = await spoolQueue.claimNext('cmd:ou_user1:om_dup');
    expect(first).not.toBeNull();

    // 没有第二条同 serialKey 的消息 → claimNext 返回 null
    const second = await spoolQueue.claimNext('cmd:ou_user1:om_dup');
    expect(second).toBeNull();
  });

  // 边界：old `new:openId` serialKey 仍正常工作（向后兼容非 command 路径）
  it('new:openId serialKey (non-command path) still works as before', async () => {
    spoolQueue.enqueue(makeMsg('om_chat_1', 'new:ou_user1', 'hello'));

    const claimed = await spoolQueue.claimNext('new:ou_user1');
    expect(claimed).not.toBeNull();
    expect(claimed?.text).toBe('hello');
  });
});
