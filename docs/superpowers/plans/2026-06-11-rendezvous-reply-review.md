# Plan Review: Rendezvous Reply Implementation

**Plan under review:** `docs/superpowers/plans/2026-06-11-rendezvous-reply.md`
**Reviewer:** Claude
**Date:** 2026-06-11
**Methodology:** Diff plan code against actual codebase. Spot 12+ correctness issues.

## 1. Blocking Issues (must fix before execution)

### P0-1: `runChatSDK` return type wrong — Task 6 will fail typecheck

**Plan (Task 6) writes:**
```typescript
return {
  result: { ok: true, reason: rendezvousResult.reason },
  handler: null,
  cardMessageId: null,
};
```

**Actual signature** (`bot.ts:1395`):
```typescript
public async runChatSDK(params: {...}): Promise<{
  result: SendMessageResult;       // ← strict shape from proxy/session.ts:21
  handler: PermissionHandler;
  cardMessageId: string | null;
}>
```

`SendMessageResult` shape (`src/proxy/session.ts:21-33`):
```typescript
{
  response: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  jsonlPath: string | null;
  sessionStatus: 'active' | 'provisioning' | 'degraded';
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
}
```

`{ok, reason}` is not a valid `SendMessageResult`. **TypeScript will reject.**

**Fix**: Construct a synthetic `SendMessageResult`:
```typescript
return {
  result: {
    response: responseText,
    costUsd: 0,
    durationMs: rendezvousResult.durationMs ?? 0,
    sessionId: '',  // unknown at this layer
    jsonlPath: eligibility.jsonlPath ?? null,
    sessionStatus: 'active',
    tokensIn: lastTurn?.usage.input_tokens ?? 0,
    tokensOut: lastTurn?.usage.output_tokens ?? 0,
  },
  handler: null as unknown as PermissionHandler,  // or throw/early return
  cardMessageId: null,
};
```

Better: don't return at all; **let the rendezvous path do its own reply and finalize**, never reach the post-runChatSDK consumer in handleChat. The cleanest is to **throw a sentinel** like `new ReplyHandledSentinel()` and have the handleChat caller detect it. But this requires changing the call site too.

Or: simplify by making the rendezvous path call `replyAndFinalize` directly and **return early** before reaching the post-processing. But runChatSDK is the one that knows the jsonlPath. The cleanest is:

```typescript
// Inside runChatSDK, rendezvous path:
const syntheticResult: SendMessageResult = {
  response: responseText,
  costUsd: 0,
  durationMs: rendezvousResult.durationMs ?? 0,
  sessionId: '',
  jsonlPath: eligibility.jsonlPath ?? null,
  sessionStatus: 'active',
  tokensIn: lastTurn?.usage.input_tokens ?? 0,
  tokensOut: lastTurn?.usage.output_tokens ?? 0,
};
// Then FALL THROUGH to the existing post-processing path, which will:
//   - registry.upsert with result.jsonlPath
//   - spoolQueue.updateProcessingMessage with result.response
//   - markReplied + markDone
// No need to early-return!
return { result: syntheticResult, handler: null as any, cardMessageId: null };
```

This reuses the existing post-processing. **Cleaner than my plan's early-return approach.**

### P0-2: `replyTo` signature wrong — Task 6 will not compile

**Plan (Task 6) writes:**
```typescript
await this.replyTo({ messageId, openId } as any, replyText).catch(async () => {
  await this.replyFn(replyText, { messageId, openId, requestUuid: stableUuid(messageId) });
});
```

**Actual signature** (`bot.ts:2546`):
```typescript
private async replyTo(msg: SpoolMessage, text: string): Promise<{...}>
```

`replyTo` takes a full `SpoolMessage`, not `{messageId, openId}`. At the rendezvous injection point we have `params.messageId` only.

**Fix**: Don't use `replyTo`. Use `replyFn` directly (the callback set in constructor). This is what the existing SDK paths do for non-SpoolMessage text replies.

```typescript
// Replace the replyTo call with:
await this.replyFn(replyText, {
  messageId,  // from params
  openId,     // from params
  requestUuid: stableUuid(messageId),
});
```

Need to verify `messageId` and `openId` are in `params`. Yes: `runChatSDK` params include `openId: string` (required) and `messageId?: string` (optional).

### P0-3: `state_error` not propagated to failure path — Task 3 logic gap

**Plan (Task 3) `checkCompletion` returns null for `state === 'error'`:**
```typescript
if (patch.state === 'error') return null; // handled by caller via state_error
```

