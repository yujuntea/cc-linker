// tests/integration/feishu-live-progress.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { readdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestBot, type TestBot } from '../helpers/feishu-bot';
import { isSessionProcessing } from '../../src/feishu/live-progress';

describe('Feishu live progress integration', () => {
  let env: TestBot;
  let tmpDir: string;

  beforeEach(() => {
    env = createTestBot({ tmpDirPrefix: 'live-progress-test-' });
    tmpDir = mkdtempSync(join(tmpdir(), 'live-jsonl-'));
  });

  afterEach(() => {
    env.cleanup();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scenario A: doSwitch to running feishu session starts watcher', async () => {
    env.registry.upsert('running-uuid', {
      origin: 'feishu', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Running', message_count: 1, last_message_preview: 'p',
    });

    // Mock listSessions to return this uuid as running
    const origList = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'running-uuid', pid: 12345, cwd: '/tmp/proj', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      // Mock cardReplyFn to return a fake message id
      (env.bot as any).cardReplyFn = async () => 'fake-card-msg-id';

      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch',
        content: JSON.stringify({ text: '/switch running-uuid' }),
        chat_type: 'p2p', message_type: 'text',
      });

      // Drain queue
      await env.bot.dispatch();

      // 验证：liveWatchers 中有这个 openId 的 watcher
      const watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(true);
    } finally {
      (env.sessionManager as any).listSessions = origList;
    }
  });

  it('scenario B: doSwitch to idle session does NOT start watcher', async () => {
    env.registry.upsert('idle-uuid', {
      origin: 'cli', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Idle', message_count: 1, last_message_preview: 'p',
    });

    // Empty listSessions
    const origList = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [];

    try {
      (env.bot as any).cardReplyFn = async () => 'fake-card-msg-id';

      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch_idle',
        content: JSON.stringify({ text: '/switch idle-uuid' }),
        chat_type: 'p2p', message_type: 'text',
      });

      await env.bot.dispatch();

      const watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(false);
    } finally {
      (env.sessionManager as any).listSessions = origList;
    }
  });

  it('scenario C: user sends new message → watcher stops', async () => {
    // Set up running session
    env.registry.upsert('running-uuid-c', {
      origin: 'feishu', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Running C', message_count: 1, last_message_preview: 'p',
    });
    await env.userManager.compareAndSwap(
      'ou_user1', null,
      { type: 'session', sessionUuid: 'running-uuid-c', cwd: '/tmp/proj' },
    );

    const origList = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'running-uuid-c', pid: 12345, cwd: '/tmp/proj', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      (env.bot as any).cardReplyFn = async () => 'fake-card-msg-id';

      // First: switch
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch_c',
        content: JSON.stringify({ text: '/switch running-uuid-c' }),
        chat_type: 'p2p', message_type: 'text',
      });
      await env.bot.dispatch();

      let watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(true);

      // Then: send a new chat message
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_new_chat_c',
        content: JSON.stringify({ text: '继续分析' }),
        chat_type: 'p2p', message_type: 'text',
      });
      await env.bot.dispatch();

      // 验证：watcher 已 stop
      watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(false);
    } finally {
      (env.sessionManager as any).listSessions = origList;
    }
  });

  it('scenario D: continuous /switch A → /switch B → A watcher stops, B starts', async () => {
    // 两个 session
    env.registry.upsert('uuid-a', {
      origin: 'feishu', cwd: '/tmp/a', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'A', message_count: 1, last_message_preview: 'p',
    });
    env.registry.upsert('uuid-b', {
      origin: 'feishu', cwd: '/tmp/b', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'B', message_count: 1, last_message_preview: 'p',
    });

    // 两者都 running
    const origList = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'uuid-a', pid: 1, cwd: '/tmp/a', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
      { sessionId: 'uuid-b', pid: 2, cwd: '/tmp/b', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      (env.bot as any).cardReplyFn = async () => 'fake-card-msg-id';

      // Switch to A
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch_a',
        content: JSON.stringify({ text: '/switch uuid-a' }),
        chat_type: 'p2p', message_type: 'text',
      });
      await env.bot.dispatch();

      let watchers = (env.bot as any).liveWatchers as Map<string, any>;
      expect(watchers.has('ou_user1')).toBe(true);
      const watcherA = watchers.get('ou_user1');
      expect(watcherA.deps.uuid).toBe('uuid-a');

      // Switch to B
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_switch_b',
        content: JSON.stringify({ text: '/switch uuid-b' }),
        chat_type: 'p2p', message_type: 'text',
      });
      await env.bot.dispatch();

      // 验证：A watcher 已 stop（stopped=true），B watcher 是新的
      expect(watcherA.stopped).toBe(true);
      watchers = (env.bot as any).liveWatchers as Map<string, any>;
      const watcherB = watchers.get('ou_user1');
      expect(watcherB).toBeDefined();
      expect(watcherB.deps.uuid).toBe('uuid-b');
      expect(watcherB).not.toBe(watcherA);
    } finally {
      (env.sessionManager as any).listSessions = origList;
    }
  });

  it('isSessionProcessing: feishu in-memory wins over CLI detection', async () => {
    // 即使 CLI marker 说不活跃，feishu in-memory 命中也算 processing
    const bot = {
      sessionManager: {
        listSessions: () => [{ sessionId: 'mixed-uuid' }],
        activityCache: undefined,
      },
    } as any;
    const result = await isSessionProcessing('mixed-uuid', { cwd: '/tmp' }, bot);
    expect(result).toBe(true);
  });
});
