# Design Review: Rendezvous Reply Spec

**Spec under review:** `docs/superpowers/specs/2026-06-11-rendezvous-reply-design.md`
**Reviewer:** Claude
**Date:** 2026-06-11
**Methodology:** Codebase diff + scenario walkthrough

## 1. Code Mismatches (12 issues)

### M1. [CRITICAL] `expectedReply.clear()` 时机错位 — 双重 reply 风险

**Spec §5.1 (T2):**
> T2: pre-step 完成 (reply 已 inject rendezvous / 走 SDK)
>   → expectedReply CLEARED (reason: 'sent')

**实际代码** (`src/agent-view/manager.ts:870-914`):
```typescript
async handleReply(openId, text) {
  // ...
  try {
    await this.deps.runChatSDK({ fromAgentViewReply: true, ... });
  } catch (err) { sdkError = err; }
  finally {
    await this.expectedReply.clear(openId);  // ← T4 才清, 不 T2
  }
  // ...
}
```

**Bug 场景**：
- T0: 用户点 [Reply]，expectedReply set
- T1: 用户发"继续"，handleReply 调 runChatSDK 走 rendezvous
- T2: rendezvous inject 成功，**expectedReply 还在！**（finally 还没跑）
- T2+30s: bg 还在 processing，**用户又发"再来一次"**
- T2+30s+ε: handleChat 再次匹配到 expectedReply，调 handleReply 第二次
- T2+60s: 第一次 rendezvous 完成，回 result
- T2+60s+ε: 第二次 rendezvous inject 成功（daemon 串行化），bg 又处理一次
- 两次都 `replyAndFinalize` → **用户看到重复响应**

**Fix**：在 runChatSDK 进入前显式 clear（新增 `markSent(openId)` 或扩展 clear reason），finally 再 clear 一次幂等。**Spec 必改。**

### M2. [HIGH] "已处理" 消息只发确认, **不显示响应文本** — Spec 误以为是行为不变

**Spec §4.2:**
```
├─ if result.ok:
│  ├─ replyAndFinalize(msg, text)  // text 来自 readLastAssistantTurn
```

**实际代码** (`src/agent-view/manager.ts:933-937`):
```typescript
await this.deps.replyFn(
  `✅ Claude 已处理完你的消息。\n` +
  `若需继续 reply,在飞书 Agent View 重新点 [Reply] 即可。`,
  { openId },
);
```

**用户面差异**：
- 当前: 发"继续" → 收到"✅ Claude 已处理完"（无内容）
- Spec 设计: 发"继续" → 收到"✅ Claude 已处理完：当前时间 18:16:51 是否继续？（35 tokens / 1.5s）"

**这是行为变更, 不是 bug**。但用户调研过吗？v2.3.11 commit 看起来是"确认 + 提示",用户已习惯。要确认是新功能还是 spec 笔误。**Spec 必确认。**

### M3. [HIGH] 重复的状态检查 — refactor 机会

**Spec §4.2 / §6.1:** "checkRendezvousEligibility 读 state.json + roster.json"

**实际代码** (`manager.ts:876-893`):
```typescript
// Step B 二次状态守卫
const result = await AgentSnapshotFetcher.fetch();
const session = result.sessions.find(s => s.sessionId === info.sessionId);
if (session.status !== 'waiting') {  // ← 这就是 eligibility check
  await this.expectedReply.clear(openId);
  await this.replyFn(`⚠️ Claude 已切换到 ${session.status},无法 reply`, ...);
  return;
}
```

**冗余**：handleReply 已经做了一次 waiting 检查。rendezvous eligibility 应该复用同一次 snapshot fetch，而不是再读一次 state.json + roster.json。

**Fix**：让 `checkRendezvousEligibility` 接受已 fetch 的 snapshot + roster 上下文。或者直接 inline 到 handleReply 的 Step B 守卫里。

### M4. [MEDIUM] 5min expectedReply timeout 与 rendezvous 60s wait 竞态

**Spec §5.1:** T2 清 expectedReply
**实际：** timeout 5min = 300_000ms (expected-reply-state.ts:25)

**竞态**：
- T0: set expectedReply (5min timer)
- T1 (T0+4min): 用户发文本，调 handleReply → 调 rendezvous
- T1 (T0+5min): 5min timer 触发 `expectedReply.clear(openId, 'timeout')`
- T1 (T0+5min+ε): rendezvous 还在 wait
- T1 (T0+6min): rendezvous 完成，handleReply finally 再次 clear (idempotent, OK)

