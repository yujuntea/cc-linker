# Agent View Reply: Rendezvous Socket 改造

**Status:** Draft (post-review v2)
**Date:** 2026-06-11
**Author:** Claude (cc-linker)
**Target version:** v2.4.0
**Supersedes:** v2.3.5/v2.3.6 auto-stop-bg approach
**Review doc:** `2026-06-11-rendezvous-reply-design-review.md` (12 代码差异 + 5 场景推演)

## Changelog

- **v2 (post-review)**: 应用 12 项 review 修复, 4 项 P0/P1 必改 + 8 项 P2/P3
  - M1: T2 立即 `markSent` (finally 兜底) — 防双重 reply
  - M2: reply 显示响应 + token stats (v2.3.11 → v2.4 行为变更)
  - M3: 状态检查 refactor 共享 (handleReply Step B 复用 snapshot)
  - M4: 5min timeout × 60s wait 竞态明确
  - M5: 多用户并发语义明确
  - M6: linkScanPath fallback 链 (空 → roster.launch.sessionId)
  - M7: 入口空文本防御
  - M8: `state=stopped` 文案
  - M9: semver 比较
  - M10: socket destroy on all paths
  - M11: Watching + reply 文档化
  - M12: launch.sessionId 是 path string
  - S2: busy case 是窗口防御, 不是主路径
  - S3: 5min timeout 后 graceful 退化
  - S4: user_stopped vs stopped 区分 (`detail === 'killed'`)
  - S5: Watching → reply UX 退步文档化
- **v1**: 初版设计 (4 sections 通过用户 review)

## 1. Problem

Agent View 的 Reply 路径（飞书 /agents → Peek → Reply）当前用 `claude stop <short>` 杀 bg + 3s wait + 新 SDK `--resume -p` 进程（v2.3.5/v2.3.6 实现）。这导致：

1. **用户场景 `bash loop script`**：Claude 在 bg 跑 `while true; date; sleep 5; done` 等用户回答"继续?"，用户发"继续"后 bg 被永久杀，loop 终止。**用户预期 = bg 继续**，实际 = bg 死。state.json 从 `running` 变 `stopped` 看着像 session 挂了。
2. **资源浪费**：每次 reply 起新 SDK 进程 + 重新读 JSONL context，几秒冷启动。
3. **状态机漂移**：bg 的 `needs` 字段不再更新（bg 死了），Agent View 卡 UI 与 bg 实际状态脱节。

## 2. Goal

**用 Claude CLI 自带的 rendezvous socket 协议直接 inject reply 到正在运行的 bg，bg 不死，loop 继续。**

User-visible 结果：飞书发"继续" → bg 继续跑 → loop 继续 → 下一轮 "是否继续?" 出现在 Agent View 卡上。**和用户坐在终端前的体验一致。**

## 3. Non-Goals

- 不替换 CLI `claude stop` 命令本身
- 不支持 Claude CLI < 2.1.139（无 rendezvousSock 字段；fallback 走老路径）
- 不支持非 bg session 的 reply（前端 chat 走 SDK，不动）
- 不实现 socket 协议版本协商（实测 2.1.163，CLI 升级时 graceful fallback）
- 不做 observability metrics（counter / p50/p95）；spec 留 hook 位，v2 不实现

## 4. Architecture

### 4.1 模块清单

| 模块 | 类型 | 职责 |
|---|---|---|
| `rendezvous-client.ts` | **新** | 封装 rendezvous JSON-RPC 协议 + state patch 流解析 + 完成判定 |
| `rendezvous-fallback.ts` | **新** | 决策是否走 rendezvous（读 state.json + roster.json） |
| `jsonl-last-assistant.ts` | **新** | 读 JSONL 拿最后一条 assistant turn 文本 + usage |
| `bot.ts runChatSDK` | 改 | pre-step 替换 v2.3.5/3.6 的 claude stop 块 |
| `expected-reply-state.ts` | 改 | 注释 + 新 reason enum (`'sent'`) |
| `job-state.ts` | 不变 | 已有 |
| `roster-source.ts` | 不变 | 已有 |
| `jsonl-peek.ts` | 不变 | 已有（继续给 Peek 用） |

### 4.2 数据流

