# Review Engine v2.1.1 — 附录

> 属于 [overview.md](./overview.md) 的下游文件。

## 附录 A：`claude --bg` 实测行为（2026-06-14）

**环境**：Claude CLI 2.1.163 on macOS 24.6.0

| 测试 | 命令 | 结果 |
|------|------|------|
| Spawn bg session | `claude --bg "say hi"` | ✅ 返回 `backgrounded · 3f219846`，落到 `~/.claude/jobs/3f219846/state.json` |
| Spawn with provider | `claude --bg "..." --settings ~/.claude/providers/kimi-for-coding.json` | ✅ state.json `respawnFlags` 记录 settings 路径 |
| 并发 spawn | 3 个连续 `claude --bg` | ✅ 3 个独立 shortId 同时跑 |
| Status 读 | `cat ~/.claude/jobs/<short>/state.json` | ✅ 含 `state` `tempo` `detail` `needs` `output` `sessionId` 等 |
| Stop | `claude stop 3f219846` | ✅ state.json state 立即变 `stopped` |
| Logs | `claude logs 3f219846` | ✅ 返回 markdown 输出 |
| Resume (直接) | `claude --resume <running-short>` | ❌ 报错："is currently running as a background agent" |
| Resume (via bg+reply-on-resume) | `claude --bg "..." --resume <sessionId> --reply-on-resume` | ✅ 新 shortId，sessionId 不变 |

**结论**：`claude --bg` + `--settings` + `--resume --reply-on-resume` + `stop` + `logs` + `state.json` 全链路可用。直接 `--resume` 在 running bg 上不可用，必须用 daemon rendezvous 协议。

> **v2.1.5 P3-2 注：本节 stale，已被附录 A.1 H7（2026-07-12 实测 `output: { result: string }` 无 cost_usd）覆盖，保留作追溯**
>
> **v2.1.2 修正（P1-10）：`state.json.output` 格式待实测确认**
>
> §7.5.1 声称 `state.json.output` 是 `{ result: string }` 对象，但 Claude CLI 不同版本的 output 格式可能不同：
> - 可能是 `{ result: string }`
> - 可能是纯 `string`
> - 可能还包含 `cost_usd` / `session_id` 等字段
>
> **实施前必须实测**（Phase 1 W1）：
> 1. 跑一个 `claude --bg "say hi"` → 等 done → `cat ~/.claude/jobs/<short>/state.json`
> 2. 检查 `output` 字段的实际类型和内容
> 3. 确认 `cost_usd` 是否内嵌在 output 中还是在 state.json 的顶层字段
> 4. 将实测结果追加到本附录表格
>
> 如格式与预期不符，需同步修改 §7.5.1 的 `ExtendedJobStateFile` 类型声明和 `parseBgOutputWithRetry` 的 JSON 提取策略。

### 附录 A.1：Claude CLI 2.1.207 实测硬约束（2026-07-12，v2.1.3）

> 本节为 v2.1.3 实施前的端到端实测结论，是 adapter/engine 设计的硬约束（实测环境：Claude CLI 2.1.207 on macOS 24.6.0，providers：minimax-m2.7 / byte-agent-glm-new / glm-5.2）。

| # | 实测项 | 命令/操作 | 结果 | 设计约束 |
|---|---|---|---|---|
| H1 | **bg 默认建隔离 worktree** -- v2.1.5 实测证伪 | `claude --bg "fix bug" --settings <p>` 在干净 git repo（无 CLAUDE.md/hook） | **不建 worktree**：worktree list 只有主目录、无 .claude/worktrees、state.json.cwd=主 cwd、改动落主 cwd（2026-07-12 隔离实测） | worktree 由显式 `--worktree` flag 触发，不传即不建；v2.1.3 H1 是特定环境（cc-linker+superpowers 插件）误判 |
| H2 | **`--bare` 禁 worktree** -- v2.1.5 修正因果 | `claude --bg --bare "fix bug" --settings <p>` | --bare 真实语义（claude --help）：skip hooks/LSP/plugin sync/CLAUDE.md auto-discovery；与 worktree 无关 | adapter **不传 --bare**（保留 CLAUDE.md/hook/LSP），不传 --worktree 即不建 worktree；详见 §3.2.1 |
| H3 | **`--cwd` 不可用** | `claude --bg "..." --cwd /path` | `state=failed`，`detail: "exit 1 before init - error: unknown option '--cwd'"` | cwd 由 `Bun.spawn({cwd})` 控制，不传 `--cwd` |
| H4 | **模型由 settings 决定** | `claude --bg "..." --settings glm-5.2.json`（不传 --model） | `respawnFlags` 自动含 `--model glm-5.2[1m]`（CLI 从 settings 解析） | engine 只传 `--settings`，不传 `--model` |
| H5 | **providerEnv 不可信** | 读 `state.json.providerEnv.ANTHROPIC_MODEL` | 显示 `MiniMax-M3[1m]`（base env 占位），与实际跑的 `glm-5.2` 不符 | 模型名从 `respawnFlags` 的 `--model` 取，不从 providerEnv |
| H6 | **无 cost_usd** | cat done state.json | 顶层无 `cost_usd`，`output.result` 是纯文本回复，仅有粗 `tokens` 总数 | 删成本统计（无可靠来源）；`max_cost_usd` 护栏不可行 |
| H7 | **`output.result` = 模型回复** | cat done state.json | `output: { result: "HELLO WORLD" }`（纯文本，含 review 输出的 JSON） | §7.5.2 `extractJsonBlock` 从 result 末尾取 JSON 成立 |
| H8 | **429 走 blocked**（v2.1.6：不再进 PAUSED，一律 ABORTED） | glm-5.2 spawn 后限流 | `state=blocked`，`needs: "rate limited - wait and retry · API Error 429 · ...重置时间"` | v2.1.6 简化：blocked 一律 ABORTED unexpected_blocked，429 由 claude code 自身重试，长 blocked 才 abort；删 PAUSED 态 + reconciler 唤醒 + liveness |
| H9 | **worktree 被 locked** | 清理 v2.1.3 实测残留 worktree | `git worktree remove` 报 "locked: claude session"；需 `git worktree unlock` 再 remove | v2.1.5：不传 `--worktree` 规避（根本不建）；H9 残留是 v2.1.3 误用 --worktree 产生 |
| H10 | **injectReply 无过滤** | `RendezvousClient.injectReply({text})` | `{type:'reply', text}` 原样发 daemon，无转义/长度限制 | review/work 任意 prompt 注入可行；v2.1.5 P1-1：review engine 改用 resumeWorkSession，injectReply 退场，此条仅作 daemon 协议实测留存 |

