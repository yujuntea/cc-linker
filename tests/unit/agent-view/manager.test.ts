import { beforeEach, describe, expect, test, mock, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import type { AgentSession } from '../../../src/agent-view/types';

let tmpDir: string;

// Snapshot of the original fetch — restored in afterAll so other test files
// don't see our mocks bleed over (Bun shares the module registry).
const origFetch = AgentSnapshotFetcher.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-view-mgr-'));
  (config as any).data.feishu_bot.owner_open_id = '';
});

afterAll(() => {
  (AgentSnapshotFetcher as any).fetch = origFetch;
});

function makeBusySession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 1234,
    cwd: '/tmp/proj',
    kind: 'background',
    startedAt: Date.now() - 60_000,
    sessionId: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    name: 'busy-task',
    status: 'busy',
    ...over,
  };
}

function makeWaitingSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    pid: 1235,
    cwd: '/tmp/proj',
    kind: 'background',
    startedAt: Date.now() - 30_000,
    sessionId: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb',
    name: 'waiting-task',
    status: 'waiting',
    waitingFor: 'awaiting user reply',
    ...over,
  };
}

function makeMgrWithSpies() {
  const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  const cardReplyFn = mock(async (_card: string, _opts: any) => 'om_list_card_001');
  const patchFn = mock(async (_messageId: string, _card: string) => null);
  const replyFn = mock(async (_text: string, _opts: any) => null);
  const mgr = new AgentViewManager({
    userManager,
    replyFn,
    cardReplyFn,
    patchFn,
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
  });
  return { mgr, userManager, cardReplyFn, patchFn, replyFn };
}

describe('AgentViewManager skeleton', () => {
  test('constructs with defaults', () => {
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });
    expect(mgr.expectedReply).toBeDefined();
    expect(mgr.shouldRefresh()).toBe(true);
  });

  test('shouldRefresh debounces', () => {
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const mgr = new AgentViewManager({
      userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: '' }),
    });
    expect(mgr.shouldRefresh()).toBe(true);
    expect(mgr.shouldRefresh()).toBe(false);
  });
});

describe('handleList', () => {
  test('sends list card on success and saves cardMessageId', async () => {
    const { mgr, userManager, cardReplyFn } = makeMgrWithSpies();
    const busy = makeBusySession();
    const waiting = makeWaitingSession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [busy, waiting],
    }));

    await mgr.handleList('ou_test_1');

    // 列表卡通过 cardReplyFn 发出,包含两个组(busy + waiting)
    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    const groupHeaders = sentCard.elements.filter(
      (e: any) => e.tag === 'markdown' && /（|处理中|等待|空闲/.test(e.content || ''),
    );
    expect(groupHeaders.length).toBeGreaterThanOrEqual(2);

    // cardMessageId 已保存到 user-mapping
    const entry = userManager.getEntry('ou_test_1');
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('last_agent_list_card');
    expect(entry?.cardMessageId).toBe('om_list_card_001');
  });

  test('sends empty card when no background sessions', async () => {
    const { mgr, userManager, cardReplyFn } = makeMgrWithSpies();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [],
    }));

    await mgr.handleList('ou_test_2');

    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    // 空状态卡 header 是 grey 模板
    expect(sentCard.header.template).toBe('grey');
    // 不应写入 last_agent_list_card entry(空卡不需要 refresh 持久化)
    expect(userManager.getEntry('ou_test_2')).toBeUndefined();
  });

  test('sends error card on fetch failure', async () => {
    const { mgr, cardReplyFn } = makeMgrWithSpies();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: false,
      reason: 'Claude daemon not running',
    }));

    await mgr.handleList('ou_test_3');

    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    const sentCard = JSON.parse(cardReplyFn.mock.calls[0][0] as string);
    // 错误卡 template=red
    expect(sentCard.header.template).toBe('red');
    expect(sentCard.elements[0].content).toContain('daemon not running');
  });
});

describe('handleRefreshList', () => {
  test('patches same card with fresh data when messageId matches', async () => {
    const { mgr, userManager, cardReplyFn, patchFn } = makeMgrWithSpies();

    // 1) 先 handleList 建立 last_agent_list_card entry
    const busy = makeBusySession();
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [busy],
    }));
    await mgr.handleList('ou_test_4');
    const entry = userManager.getEntry('ou_test_4');
    expect(entry?.cardMessageId).toBe('om_list_card_001');
    expect(cardReplyFn).toHaveBeenCalledTimes(1);

    // 2) 然后 handleRefreshList 用同样的 messageId
    // 关键:handleList 内部把 mock 调成 busy,refresh 期间不变
    await mgr.handleRefreshList('ou_test_4', 'om_list_card_001');

    // patchFn 收到 1 次调用,messageId 匹配
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(patchFn.mock.calls[0][0]).toBe('om_list_card_001');
    const patched = JSON.parse(patchFn.mock.calls[0][1] as string);
    // 应该有 Refresh 按钮(action with agent_view_refresh_list value)
    const hasRefreshBtn = patched.elements.some(
      (e: any) =>
        e.tag === 'action' &&
        e.actions.some((a: any) => a.value?.tag === 'agent_view_refresh_list'),
    );
    expect(hasRefreshBtn).toBe(true);
  });

  test('falls back to handleList when messageId does not match stored entry', async () => {
    const { mgr, userManager, cardReplyFn, patchFn } = makeMgrWithSpies();

    // 先建立 entry
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [makeBusySession()],
    }));
    await mgr.handleList('ou_test_5');
    expect(userManager.getEntry('ou_test_5')?.cardMessageId).toBe('om_list_card_001');

    // 用过期的 messageId 调用 refresh
    cardReplyFn.mockClear();
    patchFn.mockClear();
    await mgr.handleRefreshList('ou_test_5', 'om_OLD_MESSAGE_ID');

    // 校验失败:应转去 handleList(cardReplyFn 被调),patchFn 不被调
    expect(cardReplyFn).toHaveBeenCalledTimes(1);
    expect(patchFn).not.toHaveBeenCalled();
    // 新卡 messageId 替换了旧 entry
    expect(userManager.getEntry('ou_test_5')?.cardMessageId).toBe('om_list_card_001');
  });

  test('no-op when shouldRefresh returns false (debounce)', async () => {
    const { mgr, cardReplyFn, patchFn } = makeMgrWithSpies();

    // 建立 entry
    (AgentSnapshotFetcher as any).fetch = mock(async () => ({
      ok: true,
      sessions: [makeBusySession()],
    }));
    await mgr.handleList('ou_test_6');
    expect(cardReplyFn).toHaveBeenCalledTimes(1);

    // 第一次 refresh:shouldRefresh=true,会发 patch
    cardReplyFn.mockClear();
    patchFn.mockClear();
    await mgr.handleRefreshList('ou_test_6', 'om_list_card_001');
    expect(patchFn).toHaveBeenCalledTimes(1);

    // 紧接着第二次 refresh:shouldRefresh=false,无操作
    patchFn.mockClear();
    await mgr.handleRefreshList('ou_test_6', 'om_list_card_001');
    expect(patchFn).not.toHaveBeenCalled();
  });
});