```
[Feishu 用户发"继续"]
   ↓
handleChat (bot.ts:988-994)
   ↓ AgentView expectedReply match
AgentViewManager.handleReply (manager.ts:870)
   ├─ [DEFENSIVE M7] if (!text.trim()) return  // 拒绝空文本
   ↓
   ├─ 1. 入口守卫: checkRendezvousEligibility (复用 handleReplyRequest 已 fetch 的 snapshot)
   │     (注: busy case 通常由 handleReplyRequest 入口 guard 拒绝, 这里是 T0~T1 窗口防御)
   ↓
   ├─ 2. [M1 FIX] expectedReply.markSent(openId)  // T2 立即清, 防止用户连发
   ↓
   ├─ 3. pre-step in runChatSDK:
   │   ├─ if canUse:
   │   │   ├─ RendezvousClient.injectReply({short, text, timeoutMs: 60_000})
   │   │   │   ├─ connect(rendezvousSock)
   │   │   │   ├─ write {"type":"reply","text":"继续"}\n
   │   │   │   ├─ listen state patches
   │   │   │   ├─ 完成判定: state=done OR tempo=blocked+needs OR tempo=idle OR state=stopped
   │   │   │   ├─ on completion: readLastAssistantTurn(linkScanPath, fallback: roster.launch.sessionId)
   │   │   │   └─ return {ok, text, tokens, durationMs, reason}
   │   │   │
   │   │   ├─ if result.ok:
   │   │   │   ├─ replyAndFinalize(msg, text_with_stats)  // [M2] 显示响应 + token stats
   │   │   │   └─ (若 readLastAssistantTurn 失败 → text 用 patch.detail 兜底)
   │   │   │
   │   │   └─ if !result.ok (no fallback possible, bg 已在处理):
   │   │       ├─ log error
   │   │       ├─ replyFn(`处理失败: ${reason}`)
   │   │       ├─ spoolQueue.markReplied
   │   │       └─ spoolQueue.markDone (不 leak)
   │   │
   │   └─ else (canUse=false):
   │       └─ 旧路径: claude stop + 3s wait + SDK --resume -p <text>
   │           (v2.3.5/3.6 行为, 一字不改)
   ↓
   ├─ 4. finally: expectedReply.clear(openId, 'completed')  // [M1] 兜底, idempotent
   ↓
[5min timeout 期间用户又发文本]:
   ↓
   handleChat → expectedReply.get → null (T2 已清)
   ↓
   走普通 chat path (可能 conflict 卡或新 session)
   ↓ [M1 保护] 不会双重 reply
```

**关键修改**：
- **M1**: T2 立即 `markSent()`, finally 兜底。解决双重 reply 风险。
- **M2**: replyAndFinalize 传 `text_with_stats` (response text + token count + duration)。**这是 v2.3.11 → v2.4 的行为变更**：v2.3.11 只发"✅ 已处理"无内容, v2.4 加响应文本。
- **M7**: handleReply 入口 `if (!text.trim()) return`, 防御空文本。
- **M11**: 用户 watching + reply 时, attached watcher 在 handleChat:940 已被 stop; reply 走 rendezvous 正常处理 (与 v2.2 handleBackToChat 一致, 用户已接受)。
- **M5 + 多用户**: per-openId expectedReply, 同一 session 的并发 reply 由 handleReply Step B 守卫拒绝 (bg busy → "已切换到 running, 无法 reply")。

### 4.3 契约