### 附录 A.2：v2.1.3 未实测/待标注事项（2026-07-12）

| # | 事项 | 实测需求 | Phase 1 处理 |
|---|---|---|---|
| **P1-4** | blocked bg session 生命周期：429 限流时 bg 进入 blocked，daemon 是否会在挂起几小时后主动清理（gc）？ | **2026-07-12 已实测（5分41秒观察，短窗口但信号清晰）**：spawn glm-5.2 bg 触发 429 → state.json 持续 "blocked"，bg 进程（claude bg-spare / claude bg-pty-host）持续存活，daemon roster 重启后重新 attach；daemon 5s idle 自己退出但 bg 不死。**结论**：daemon 不主动 gc blocked bg，bg 状态冻结在 state.json 等待新输入（解限额后通过 daemon injectReply 唤醒（注：review engine v2.1.5 PAUSED 唤醒不用 injectReply，用 poll state.json））。5 分钟不能 100% 证明 24h，但 POSIX 通常不杀长 idle 子进程；如真出现死 bg，P0-4 兜底 → PANE_LOST。**v2.1.5 P0-2 已修正**：liveness 改读 `~/.claude/daemon/roster.json` 的 `workers[<shortId>]` 查 pid（`kill -0`）+ `supervisorPid`（daemon 活着）。实测 state.json 无 pid 字段，v2.1.4 设计的"spawn 时记录 OS pid + kill -0"不成立（spawn pid 是 launcher、backgrounding 后退出）→ 每次唤醒误转 PANE_LOST。复用 readRoster()（src/agent-view/roster-source.ts）。 |
| **P1-7** | URL 输入支持（`cc-linker review run https://...`） | cat 无效，模型需 webfetch（实测未做） | **Phase 1 不支持**：doctor 检测 `task` 含 `http://`/`https://` → 报错 "URL 输入留 Phase 3，请用本地路径或 git ref" |
| **P2-5** | cwd 内 `.claude/providers/*.json` 是否被 review engine 读取 | 当前实现走 `providerManager.resolve()` 只查 `~/.claude/providers/` | Phase 1 不支持 cwd 内 providers；如需支持，把 `ProviderManager.scan()` 加 cwd 路径（未来可考虑） |
| **P2-6** | 6+ bg session 并发实测（3 pipeline × 2 pane） | 当前实测只验过 3 并发 | Phase 1 默认 `max_concurrent_pipelines = 1`，并发压力测试留 Phase 2 飞书集成前做 |

**实测残留清理**：实测产生 6 个 bg session（d5c01dd1/2025e5ff/b26ea912/b4c50366/79145be5/8b16bf27）+ 2 个 worktree（review-fix/fix-add-bug），均已 `claude stop` + `git worktree unlock && remove` + `git branch -D` 清理。
>
> **v2.1.5 P3-4 实测注意**：`claude --bg --help` 不是合法用法（--bg 会吞掉 --help，直接 spawn 一个 idle bg session 留垃圾）。doctor 自检 / 测试套件若要验证 CLI 版本，用 `claude --version` 或 `claude --help`（不带 --bg）。

## 附录 B：复用的 Agent View 模块清单

| 模块 | 路径 | 复用方式 |
|------|------|---------|
| `readJobState` | `src/agent-view/job-state.ts` | adapter / engine / cli-watch 全调 |
| ~~`RendezvousClient.injectReply`~~ | ~~`src/agent-view/rendezvous-client.ts`~~ | v2.1.5 P1-1 移除：FIXING 改 resumeWorkSession，review engine 不再复用 injectReply |
| `resolvePeekContent` | `src/agent-view/manager.ts` | cli-watch pane 详情（4 级降级） |
| `AgentSnapshotFetcher.fetch` | `src/agent-view/snapshot-fetcher.ts` | cli-watch 列表 |
| `VersionGuard.check` | `src/agent-view/version-guard.ts` | doctor 校验 CLI 版本 |
| `DaemonProbe.check` | `src/agent-view/daemon-probe.ts` | doctor 校验 daemon 健康 |
| `CLAUDE_JOBS_DIR` | `src/utils/paths.ts` | adapter / cli-watch |
| ~~`readRoster`~~ | ~~`src/agent-view/roster-source.ts`~~ | v2.1.6 移除：PAUSED 态删除，reconciler 不再做 liveness，不再读 roster |

