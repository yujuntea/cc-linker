import { describe, test, it, expect, beforeEach, afterEach } from 'bun:test';
import { SpoolQueue } from '../../../src/queue/spool';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SpoolQueue', () => {
  let tmpDir: string;
  let spool: SpoolQueue;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spool-test-'));
    spool = new SpoolQueue(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueues a message', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const, sessionUuid: 'uuid-1' },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(spool.enqueue(msg)).toBe(true);
    expect(spool.queueSize()).toBe(1);
  });

  it('rejects duplicate message (idempotency)', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(spool.enqueue(msg)).toBe(true);
    expect(spool.enqueue(msg)).toBe(false); // duplicate
  });

  it('claims and processes a message', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    spool.enqueue(msg);
    const claimed = spool.claimNext('uuid-1');

    expect(claimed).not.toBeNull();
    expect(claimed?.messageId).toBe('msg-1');
    expect(claimed?.status).toBe('processing');
    expect(spool.queueSize()).toBe(1); // still in processing
  });

  it('does not claim another message with the same serialKey while one is processing', () => {
    const msg1 = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'first',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const msg2 = {
      messageId: 'msg-2',
      openId: 'ou_user1',
      text: 'second',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: '2026-01-01T00:00:01Z',
      updatedAt: '2026-01-01T00:00:01Z',
    };

    spool.enqueue(msg1);
    spool.enqueue(msg2);

    expect(spool.claimNext('uuid-1')?.messageId).toBe('msg-1');
    expect(spool.claimNext('uuid-1')).toBeNull();

    spool.markDone('msg-1', 'uuid-1', 'reply-1');
    expect(spool.claimNext('uuid-1')?.messageId).toBe('msg-2');
  });

  it('marks message as done', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    spool.enqueue(msg);
    spool.claimNext('uuid-1');
    spool.markDone('msg-1', 'uuid-1', 'reply-123');

    expect(spool.queueSize()).toBe(0);
    const done = spool.listPending(); // pending should be empty
    expect(done).toHaveLength(0);
  });

  it('marks message as failed', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    spool.enqueue(msg);
    spool.claimNext('uuid-1');
    spool.markFailed('msg-1', 'uuid-1', 'test error');

    expect(spool.queueSize()).toBe(0);
  });

  it('recovers processing messages on startup', () => {
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-1',
      status: 'processing' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Simulate a crashed processing message
    const path = join(spool['processingDir'], `uuid-1:msg-1.json`);
    writeFileSync(path, JSON.stringify(msg));

    const recovered = spool.recoverProcessing();
    expect(recovered).toBe(1);
    expect(spool.queueSize()).toBe(1); // back to pending
  });

  it('listPending returns sorted messages', () => {
    const msgs = [
      { messageId: 'msg-2', openId: 'ou_user1', text: 'second', target: { type: 'session' as const }, serialKey: 'uuid-1', status: 'pending' as const, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      { messageId: 'msg-1', openId: 'ou_user1', text: 'first', target: { type: 'session' as const }, serialKey: 'uuid-1', status: 'pending' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ];

    spool.enqueue(msgs[0]);
    spool.enqueue(msgs[1]);

    const pending = spool.listPending();
    expect(pending).toHaveLength(2);
    expect(pending[0].messageId).toBe('msg-1');
    expect(pending[1].messageId).toBe('msg-2');
  });

  it('recordDelivery is idempotent (preserves createdAt)', () => {
    spool.recordDelivery('msg-1', 'sending', 'uuid-1');
    const d1 = spool.getDelivery('msg-1');
    expect(d1?.status).toBe('sending');
    expect(d1?.createdAt).toBeDefined();

    const createdBefore = d1!.createdAt;

    // Update to sent
    spool.recordDelivery('msg-1', 'sent', 'uuid-1');
    const d2 = spool.getDelivery('msg-1');
    expect(d2?.status).toBe('sent');
    expect(d2?.createdAt).toBe(createdBefore); // preserved
  });

  it('does not mark multi-chunk delivery as sent until all chunks are sent', () => {
    spool.recordDelivery('msg-2', 'sending', 'uuid-1', 0, undefined, 2);
    spool.recordDelivery('msg-2', 'sent', 'uuid-1', 0, 'reply-1', 2);

    const partial = spool.getDelivery('msg-2');
    expect(partial?.status).toBe('sending');
    expect(partial?.chunkCount).toBe(2);

    spool.recordDelivery('msg-2', 'sent', 'uuid-2', 1, 'reply-2', 2);
    const completed = spool.getDelivery('msg-2');
    expect(completed?.status).toBe('sent');
  });

  it('does not finalize partially-sent multi-chunk messages', () => {
    const msg = {
      messageId: 'msg-3',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' as const },
      serialKey: 'uuid-3',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    spool.enqueue(msg);
    spool.claimNext('uuid-3');
    spool.recordDelivery('msg-3', 'sent', 'uuid-1', 0, 'reply-1', 2);

    expect(spool.finalizeDeliveredMessages()).toBe(0);
    expect(spool.listProcessing()).toHaveLength(1);
  });

  // PR 7 Task 7.3 (M-5): lock cleanup behavior — age decided by mtime, not lex.
  // 构造 2 个 done 文件：lex 排序时 a_old 在前，但 mtime 时 b_new 在前。
  // retention 设 1h，b_new (30min ago) 保留, a_old (2h ago) 删。
  // 即使 lex 排序先看 a_old，mtime 决策决定保留 b_new。
  test('cleanup keeps newer-by-mtime file even if lex would prefer other', () => {
    const doneDir = join(tmpDir, 'done');
    const now = Date.now();
    const { utimesSync } = require('fs');
    // a_old.json: lex 排序在前, mtime 2h 前 (超 1h cutoff → 删)
    writeFileSync(join(doneDir, 'a_old.json'), '{}');
    utimesSync(join(doneDir, 'a_old.json'), (now - 2 * 3600 * 1000) / 1000, (now - 2 * 3600 * 1000) / 1000);
    // b_new.json: lex 排序在后, mtime 30min 前 (在 1h cutoff 内 → 保留)
    writeFileSync(join(doneDir, 'b_new.json'), '{}');
    utimesSync(join(doneDir, 'b_new.json'), (now - 30 * 60 * 1000) / 1000, (now - 30 * 60 * 1000) / 1000);

    // 覆盖 config: done_retention_hours=1 (默认 24 太长, 所有都保留)
    const { config } = require('../../../src/utils/config');
    config.setRuntimeOverride('queue.done_retention_hours', 1);
    config.setRuntimeOverride('queue.done_max_files', 1000);

    const result = spool.cleanup();
    const remaining = readdirSync(doneDir).sort();
    // b_new.json 保留 (mtime 在 cutoff 内); a_old.json 被删 (mtime 超 cutoff)
    expect(remaining).toContain('b_new.json');
    expect(remaining).not.toContain('a_old.json');
    expect(result.cleaned).toBe(1);
  });
});

describe('SpoolQueue.updateMessageFlags', () => {
  let spool: any;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spool-test-'));
    spool = new SpoolQueue(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('持久化 skipActivityCheck', async () => {
    // 1. 手动写入 processing 目录（模拟 worker claim）
    const msg = {
      messageId: 'msg-1',
      openId: 'ou_1',
      text: 'test',
      target: { type: 'session', sessionUuid: 's1' },
      serialKey: 's1',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(join(tmpDir, 'processing'), { recursive: true });
    writeFileSync(join(tmpDir, 'processing', 's1:msg-1.json'), JSON.stringify(msg));

    // 2. 调用 updateMessageFlags
    const ok = await spool.updateMessageFlags('msg-1', 's1', { skipActivityCheck: true });
    expect(ok).toBe(true);

    // 3. 读回验证
    const updated = JSON.parse(readFileSync(join(tmpDir, 'processing', 's1:msg-1.json'), 'utf8'));
    expect(updated.skipActivityCheck).toBe(true);
  });

  test('处理中消息不存在时返回 false', async () => {
    const ok = await spool.updateMessageFlags('nonexistent', 's1', { skipActivityCheck: true });
    expect(ok).toBe(false);
  });
});