```typescript
// src/agent-view/rendezvous-client.ts

export interface RendezvousReplyOptions {
  short: string;
  text: string;
  /** 物理 socket path, 来自 roster.json:workers[short].rendezvousSock */
  rendezvousSock: string;
  /** 等待 bg 完成的最大时间, default 60_000 */
  timeoutMs?: number;
  /** 每个 state patch 的实时回调, 主要用于日志 */
  onStatePatch?: (patch: StatePatch) => void;
  /** jsonl path, 用于读末次 assistant turn */
  jsonlPath?: string;
}

export type RendezvousCompletionReason =
  | 'done'           // state=done, worker 主动结束 (bg 自己 exit, 正常)
  | 'user_stopped'   // state=stopped, detail 含 'killed' 或外部 stop 信号
  | 'new_needs'      // tempo=blocked + needs 非空, bg 在等下一轮
  | 'idle'           // tempo=idle + 无 needs, bg 完成无新问题
  ;

export type RendezvousFailureReason =
  | 'timeout'              // 60s 内无终态 patch
  | 'socket_closed'        // daemon 断了
  | 'daemon_error'         // daemon 返 {type:'error',...}
  | 'in_flight_timeout'    // tempo=active 持续 60s, inFlight.tasks>0
  | 'state_error'          // patch 含 state='error'
  ;

export interface RendezvousReplyResult {
  ok: boolean;
  reason: RendezvousCompletionReason | RendezvousFailureReason;
  text?: string;            // 最后 assistant 文本 (从 JSONL 拿)
  tokens?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
  durationMs?: number;
  patches?: StatePatch[];   // 收到的全部 patch, 用于调试
}
```

```typescript
// src/agent-view/rendezvous-fallback.ts

export type IneligibleReason =
  | 'bg_busy'            // tempo=active OR running/working 无 needs
  | 'no_rendezvous_sock' // roster 缺该字段 (旧 CLI)
  | 'old_cli'            // cliVersion < 2.1.139
  | 'daemon_down'        // state.json 缺失 OR 物理 sock 不存在
  ;

export interface RendezvousEligibility {
  canUse: boolean;
  reason: 'bg_waiting' | IneligibleReason;
  rendezvousSock?: string;
  jsonlPath?: string;
}

export async function checkRendezvousEligibility(short: string): Promise<RendezvousEligibility>;
```

```typescript
// src/agent-view/jsonl-last-assistant.ts

export interface LastAssistantTurn {
  text: string;            // 提取的 markdown text
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null };
  stopReason: string;      // 'end_turn' 等
  timestamp: string;       // ISO
  uuid: string;            // JSONL turn uuid
}

/**
 * 读 JSONL 末次 assistant turn.
 *
 * jsonlPath: 绝对路径字符串, 可以是:
 *   - state.json.linkScanPath (running/working 时为空, blocked/done 时有值)
 *   - roster.json:workers[short].dispatch.launch.sessionId (.jsonl 全路径, fallback)
 *
 * [M6] linkScanPath 为空时, 调用方应回退到 roster.launch.sessionId (path string,
 *     不是 UUID, 注意 readLastAssistantTurn 直接接 path).
 */
export async function readLastAssistantTurn(jsonlPath: string): Promise<LastAssistantTurn | null>;
```

### 4.4 Rendezvous 协议（实测）

**请求**（client → daemon，单行 JSON + `\n`）：

```json
{"type":"reply","text":"<user text>"}
```

**响应**（daemon → client，多行 NDJSON 风格流）：

```json
{"type":"state","patch":{"tempo":"active","needs":""}}
{"type":"state","patch":{"tempo":"blocked","needs":"是否继续?"}}
{"type":"state","patch":{"tempo":"idle","needs":"","state":"done"}}
```

**完成判定**（任一即视为 reply 处理完）：

| 触发 | RendezvousCompletionReason |
|---|---|
| `patch.state === 'done'` | `done` |
| `patch.state === 'stopped' && patch.detail === 'killed'` | `user_stopped` (S4: 用户/cron 主动 stop) |
| `patch.state === 'stopped' && patch.detail !== 'killed'` | `stopped` (其他 stop, 罕见) |
| `patch.tempo === 'blocked' && patch.needs !== ''` | `new_needs` |
| `patch.tempo === 'idle' && !patch.needs` | `idle` |

**`detail` 字段判断** (M8 配套): state.json 的 `detail` 在不同来源下不同:
- 用户 `claude stop` → detail='killed' (daemon.log: `bg settled X (killed)`)
- bg agent 自己 exit → detail='done' (但这时通常 state=done 走 done 分支)
- 其他 (oom/signal) → detail=string

实测 daemon.log: `[bg] bg settled dcb2ec25 (killed)` 和 `(done)` 两种 termination 来源, 这是 `detail` 字段的真实差异。

**失败判定**：