**But the caller has NO such handling.** The injectReply promise resolves only on completion (which excludes error) or timeout. If bg reports `state: 'error'`, the promise hangs until the 60s timeout, then returns `reason: 'timeout'`. The user gets a misleading "处理超时" instead of "bg 报错了".

**Fix**: Return `state_error` from checkCompletion for `patch.state === 'error'`. The injectReply outer logic treats this as a completion (ok=false path with reason=state_error).

```typescript
if (patch.state === 'error') return 'state_error' as RendezvousFailureReason;
// But we need checkCompletion to also return failure reasons...
// Better: change checkCompletion's return type to include failure reasons.
```

**Cleaner**: Refactor `checkCompletion` to return either `{done: true, reason: CompletionReason}` or `{done: false}` (still processing), AND have a separate `isFailure(patch)` check.

```typescript
function checkCompletion(patch: StatePatch): RendezvousCompletionReason | null {
  if (patch.state === 'done') return 'done';
  if (patch.state === 'stopped') {
    if (patch.detail === 'killed') return 'user_stopped';
    return 'stopped';
  }
  if (patch.state === 'error') return 'state_error';  // ← FIX
  if (patch.tempo === 'blocked' && patch.needs && patch.needs.length > 0) return 'new_needs';
  if (patch.tempo === 'idle' && !patch.needs) return 'idle';
  return null;
}
```

But this conflates completion and failure. Better: return a discriminator.

```typescript
type CompletionResult =
  | { kind: 'completed'; reason: RendezvousCompletionReason }
  | { kind: 'failed'; reason: RendezvousFailureReason }
  | { kind: 'pending' }
  ;

function checkPatch(patch: StatePatch): CompletionResult {
  if (patch.state === 'done') return { kind: 'completed', reason: 'done' };
  if (patch.state === 'stopped') {
    return { kind: 'completed', reason: patch.detail === 'killed' ? 'user_stopped' : 'stopped' };
  }
  if (patch.state === 'error') return { kind: 'failed', reason: 'state_error' };
  if (patch.tempo === 'blocked' && patch.needs) return { kind: 'completed', reason: 'new_needs' };
  if (patch.tempo === 'idle' && !patch.needs) return { kind: 'completed', reason: 'idle' };
  return { kind: 'pending' };
}
```

Then injectReply:
```typescript
const r = checkPatch(env.patch);
if (r.kind === 'completed') finish({ ok: true, reason: r.reason, ... });
else if (r.kind === 'failed') finish({ ok: false, reason: r.reason, ... });
```

The type union already supports this since `RendezvousReplyResult.reason: RendezvousCompletionReason | RendezvousFailureReason`.

### P0-4: Task 6 has placeholder text — won't execute

**Plan Task 6 step 2 contains:**
> Trim the v2.2.11 conflict card branch to keep behavior; refer to existing lines for the exact text.

This is exactly the "implement later / refer to existing" anti-pattern. **The plan must contain the actual code.**

**Fix**: Either (a) provide the full conflict card code (~30 lines, just copy from existing), or (b) simplify: since the rendezvous path is the only NEW path in this task, the conflict card can be **left untouched**. Task 6 only modifies the rendezvous branch. The existing conflict card logic is already correct and doesn't need changes.

**Recommended**: (b) - don't touch the conflict card at all. Restructure Task 6 to clearly only ADD the rendezvous branch before the existing pre-step.

---

## 2. High-severity issues

### P1-1: Task 5 has placeholder ("find the section, then add")

**Plan:**
> Read `src/utils/config.ts` to find the AgentView section, then add

Must show the actual zod schema. The codebase uses zod for config validation.

**Fix**: Provide the actual snippet:
```typescript
// src/utils/config.ts, in the AgentView zod schema block:
rendezvous_enabled: z.boolean().default(false),
rendezvous_timeout_ms: z.number().int().positive().default(60_000),
```

### P1-2: `formatTokenCount` already exists — don't duplicate

**Plan Task 6 defines:**
```typescript
function formatTokens(usage) { ... 1000 → 1.0K ... }
```

**Already exists** in `src/feishu/card-updater.ts:456, 503`:
```typescript
function formatTokenCount(n: number): string { ... }
```

**Fix**: Import and use the existing helper. Add to imports in bot.ts:
```typescript
import { formatTokenCount } from './card-updater';
```

Or extract it to a shared util module. The plan should not duplicate.

### P1-3: Task 9 E2E confuses cc-linker daemon with Claude daemon

**Plan:**
> `kill -9 $(cat ~/.cc-linker/daemon.pid)` (or `cc-linker daemon stop`)

