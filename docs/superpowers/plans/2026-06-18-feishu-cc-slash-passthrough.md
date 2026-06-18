# Feishu Claude Code Slash Command Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Claude Code built-in slash commands (`/init /review /cost /doctor` etc.) on Feishu mobile by transparently forwarding unrecognized `/xxx` messages as prompt text to the active Claude session.

**Architecture:** Modify `handleCommand`'s default branch to fall through to `handleChat` instead of erroring with "未知命令". Always resolve `target` in `onMessage` (currently only resolved for non-commands). Remove the dead `if (msg.text.startsWith('/'))` branch in `handleChat` that would otherwise infinitely recurse. cc-linker built-in commands keep priority; everything else is passthrough text.

**Tech Stack:** Bun + TypeScript, `bun:test`, `cc-linker` Feishu bot pipeline (`SpoolQueue` → `dispatch` → `handleClaimed` → `handleCommand`/`handleChat`).

**Reference spec:** `docs/superpowers/specs/2026-06-18-feishu-cc-slash-passthrough-design.md` (v1.2)

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `src/feishu/bot.ts` | Modify | onMessage target resolve, handleCommand default fallthrough, handleChat dead-code removal, helpText new line |
| `tests/helpers/feishu-bot.ts` | Modify | Accept optional `sessionManager` override for mocking |
| `tests/unit/feishu/bot-slash-passthrough.test.ts` | Create | 12 TDD test cases covering §6.1 spec matrix |
| `tests/unit/feishu/bot.test.ts` | Modify | Update "rejects unknown commands" test at L242-254 (currently asserts 未知命令, will fail post-change) |
| `CLAUDE.md` | Modify | Add "Slash Command Passthrough (v2.5)" subsection |

**Decomposition rationale:** All changes in `bot.ts` are colocated in the same file because they belong to the same logical feature (passthrough). Test helper is shared, so the sessionManager mock support lives there. New test file follows existing `bot-<feature>.test.ts` naming.

---

## Task 1: Extend test helper to support sessionManager mock

**Files:**
- Modify: `tests/helpers/feishu-bot.ts:24-41,76-150`
- Test: existing tests should still pass (no behavior change for them)

The new tests need to mock `sessionManager.sendMessage` / `sendSDKMessage` to avoid running real Claude CLI. Currently `createTestBot` hardcodes `const sessionManager = new ClaudeSessionManager()` (line 112). Add an opt-in override path.

- [ ] **Step 1: Modify `createTestBot` to accept `opts.sessionManager`**

In `tests/helpers/feishu-bot.ts`, update `TestBotOptions` interface (around line 24-41) and `createTestBot` function (around line 76-150):

```typescript
export interface TestBotOptions {
  tmpDirPrefix?: string;
  replyIdSuffix?: string;
  noConfigMutation?: boolean;
  extraConfigMutations?: Record<string, unknown>;
  /** Optional override for the ClaudeSessionManager instance. When provided,
   *  tests can stub sendMessage/sendSDKMessage to assert passthrough behavior
   *  without spawning real `claude -p` subprocesses. */
  sessionManager?: ClaudeSessionManager;
}

// In createTestBot, replace the hardcoded line:
  const sessionManager = opts.sessionManager ?? new ClaudeSessionManager();
```

Also update the return value (line 149) — already returns `sessionManager`, so no change needed there. The constructor of `FeishuBot` (around line 117-131) already accepts `opts.sessionManager`, so wiring is direct.

- [ ] **Step 2: Run existing tests to verify no regression**

```bash
bun test tests/unit/feishu/
```

Expected: all existing tests pass. If any fail, the helper signature change broke something — re-check `opts.sessionManager` is optional and defaults to `new ClaudeSessionManager()`.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/feishu-bot.ts
git commit -m "test(helper): support optional sessionManager override in createTestBot

Allows slash-passthrough tests (and future Claude-call tests) to stub
sendMessage / sendSDKMessage without spawning real claude -p.
No behavior change for existing tests."
```

---

## Task 2: Write failing tests for passthrough behavior (TDD red phase)

**Files:**
- Create: `tests/unit/feishu/bot-slash-passthrough.test.ts`

12 test cases covering spec §6.1. Run after creation — ALL should FAIL (current default branch returns "未知命令"; current onMessage skips target resolve for commands).

- [ ] **Step 1: Create the test file with all 12 cases**

```typescript
import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import type { SpoolMessage } from '../../../src/queue/spool';
import type { TargetSnapshot } from '../../../src/queue/spool';
import type { SessionEntry } from '../../../src/registry/types';