| 触发 | RendezvousFailureReason |
|---|---|
| 60s 内无终态 patch | `timeout` |
| socket 断开 | `socket_closed` |
| 收到 `{type:'error',...}` | `daemon_error` |
| `tempo === 'active' && inFlight.tasks > 0` 持续 60s | `in_flight_timeout` |
| 收到 `{type:'state', patch:{state:'error'}}` | `state_error` |

## 5. State Machine

### 5.1 Reply 生命周期

```
T0: 用户点 [Reply] (handleReplyRequest 已守 session.status === 'waiting')
    → expectedReply set
    → [Reply prompt] card sent
T1: 用户发文本 "继续"
    → handleChat reply 分支 (bot.ts:988-994)
    → AgentViewManager.handleReply (manager.ts:870)
T1.5 [M7] 防御性: if (!text.trim()) return  // 拒绝空文本
T2 [M1 FIX]: expectedReply.markSent(openId)  // 立即清, 防双重 reply
T3: pre-step in runChatSDK:
    → checkRendezvousEligibility (从 handleReplyRequest snapshot 复用)
    → if canUse: RendezvousClient.injectReply (60s wait)
    → if !canUse: 旧路径 claude stop + SDK --resume
T4: reply 处理完
    → replyAndFinalize(msg, text_with_stats)  // [M2] 显示响应 + tokens
    → markReplied + markDone
T5 [M1 兜底]: finally expectedReply.clear(openId, 'completed')  // idempotent
T6: bg worker 收尾 (几秒到几十秒, watcher 范围内)
T7: bg 完成 (new_needs / done / idle / user_stopped)
    → state.json 更新
    → attached watcher patch Agent View 卡
    → 若 new_needs: 显示新 [Reply] 按钮, 用户可继续
```

**T2 关键**: markSent 必须在 inject 之后 **立即** 调 (T2 阶段), 不能等 T4/T5。v2.3.11 的 finally-clear 实现是 bug, 因为 T0~T4 期间用户能连发第二条。fix 后 T2 立即清, T5 兜底清 (idempotent)。

### 5.2 失败恢复

| 阶段失败 | 恢复方式 |
|---|---|
| T2 前 pre-check 失败 (canUse=false) | fallback → 旧路径, 用户无感 |
| T3 inject 成功但 60s 内无终态 | report `处理超时`, bg 仍在跑 (T6 自然完成会 patch 卡) |
| T3 socket 断开 (daemon 死) | report `daemon 断了`, bg 可能继续 (用户 Peek 看) |
| T3 daemon returns `{type:'error'}` | report `daemon 错误`, bg 状态未明 |
| T4 响应收集失败 (JSONL 找不到新 turn) | success=true, text 用 patch.detail 兜底 |
| T7 user_stopped (用户主动 stop) | success=true, text "bg 已停止", 文案见 §6.2 |

### 5.3 并发 + 多用户 (M5)

**多 openId 同一 session reply**:
- User A 抢先 inject, bg processing (tempo=active)
- User B 后发, handleReply Step B 守卫 re-fetch snapshot → bg is `running`, 报"已切换到 running, 无法 reply"
- 不会双重 inject (daemon 串行化 + 我们的 eligibility 检查)

**单 openId 多次 reply (M1 fix 后)**:
- 第一次 inject 后, T2 立即 markSent
- 第二次文本到达 handleChat, expectedReply.get → null, 走普通 chat (可能被 SDK 拒, 或新 session)

**Watching + reply (M11)**:
- 用户 attached 状态下发文本
- handleChat:940 先 stop attached watcher (用户失去 watch view)
- 接着 expectedReply match → handleReply
- 行为: 用户从"watching"切到"chat + reply", 收 watch 卡消失, 收 [Reply prompt] 卡, 收响应卡
- UX 退步但可接受 (与 v2.2 handleBackToChat 一致)

## 6. Error Handling

### 6.1 Fallback 决策矩阵