`cc-linker daemon` is the **Feishu bot daemon**, not Claude's bg supervisor. Killing it stops the bot, not the bg worker. The bg continues running.

**Fix**: Clarify in E2E that:
- Claude daemon manages bg workers (rendezvous socks are in `/tmp/cc-daemon-503/...`)
- cc-linker daemon is the Feishu bot (owns the spool queue)
- "Scenario 5: daemon 重启" should test the **cc-linker** daemon (bot side), not Claude daemon
- To test Claude daemon dying, you can't easily kill it (it's running claude daemon managed by launchd); instead test by stopping the rendezvous socket manually: `rm /tmp/cc-daemon-503/02d85b02/rv/<short>.sock` and verify fallback

### P1-4: Task 7's removed success reply may regress SDK path

**Plan Task 7 removes:**
```typescript
await this.deps.replyFn(`✅ Claude 已处理完...`, { openId });
```

**But**: When rendezvous is **disabled** (flag=false, default), the SDK path runs. The SDK path doesn't produce a chat-message reply (it patches a card). The user got the success text from handleReply previously. With the change, the user gets... what?

**Trace**: 
- handleChat → handleReply → runChatSDK (SDK path) → patches card via CardUpdater → returns SendMessageResult
- handleReply ignores the result (just checks for errors)
- The user sees the card being patched (live updates), not a chat text

So the OLD code's "✅ 已处理" chat text was **redundant** with the card. Removing it is actually a UX cleanup, not a regression. But the spec said M2 "show response text + token stats" which the OLD code didn't do. So:

**Either**:
- (A) Plan aligns with spec M2: add response text + stats back, but make it work for BOTH rendezvous and SDK paths
- (B) Plan simplifies: remove the chat text entirely; user sees only the card

The spec commits to (A). Plan needs to do that for both paths. The SDK path needs a `lastTurn` fetch too, which adds work in the SDK path.

**Fix**: Add a helper that, given a sessionId, fetches `lastTurn` from JSONL and produces the success text. Call this helper from BOTH paths. For SDK path, the result.jsonlPath points to the JSONL.

```typescript
async function buildReplyTextFromJsonl(jsonlPath: string | null, fallback: string): Promise<string> {
  if (!jsonlPath) return fallback;
  const turn = await readLastAssistantTurn(jsonlPath);
  if (!turn) return fallback;
  return `✅ Claude 已处理完你的消息。\n\n${turn.text}\n\n` +
         `⏱ ${...}ms · ${formatTokenCount(turn.usage.input_tokens + turn.usage.output_tokens + ...)} tokens · 1 轮数`;
}
```

This unifies the success path for both rendezvous and SDK.

---

## 3. Medium-severity issues

### P2-1: Task 2 uses `require('fs')` in ESM project

**Plan:**
```typescript
const fs = require('fs');
fs.symlinkSync(...);
```

The project is ESM (`"type": "module"` in package.json). Mixing `require` works in TypeScript with esModuleInterop, but it's inconsistent with the rest of the codebase.

**Fix**: Replace with `import * as fs from 'fs';` at the top, then use `fs.symlinkSync(...)`.

### P2-2: Missing Task 0 — probe notes doc

**Spec §10 references:**
> 实证探针（PR 1 实施时合并到本目录）：
>   - `docs/qa/2026-06-11-rendezvous-probe-notes.md` 记录 6 次探针

**No task creates this file.** Implementation engineer will write it as a side-effect at the end of PR 1, but it should be explicit.

**Fix**: Add a small "Task 0: Document probe notes" before Task 1.

### P2-3: Task 6's logic flow has a subtle issue with the conflict card

In my plan, the new pre-step has:
```typescript
if (fromAgentViewReply && worker) {
  // stop bg, wait 3s
}
const roster2 = readRoster();
const worker2 = roster2.workers[short];
if (worker2 && !fromAgentViewReply) {
  // conflict card
}
```

This means:
- `fromAgentViewReply=true` → stop bg, fall through (no conflict card even if worker still alive)
- `fromAgentViewReply=false` → conflict card if worker alive

This is the v2.3.5/3.6 behavior. But the rendezvous path is the **new** path that runs BEFORE this. So the structure is:

```typescript
// NEW: rendezvous path
if (rendezvousEnabled && fromAgentViewReply) {
  // try rendezvous, return on success, fallback on failure
}
// OLD: conflict card path
if (fromAgentViewReply && worker) {
  // stop bg
}
const worker2 = readRoster().workers[short];
if (worker2 && !fromAgentViewReply) {
  // conflict card
}
```