**OK 行为**, 但应该:
- Spec 明确说: "rendezvous 跑的时候, 5min timer 是 background; clear happens at rendezvous completion or 5min timeout, whichever first"
- 测一个 case: T0 到 T0+5min 不发文本, verify expectedReply cleared

### M5. [MEDIUM] 多用户 reply 同一 session — 行为不明确

**场景**：两个飞书用户都打开了 Agent View,都点同一个 session 的 [Reply]。

**当前行为**：
- 两个 expectedReply entry (per openId)
- User A 先发, inject 成功, bg processing
- User B 后发, handleReply 第二次, snapshot re-fetch → bg 是 running (not waiting) → 报"已切换到 running, 无法 reply"
- OK

**Spec 没明确**：rendezvous 串行化行为 (daemon 自己保证), 但 client 这边 2 个 `replyAndFinalize` 的错误处理。

**Fix**：spec 加一节 "Multi-openId 并发", 说明预期行为 + 测试 case。

### M6. [MEDIUM] `linkScanPath` 在 running/working 时为空 — JSONL 读 fallback 不全

**实测 state.json** (dcb2ec25 当 `state: 'done'` 时):
```json
"linkScanPath": "/Users/.../dcb2ec25-...jsonl",
"linkScanOffset": 384818,
```

**Spec §4.3:** "completion 后从 linkScanPath 拿最后一条 assistant turn"

**问题**：bg 在 `running/working` 状态时, state.json 的 `linkScanPath` 可能为空（只在 blocked/done 时写入 — 这是 v2.3 的设计）。但 rendezvous 完成后 bg 处于 `done` / `new_needs (blocked)` 状态, linkScanPath 应该已写。

**Fallback (spec 缺)**：若 linkScanPath 为空, 退到 `roster.json:workers[short].dispatch.launch.sessionId` (这是 JSONL 全路径)。`manager.ts:208-216` 已有这个 fallback 模式。

**Fix**：spec §4.3 + §7.1 测试加 "handles empty linkScanPath, falls back to roster.launch.sessionId"。

### M7. [LOW] reply text 为空字符串 — 没防御

**Spec:** 没提 input 校验
**实际**：`manager.ts:870` 直接接 text, 传给 runChatSDK, 传给 rendezvous

**Bug 场景**：用户点 [Reply], 在 waiting card 上按 Enter (没打字就发), 文本 = ""
- rendezvous inject `{"text":""}` → bg worker 收到空 user turn
- Claude 会 ask "you sent empty text", 或 loop 出错
- 浪费一次 round-trip

**Fix**：在 handleReply 入口加 `if (!text.trim()) return;`

### M8. [LOW] Spec 漏了"bg stopped" 时的文案

**Spec §6.2:** 没列 `state: stopped` 终态时的用户面文案

**实际**：rendezvous 完成后, 若 bg 主动进入 `state: stopped` (e.g. agent 自己 exit), reason='stopped', ok=true。但 spec 的 §6.2 没有这个 case 的文案。

**Fix**：spec §6.2 加一行: `bg 完成且停止: "✅ bg 已处理完毕。"`

### M9. [LOW] Spec 没说 spec.cliVersion 检测的实际写法

**Spec §4.1 / §6.1:** "cliVersion < 2.1.139 fallback"

**实际**：roster.json 里的 `cliVersion: "2.1.163"` (string, 不是 number)
- 比较: `parseInt(cliVersion) < 2_001_139` ? 复杂
- 应该: `semverCompare(cliVersion, "2.1.139") < 0`

**Spec 缺**：明确用 semver 比较, 列出失败 case (e.g. "2.1.139-beta" 怎么处理)。

### M10. [LOW] `--bg-pty-host` 进程泄漏 case 没收

**Changelog 2.1.166:** "Fixed orphaned `claude --bg-pty-host` processes spinning at 100% CPU after the daemon dies while connected on macOS"

**Spec §6.1:** "daemon 死 → socket 断开 → report"

**遗漏**：socket 断开时, pty-host 可能仍残留 (CLI bug), 我们关 socket 不影响。Spec 应该确认我们的关 socket 逻辑不会 leak 资源 (rendezvous-client 必须在 done/err 时 destroy)。

**Fix**：rendezvous-client.test.ts 加 "socket destroy called on all paths" 测试, spec §7.1 加这个 case。

### M11. [LOW] Spec 没说 `handleChat` 里的 `attachedWatchers.stop()` 与 reply 的关系

**实际代码** (`bot.ts:940-942`):
```typescript
if (this.agentView.attachedWatchers.has(msg.openId)) {
  void this.agentView.attachedWatchers.stop(msg.openId, 'user_chat', { patchFinal: true });
}
```