| 阶段 | 错误 | 决策 |
|---|---|---|
| **pre-flight** | roster 缺 short | fallback → SDK |
| | roster 缺 `rendezvousSock` | fallback → SDK |
| | `cliVersion < 2.1.139` (semver 比较, [M9]) | fallback → SDK |
| | state.json 不存在 | fallback → SDK |
| | bg busy (tempo=active / running 无 needs) | fallback → SDK |
| | **[S2 注释]** busy case 实际由 handleReplyRequest 入口 guard 拒绝, 这里是 T0~T1 窗口防御 (用户慢打, bg 状态变化) |
| **connect** | socket 文件不存在 | fallback → SDK |
| | ECONNREFUSED / EACCES / timeout(5s) | fallback → SDK |
| **send** | write EPIPE / ECONNRESET | fallback → SDK |
| | daemon 5s 内无回包 | fallback → SDK |
| | daemon 返 `{type:'error'}` | fallback → SDK |
| **wait** | 60s 内无终态 | report (no fallback) |
| | socket 断开 | report (no fallback) |
| | patch `state: 'error'` | report (no fallback) |
| **response collect** | JSONL 缺失/撕裂/无新 turn | report success 但 text 用 patch.detail fallback |
| **post-reply** | replyFn 网络挂 | 抛 ReplyDeliveryPendingError, SpoolQueue 退避重试 |
| | markReplied/markDone 失败 | log error, best-effort |

### 6.2 用户面文案

| 场景 | 文案 |
|---|---|
| 成功 (有响应) **[M2]** | `✅ Claude 已处理完你的消息。\n\n{text}\n\n{41.7K tokens · 70s · 1 轮数}` |
| 成功 (无文本可读) | `✅ bg 已处理完毕（未生成文本响应）。在 Agent View 点 Peek 查看完整输出。` |
| 成功 (bg user_stopped) **[S4]** | `✅ bg 已停止。{若有 text: text + token stats; 若无: (无新响应, Peek 看完整输出)}` |
| 超时 | `⏱ bg 处理超时（60s 内未完成），已停止等待。bg 可能仍在后台运行。` |
| daemon 死 | `⚠️ Claude daemon 已停止，无法处理 reply。请联系管理员重启 daemon。` |
| 旧 CLI / bg busy | 用户无感（静默 fallback 走老路径） |
| 空文本 **[M7]** | (无回复, 直接 return, 不影响 user) |

### 6.3 日志

```typescript
logger.info(`rendezvous: inject short=${short} text_len=${text.length} reason=bg_waiting`);
logger.info(`rendezvous: connected rendezvousSock=${rendezvousSock}`);
logger.debug(`rendezvous: patch ${JSON.stringify(patch)}`);
logger.info(`rendezvous: bg completed reason=${reason} duration=${durationMs}ms tokens_out=${tokens?.output}`);
logger.warn(`rendezvous: fallback to SDK because ${eligibility.reason}`);
logger.error(`rendezvous: inject failed mid-flight reason=${result.reason} (no fallback possible)`);
```

## 7. Testing Strategy

### 7.1 单元测试（核心，约 25 个 case）

**`tests/unit/agent-view/rendezvous-client.test.ts`**（新）

用 `net.createServer` 起真 Unix socket server 模拟 daemon：

- sends single line JSON
- parses tempo=active patch
- completes on state=done
- completes on tempo=blocked+needs
- completes on tempo=idle
- completes on state=stopped
- timeouts after 60s (用短 timeout 加速)
- socket disconnect mid-wait
- daemon returns error JSON
- passes onStatePatch callback
- cleans up socket on done
- cleans up socket on timeout
- **[M10]** destroys socket on all paths (done/timeout/error/disconnect)
- handles long text (>10KB)
- handles unicode text
- **[S4]** distinguishes user_stopped (detail='killed') vs other stopped (detail≠'killed')

**`tests/unit/agent-view/rendezvous-fallback.test.ts`**（新）

Mock roster.json + state.json 在 temp dir：

- bg waiting → rendezvous (canUse=true)
- bg busy → fallback (bg_busy)
- bg working without needs → fallback
- no roster entry → fallback (no_rendezvous_sock)
- rendezvousSock missing → fallback
- old CLI version → fallback (old_cli)
- daemon not running (sock gone) → fallback (daemon_down)
- state.json missing → fallback
- read state fails → fallback

**`tests/unit/agent-view/jsonl-last-assistant.test.ts`**（新）

- extracts last assistant text
- extracts usage tokens
- skips user/tool/system turns
- handles empty file
- handles last line incomplete
- handles missing linkScanPath
- handles content as array of blocks
- **[M6]** falls back to roster.launch.sessionId when linkScanPath null
- **[M6]** handles non-existent path (returns null)

