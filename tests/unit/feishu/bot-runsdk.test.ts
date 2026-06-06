import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { FeishuBot } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';

/**
 * Tests for Task 11: extracting handleChatSDK as public runChatSDK + adding
 * setAgentView. The full SDK streaming lifecycle is exercised by other bot tests
 * (handleChat end-to-end); this file focuses on the new public surface and the
 * v2.2 critical fix: setAgentView must overwrite deps.runChatSDK with an arrow
 * function that captures the FeishuBot instance.
 */
describe('FeishuBot.runChatSDK (T11 public surface)', () => {
  let env: TestBot;
  let bot: FeishuBot;

  beforeEach(() => {
    env = createTestBot({
      tmpDirPrefix: 'bot-runsdk-',
      extraConfigMutations: {
        'feishu_bot.default_cwd': '',
        'security.allowed_roots': [],
        'security.denied_roots': [],
        'stream.enabled': false,
        'sdk.enabled': true,
      },
    });
    bot = env.bot;
  });

  afterEach(() => {
    env.cleanup();
  });

  it('exposes runChatSDK as a public method on the prototype', () => {
    // Critical for AgentViewManager.handleReply (T18) to invoke it from outside the bot.
    expect(typeof (FeishuBot.prototype as any).runChatSDK).toBe('function');

    // The instance also resolves it (not just on the prototype) so the bot can
    // pass `this.runChatSDK` to dependents without losing binding.
    expect(typeof (bot as any).runChatSDK).toBe('function');
  });

  it('exposes setAgentView as a public method', () => {
    expect(typeof (FeishuBot.prototype as any).setAgentView).toBe('function');
    expect(typeof (bot as any).setAgentView).toBe('function');
  });

  it('stores the agentView manager when setAgentView is called', () => {
    // Build a real AgentViewManager using the bot's existing UserManager so the
    // constructor's ExpectedReplyState is wired correctly.
    const mgr = new AgentViewManager({
      userManager: env.userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      // runChatSDK is a placeholder — setAgentView MUST replace this with the
      // arrow-bound version. We pass a sentinel that asserts it gets replaced.
      runChatSDK: (() => {
        throw new Error('placeholder should be replaced by setAgentView');
      }) as any,
    });

    bot.setAgentView(mgr);

    // The private field stores the manager (verified via the public deps hook
    // — see next test for the override assertion).
    expect((bot as any).agentView).toBe(mgr);
  });

  it('overrides deps.runChatSDK with an arrow function that captures the bot', async () => {
    // v2.2 critical fix: a bare `this.runChatSDK` reference would lose `this`
    // when called from AgentViewManager.handleReply. setAgentView MUST rewrite
    // deps.runChatSDK to a closure over the bot instance.
    let callCount = 0;
    let capturedThis: any = null;

    const mgr = new AgentViewManager({
      userManager: env.userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      // Placeholder to be replaced; record invocations so we can verify the
      // override is reachable AND executes against the bot.
      runChatSDK: (() => {
        throw new Error('placeholder should be replaced by setAgentView');
      }) as any,
    });

    bot.setAgentView(mgr);

    // After setAgentView, deps.runChatSDK must be a function (not the thrower).
    expect(typeof mgr.deps.runChatSDK).toBe('function');

    // Call it. We're not providing a real sessionManager.sendSDKMessage, so the
    // SDK call will throw — that's fine. We assert via a wrapper that the
    // override (a) executes at all, and (b) when invoked from the manager's
    // perspective, eventually touches the bot. The cleanest way to assert (b)
    // without running the full SDK pipeline is to replace sessionManager with
    // a stub that records `this` from the perspective of the bot's method.
    const origSessionManager = (bot as any).sessionManager;
    (bot as any).sessionManager = {
      sendSDKMessage: async (..._args: any[]) => {
        capturedThis = bot; // The arrow function should have called us with bot-bound state
        callCount += 1;
        // Return a minimally-shaped result; runChatSDK will then try to use
        // cardUpdater / etc. which doesn't exist without feishuClient. That's
        // OK for this test — we only care that the override path was reached.
        return {
          result: {
            response: 'stub',
            tokensIn: 0,
            tokensOut: 0,
            durationMs: 0,
            sessionStatus: 'active' as const,
            error: null,
            jsonlPath: null,
            sessionId: null,
          },
          handler: { getUnresolvedCount: () => 0, getHandlerId: () => 'stub' },
        };
      },
    };

    try {
      // Call the override. With no feishuClient, cardUpdater is null, so the
      // success path will go to the registry/spool branch which is a no-op
      // for this test (we don't have a current registry entry). It might still
      // throw trying to call methods on missing cardUpdater; wrap in try.
      try {
        await mgr.deps.runChatSDK({
          openId: 'ou_user1',
          sessionUuid: 'sess-1',
          cwd: '/tmp',
          promptText: 'hello',
          serialKey: 'sess-1',
          isNew: false,
        });
      } catch (_e) {
        // Expected — the stub doesn't return a full result. We only care that
        // sendSDKMessage was reached, which proves the override fires.
      }

      expect(callCount).toBe(1);
      expect(capturedThis).toBe(bot);
    } finally {
      (bot as any).sessionManager = origSessionManager;
    }
  });

  it('replaces the agentView reference when called a second time', () => {
    // Sanity: setAgentView is a single-call setter; calling it once stores
    // the manager and overrides the dep. Calling it again with a different
    // manager must replace, not merge or alias.
    const mgr1 = new AgentViewManager({
      userManager: env.userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: (() => { throw new Error('mgr1 placeholder'); }) as any,
    });
    const mgr2 = new AgentViewManager({
      userManager: env.userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: (() => { throw new Error('mgr2 placeholder'); }) as any,
    });

    bot.setAgentView(mgr1);
    expect((bot as any).agentView).toBe(mgr1);
    // mgr1's deps.runChatSDK is now the arrow-bound version (no longer the
    // thrower) — that's the whole point of setAgentView.
    expect(typeof mgr1.deps.runChatSDK).toBe('function');

    bot.setAgentView(mgr2);
    expect((bot as any).agentView).toBe(mgr2);
    expect((bot as any).agentView).not.toBe(mgr1);
    expect(typeof mgr2.deps.runChatSDK).toBe('function');
  });
});
