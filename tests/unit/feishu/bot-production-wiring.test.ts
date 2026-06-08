import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Smoke test for the regression where createBotRuntime forgot to call
 * bot.setAgentView(agentView) and agentView.restoreExpectedReplyStates().
 * This is a CODE-LEVEL assertion: it reads the actual start.ts source and
 * checks that the wiring is present. If a future refactor deletes the call,
 * this test fails loudly.
 *
 * Why not a behavioral test? Constructing the bot's full runtime requires
 * WSClient/Feishu credentials and is too heavy for a unit test. The whole
 * point of this regression test is: "the wiring must exist in start.ts" —
 * which is a property of the source, not a behavior of the runtime.
 */
describe('start.ts — Agent View wiring regression', () => {
  const startPath = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'commands', 'start.ts');
  const src = readFileSync(startPath, 'utf8');

  test('imports AgentViewManager from src/agent-view/manager', () => {
    expect(src).toMatch(/import\s*\{[^}]*AgentViewManager[^}]*\}\s*from\s*['"]\.\.\/\.\.\/agent-view\/manager['"]/);
  });

  test('constructs an AgentViewManager instance', () => {
    expect(src).toMatch(/new\s+AgentViewManager\s*\(/);
  });

  test('calls bot.setAgentView(agentView)', () => {
    expect(src).toMatch(/bot\.setAgentView\s*\(\s*agentView\s*\)/);
  });

  test('calls agentView.restoreExpectedReplyStates()', () => {
    expect(src).toMatch(/agentView\.restoreExpectedReplyStates\s*\(\s*\)/);
  });

  test('declares a patchFn and wires it through createPatchFn (v2.2.20 refactor)', () => {
    // v2.2.20: patchFn 实现搬到 src/feishu/patch.ts 的 createPatchFn。
    // start.ts 不再直接调 client.im.v1.message.patch(在 patch.ts 里)。
    // 验证两点:
    //   1) start.ts 仍然声明 patchFn 变量(后续赋值给 agentView.deps.patchFn)
    //   2) start.ts 引用 createPatchFn 来构造它
    expect(src).toMatch(/let\s+patchFn/);
    expect(src).toMatch(/createPatchFn\s*\(/);
    // start.ts 应该 import 这个 helper
    expect(src).toMatch(/from\s+['"]\.\.\/\.\.\/feishu\/patch['"]/);
  });

  // v2.2.9 regression — start.ts:232 declares replyFn / cardReplyFn / patchFn as
  // `async () => null` stubs, then later (inside the `if (appId && appSecret)`
  // block) reassigns them to real Feishu client wrappers. agentView is
  // constructed BEFORE the reassignment, so it captures the stub by reference
  // — `agentView.deps.replyFn` stays the stub unless we explicitly re-sync.
  //
  // patchFn was already re-synced (`agentView.deps.patchFn = patchFn`),
  // cardReplyFn works via a closure wrapper (agentViewCardReplyFn reads the
  // outer `cardReplyFn` variable by name), but replyFn was missed → all
  // Attach/Stop/Reply text messages silently dropped to /dev/null.
  // This test pins the fix in place.
  test('syncs the real replyFn back to agentView.deps after Feishu client is set up', () => {
    expect(src).toMatch(/agentView\.deps\.replyFn\s*=\s*replyFn/);
  });

  test('syncs the real patchFn back to agentView.deps after Feishu client is set up', () => {
    expect(src).toMatch(/agentView\.deps\.patchFn\s*=\s*patchFn/);
  });

  test('cardReplyFn is wrapped in a closure so reassignment propagates without explicit sync', () => {
    // The closure reads `cardReplyFn` by name → reassignment to local var is observed.
    expect(src).toMatch(/agentViewCardReplyFn[^=]*=\s*async[^{]*\{\s*return\s+cardReplyFn\(/);
  });
});