**行为**：用户 "watching" 一个 session, 然后发文本 (含 reply), attached watcher **先被 stop**, 然后 expectedReply 检查。

**Spec 没提**。这是兼容性行为, 应该文档化: "用户 watching + reply: watch 终止, reply 走 rendezvous, 用户失去 watch view (与 v2.2 handleBackToChat 一致)"

### M12. [LOW] Spec 没说 `dispatch.launch.sessionId` 的可能格式

**实测 roster.json:**
```
"launch": {
  "mode": "resume",
  "sessionId": "/Users/tester/.claude/projects/-Users-tester/0307afb9-c11c-4536-bca6-e6a049c29413.jsonl",
  "fork": true,
}
```

**Spec §4.3 fallback 链:** "用 `dispatch.launch.sessionId`"

**问题**：这是 `.jsonl` 绝对路径, 不是 UUID。readLastAssistantTurn 直接接受 path, OK。但 spec 应明确 "path string, not UUID"。

---

## 2. Scenario Walkthroughs (5 scenarios)

### S1. Happy path (你 dcb2ec25 的 case)

```
T0: 用户点 [Reply] in dcb2ec25 (bash loop waiting)
T0+1s: handleReplyRequest → expectedReply set
T0+1s: [Reply prompt] 卡显示 "等待输入: 是否继续?"
T0+5s: 用户发"继续"
T0+5s+ε: handleChat → handleReply → checkRendezvousEligibility
         - state.json: tempo=blocked, needs="是否继续?" → bg_waiting ✓
         - roster: rendezvousSock exists → rendezvousSock set
T0+5s+1: RendezvousClient.injectReply
         - connect rendezvousSock
         - write {"type":"reply","text":"继续"}\n
         - patch stream: tempo=active (bg 起来)
         - patch: tempo=blocked, needs="是否继续?" (new_needs 完成)
T0+5s+30: rendezvous done
         - readLastAssistantTurn(jsonl) → "当前时间: 18:16:51 是否继续?" + usage
T0+5s+31: replyAndFinalize(msg, text)
         - replyFn: "✅ Claude 已处理完：当前时间: ... (35 tokens / 1.5s)"
         - markReplied + markDone
T0+5s+32: attached watcher 检测 state.json 变化, patch [Reply prompt] 卡 → "Waiting · 是否继续? · [Peek] [Stop] [Reply]"
T0+5s+33: 用户可继续点 [Reply]
```

✅ **完美**, 但 spec 漏了 T0+5s+32 (watcher 自然 patch 卡) 这步的描述。

### S2. Bg busy (用户在 npm install 时点 [Reply])

**前置**: bg 在跑 `npm install`, tempo=active, no needs

```
T0: handleReplyRequest 入口, session.status !== 'waiting' → 拒绝, 发"⚠️ 该 session 不是 waiting 状态,无法 reply"
T0+ε: [Reply] 按钮根本不应该出现 (card.ts 逻辑, 但 spec 没追溯这个)
```

✅ **实际上用户在 busy 时根本点不到 [Reply]**。My Q1 假设的"busy reply"在实际产品里不可能触发, fallback 路径主要是**理论防御**。

**Spec 必改**: "busy case 实际由 handleReplyRequest 入口守卫拒绝, rendezvous-fallback 主要是 5min timeout 内的窗口防御 (T0 后用户慢, bg 状态变化)"

### S3. 用户 5min 内不发文本 (timeout)

```
T0: 点 [Reply], expectedReply set
T0+5min: timer 触发 expectedReply.clear('timeout')
T0+5min+ε: in-memory + user-mapping 都被清
T0+5min+10s: 用户终于想到要发文本
         handleChat → expectedReply.get → null → 走普通 chat path
         若 target=session: SDK --resume; 若 target=no_target: error
```

✅ **graceful 退化**, spec 没明确说这种情况会怎样。

**Spec 必加**: "5min timeout 后用户发文本: graceful 退化, 走普通 chat, 可能 conflict (bg busy) 或 no_target (无 session)"

### S4. User clicks [Stop] mid-reply

```
T0: 点 [Reply], expectedReply set
T0+5s: 发"继续", rendezvous inject
T0+5s+10: bg processing, tempo=active
T0+10s: 用户在 agent view 卡点 [Stop]
         handleStop → claude stop <short>
         daemon 收到 stop 信号, kill bg
T0+10s+1: rendezvous 收到 patch: state=stopped
         完成判定 → reason='stopped', ok=true
T0+10s+2: readLastAssistantTurn → bg 死前可能写了部分 turn, 也可能没
T0+10s+3: replyAndFinalize("✅ bg 已停止（未生成新响应）")
```