/**
 * Build a minimal SpoolMessage that the dispatch pipeline can process.
 * Pass an explicit target so we exercise the session-case path when needed.
 */
function buildMsg(
  text: string,
  openId: string,
  messageId: string,
  target: TargetSnapshot,
): SpoolMessage {
  return {
    messageId,
    openId,
    text,
    serialKey: `cmd:${openId}:${messageId}`,
    target,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function noTarget(openId: string): TargetSnapshot {
  return { type: 'no_target', openId, mappingVersion: 0 };
}

function sessionTarget(openId: string, uuid: string, cwd: string): TargetSnapshot {
  return {
    type: 'session',
    sessionUuid: uuid,
    cwd,
    openId,
    mappingVersion: 0,
  };
}

describe('FeishuBot slash command passthrough (v2.5)', () => {
  let env: TestBot;

  beforeEach(() => {
    env = createTestBot({ tmpDirPrefix: 'bot-slash-passthrough-' });
  });

  afterEach(() => {
    env.cleanup();
  });

  // ─── Test 1: /init not in cc-linker command list → fallthrough ───
  test('T1: /init falls through to handleChat (no 未知命令 reply)', async () => {
    // No user-mapping entry → target is no_target → handleChat case 'no_target'
    await env.bot.handleCommand(buildMsg('/init', 'ou_t1', 'msg_t1', noTarget('ou_t1')));

    // Spec §6.1 #1: default 分支不返回 "未知命令"; handleChat no_target 提示
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
    // And the no_target prompt mentions /new
    const hasNewPrompt = env.textReplies.some(r => r.includes('/new'));
    expect(hasNewPrompt).toBe(true);
  });

  // ─── Test 2: /review pr diff reaches handleChat with full text ───
  test('T2: /review pr diff reaches handleChat session case; full text preserved', async () => {
    // Mock sendSDKMessage to capture the prompt text without spawning real claude
    const captured: { text?: string; sessionId?: string | null } = {};
    const sm = new ClaudeSessionManager();
    sm.sendSDKMessage = (async (sessionId: string | null, text: string, ..._rest: any[]) => {
      captured.sessionId = sessionId;
      captured.text = text;
      return {
        result: { response: 'mocked', costUsd: 0, durationMs: 0, sessionId: sessionId ?? '', jsonlPath: null, sessionStatus: 'active' as const },
        handler: {} as any,
      };
    }) as any;

    env.cleanup();
    env = createTestBot({ tmpDirPrefix: 'bot-slash-passthrough-t2-', sessionManager: sm });

    // Set up session in registry + user-mapping so handleChat enters session case
    const sessionUuid = '11111111-1111-1111-1111-111111111111';
    env.registry.upsert(sessionUuid, {
      cwd: '/tmp', project_name: 'test', title: 't2',
      message_count: 0, created_at: new Date().toISOString(),
      last_active: new Date().toISOString(), status: 'active',
      jsonl_path: null,
    } as Partial<SessionEntry> as any);
    await env.userManager.compareAndSwap('ou_t2', null, {
      type: 'session', sessionUuid, cwd: '/tmp',
    });

    await env.bot.handleCommand(
      buildMsg('/review pr diff', 'ou_t2', 'msg_t2', sessionTarget('ou_t2', sessionUuid, '/tmp')),
    );

    // Spec §6.1 #2: handleChat 收到完整文本 `/review pr diff`（含前导斜杠）
    expect(captured.text).toBe('/review pr diff');
    expect(captured.sessionId).toBe(sessionUuid);
  });

  // ─── Test 3: /clear falls through ───
  test('T3: /clear falls through to handleChat (no 未知命令 reply)', async () => {
    await env.bot.handleCommand(buildMsg('/clear', 'ou_t3', 'msg_t3', noTarget('ou_t3')));
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 4: //help double-slash → cmd='help' → cc-linker matches ───
  test('T4: //help is matched by cc-linker (cmd=help after slash strip)', async () => {
    await env.bot.handleCommand(buildMsg('//help', 'ou_t4', 'msg_t4', noTarget('ou_t4')));
    // Should match case 'help' → helpText
    const hasHelpText = env.textReplies.some(r => r.text.includes('可用命令'));
    expect(hasHelpText).toBe(true);
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 5: /HELP uppercase → lowercased → cc-linker matches ───
  test('T5: /HELP is lowercased and matched by cc-linker', async () => {
    await env.bot.handleCommand(buildMsg('/HELP', 'ou_t5', 'msg_t5', noTarget('ou_t5')));
    const hasHelpText = env.textReplies.some(r => r.text.includes('可用命令'));
    expect(hasHelpText).toBe(true);
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 6: no session + /init → no_target prompt ───
  test('T6: no session + /init triggers no_target prompt mentioning /new', async () => {
    await env.bot.handleCommand(buildMsg('/init', 'ou_t6', 'msg_t6', noTarget('ou_t6')));
    const reply = env.textReplies.find(r => r.text.includes('/new'));
    expect(reply).toBeDefined();
    // Same prompt as chat text would produce
    expect(reply!.text).toContain('/list');
    expect(reply!.text).toContain('/switch');
  });

  // ─── Test 7: with session + /init → enters session case ───
  test('T7: with session + /init enters handleChat session case', async () => {
    // Mock sendSDKMessage to avoid real claude spawn (test env may lack binary)
    const sm = new ClaudeSessionManager();
    sm.sendSDKMessage = (async (sessionId: string | null, text: string, ..._rest: any[]) => ({
      result: { response: 'mocked', costUsd: 0, durationMs: 0, sessionId: sessionId ?? '', jsonlPath: null, sessionStatus: 'active' as const },
      handler: {} as any,
    })) as any;

    env.cleanup();
    env = createTestBot({ tmpDirPrefix: 'bot-slash-passthrough-t7-', sessionManager: sm });

    const sessionUuid = '22222222-2222-2222-2222-222222222222';
    env.registry.upsert(sessionUuid, {
      cwd: '/tmp', project_name: 'test', title: 't7',
      message_count: 0, created_at: new Date().toISOString(),
      last_active: new Date().toISOString(), status: 'active',
      jsonl_path: null,
    } as Partial<SessionEntry> as any);

    await env.userManager.compareAndSwap('ou_t7', null, {
      type: 'session', sessionUuid, cwd: '/tmp',
    });

    await env.bot.handleCommand(
      buildMsg('/init', 'ou_t7', 'msg_t7', sessionTarget('ou_t7', sessionUuid, '/tmp')),
    );

    // Spec §6.1 #7: case 'session' 路径, busy check / rendezvous probe 启动
    // 断言: handleChat session case 进入 (非 default), 不返回 未知命令
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 8: //foo → cmd='foo' → fallthrough, text is //foo ───
  test('T8: //foo → cmd=foo → fallthrough; no_target path', async () => {
    await env.bot.handleCommand(buildMsg('//foo', 'ou_t8', 'msg_t8', noTarget('ou_t8')));
    // No session → no_target prompt
    const hasNewPrompt = env.textReplies.some(r => r.text.includes('/new'));
    expect(hasNewPrompt).toBe(true);
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 9: /cancel in Agent View expectedReply state ───
  test('T9: /cancel clears expectedReply at entry AND triggers handleChat /cancel branch', async () => {
    const clearCalls: { openId: string; reason: string }[] = [];
    const cancelCalls: string[] = [];
    const mockAgentView = {
      deps: {} as any,
      handleCancelReply: async (openId: string) => { cancelCalls.push(openId); },
      expectedReply: {
        get: () => ({ sessionUuid: 'x', cwd: '/tmp', prompt: 'test' }),
        clear: async (openId: string, reason: string) => {
          clearCalls.push({ openId, reason });
          return true;
        },
      },
    };
    env.bot.setAgentView(mockAgentView as any);

    await env.bot.handleCommand(buildMsg('/cancel', 'ou_t9', 'msg_t9', noTarget('ou_t9')));

    // Spec §6.1 #9 + §6.2 /cancel 等待中 行:
    // 1. 入口 expectedReply.clear called with reason='overwrite'
    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0].reason).toBe('overwrite');
    // 2. handleChat /cancel branch → handleCancelReply called
    expect(cancelCalls).toEqual(['ou_t9']);
    // 3. No 未知命令 reply (was the old broken behavior)
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 10: recursion guard (handleCommand called once, not twice) ───
  test('T10: no infinite recursion — handleCommand called exactly once per /xxx', async () => {
    // Spy by replacing handleCommand with a wrapper that counts calls
    const origHandleCommand = env.bot.handleCommand.bind(env.bot);
    let callCount = 0;
    (env.bot as any).handleCommand = async (msg: SpoolMessage) => {
      callCount++;
      return origHandleCommand(msg);
    };

    await env.bot.handleCommand(buildMsg('/init', 'ou_t10', 'msg_t10', noTarget('ou_t10')));

    expect(callCount).toBe(1);
  });

  // ─── Test 11: expectedReply cleared on /xxx (write command) ───
  test('T11: /xxx in expectedReply state triggers entry clear + 等待输入已自动取消 reply', async () => {
    const clearCalls: { openId: string; reason: string }[] = [];
    const mockAgentView = {
      deps: {} as any,
      handleCancelReply: async () => {},
      expectedReply: {
        get: (openId: string) => ({ sessionUuid: 's', cwd: '/tmp', prompt: 'p' }),
        clear: async (openId: string, reason: string) => {
          clearCalls.push({ openId, reason });
          return true;
        },
      },
    };
    env.bot.setAgentView(mockAgentView as any);

    await env.bot.handleCommand(buildMsg('/init', 'ou_t11', 'msg_t11', noTarget('ou_t11')));

    // /init is not in [help, status, whoami], so entry should attempt clear
    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0].reason).toBe('overwrite');
    // And the entry reply mentions "已自动取消"
    const hasCancelReply = env.textReplies.some(r => r.text.includes('等待输入已自动取消'));
    expect(hasCancelReply).toBe(true);
  });

  // ─── Test 12: serialKey preserved as cmd:openId:messageId ───
  test('T12: /xxx uses serialKey=cmd:openId:messageId (independent lock)', async () => {
    const msg = buildMsg('/init', 'ou_t12', 'msg_t12', noTarget('ou_t12'));
    expect(msg.serialKey).toBe('cmd:ou_t12:msg_t12');

    await env.bot.handleCommand(msg);
    // No assertion on internal lock — just that the message is processed without error
    // and the serialKey was preserved through fallthrough (no mutation)
    expect(msg.serialKey).toBe('cmd:ou_t12:msg_t12');
  });
});
```

- [ ] **Step 2: Run tests to verify they all fail (TDD red)**

```bash
bun test tests/unit/feishu/bot-slash-passthrough.test.ts 2>&1 | tail -40
```

Expected outcome (which tests fail BEFORE Task 3 implementation):

| Test | Before fix | Reason |
|---|---|---|
| T1 (`/init` → handleChat) | **FAIL** | default branch returns "未知命令"; no /new prompt |
| T2 (`/review pr diff`) | **FAIL** | default returns "未知命令"; sendSDKMessage mock not invoked → `captured.text` undefined |
| T3 (`/clear`) | **FAIL** | default returns "未知命令" |
| T4 (`//help`) | PASS | Already matches case 'help' (no fix needed) |
| T5 (`/HELP`) | PASS | Already lowercased to 'help' |
| T6 (no session + `/init`) | **FAIL** | default returns "未知命令"; no /new reply |
| T7 (with session + `/init`) | **FAIL** | default returns "未知命令"; mock not invoked |
| T8 (`//foo`) | **FAIL** | default returns "未知命令" |
| T9 (`/cancel` flow) | **FAIL** | handleCancelReply not called (cancelCalls empty) |
| T10 (recursion guard) | PASS | Already no recursion before fix (regression guard only) |
| T11 (expectedReply clear) | PASS | Entry-level clear happens regardless of switch outcome |
| T12 (serialKey invariant) | PASS | Pure invariant check |

**Goal**: at minimum T1, T2, T3, T6, T7, T8, T9 must FAIL with current code. T4, T5, T10, T11, T12 are regression guards that pass before AND after fix.

- [ ] **Step 3: Commit (red phase)**

```bash
git add tests/unit/feishu/bot-slash-passthrough.test.ts
git commit -m "test(feishu): add slash-passthrough test cases (TDD red)

12 cases per spec §6.1. Currently fail because:
- handleCommand default returns 未知命令 (T1, T3, T6, T8)
- handleChat dead code recursion not guarded (T10)
- expectedReply clear not triggered for /xxx (T11)
Will turn green after Task 3 implementation."
```

---

## Task 3: Implement core passthrough (3 changes in `bot.ts`)

**Files:**
- Modify: `src/feishu/bot.ts:321-324` (onMessage target resolve)
- Modify: `src/feishu/bot.ts:1012-1014` (handleCommand default branch)
- Modify: `src/feishu/bot.ts:1031-1051` (handleChat dead code removal + comment update)

ALL THREE changes are required together. If dead code (1031-1051) is left in place while default (1012-1014) calls handleChat, infinite recursion occurs.

- [ ] **Step 1: Modify `onMessage` target resolution (lines 321-324)**

In `src/feishu/bot.ts`, replace:

```typescript
    const isCommand = isCommandMessage(text);
    const target = isCommand
      ? { type: 'no_target' as const, openId: event.open_id, mappingVersion: this.userManager.getVersion() }
      : await this.resolveChatTarget(event.open_id, event.message_id);
```

with:

```typescript
    const isCommand = isCommandMessage(text);
    // v2.5: 总是解析 target — cc-linker 命令忽略 target, 但 /xxx 透传路径走 handleChat 需要真 target
    const target = await this.resolveChatTarget(event.open_id, event.message_id);
```

- [ ] **Step 2: Modify `handleCommand` default branch (lines 1012-1014)**

In `src/feishu/bot.ts`, replace:

```typescript
      default:
        await this.replyAndFinalize(msg, `未知命令: /${cmd}\n\n${this.helpText()}`);
        return;
```

with:

```typescript
      default: {
        // v2.5: cc-linker 未识别的 /xxx → 作为 prompt 文本透传给当前会话的 Claude。
        // - 模型已训练识别 /init /review /cost 等内置 slash 命令
        // - 自定义命令 ~/.claude/commands/*.md 不展开 (跟 claude -p 模式对齐)
        // - busy check / rendezvous / 流式 / 错误处理全部复用 handleChat 既有路径
        // - serialKey 仍是 cmd:openId:messageId (独立锁), 不影响 chat 的 sessionUuid 锁
        await this.handleChat(msg);
        return;
      }
```

- [ ] **Step 3: Remove dead code in `handleChat` (lines 1031-1051)**

In `src/feishu/bot.ts`, delete the contiguous block of lines 1031-1051:
- L1031-1033: 3-line comment introducing the dead block (`// 注意: 这里的 if (msg.text.startsWith('/')) ...`)
- L1034: `if (msg.text.startsWith('/')) {`
- L1035-1050: block body (16 lines)
- L1051: closing `}`

Leave line 1052+ (`// 非 / 开头普通消息:检查 expectedReply`) and below untouched. Replace the deleted 21 lines with:

```typescript
      // v2.5: 移除 v2.4.x 的 /startsWith('/') dead code — 原意图是 safety net,
      // 现在 fallthrough 路径是 default→handleChat, 这里再分发会无限递归。
      // 命令消息一律在 dispatcher (line ~848) 通过 isCommandMessage 路由到 handleCommand,
      // 此处只处理 /cancel (Agent View 专用) 和普通文本。
```

Verify by visual inspection that the comment-and-code block you delete is contiguous and contains the dead `if (msg.text.startsWith('/'))` branch.

- [ ] **Step 4: Run new tests to verify they pass (TDD green)**

```bash
bun test tests/unit/feishu/bot-slash-passthrough.test.ts 2>&1 | tail -40
```

Expected: all 12 tests pass. If any fail:
- If T1/T3/T6/T8 fail with "未知命令" assertion → step 2 not applied correctly
- If T10 fails (callCount=2) → step 3 not applied (dead code still recursing)
- If T11 fails (clear not called) → step 2 default branch not triggered
- If T4/T5 fail → check that switch's existing case 'help' still matches after refactor

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: 0 errors. If errors mention `await this.handleChat(msg)` signature mismatch — verify `handleChat` accepts `SpoolMessage` (it does, line 1018).

- [ ] **Step 6: Commit (green phase)**

```bash
git add src/feishu/bot.ts
git commit -m "feat(feishu): passthrough unrecognized /xxx commands to Claude

v2.5 slash command passthrough:
- onMessage: always resolve target (was: skip for commands)
- handleCommand default: call handleChat (was: reply '未知命令')
- handleChat: remove dead /startsWith('/') branch (would infinite-recurse)

cc-linker built-in commands keep priority. /xxx falls through to chat
pipeline where model interprets built-in /init /review /cost etc.
Spec: docs/superpowers/specs/2026-06-18-feishu-cc-slash-passthrough-design.md"
```

---

## Task 4: Fix existing test that asserts "未知命令"

**Files:**
- Modify: `tests/unit/feishu/bot.test.ts:242-254`

After Task 3, the existing test `it('rejects unknown commands', ...)` will fail because `/unknown` no longer triggers "未知命令" reply. Update its assertion to match new passthrough behavior.

- [ ] **Step 1: Run full test suite to confirm `bot.test.ts` failure**

```bash
bun test tests/unit/feishu/bot.test.ts 2>&1 | grep -E "(FAIL|✓|✗|rejects unknown)" | head -20
```

Expected: `rejects unknown commands` test fails. Other tests pass.

- [ ] **Step 2: Read context around line 242-254 in `bot.test.ts`**

```bash
sed -n '240,260p' tests/unit/feishu/bot.test.ts
```

Expected output shows the full `it('rejects unknown commands', ...)` block. Note any setup (e.g., `bot.onMessage` vs `bot.handleCommand`).

- [ ] **Step 3: Update the test assertion**

In `tests/unit/feishu/bot.test.ts`, replace the test body (approximately lines 242-254):

```typescript
  it('rejects unknown commands', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/unknown' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    expect(env.textReplies.some(r => r.text.includes('未知命令'))).toBe(true);
  });
```

with:

```typescript
  it('v2.5: /unknown no longer rejected — falls through to handleChat as chat text', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/unknown' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    // v2.5: cc-linker 不再拒绝未知 /xxx — fallthrough 到 handleChat
    // 无活跃会话 → 走 case 'no_target' → 提示 /new (跟 chat 文本一致)
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
    // And user gets the standard no-session prompt
    const hasNewPrompt = env.textReplies.some(r => r.text.includes('/new'));
    expect(hasNewPrompt).toBe(true);
  });
```

- [ ] **Step 4: Run full test suite to verify green**

```bash
bun test tests/unit/feishu/
```

Expected: all tests pass (including the updated `rejects unknown commands` and the 12 new slash-passthrough tests).

- [ ] **Step 5: Run full project test suite**

```bash
bun test
```

Expected: all tests pass. If other suites fail (e.g., `tests/integration/`), investigate — but most likely the change is scoped to feishu unit tests.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/feishu/bot.test.ts
git commit -m "test(bot): update 'rejects unknown commands' for v2.5 passthrough

Old assertion: 未知命令 reply present.
New assertion: 未知命令 reply absent, /new prompt present.

/unknown now falls through to handleChat (no user-mapping → no_target
case → /new prompt). Mirrors chat-text behavior."
```

---

## Task 5: Update `helpText()` with passthrough hint

**Files:**
- Modify: `src/feishu/bot.ts:3223-3242` (append one line to helpText array)

- [ ] **Step 1: Read current helpText**

```bash
sed -n '3223,3242p' src/feishu/bot.ts
```

Verify the function starts at line 3223 and ends with `'/agents'` entry.

- [ ] **Step 2: Append new line to helpText array**

In `src/feishu/bot.ts`, find the helpText array. Insert one new line **after** the existing `/agents` entry:

```typescript
      '  /agents                            - 查看 agent 列表 (Agent View)',
      '  /<其他命令>                        - 透传给当前会话的 Claude (如 /init /review /cost)',
```

Alignment: `  /<其他命令>` occupies 13 display cells (2 leading spaces + `/` + `<` + 4 Chinese chars × 2 cells + `>`). To align `-` at column 38 (existing convention), insert 24 spaces between `>` and `-`.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: 0 errors. The new string is just an array element, no type impact.

- [ ] **Step 4: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "feat(feishu): add /<其他命令> line to helpText

Documents the new passthrough behavior. Aligns at column 37 with
existing helpText entries (Chinese chars = 2 display cells)."
```

---

## Task 6: Update CLAUDE.md with Slash Command Passthrough section

**Files:**
- Modify: `CLAUDE.md` (append new subsection after "Feishu Bot Architecture" around line 49)

- [ ] **Step 1: Find the insertion point**

```bash
grep -n "^### Feishu Bot Architecture\|^### Session Proxy" CLAUDE.md
```

Expected output shows `### Feishu Bot Architecture` at one line and `### Session Proxy & Streaming` after. We insert our new subsection between them.

- [ ] **Step 2: Insert new subsection**

In `CLAUDE.md`, find the line right before `### Session Proxy & Streaming` (around line 70). Insert this block above it:

```markdown
### Slash Command Passthrough (v2.5)

cc-linker 命令 (`/list /switch /help /resume /model /status /agents /stop /cancel /listdir /new /whoami`) 优先处理；其他 `/xxx` 作为 prompt 文本透传给当前会话的 Claude，由 model 自行识别（model 已训练识别 /init /review /cost 等内置命令）。无活跃会话时与普通聊天文本一致：提示需要先 `/new`。自定义命令 `~/.claude/commands/*.md` 不展开（与 `claude -p` 模式对齐）。Known limitation: 两次 `/xxx` 到同 session 不互锁（serialKey 不同），靠 busy check + force-send 显式确认兜底。

```

- [ ] **Step 3: Verify CLAUDE.md syntax**

```bash
grep -c "^### " CLAUDE.md
```

Expected count: 10 (project currently has 9 `### ` subsections; we add 1).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Slash Command Passthrough (v2.5) in CLAUDE.md

New subsection under Feishu Bot Architecture covering:
- cc-linker command priority list
- /xxx passthrough to Claude
- No-session behavior (consistent with chat text)
- Known limitation: same-session /xxx non-serialization"
```

---

## Task 7: Final verification

**Files:**
- No file changes — pure verification

- [ ] **Step 1: Run typecheck**

```bash
bun run typecheck
```

Expected: 0 errors. If errors, re-check the edits in Tasks 3-5.

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: all tests pass. 12 new slash-passthrough tests + all pre-existing tests (including updated `bot.test.ts:rejects unknown commands`).

- [ ] **Step 3: Smoke test in dev mode**

```bash
bun run dev start --daemon
sleep 3
# In a real environment: send /init from Feishu mobile and verify Claude processes it
# In dev: send via mock or test the daemon status
bun run dev daemon status
```

Expected: daemon reports running with the new code. (Manual Feishu interaction requires real Feishu bot credentials — skipped in this automated plan.)

- [ ] **Step 4: Stop dev daemon**

```bash
bun run dev stop
```

Expected: daemon stops cleanly.

- [ ] **Step 5: Final commit (if any uncommitted changes from verification)**

```bash
git status
```

If clean, no commit needed. If verification surfaced a minor doc fix, commit it.

---

## Self-Review Checklist

After all tasks complete, verify:

1. **Spec coverage:**
   - Spec §5.1 (onMessage target) → Task 3 Step 1 ✓
   - Spec §5.2 (handleCommand default) → Task 3 Step 2 ✓
   - Spec §5.3 (handleChat dead code) → Task 3 Step 3 ✓
   - Spec §5.4 (helpText) → Task 5 ✓
   - Spec §5.5 (CLAUDE.md) → Task 6 ✓
   - Spec §6.1 (12 tests) → Task 2 ✓
   - Spec §6.4 (existing test fix) → Task 4 ✓
   - Spec §8 (acceptance: typecheck + tests + integration) → Task 7 ✓

2. **Placeholder scan:** No "TBD", "TODO", "implement later" in any task. All code blocks are complete.

3. **Type consistency:**
   - `buildMsg` returns `SpoolMessage` consistently across all 12 tests
   - `sessionManager.sendSDKMessage` mock signature matches real one (5+ args)
   - `TargetSnapshot` types match imports from `src/queue/spool`

4. **Commit cadence:** 7 commits total (Tasks 1-6 + optional Task 7 if needed). Each is atomic and TDD-aligned.

5. **Risk acknowledgments:**
   - Task 3 Step 4 explicitly checks for recursion (T10 failure = dead code not removed)
   - Task 4 updates the one known broken test
   - Task 6 documents known limitation in CLAUDE.md