import { beforeEach, afterEach, describe, expect, test, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry/registry';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';
import type { SpoolMessage } from '../../../src/queue/spool';

let tmpDir: string;
let bot: FeishuBot;
let agentView: AgentViewManager;
let userManager: UserManager;
let attachedWatchers: { has: any; stop: any };

const origFetcherFetch = AgentSnapshotFetcher.fetch;

function makeMsg(over: Partial<SpoolMessage> = {}): SpoolMessage {
  return {
    messageId: 'msg-' + Math.random().toString(36).slice(2),
    openId: 'ou_watch_test',
    text: 'hello',
    target: { type: 'no_target' },
    serialKey: 'sk-1',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bot-watch-stop-'));
  (config as any).data.feishu_bot.owner_open_id = '';
  userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
  const spoolQueue = new SpoolQueue(tmpDir);
  const registry = new RegistryManager(tmpDir);
  const sessionManager = new ClaudeSessionManager();
  agentView = new AgentViewManager({
    userManager,
    replyFn: async () => 'msg',
    cardReplyFn: async () => 'om',
    patchFn: async () => ({}),
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: null }),
  });
  // 注入一个 mock attachedWatchers
  attachedWatchers = {
    has: mock(() => false),
    stop: mock(async () => {}),
  };
  (agentView as any).attachedWatchers = attachedWatchers;
  bot = new FeishuBot({
    userManager, listSnapshotManager, spoolQueue, registry, sessionManager,
    replyFn: async () => 'reply-id',
    cardReplyFn: async () => 'card-id',
    patchFn: async () => ({}),
  });
  bot.setAgentView(agentView);
  (AgentSnapshotFetcher as any).fetch = mock(async () => ({ ok: true, sessions: [] }));
});

afterEach(() => {
  (AgentSnapshotFetcher as any).fetch = origFetcherFetch;
});

describe('FeishuBot.handleChat watch stop hook', () => {
  test('with active watch: stops watch on user text', async () => {
    attachedWatchers.has.mockReturnValue(true);
    await bot.handleChat(makeMsg({ text: 'hello' }));
    // 不 await,但要等 microtask flush
    await new Promise(r => setImmediate(r));
    expect(attachedWatchers.stop).toHaveBeenCalledWith(
      'ou_watch_test', 'user_chat', { patchFinal: true },
    );
  });

  test('with no watch: no stop call', async () => {
    attachedWatchers.has.mockReturnValue(false);
    await bot.handleChat(makeMsg({ text: 'hello' }));
    await new Promise(r => setImmediate(r));
    expect(attachedWatchers.stop).not.toHaveBeenCalled();
  });

  test('with /cancel: also stops watch', async () => {
    attachedWatchers.has.mockReturnValue(true);
    // /cancel 会走 handleCancelReply,但 stop hook 必须在它之前
    await bot.handleChat(makeMsg({ text: '/cancel' }));
    await new Promise(r => setImmediate(r));
    expect(attachedWatchers.stop).toHaveBeenCalledWith(
      'ou_watch_test', 'user_chat', { patchFinal: true },
    );
  });
});