⚠️ **这里有问题**：bg 是被用户 stop 的, **reply 不应该报"成功"**。这是用户的"撤销"操作, 不是 reply 成功。

**Spec 缺**: "用户主动 stop bg 时的 reply 结果" — 应区分:
- bg 自己 exit → ok=true, reason='stopped' (这是 bg 正常结束, 但很少见)
- 用户/cron 主动 stop → ???
  - 选项 A: 仍 ok=true, 报"已停止", 用户已知道
  - 选项 B: ok=false, 报"bg 已被停止"
  - 我的判断: A 更准确, 但 spec 必须明确

### S5. User 在 watching 卡上点 [Reply]

```
前置: 用户 attached dcb2ec25, attachedWatchers 持续 patch 卡
T0: 附着卡显示 "Last watched 2:53:19 PM · [Refresh] [Stop Watching] [Reply]"
T0+1s: 用户点 [Reply] in 附着卡
         handleReplyRequest → expectedReply set
         [Reply prompt] 卡叠加发送
T0+5s: 用户发"继续"
T0+5s+ε: handleChat:
         - 第一行: attachedWatchers.has(openId) → stop attached watcher
         - 第二行: expectedReply match → handleReply
T0+5s+1: handleReply → rendezvous inject
T0+5s+30: replyAndFinalize
```

⚠️ **副作用**: 用户失去了 watching 视图 (handleBackToChat behavior)。My spec 没说这个 UX 退步。

**Spec 必加**: "Watching + Reply: attached watcher 静默 stop, 用户回 chat 模式 (这与 v2.2 handleBackToChat 一致, 用户已接受)"

---

## 3. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| **M1 双重 reply** (T2 clear 时机错) | 🔴 P0 | **Spec M1 fix 必做**, 加单测 |
| **M2 用户面行为变更** (无文本 vs 有文本) | 🟡 P1 | **Spec M2 必确认**, 与产品决策 |
| **M3 重复 check** (refactor 机会) | 🟢 P2 | Spec 推荐 shared helper, 不阻塞 |
| **M4 5min timeout 竞态** | 🟢 P2 | Spec 明确, 测一个 case |
| **M5 多用户并发** | 🟢 P2 | Spec 加节, 测一个 case |
| **M6 linkScanPath fallback** | 🟢 P2 | Spec 补 fallback, 加测 |
| **M7 空文本** | 🟢 P3 | handleReply 入口加 trim() 检查 |
| **M8 stopped 文案** | 🟢 P3 | Spec §6.2 加一行 |
| **M9 semver 比较** | 🟢 P3 | Spec 明确, 用 semver 函数 |
| **M10 socket 泄漏** | 🟢 P3 | rendezvous-client 测试加 |
| **M11 watch + reply** | 🟢 P3 | Spec 文档化 |
| **M12 path 格式** | 🟢 P3 | Spec 明确 |
| **S4 user stop** | 🟡 P1 | Spec 必加决策 |
| **S5 watch → reply** | 🟢 P3 | Spec 文档化 |

---

## 4. 必须修改的 (4 项)

1. **M1: T2 clear timing** — Spec 必改 `expectedReply.clear()` 必须在 rendezvous inject 成功后立即调, finally 里的清作为兜底
2. **M2: response text** — Spec 必明确: "✅ 处理完" 后是否带响应文本 + token stats (vs 当前纯确认)
3. **S4: user-initiated stop** — Spec 必加决策: bg 被用户 stop 时的 reply 文案/语义
4. **S2 clarification** — Spec 必澄清: "busy case 实际由 handleReplyRequest 入口守卫拒绝, fallback 是窗口防御"

## 5. 建议但非阻塞 (8 项)

M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, S3, S5 — 在 PR 2 实施时分别补到 spec 或代码注释里。

## 6. 整体评估

**Spec 整体质量**: 8.5/10
- 架构清晰, 模块边界合理
- Fallback 矩阵完整
- 测试策略扎实
- 但有几处 **跟代码不一致** 和 **用户面行为未明确** 必须在开工前解决

**最大风险**: M1 (T2 clear) — 不修会导致用户看到重复响应, 是个 P0 bug。**修起来也简单**: 在 runChatSDK 入口加一行 `await this.expectedReply.clear(openId, 'sent')` (假设 rendezvous/SDK 都接受), finally 兜底。

**建议下一步**:
1. 把 4 项必改写到 spec, 重新 review
2. 然后才进 writing-plans

要我直接把 4 项必改 inline 到 spec, 还是你想先讨论哪一项?
