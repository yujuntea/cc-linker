import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { startupReconcile } from '../../../src/runtime/reconciler';
import { UserManager, ListSnapshotManager } from '../../../src/feishu';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RUNTIME_SESSION_EVENTS_DIR } from '../../../src/utils/paths';
import { mkdir, rm } from 'fs/promises';

describe('startupReconcile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs reconciliation with empty state', async () => {
    const registry = new RegistryManager(tmpDir);
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    const spoolQueue = new SpoolQueue(tmpDir);
    const eventsDir = join(tmpDir, 'session-events');
    mkdirSync(eventsDir, { recursive: true });

    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
      eventsDir,
    });

    expect(result.recoveredProcessing).toBe(0);
    expect(result.rolledBackClaims).toBe(0);
    expect(result.mergedEvents).toBe(0);
    expect(result.expiredSnapshots).toBe(0);
    expect(result.expiredFiles).toBe(0);
  });

  it('merges session events into registry', async () => {
    const eventsDir = join(tmpDir, 'session-events');
    mkdirSync(eventsDir, { recursive: true });

    // Create a session event
    writeFileSync(join(eventsDir, 'evt-uuid.json'), JSON.stringify({
      sessionId: 'new-session-uuid',
      cwd: '/Users/test/project',
      discoveredAt: '2026-05-10T10:00:00Z',
    }));

    // Patch the events dir for testing
    const originalDir = (await import('../../../src/utils/paths')).RUNTIME_SESSION_EVENTS_DIR;

    // Since RUNTIME_SESSION_EVENTS_DIR is a constant, we test the merge logic directly
    // by creating events in the expected location
    // For this test, we'll just verify the reconciler runs without errors

    const registry = new RegistryManager(tmpDir);
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    const spoolQueue = new SpoolQueue(tmpDir);

    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
      eventsDir,
    });

    expect(result.mergedEvents).toBe(1);
    expect(registry.get('new-session-uuid')?.cwd).toBe('/Users/test/project');
  });

  it('recovers processing messages from spool', async () => {
    const eventsDir = join(tmpDir, 'session-events');
    mkdirSync(eventsDir, { recursive: true });
    const spoolQueue = new SpoolQueue(tmpDir);

    // Simulate a crashed processing message
    const msg = {
      messageId: 'crashed-msg',
      openId: 'ou_user1',
      text: 'hello',
      target: { type: 'session' },
      serialKey: 'uuid-1',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(spoolQueue['processingDir'], 'uuid-1:crashed-msg.json'), JSON.stringify(msg));

    const registry = new RegistryManager(tmpDir);
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));

    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
      eventsDir,
    });

    expect(result.recoveredProcessing).toBe(1);
    expect(spoolQueue.queueSize()).toBe(1); // back to pending
  });

  // PR 7 Task 7.2 (M-4): startupReconcile 加 wecom 平台过滤
  // 历史: startupReconcile 之前总处理所有 processing 消息, 双平台共享 SpoolQueue
  //   时没问题, 但 PR 3 Task 3.4 引入了 platforms 数组 — 每个平台应只 recover 自己的消息。
  // 修法: startupReconcile 接受 platform?: 'feishu' | 'wecom' 参数,
  //   listProcessing/recoverProcessing 内部按 platform 过滤。
  it('M-4: startupReconcile(platform=wecom) 只处理 wecom 平台消息', async () => {
    const eventsDir = join(tmpDir, 'session-events');
    mkdirSync(eventsDir, { recursive: true });
    const spoolQueue = new SpoolQueue(tmpDir);

    // 写 2 条 processing 消息: 1 条 wecom + 1 条 feishu
    const wecomMsg = {
      messageId: 'wecom-msg-1',
      openId: '',
      text: 'wecom hello',
      userId: 'wmu_user1',
      platform: 'wecom',
      target: { type: 'session' },
      serialKey: 'uuid-w-1',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const feishuMsg = {
      messageId: 'feishu-msg-2',
      openId: 'ou_user2',
      text: 'feishu hello',
      userId: 'ou_user2',
      platform: 'feishu',
      target: { type: 'session' },
      serialKey: 'uuid-f-2',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(spoolQueue['processingDir'], 'uuid-w-1:wecom-msg-1.json'), JSON.stringify(wecomMsg));
    writeFileSync(join(spoolQueue['processingDir'], 'uuid-f-2:feishu-msg-2.json'), JSON.stringify(feishuMsg));

    const registry = new RegistryManager(tmpDir);
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));

    // 调 startupReconcile, 传 platform='wecom'
    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
      eventsDir,
      platform: 'wecom',
    });

    // 1. recoverProcessing 只算 wecom 的 (1 条)
    expect(result.recoveredProcessing).toBe(1);

    // 2. queueSize 仍 = 2 (wecom 回到 pending, feishu 留在 processing)
    expect(spoolQueue.queueSize()).toBe(2);

    // 3. pending 里有 wecom 消息
    const pending = spoolQueue.listPending();
    const wecomPending = pending.find(m => m.messageId === 'wecom-msg-1');
    expect(wecomPending).toBeDefined();
    expect(wecomPending?.status).toBe('pending');

    // 4. processing 里仍有 feishu 消息 (没被动)
    const stillProcessing = spoolQueue.listProcessing();
    const feishuStill = stillProcessing.find(m => m.messageId === 'feishu-msg-2');
    expect(feishuStill).toBeDefined();
    expect(feishuStill?.status).toBe('processing');

    // 5. processing 里不应有 wecom 消息
    const wecomStill = stillProcessing.find(m => m.messageId === 'wecom-msg-1');
    expect(wecomStill).toBeUndefined();
  });

  it('M-4: startupReconcile() 默认 (无 platform) 处理 feishu + wecom 全部', async () => {
    const eventsDir = join(tmpDir, 'session-events');
    mkdirSync(eventsDir, { recursive: true });
    const spoolQueue = new SpoolQueue(tmpDir);

    // 同样 2 条 processing 消息
    const wecomMsg = {
      messageId: 'wecom-msg-1',
      openId: '',
      text: 'wecom hello',
      userId: 'wmu_user1',
      platform: 'wecom',
      target: { type: 'session' },
      serialKey: 'uuid-w-1',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const feishuMsg = {
      messageId: 'feishu-msg-2',
      openId: 'ou_user2',
      text: 'feishu hello',
      userId: 'ou_user2',
      platform: 'feishu',
      target: { type: 'session' },
      serialKey: 'uuid-f-2',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(spoolQueue['processingDir'], 'uuid-w-1:wecom-msg-1.json'), JSON.stringify(wecomMsg));
    writeFileSync(join(spoolQueue['processingDir'], 'uuid-f-2:feishu-msg-2.json'), JSON.stringify(feishuMsg));

    const registry = new RegistryManager(tmpDir);
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));

    // 不传 platform → 处理全部
    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
      eventsDir,
    });

    // 1. recoverProcessing = 2 (两条都恢复)
    expect(result.recoveredProcessing).toBe(2);

    // 2. queueSize = 2 (都在 pending)
    expect(spoolQueue.queueSize()).toBe(2);

    // 3. 两条消息都从 processing 移到 pending
    const pending = spoolQueue.listPending();
    expect(pending.find(m => m.messageId === 'wecom-msg-1')).toBeDefined();
    expect(pending.find(m => m.messageId === 'feishu-msg-2')).toBeDefined();

    // 4. processing 目录为空
    expect(spoolQueue.listProcessing()).toHaveLength(0);
  });

  it('M-4: startupReconcile(platform=feishu) 只处理 feishu 平台消息 (对偶测试)', async () => {
    const eventsDir = join(tmpDir, 'session-events');
    mkdirSync(eventsDir, { recursive: true });
    const spoolQueue = new SpoolQueue(tmpDir);

    const wecomMsg = {
      messageId: 'wecom-msg-1',
      openId: '',
      text: 'w',
      userId: 'wmu_user1',
      platform: 'wecom',
      target: { type: 'session' },
      serialKey: 'uuid-w-1',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const feishuMsg = {
      messageId: 'feishu-msg-2',
      openId: 'ou_user2',
      text: 'f',
      userId: 'ou_user2',
      platform: 'feishu',
      target: { type: 'session' },
      serialKey: 'uuid-f-2',
      status: 'processing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(spoolQueue['processingDir'], 'uuid-w-1:wecom-msg-1.json'), JSON.stringify(wecomMsg));
    writeFileSync(join(spoolQueue['processingDir'], 'uuid-f-2:feishu-msg-2.json'), JSON.stringify(feishuMsg));

    const registry = new RegistryManager(tmpDir);
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));

    // 传 platform='feishu'
    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
      eventsDir,
      platform: 'feishu',
    });

    // recoverProcessing 只算 feishu 的
    expect(result.recoveredProcessing).toBe(1);

    // feishu 移到 pending
    expect(spoolQueue.listPending().find(m => m.messageId === 'feishu-msg-2')).toBeDefined();

    // wecom 仍 processing
    expect(spoolQueue.listProcessing().find(m => m.messageId === 'wecom-msg-1')).toBeDefined();
  });

  it('rolls back timed-out claims', async () => {
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const now = new Date();
    const expiredTime = new Date(now.getTime() - 11 * 60 * 1000);

    // Create an expired claim directly in the mapping file
    await userManager.compareAndSwap(
      'ou_user1',
      null,
      {
        type: 'pending_new_session_claimed',
        sessionUuid: 'uuid-1',
        createdAt: expiredTime.toISOString(),
        claimedByMessageId: 'msg-123',
        claimedAt: expiredTime.toISOString(),
      }
    );

    const registry = new RegistryManager(tmpDir);
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    const spoolQueue = new SpoolQueue(tmpDir);
    const eventsDir = join(tmpDir, 'session-events');
    mkdirSync(eventsDir, { recursive: true });

    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
      eventsDir,
    });

    expect(result.rolledBackClaims).toBe(1);
    const entry = userManager.getEntry('ou_user1');
    expect(entry?.type).toBe('pending_new_session');
  });
});