> **v2.1.3 移除**：`readLastAssistantTurn`（原被 `adapter.getContextUsage` 消费，getContextUsage 随 cascade 删除后不再需要——成本统计已随 cascade 整组移除）。

## 附录 C：v2.1 → v2.1.1 变更背景（动机 + 决策 + 章节索引）

> 本附录保留"为什么这么改 + 关键决策"。实现细节请直接看主文对应章节。

### C.1 变更 1：单一 Review 模型

**动机**：多 review 并行带来 5 类复杂度（并发写冲突 / JUDGE 权重难定 / PANE_LOST 复杂 / 成本翻倍 / ratio 不直观）。

**决策**：限定为 1+1（work + 1 review）。

**实现**：见 [implementation.md §6.1](./implementation.md#61-pipelinerecord-数据结构) PaneRegistry.review 单数、[state-machine.md §5.1](./state-machine.md#51-reviewstate-枚举) EXTERNAL_REVIEW 单数。

### C.2 变更 2：commit 前置指令

**动机**：FIXING 在 cwd 修改源文件，verify-first 不保证 100% 无错。需要回滚锚点。

**决策**：FIXING 启动前 git commit → checkpoint SHA。

**实现**：见 [implementation.md §7.2.1](./implementation.md#721-engine-checkpoint-边界-case)（v2.1.3：preamble 已删，checkpoint 改由 engine 在阶段切换前自己打）。

### C.3 变更 3：JSON parse 失败不静默

**动机**：v2.1 "parse 失败视为 0 issues" 是最危险的失败模式（静默 false positive）。

**决策**：retry 1 次 → 仍失败 → parse_degraded + 排除。

**实现**：见 [implementation.md §7.5.4](./implementation.md#754-parse-失败处理)。

### C.4 变更 4：Context Window 策略（I9 重设计 + v2.1.2 cascade 演进）

**v2.1.1 动机**：原始 `review_fix` 策略质量差（review 模型不理解 work 代码上下文）。

**v2.1.1 I9 重设计**：删 review_fix。reset = 杀 work + spawn 新 work + 注入 review issues + history + docs → worker verify+fix → DONE。

**3 个不变量**：work 仍是唯一修复者 / context fresh + issue 记忆保留 / verify-first 不变。

**v2.1.2 cascade 演进动机**（2026-06-19）：
- 现状 reset 直接杀 session 太重 —— 浪费 worker 已建立的代码库"肌肉记忆"
- 现状 abort 太激进 —— context 80% 没用满就放弃
- 应该先试 `/compact`（Claude CLI 原生命令），不行再 reset，再不行才 abort

**v2.1.2 三档 cascade**：
1. **compact**（n=1，1st overflow）：injectReply `/compact` → 同 session 继续
2. **reset**（n=2 或 compact 失败）：杀 session + spawn 新 + 注入 context
3. **abort**（n>maxCompact+1，默认 n≥3）：reason=`context_overflow_max_attempts`

**配套改进**：
- 阈值规则修 bug（v2.1.1 对 128K 模型**永不会触发** overflow 检查；200K 模型只在 100% 才触发）
- 新增 review opinions 落盘（worker 用 @file 引用，避免 prompt 膨胀）

**v2.1.3 反转 I9（2026-07-12）**：用户决定进一步简化——删 JUDGE_BY_WORK，让 review 模型在 EXTERNAL_REVIEW 内**既审又修**（识别→确认→直接修复→verify，单 bg turn），等于复活了 v2.1.1 删掉的 `review_fix`。但与原 `review_fix` 的关键差异：跨模型校验靠"review 修完 → work postfix R1 复查 review 改动"闭环保留（work 仍是复查者，只是不再做 accept/reject 裁决门）。同时删 HUMAN_DECIDE（JUDGE reject 分支的兜底，无 JUDGE 即无存在理由）+ 删 context cascade（裸奔，靠 max_rounds + max_cost_usd 兜底）。决策详见 §C.8。

**实现**：见 [implementation.md §7.5.7](./implementation.md#757-context-window-策略化处理)（v2.1.3 已整组删除）、[§7.5.8](./implementation.md#758-review-opinions-落盘v212-新增)（v2.1.3 已整组删除）。

### C.5 变更 5：`adapter.getContextUsage` API

**动机**：C.4 需要 engine 查 work session context 用量。

**实现**：见 [overview.md §3.2](./overview.md#32-新建层15-个模块) adapter.ts 说明。

> **v2.1.3 移除**：`getContextUsage` 随 context cascade 整组删除（见 §C.8）。adapter 从 6 API（v2.1 含 getContextUsage）缩为 5 API（startSession / resumeWorkSession / injectReply / poll / stop）。成本提取改由 `adapter.poll()` 在 state=done 时直接从 `state.json.output.cost_usd` 解析，不依赖 `getContextUsage`。
>
> **v2.1.4 补**：adapter 加 `isBgAlive(pid)` API（5 → 6 API），用于 P0-4 reconciler PAUSED 唤醒时 `kill -0` 验证 bg 进程活着（详见附录 A.2 P1-4 实测）。（v2.1.5 P0-2：liveness 改读 roster.json，不再 kill -0 spawn pid；P1-1 删 injectReply，adapter 6 -> 5 API：startSession / resumeWorkSession / poll / stop / isBgAlive）

### C.6 完整决策链

| 时点 | 决策 |
|---|---|
| 2026-06-06 | v1：13 个新模块全栈自建 |
| 2026-06-13 | v2：复用 Agent View，新建 7 个模块 |
| 2026-06-14 | v2.1：19 项修正 + 10 项评审修正 |
| 2026-06-15 | v2.1.1：6 项 patch |
| 2026-06-17 | 评审反馈 7 P0 + 11 P1 + I9 重设计 |
| 2026-06-19 | v2.1.2：I9 三档 cascade（compact → reset → abort）+ review opinions 落盘 + 阈值规则修 bug |
| 2026-07-12 | v2.1.3：删 JUDGE_BY_WORK（review 既审又修，反转 I9）+ 删 HUMAN_DECIDE + 删 context cascade（裸奔）+ 无论如何都跑一轮外审 + 统一 clean 标准 |

### C.7 v2.1.2 变更动机 + 决策（本轮）

> **v2.1.3 注**：本节记录 v2.1.2 的 context cascade + review opinions 落盘决策，**两者均在 v2.1.3 被移除**（见 §C.8）。保留本节作为决策追溯，不代表当前设计。

#### C.7.1 变更动机

用户提出 3 个问题（2026-06-19 review）：

| # | 问题 | 用户原话 |
|---|------|---------|
| Q1 | EXTERNAL_REVIEW 后 context 超阈值，直接 abort 太激进 | "不应该直接abort吧，是不是应该把 worker '/compact' 下，然后再在 work 继续处理" |
| Q2 | review opinions 是否写到文件供 worker 引用 | "external review的review意见是否可以直接写到文件中，这样worker再进行继续fix时，可以更方便获得review意见" |
| Q3 | context 检测规则是否正确 | "请你也确认下目前的 context 上下的文判断规则，看看是否合理正确" |

#### C.7.2 决策

| Q | 决策 | 理由 |
|---|------|------|
| Q1 | **新增 compact 档，三档 cascade** | `/compact` 是 Claude CLI 原生，轻量（~1s）；比 reset 保留 worker 代码肌肉记忆；cascade 内 compact 失败自动升级 reset，不留悬挂 |
| Q2 | **写文件（json + md 两份）** | prompt 膨胀问题（>10 条 issues 时 inline JSON 可达 30K tokens）；worker 可 `@file` 精确定位；Reconciler 跨崩溃恢复直接读到；落盘失败可降级 inline |
| Q3 | **百分比 + 1M 特殊处理，修 128K/200K 模型 bug** | v2.1.1 绝对值阈值在 128K 模型上 `max < threshold` → 永不会触发；200K 模型只在 100% 才触发（太晚）；1M 模型 512K 偏晚（>512K 模型效率下降） |

#### C.7.3 阈值变更明细

| 模型 | max | v2.1.1 threshold | v2.1.2 threshold | 改动 |
|------|-----|-----------------|------------------|------|
| `MiniMax-M3` | 1M | 512K | 460K | 提前 52K |
| `claude-sonnet-4-5` | 1M | 512K | 460K | 提前 52K |
| `claude-sonnet-4` | 200K | 200K (100%) | 160K (80%) | 提前 40K |
| `kimi-for-coding` | 256K | 200K (78%) | 204K (80%) | 略晚 4K |
| `bailian-qwen3.6` | 128K | 200K (不可能) | 102K (80%) | **修 bug** |

#### C.7.4 配置变更

```diff
- context_overflow_threshold_1m = 512000
- context_overflow_threshold_default = 200000
- context_overflow_strategy = "reset"          # "reset" | "abort"
- context_overflow_hysteresis_rounds = 1
+ context_overflow_threshold_1m = 460000       # 1M 模型阈值（>512K 模型效率下降）
+ context_overflow_threshold_percent = 0.80   # 非 1M 模型：max * 80%
+ context_overflow_strategy = "cascade"        # v2.1.2：唯一策略 = cascade
+ max_compact_attempts = 1                    # compact 档最多尝试次数
+ compact_timeout_ms = 30000                  # /compact 单次超时
```

#### C.7.5 PipelineRecord 字段变更

```diff
  interface PipelineRecord {
    ...
    contextResets?: ContextResetEvent[];
+   /** v2.1.2：context overflow 累计触发次数 */
+   contextOverflowCount?: number;
+   /** v2.1.2：EXTERNAL_REVIEW opinions 落盘路径 */
+   contextFiles?: {
+     externalReviewJson?: string;
+     externalReviewMd?: string;
+   };
  }
```

#### C.7.6 ReviewState enum 变更

> **v2.1.3 注**：本 diff 块记录 v2.1.2 对 enum 的改动。其中 `JUDGE_BY_WORK` / `contextOverflowApplied` / `injectedIssues` / `DONE.contextOverflowApplied` 已在 v2.1.3 全部移除（JUDGE_BY_WORK 删除、cascade 整组移除）。保留此 diff 仅作 v2.1.2 决策追溯。

```diff
  | { kind: 'SELF_REVIEW_R1'; ...;
-     contextReset?: boolean;
+     contextOverflowApplied?: 'reset';   // v2.1.2：从 boolean 升级为枚举
      injectedIssues?: Issue[] }

  | { kind: 'JUDGE_BY_WORK'; ...;
+     contextOverflowApplied?: 'compact' }   // v2.1.2：通过 compact 抵达此状态

  | { kind: 'DONE'; ...;
-     contextOverflowApplied?: 'reset' | 'abort' }
+     contextOverflowApplied?: 'compact' | 'reset' }   // v2.1.2：abort 不进 DONE
```

#### C.7.7 未做的事

> **v2.1.3 注**：本节是 v2.1.2 的"未做"记录。其中"主动保留"第 1 条（KNOWN_CONTEXT_LIMITS 内置表）与第 3 条（HUMAN_DECIDE 4h timeout）已在 v2.1.3 反转——v2.1.3 删了 KNOWN_CONTEXT_LIMITS + 删了 HUMAN_DECIDE。"已知限制"全部随 cascade + 落盘整组移除。

**主动保留（明确不改，v2.1.2 视角）**：
- ❌ 没用 profile 内 `[context_limits]` 改 max 模型表（保留 v2.1.1 的 KNOWN_CONTEXT_LIMITS 内置表）→ **v2.1.3 已删 KNOWN_CONTEXT_LIMITS**
- ❌ 没改 max_rounds 默认值（仍是 code=8 / plan=5 / spec=4 / global=6）
- ❌ 没动 HUMAN_DECIDE 4h timeout（I10 已在 v2.1.1 调到 4h）→ **v2.1.3 已删 HUMAN_DECIDE**
- ❌ 没动 parse_retry_timeout 15s（I11 已在 v2.1.1 调到 15s）

**已知限制 / 未实现（评审需知）**：
- ❌ **FIXING 期间 context 增长检测不到**：cascade 只在 `EXTERNAL_REVIEW.done` 触发。FIXING 期间 worker 自己把 context 从 50% 撑到 90% 不会被检测，要等下个 EXTERNAL_REVIEW 才能 cascade。Phase 3 可能加 FIXING 期间的 periodic usage check（每 30s 调 getContextUsage，超阈值提前结束），但本轮不做。
- ❌ **threshold 没有 per-phase override**：当前阈值只在 `[guards]` 段全局生效。code phase 可能想更激进（60% 提前 cascade），spec phase 想放宽（90%），目前不支持。Phase 3 配置热更新后再考虑加 `[phase_overrides.<phase>] context_overflow_threshold_percent = ...`。
- ❌ **cascade 档位随配置变化**（已在 §7.5.7.1 顶部明确说明）：默认 `max_compact_attempts=1` 是 3 档；配 N 是 N+2 档。配错会行为不符直觉，需谨慎。
- ❌ **写文件失败 → abort 而非 inline fallback**（已在 §7.5.8.7 改）：inline 注入会让 context 二次超限（恶性循环），所以写失败直接 ABORTED reason=review_opinions_write_failed，提示用户排查。
- ❌ **post-compact usage 检查时机 race**：poll done 是等 worker 完成 turn，但 worker 可能 compact 后又自动调 tool（不该发生但理论可能），导致 usage 没降反升。Phase 3 可加 post-compact 强校验。
- ❌ **cascade 升级路径的 n 语义**：compact 失败升级 reset 时 n 仍是 1（不是 2），避免在 1 次 EXTERNAL_REVIEW 内累计 2 次。已在 §7.5.7.1 cascade dispatch 代码隐含。

> **v2.1.3 注**：§C.7.7 列的"已知限制"（FIXING 期间 context 检测 / threshold per-phase / cascade 档位 / 写文件失败 / post-compact race / n 语义）随 context cascade + review opinions 落盘整组移除，不再是当前设计的限制。

### C.8 v2.1.3 变更动机 + 决策（本轮，2026-07-12）

#### C.8.1 用户提出的简化

用户认为 v2.1.2 方案过复杂，提出两点简化（原话摘要）：

| # | 简化 | 原话摘要 |
|---|------|---------|
| S1 | EXTERNAL_REVIEW 后不再 JUDGE_BY_WORK，review 模型完成 review 后直接在 EXTERNAL_REVIEW 内修复，不再来回传递；fix 完成后再重复一轮 review+fix | "复杂 review 的模型完成 review 后…直接在 EXTERNAL_REVIEW 中进行修复，不再来回传递" |
| S2 | 去除 HUMAN_DECIDE；去除复杂的 context OK 判断 | "去除复杂的 HUMAN_DECIDE 处理…去除复杂的 context ok 判断，也不再需要" |

实施前与用户确认了关键分叉（review 发现的问题由谁修），用户选择**路线 A：review 模型自己修 + context check 完全删（裸奔）**。随后用户补充两点：

| # | 补充 | 原话 |
|---|------|------|
| A1 | 无论如何都跑一轮 external review | "无论如何都跑一轮 external review" |
| A2 | clean 标准：无 Critical/High/Medium 需修复的问题 | "判断是否 clean 的标准…要求无 Critical, High, Medium 需要修复的问题" |

#### C.8.2 决策

| 项 | 决策 | 理由 |
|---|------|------|
| S1 | **review 既审又修**（单 bg turn：识别→确认→git preamble→verify-first 修复→输出 JSON）。反转 v2.1.1 I9 的 `review_fix` 删除决策 | 用户优先简化；跨模型校验靠 work postfix 复查闭环保留，不靠 JUDGE 裁决门 |
| S1 配套 | 删 JUDGE_BY_WORK 状态 + `computeVerdict` + `WorkDecision` + `DecisionContext` + `JudgeOutputSchema` + `prompts.work.judge` | JUDGE 的 accept/reject 过滤职责与 FIXING 的 verify-first（real/hallucination 判定）冗余，删之无损 |
| S2a | 删 HUMAN_DECIDE 状态 + `review decide` 子命令 + `human_pending/` 目录 + `human_decide_timeout_ms` 配置 + `human_decision_timeout` reason | HUMAN_DECIDE 是 JUDGE reject 分支的兜底；无 JUDGE 即无 reject 分支，无存在理由 |
| S2b | 删 context-OK 判断 + 三档 cascade（compact/reset/abort）整组 + `getContextUsage` API + 4 个模块（`context-overflow.ts` / `build-context-reset-prompt.ts` / `build-context-compact-prompt.ts` / `review-opinions-writer.ts`）+ 全部 context/cascade 配置 + review opinions 落盘 + @file 引用机制 | 删 JUDGE 后 work 不再做 judge/外审 fix，context 累积速度大幅下降；常规 2-4 轮不会 overflow；主动检测 + cascade 复杂度不再划算。极端情况靠 `max_rounds` + `max_cost_usd` 兜底 |
| A1 | R1 clean / R2 clean 不再 → DONE，一律进 EXTERNAL_REVIEW；DONE 只在 EXTERNAL_REVIEW 收敛时达成 | 用户明确要求"无论如何都跑一轮外审"——self-review 全清时仍需外部模型把关，避免 work 自审盲区 |
| A2 | 统一 clean 标准 `isClean(issues) = 无 P0/P1/P2`，P3 不阻塞（记入报告但不触发新一轮 fix）。用于 R1/R2 clean 判定 + EXTERNAL_REVIEW 收敛判定 | 用户明确"P0/P1/P2 需修才阻塞，P3 可忽略"；统一三处判定避免不一致 |

#### C.8.3 跨模型校验如何保留（关键论证）

反转 I9 后，"work 是唯一修复者"不变量被打破：review 模型现在也改代码。**cross-model 校验通过以下闭环保留**：

```
review 修了 ≥1 个 real P0/P1/P2
  → EXTERNAL_REVIEW → SELF_REVIEW_R1(postfix, round+1)
  → work 复查 review 改的代码（work 是不同模型，构成交叉）
  → work 若发现新 P0/P1/P2 → FIXING → R2 → EXTERNAL_REVIEW → review 再修 → ...
  → 收敛于 EXTERNAL_REVIEW 发现 0 个 real P0/P1/P2 → DONE
```

即：**review 修、work 复查**，两个模型互相挑错直到都满意。原 JUDGE_BY_WORK 的 accept/reject 是"work 单方面裁决 review 意见"，现在改为"work 用 R1 复查 review 的实际代码改动"——更直接、更符合代码评审直觉。受 `max_rounds` 兜底，反复分歧不会无限循环。

#### C.8.4 风险与取舍

| 风险 | 取舍 |
|------|------|
| review 改未写过的代码，fix 质量可能不如 work | 接受：work postfix 复查会兜住 review 的劣质修复；verify-first 在 review 侧也生效 |
| context 裸奔，极端长任务撑爆无主动干预 | 接受：max_rounds 兜底（v2.1.3 删成本统计，无 max_cost_usd）；Phase 3 可重引入轻量 abort（不做 cascade） |
| review 改代码与 work 串行假设 | 状态机保证：work state=done 才进 EXTERNAL_REVIEW，两 pane 串行，不会并发改文件 |
| 删 HUMAN_DECIDE 失去高分歧人工兜底 | 接受：MVP 自动化优先；max_rounds 到顶 ABORTED 后，`review resume` **拒绝**（终态不可逆）；用户需 `cc-linker review run` 重新开始，或手动介入已落到 `aborted/` 的 PipelineRecord 检查历史 checkpoint 手动 rollback |

#### C.8.5 未做的事（第一轮，实测前）

**主动保留**：
- ❌ ~~没改 max_rounds 默认值（仍是 code=8）~~ -> **C.8.6 实测后改为 code=6**
- ❌ 没改 parse_retry_timeout 15s
- ❌ 没动 PANE_LOST（bg session 仍可能死，与本次简化正交）
- ❌ 没改 R1/R2 的触发与结构（只改了 clean 的去向：从 DONE 改为 EXTERNAL_REVIEW）

**Phase 3 可重新引入**：
- context 用量轻量 abort 兜底（单档，不做 cascade）--若实践中确实出现撑爆
- review 修复质量打分 / 人工复核高分歧

#### C.8.6 v2.1.3 实测修正决策（2026-07-12 第二轮，端到端实测后）

> 第一轮（C.8.1-C.8.5）基于纸面分析。本节为用真实 claude 2.1.207 + minimax/glm/byte providers 端到端实测后的修正决策（实测硬约束见附录 A.1）。

**实测发现的问题与修正**：

| # | 实测发现 | 修正决策 | 影响 |
|---|---|---|---|
| F1 | state.json 无 cost_usd，v2.1.3 删的 jsonl usage 路径反而是唯一能用的 | **删成本统计整组**（用户拍板：不需要成本统计）：删 `totalCostUsd`/`costUsd`/`max_cost_usd`/cost 价格表/`budget_exceeded` | §6.1/§7.2/§8/§10 |
| F2 | 429 限额耗尽走 blocked + 重置时间（国产模型常态） | ~~**新增 PAUSED 态**~~（v2.1.6 反转：删 PAUSED，blocked 一律 ABORTED，依赖 claude code 自身重试，详见 C.9） | §5/§6.4/§10 |
| F3 | providerEnv 不可信，模型实际由 settings + respawnFlags 决定 | `parseModelFromRespawnFlags`（从 respawnFlags 的 --model 取），删 `parseModelFromProviderEnv`；engine 只传 `--settings` 不传 `--model` | §3.2.1/§7.4 |
| F4 | blocked 不止"等用户输入"，rate limit/permission 都走 blocked | ~~`BlockedResult{kind}` 三分流~~（v2.1.6 简化：blocked 一律 unexpected -> ABORTED，不区分，详见 C.9） | §4.3/§10 |
| F5 | review 输入 artifact 构造未定义 | **用户提议**：review/work 输入统一用 spec/plan（或 `<task>` 需求文本），模型自己 cat + 自选 `git diff` 范围，engine 不构造 artifact；删 EXTERNAL_REVIEW.cycle | §7.2 prompts |
| F-WT | bg 默认建隔离 worktree，主 cwd 不被改动 | **v2.1.5 P0-3 反转**：不传 `--worktree`（--bare 禁 worktree 是误判，已修正），work/review 直接在原开发分支改；~~engine 打 git checkpoint~~（v2.1.6 删 checkpoint，详见 C.9） | §2.2/§7.2/§10 |
| F-CWD | `--cwd` 不可用（exit 1） | cwd 由 `Bun.spawn({cwd})` 控制 | §3.2.1 |
| F7 | 模型 git commit 行为不可控（自建分支/worktree、message 乱） | **checkpoint 改由 engine 打**（阶段切换前 engine 跑 git commit），模型不碰 git；删 preamble；ReviewFixOutput 删 checkpointSha | §7.2/§7.2.1/§7.5.3 |
| F8 | "0 行重复代码"误导（src 零 `--bg` spawn 先例） | G6 改为"复用状态读取/liveness/停止；spawn --bg（不传 --worktree）为 adapter 新增" | §2.1 |
| F9 | resolveSettingsPath 多余 | 复用 `providerManager.resolve(alias).path`（`src/utils/providers.ts`） | §7.4 |
| F10 | 单轮 turn 数增加（review 修 + postfix 复查） | max_rounds code 8 -> 6 | §5.2 |

**关键设计取舍（用户拍板）**：
- **review 既审又修**（反转 I9）：review 在 EXTERNAL_REVIEW 单 turn 内识别+确认+直接修+verify；cross-model 靠 work postfix R1 复查闭环。
- **无论如何都跑一轮外审**：R1/R2 clean 不再 -> DONE，一律进 EXTERNAL_REVIEW；429 PAUSED 恢复后也继续跑（不跳过）。
- **clean 标准**：无 P0/P1/P2 需修复，P3 不阻塞。
- **context 裸奔**：删 cascade，靠 max_rounds 兜底；Phase 3 可重引入轻量 abort。
- ~~**checkpoint 由 engine 打**~~（v2.1.6 反转：engine 不打 checkpoint，基于 {task}+当前状态全面 review，详见 C.9）：原 v2.1.3 不信任模型 git 行为，v2.1.6 进一步不信任 engine 该不该打 checkpoint。

**第二轮未做**：
- ❌ ~~没实现 PAUSED 期间 bg session 死亡的自动 respawn~~（v2.1.6：PAUSED 态删除，此条无意义）
- ❌ 没做 review 自选 diff 看漏的检测（靠 work postfix 复查 + prompt 明确要求查全部 diff 兜底）

### C.9 v2.1.6 变更动机 + 决策（2026-07-12，第三轮 review 修正）

#### C.9.1 用户提出的简化

第二轮 review 后，用户提出两点简化：

| # | 简化 | 原话摘要 |
|---|------|---------|
| S1 | review/self-review 应结合原始 spec/plan/需求做**全面 review**，而非只看 fix diff；不需要 engine 打 checkpoint | "建议 review 时应该结合原始的 spec,plan 或者原始的需求描述，进行全面的 review，而不是只看 fix diff。建议不需要做 checkpoint 输出。让模型自己去根据现在的实际情况来 review" |
| S2 | 429 简化处理，claude code 本身已有失败重试，review engine 不用过多参与 | "429 失败时，claude code 本身已经有失败重试机制，我理解我们不用过多参与，简化处理即可" |

#### C.9.2 决策

| 项 | 决策 | 理由 |
|---|------|------|
| S1a | **删整个 checkpoint 体系**：engine 不打 preProduce/preReview/pre-FIXING checkpoint，删 HistoryEvent.checkpointSha、PipelineRecord.preProduceCheckpointSha/preReviewCheckpointSha、§7.2.1 边界 case 表、spawn 后自检 | engine 打 checkpoint + 注入 diff baseline SHA 本质是不信任模型能自己看代码状态；但 claude --bg 模型本就能 git diff/git log/cat，给它需求 + 让它自己看当前状态更自然 robust；少打 commit 减少用户分支污染 |
| S1b | self_review/review prompt 改为"基于需求 {task} + 当前代码/产出状态全面 review"，模型自己 git diff/git log/cat | 全面 review 比窄 diff 复查更 robust（模型看全貌而非窄 diff）；postfix R1 也全面复查当前状态，不再窄看 review diff |
| S1c | 删 review cleanup 命令 | 无 checkpoint commit 无需清理；回滚靠用户跑 review 前的 HEAD（P1-3 强制 clean tree 保证 HEAD 干净） |
| S2 | **删 PAUSED 态**：429 等 blocked 场景一律 ABORTED unexpected_blocked，依赖 claude code 自身重试 | claude code 对 429 已有重试；review engine 重做一套限流处理（PAUSED + parse 重置时间 + reconciler 唤醒 + liveness）与之重叠且复杂；blocked 一律 abort 最简，用户 review resume/run 重跑 |
| S2 配套 | 删 pauseHistory、BlockedResult.rate_limited/permission（只留 unexpected）、rate_limit_* 配置、isBgAlive API、reconciler PAUSED 唤醒 + liveness 整组 | PAUSED 不存在则这些都不需要 |

#### C.9.3 删除的内容

- **状态**：PAUSED（429 限额挂起）
- **字段**：PipelineRecord.preProduceCheckpointSha / preReviewCheckpointSha、HistoryEvent.checkpointSha、PAUSED.pauseHistory、PaneRegistry.work.currentPid/roundPids、PaneRegistry.review.pid
- **API**：adapter.isBgAlive（4 API：startSession / resumeWorkSession / poll / stop）
- **复用**：readRoster()（liveness 不再做）、RendezvousClient.injectReply（v2.1.5 已退场）
- **配置**：rate_limit_resume_poll_interval_ms / rate_limit_fallback_interval_ms
- **命令**：review cleanup
- **reason**：permission_denied / paused_cancelled（blocked 一律 unexpected_blocked）
- **转换**：任意 active -> PAUSED / PAUSED -> PAUSED / PAUSED -> (pausedFrom) / PAUSED -> ABORTED

#### C.9.4 风险与取舍

| 风险 | 取舍 |
|------|------|
| 无 checkpoint 回滚锚点 | 接受：用户跑 review 前的 HEAD 即回滚点（P1-3 强制 clean tree 保证干净）；git reset --hard <review前的commit> 回滚 |
| 模型自选 diff 看漏改动 | 接受：prompt 明确 git log + git diff HEAD~N 覆盖本轮全部；work postfix R1 全面复查兜底 |
| 429 月限额场景 pipeline 直接 ABORTED | 接受：用户 review resume/run 重跑；Phase 1 不做长限额挂起，Phase 2 review-server 可重新引入 |
| FIXING parse 失败保守推进 | 接受：R2 全面 review（基于当前代码状态）能兜住 FIXING 改坏的问题，比原窄 diff 复查更强 |

#### C.9.5 未做的事

- ❌ 没加 checkpoint 的细粒度回滚（pre-FIXING 等中间态）-- MVP 不需要，Phase 2 可考虑
- ❌ 没做 429 的智能等待/重试 -- 完全依赖 claude code 自身；如实践中月限额频繁致 ABORTED，Phase 2 review-server 可重引入轻量 PAUSED
- ❌ 没改 max_rounds 默认值（仍是 code=6）


## 附录 D：v2.1.1 评审反馈汇总（2026-06-17）

> 索引表，详细修复见主文对应章节。

| ID | 类别 | 问题 | 修复位置 |
|---|---|---|---|
| B1 | P0 | `output` 类型错 | [implementation.md §7.5.1](./implementation.md#751-数据来源) |
| B2 | P0 | 函数名错 `readLastAssistantUsage` | [overview.md §3.2](./overview.md#32-新建层15-个模块) |
| B3 | P0 | 引用未定义变量 | [implementation.md §7.5.7](./implementation.md#757-context-window-策略化处理) |
| B4 | P0 | model-parser 公式冗余 | [overview.md §3.2](./overview.md#32-新建层15-个模块) |
| B5 | P0 | source 枚举不完整 | [state-machine.md §5.1](./state-machine.md#51-reviewstate-枚举) |
| B6 | P0 | injectReply signal 不可达 | [overview.md §3.2](./overview.md#32-新建层15-个模块) |
| B7 | P0 | executeContextReset 签名缺 profile | [implementation.md §7.5.7.3](./implementation.md#7573-策略-1reset默认) |
| I1 | P1 | v2.1 review-A/B 残留 | 全文清理 |
| I2 | P1 | 注释与代码不一致（模块计数 9→13） | [overview.md §3.2](./overview.md#32-新建层15-个模块) |
| I3 | P1 | panes.review 生命周期不清 | [implementation.md §6.1](./implementation.md#61-pipelinerecord-数据结构) |
| I4 | P1 | findDeadPanes 实现缺失 | [implementation.md §6.4](./implementation.md#64-reconciler) |
| I5 | P1 | JobStateFile 扩展路径未拍板 | [implementation.md §7.5.6](./implementation.md#756-jobstatefile-接口扩展) |
| I6 | P1 | 兼容性描述矛盾 | [ux-and-plan.md §15](./ux-and-plan.md#15-影响清单v21--v211) |
| I7 | P1 | 走查示例 review×2 残留 | [state-machine.md §5.3.5](./state-machine.md#535-走查示例) |
| I8 | P1 | work pane 死亡设计含糊 | [implementation.md §6.4](./implementation.md#64-reconciler) |
| I9 | P1 重大 | review_fix 质量差 | [implementation.md §7.5.7](./implementation.md#757-context-window-策略化处理) |
| I10 | P1 | human_decide_timeout 1h 偏激进 | [implementation.md §7.2](./implementation.md#72-完整配置示例) |
| I11 | P1 | parse_retry_timeout 30s 偏长 | [implementation.md §7.2](./implementation.md#72-完整配置示例) |

**工作量**：7 P0 + 11 P1 → 全部修复。
