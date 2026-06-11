# Agent View Reply: Rendezvous Socket 改造

**Status:** Draft
**Date:** 2026-06-11
**Author:** Claude (cc-linker)
**Target version:** v2.4.0
**Supersedes:** v2.3.5/v2.3.6 auto-stop-bg approach

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
handleChat (bot.ts:983)
   ↓ AgentView expectedReply match
AgentViewManager.handleReply
   ↓
runChatSDK({ fromAgentViewReply: true, ... })
   ↓
pre-step (新逻辑):
   ├─ checkRendezvousEligibility(short)
   │   ├─ 读 state.json
   │   ├─ 读 roster.json
   │   ├─ 检测 cliVersion >= 2.1.139
   │   └─ 检测 rendezvousSock 物理存在
   │
   ├─ if canUse:
   │   ├─ RendezvousClient.injectReply({short, text, timeoutMs: 60_000})
   │   │   ├─ connect(rendezvousSock)
   │   │   ├─ write {"type":"reply","text":"继续"}\n
   │   │   ├─ listen state patches
   │   │   ├─ 完成判定: state=done OR tempo=blocked+needs OR tempo=idle OR state=stopped
   │   │   ├─ on completion: readLastAssistantTurn(linkScanPath)
   │   │   └─ return {ok, text, tokens, durationMs, reason}
   │   │
   │   ├─ if result.ok:
   │   │   ├─ replyAndFinalize(msg, text)  // 复用 v2.3.11 路径, 内含 replyTo + markReplied + markDone
   │   │   └─ (若 readLastAssistantTurn 失败 → text 用 patch.detail 兜底, 仍调 replyAndFinalize)
   │   │
   │   └─ if !result.ok (no fallback possible, bg 已在处理):
   │       ├─ log error
   │       ├─ replyFn(`处理失败: ${reason}`)
   │       ├─ spoolQueue.markReplied
   │       └─ spoolQueue.markDone (关键: 不 leak)
   │
   └─ else (canUse=false):
       └─ 旧路径: claude stop + 3s wait + SDK --resume -p <text>
           (v2.3.5/3.6 行为, 一字不改)
```

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
  | 'done'           // state=done, worker 主动结束
  | 'stopped'        // state=stopped, 被 stop
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
| `patch.state === 'stopped'` | `stopped` |
| `patch.tempo === 'blocked' && patch.needs !== ''` | `new_needs` |
| `patch.tempo === 'idle' && !patch.needs` | `idle` |

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
T0: 用户点 [Reply]
    → expectedReply set
    → [Reply prompt] card sent
T1: 用户发文本 "继续"
    → handleChat reply 分支
    → AgentViewManager.handleReply
    → runChatSDK({fromAgentViewReply: true})
T2: pre-step 完成 (reply 已 inject rendezvous / 走 SDK)
    → expectedReply CLEARED (reason: 'sent')
    → reply 已发, 走 replyTo → markReplied → markDone
T3: bg worker 处理 reply (几秒到几十秒, 在 attached watcher 范围内)
T4: bg 完成 (new_needs / done / idle / stopped)
    → state.json 更新
    → attached watcher patch Agent View 卡
    → 若 new_needs: 显示新 [Reply] 按钮, 用户可继续
```

### 5.2 失败恢复

| 阶段失败 | 恢复方式 |
|---|---|
| T2 前 pre-check 失败 | fallback → 旧路径, 用户无感 |
| T2 后 inject 失败 | report error, markReplied+markDone 兜底（不 leak spool 锁） |
| T4 响应收集失败 | reply "已处理（无 detail）", 用户 Peek 看完整输出 |
| daemon 中途死 | 报"daemon 断了" |

## 6. Error Handling

### 6.1 Fallback 决策矩阵

| 阶段 | 错误 | 决策 |
|---|---|---|
| **pre-flight** | roster 缺 short | fallback → SDK |
| | roster 缺 `rendezvousSock` | fallback → SDK |
| | `cliVersion < 2.1.139` | fallback → SDK |
| | state.json 不存在 | fallback → SDK |
| | bg busy (tempo=active / running 无 needs) | fallback → SDK |
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
| 成功 (有响应) | `✅ Claude 已处理完你的消息。\n\n{text}\n\n{41.7K tokens · 70s · 1 轮数}` |
| 成功 (无文本可读) | `✅ bg 已处理完毕（未生成文本响应）。在 Agent View 点 Peek 查看完整输出。` |
| 超时 | `⏱ bg 处理超时（60s 内未完成），已停止等待。bg 可能仍在后台运行。` |
| daemon 死 | `⚠️ Claude daemon 已停止，无法处理 reply。请联系管理员重启 daemon。` |
| 旧 CLI / bg busy | 用户无感（静默 fallback 走老路径） |

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
- handles long text (>10KB)
- handles unicode text

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

- 实证探针（PR 1 实施时合并到本目录）：
  - `docs/qa/2026-06-11-rendezvous-probe-notes.md` 记录 6 次探针（rv socket 协议 / 完整 state cycle / JSONL 末次 turn 验证）
- 现有 v2.3.5/v2.3.6 改动：`src/feishu/bot.ts:1473-1526`（pre-step claude stop 块）
- 现有 state.json 读取：`src/agent-view/job-state.ts`
- 现有 roster.json 读取：`src/agent-view/roster-source.ts`
- existing jsonl peek：`src/agent-view/jsonl-peek.ts`
- 现有 replyAndFinalize 路径：`src/feishu/bot.ts:2530`
