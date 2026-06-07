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

  test('declares a patchFn (Feishu message.update wiring)', () => {
    // patchFn is the function that calls client.im.v1.message.patch
    expect(src).toMatch(/let\s+patchFn/);
    // Real implementation should call message.patch with message_id + content
    expect(src).toMatch(/client\.im\.v1\.message\.patch\s*\(/);
    expect(src).toMatch(/message_id/);
  });
});