The `rendezvousEnabled && fromAgentViewReply` returns on success. On failure (canUse=false or inject failure), control falls through to the OLD path. The OLD path's `if (fromAgentViewReply && worker)` is still hit, doing the stop+3s+fall-through. **This is correct for fallback** but redundant if rendezvous already tried.

The `worker2 && !fromAgentViewReply` branch: if fromAgentViewReply=true, this is false, so no conflict card. OK.

So the logic is correct, but it's a bit confusing to read. The plan should annotate this clearly.

### P2-4: Task 8 regression test doesn't test the new path

**Plan Task 8:**
```typescript
test('when rendezvous_enabled=false, runChatSDK still uses claude stop path (regression)', async () => {
  // ... verifies /agents works with default config (flag=false)
});
```

But this test doesn't actually exercise the rendezvous path because flag is false. To test the new path, we need:
- A test that mocks `checkRendezvousEligibility` to return canUse=true
- A test that mocks the rendezvous socket
- Verifies the result reaches the user

Without this, Task 8 only tests "nothing broke", not "the new path works".

**Fix**: Add a more thorough test that:
- Mocks checkRendezvousEligibility (via DI or test hook)
- Provides a mock rendezvous server
- Sends a /agents-style command with fromAgentViewReply=true
- Verifies the response text reaches the test's reply capture

OR add a separate test file: `tests/unit/feishu/bot-rendezvous-reply.test.ts`.

---

## 4. Lower-severity issues

### P3-1: Plan doesn't address the `messageId` optional in runChatSDK params

`messageId?: string` is optional. In Task 6, I use `stableUuid(messageId)`. If messageId is undefined, this crashes.

**Fix**: Add `if (messageId) ...` guard, or assert it's required in the rendezvous path.

### P3-2: `SendMessageResult.sessionStatus` defaults missing

In my synthetic result, I set `sessionStatus: 'active'`. But the rendezvous session is technically "alive + new reply just processed". 'active' is correct. But the caller (handleChat:1080) uses this to set `registry.status`. So rendezvous sessions get marked 'active' in the registry. OK.

But what about for the `new_session_claimed` state? The rendezvous path doesn't create a new session. So 'active' is correct.

### P3-3: Plan doesn't have a "rollback" step for the rollout

The spec mentions `rendezvous_enabled = false` for rollback. Plan Tasks 5 + 10 set the default to false/true. But there's no test for "verify rollout works with flag=false → flag=true".

Minor. Documented in spec, can be added to Task 10.

### P3-4: Plan has 1728 lines — large

Could split into 4 sub-plans (one per PR). Each PR plan ~430 lines. But the user might prefer a single plan for context. Leave as-is.

---

## 5. What's GOOD about the plan

- TDD structure (test → fail → implement → pass → commit) is consistent across tasks
- File paths are correct
- Test cases are comprehensive (38+ unit tests cover all spec requirements)
- Phased rollout (5 PRs) aligns with spec's risk mitigation
- The PR 1 boundary (modules + tests, no runChatSDK change) is correct
- Self-review checklist is honest about gaps

## 6. Score

**8.0/10** — 4 P0 issues must fix, 4 P1 issues should fix. Once addressed, plan is directly executable.

## 7. Required fixes before execution

1. **P0-1**: Return type — use synthetic SendMessageResult, fall through to existing post-processing
2. **P0-2**: replyTo signature — use `replyFn` (callback) not `replyTo` (instance method)
3. **P0-3**: state_error — return `state_error` from checkCompletion, use discriminated union
4. **P0-4**: Task 6 placeholder — restructure so the conflict card branch is unchanged
5. **P1-1**: Task 5 placeholder — provide actual zod schema snippet
6. **P1-2**: formatTokenCount — use existing helper
7. **P1-3**: Task 9 daemon confusion — clarify cc-linker vs Claude daemon
8. **P1-4**: Task 7 regression — unify success text for both paths via JSONL fetch

## 8. Recommended fixes

9. **P2-1**: ESM `require` → `import * as fs`
10. **P2-2**: Add Task 0 for probe notes
11. **P2-3**: Annotate Task 6 logic flow with comments
12. **P2-4**: Add a rendezvous path test in Task 8 (not just regression)
13. **P3-1**: Guard `messageId` optional

---

## 9. Direct answer to "是否可以直接用来落地执行开发"

**Not yet** — 4 P0 issues would block the implementation engineer. Once fixed, the plan is solid and the engineer can execute task-by-task.

**Estimated fix time**: 30-60 minutes to inline the corrections. The plan structure is good; the issues are all in the code snippets of Task 5, 6, 7.

Want me to apply these fixes inline and re-commit the plan?