### 7.2 集成测试

**`tests/integration/agent-view-rendezvous.test.ts`**（新）

`describe.skip` if daemon / provider 不可用，CI 友好：

- inject reply updates state.json (running → done)
- state patch stream fires (≥2 patches)
- last assistant turn has reply text
- timing: bg round-trip < 30s

### 7.3 回归测试

**`tests/unit/feishu/bot-command.test.ts`** 加：

- `/agents 路径在 rendezvous 失败时仍走老 SDK 路径`
- `runChatSDK fromAgentViewReply=true 触发 rendezvous pre-step`

**`tests/unit/agent-view/expected-reply-state.test.ts`** 加 **[M1]**：

- `markSent 立即清 in-memory 和 user-mapping`
- `concurrent reply 保护: markSent 后 expectedReply.get → null`

**`tests/integration/feishu-concurrent-commands.test.ts`** 加：

- `concurrent replies on same session` (expectedReply CAS 保护)

### 7.4 人工 E2E

`docs/qa/v2.4-agent-view-rendezvous.md`（新）

5 个场景：

1. waiting 场景（bash loop 类）
2. busy 场景（npm install）
3. 多次 reply 循环
4. Stop 中断
5. daemon 重启

## 8. Migration / Rollout

### 8.1 Feature flag

**config.toml**:
```toml
[agent_view]
# Phase 1: default false (待 PR 4 才翻)
# Phase 2: default true (PR 4 之后)
rendezvous_enabled = false
rendezvous_timeout_ms = 60000
```

### 8.2 Rollout steps

1. PR 1: 新模块 + 单测（**不接入 runChatSDK**, `rendezvous_enabled` 不存在)
2. PR 2: 接入 runChatSDK pre-step，加 `rendezvous_enabled` flag（**default false**）
3. PR 3: 本地 manual E2E 验证 (把 flag 临时翻 true 跑)
4. PR 4: flip default to `true`（grep -c fallback 占比监控一周）
5. PR 5: fallback 占比 < 30% 可视为稳定

### 8.3 Rollback

- 改 config.toml `rendezvous_enabled = false` 即时回滚到 v2.3.5/3.6 行为
- 无需代码 revert

## 9. Open Questions / Future Work

- 协议版本协商（实测 2.1.163，未来 CLI 升级兼容）
- `linkScanOffset` 利用：从 offset 之后读 JSONL，避免重读已处理的 turn
- observability metrics（counter, p50/p95）
- 跨平台 socket 路径（macOS only 与现有约束一致）
- SendMessage tool 路径（2.1.166+）用于跨 session 消息，spec 不覆盖

## 10. References

- **Review 报告**: `docs/superpowers/specs/2026-06-11-rendezvous-reply-design-review.md`
- 实证探针（PR 1 实施时合并到本目录）：
  - `docs/qa/2026-06-11-rendezvous-probe-notes.md` 记录 6 次探针（rv socket 协议 / 完整 state cycle / JSONL 末次 turn 验证）
- 现有 v2.3.5/v2.3.6 改动：`src/feishu/bot.ts:1473-1526`（pre-step claude stop 块）
- 现有 handleReply 路径：`src/agent-view/manager.ts:870-938`（含 Step B 守卫, try/finally clear, generic "已处理" 文案）
- 现有 handleReplyRequest 路径：`src/agent-view/manager.ts:798-856`（Step A, 三重守卫, expectedReply.set）
- 现有 expectedReply 状态机：`src/agent-view/expected-reply-state.ts`（CAS 写入, 5min timeout, restore on bot startup）
- 现有 state.json 读取：`src/agent-view/job-state.ts`
- 现有 roster.json 读取：`src/agent-view/roster-source.ts`
- existing jsonl peek：`src/agent-view/jsonl-peek.ts`
- 现有 replyAndFinalize 路径：`src/feishu/bot.ts:2530`
- 现有 handleChat reply 分支：`src/feishu/bot.ts:988-1001`（handleReply + markReplied + markDone）
- 现有 handleChat attached watcher stop：`src/feishu/bot.ts:940-942`
