# Review Engine v2.1.1 — 实现细节

> 属于 [overview.md](./overview.md) 的下游文件。

## 6. PipelineStore & Reconciler

### 6.0 共享类型定义

```typescript
/** Review issue（核心类型，贯穿全流程） */
interface Issue {
  id: string;                              // = fingerprint（engine 分配，跨轮稳定）；v2.1.5 P2-8 统一 work+review
  role: 'work' | 'review';                 // 来源角色
  severity: 'P0' | 'P1' | 'P2' | 'P3';    // P0=Critical / P1=High / P2=Medium / P3=Low
  location: string;                        // 文件路径 + 行号
  description: string;
  suggestion?: string;
  fingerprint: string;                     // SHA256(role:severity:location:description) 前 8 位
}

/** Parse retry 选项（§7.5.4） */
interface ParseRetryOptions {
  role: 'work' | 'review';
  round: number;
  retryPrompt?: string;
  maxRetries?: number;     // 默认 1
  timeoutMs?: number;      // 默认 15000
}

/** Parse 结果（§7.5.4） */
interface ParseSuccess<T> { ok: true; data: T; retries: number }
interface ParseFailure { ok: false; parseDegraded: true; reason: string; raw: string }
type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/** Reconciler 返回值（§6.4） */
interface ReconcileResult {
  recovered: number;
  lostPanes: number;
  timedOut: string[];       // PipelineId[]
  errors: string[];
}

/** Review 意见 + 修复（EXTERNAL_REVIEW 产出，v2.1.3：review 既审又修） */
interface ReviewFixOutput {
  role: 'review';
  issues: Issue[];                        // 识别出的全部 issues（含 P3）
  perIssue: Array<{
    issueId: string;
    severity: 'P0' | 'P1' | 'P2' | 'P3';  // v2.1.5 P1-4：内嵌 severity，收敛判定直接用，不反查 issue_id
    verdict: 'real' | 'hallucination';
    verdictReason: string;
    fixApplied: boolean;                  // 是否已修复
    fixSummary?: string;
  }>;
  reasoning: string;
}
```

> **v2.1.3 删除的类型**：`ContextCheckResult`（context overflow 检测）、`WorkDecision`（JUDGE 产出）、`DecisionContext`（HUMAN_DECIDE 载荷）、`ContextResetEvent`（cascade 事件）已全部移除。`ReviewOpinion` 改名为 `ReviewFixOutput`，从"只识别"升级为"识别+修复"。

### 6.0.1 统一 clean 判定（v2.1.3 新增）

```typescript
// P0/P1/P2 阻塞收敛；P3 不阻塞，记入 issueTrail 但不触发新一轮 fix。
// 用于 R1/R2 clean 判定 与 EXTERNAL_REVIEW 收敛判定。
function isClean(issues: Issue[]): boolean {
  return issues.filter(i => ['P0', 'P1', 'P2'].includes(i.severity)).length === 0;
}
```

```typescript
// adapter.poll 检测 state=blocked 时（v2.1.6：不再分流，一律 unexpected）
interface BlockedResult {
  kind: "unexpected";   // v2.1.6：blocked 一律 unexpected（429/permission/等输入不区分，由 claude code 自身重试）
  raw: string;          // 原始 needs/detail
}
// - state=blocked -> 一律 unexpected（engine ABORTED unexpected_blocked）
//   v2.1.6 简化：429 限流由 claude code 自身重试，review engine 不识别 429 / 不进 PAUSED / 不 parse 重置时间
```

### 6.1 PipelineRecord 数据结构

```typescript
interface PipelineRecord {
  pipelineId: string;           // ULID
  createdAt: string;
  updatedAt: string;
  ownerOpenId?: string;         // Phase 2 飞书集成用
  state: ReviewState;
  input: {
    rawInput: string;
    phase: 'spec' | 'plan' | 'code' | 'unknown';
    profile: string;
    maxRounds: number;
    cwd: string;
  };
  panes: PaneRegistry;
  history: HistoryEvent[];
  parseDegraded?: ParseDegradedEvent[];
  // v2.1.6：删 preProduceCheckpointSha / preReviewCheckpointSha / HistoryEvent.checkpointSha
  // -- engine 不打 checkpoint，self_review/review 基于 {task} + 当前代码状态全面 review（模型自己 git diff/git log/cat）
}

interface PaneRegistry {
  work?: {
    sessionId: string;          // 跨轮不变
    currentRoundShortId?: string;
    /** v2.1.5 P0-2：currentPid/roundPids 移除--state.json 无 pid，spawn pid 是 launcher 不可信；liveness 用 currentRoundShortId 读 roster.json workers[short] 实时查 pid */
    // currentPid?: number;   // v2.1.5 移除
    // roundPids?: number[];  // v2.1.5 移除
    provider: string;
    startedAt: string;
    roundShortIds: string[];
  };
  review?: {                    // v2.1.1 单数；v2.1.3 review 现在直接修代码
    role: 'review';
    shortId: string;
    sessionId: string;
    /** v2.1.5 P0-2：pid 移除--liveness 用 shortId 读 roster.json workers[short] 查 pid */
    // pid?: number;  // v2.1.5 移除
    provider: string;
    round: number;
  };
}

interface ParseDegradedEvent {
  ts: string;
  role: 'work' | 'review';
  round: number;
  state: ReviewState['kind'];
  reason: string;
  recoveredByRetry: boolean;
}

interface HistoryEvent {
  ts: string;
  fromState: ReviewState['kind'] | null;
  toState: ReviewState['kind'];
  round: number;
  role: 'work' | 'review' | 'human';
  paneShortId?: string;
  paneSessionId?: string;
  providerAlias?: string;
  inputDigest: string;
  outputDigest: string;
  outputSizeBytes: number;
  durationMs: number;
  issues?: Issue[];
  // v2.1.6：删 checkpointSha -- engine 不打 checkpoint
}
```

> **v2.1.3 删除的字段**：`PipelineRecord.contextResets` / `contextOverflowCount` / `contextFiles` 全部移除（context cascade + review opinions 落盘整组移除）；`PaneRegistry.review.cycle` 移除（review pane 不再区分 initial/postfix，每轮新 session）；`HistoryEvent.verdict` / `fixingCheckpointSha` 合并重命名为统一 `checkpointSha`（engine 打）；`PipelineRecord.totalCostUsd` / `HistoryEvent.costUsd` 移除（成本统计整组移除，实测 state.json 无 cost_usd）。

### 6.2 持久化目录

**v2.1.2 修正**：每个 pipeline 占用一个**目录**（而非单文件），用于存放 PipelineRecord。

**v2.1.3 瘦身**：删 `human_pending/`（HUMAN_DECIDE 移除）+ 删 `state/` 子目录（review opinions 落盘整组移除，不再有 context-related artifacts）。

```
~/.cc-linker/review-pipelines/
├── .lock                              # 全局锁（reconciler 用）
├── running/
│   └── <pipelineId>/                  # per-pipeline 目录
│       ├── pipeline.json              # PipelineRecord 主文件
│       └── .lock                      # per-pipeline 锁（§6.3）
├── queued/                            # 排队等待（§6.5）
│   └── <pipelineId>/pipeline.json
├── done/
│   └── <pipelineId>/pipeline.json
├── failed/
│   └── <pipelineId>/pipeline.json
└── aborted/
    └── <pipelineId>/pipeline.json
```

**5 目录**（v2.1.3：删 `human_pending/`，不使用 pending/）。原子写规则：写 `.tmp` 再 `rename`。

**目录迁移**：pipeline 状态变化时，整个 `<pipelineId>/` 目录在 5 个父目录间移动（`rename` 原子操作）。

### 6.3 幂等性

```typescript
async function transition(pipeline: PipelineRecord, event: EngineEvent): Promise<void> {
  const lastEvent = pipeline.history[pipeline.history.length - 1];
  if (lastEvent && lastEvent.toState === computeNextState(pipeline.state, event).kind) {
    return;  // 幂等跳过
  }
  // ...正常推进 + saveRunning
}
```

**4 道防线**：
1. History 去重：`lastEvent.toState === 目标 state` → 跳过
2. 转换函数幂等：纯函数
3. Polling 间隔去重：500ms 一次，只在 state 变化时 emit
4. **文件锁**：`~/.cc-linker/review-pipelines/{running,done,failed,aborted}/<pipelineId>/.lock`（per-pipeline，`proper-lockfile`）

**FIXING source-aware 幂等性**：FIXING 必须 source + inputIssues 都匹配才算幂等（v2.1.3：source 仅 `R1 | R2`）。

### 6.4 Reconciler

**触发时机**（v2.1.5 P0-1 / v2.1.6 简化）：review engine 子进程内**常驻循环**--`review run` fork 的 engine 进程每 60s 调一次 `reconcile()` 扫 `running/` 检查 pane 存活 + PANE_LOST 24h 超时。CLI 命令**不驱动状态机**（避免与后台 engine 双驱动冲突）：任意 `review` CLI 命令启动时只读 `engine.pid` + `kill -0` 判 engine 活否--活着则不干预；死了则提示用户 `review resume <id>` 重挂，**不自动调 reconcileInternal 推进**。不再依赖外部"daemon 启动"（Phase 1 无独立 review daemon；Phase 2 `review-server` 才是独立常驻进程）。

```typescript
async function reconcile(): Promise<ReconcileResult> {
  await acquireLock('~/.cc-linker/review-pipelines/.lock');   // 全局锁
  try {
    return await reconcileInternal();
  } finally {
    await releaseLock('~/.cc-linker/review-pipelines/.lock');
  }
}
```

**Reconciler 行为**：

| 场景 | 行为 |
|------|------|
| running/ + 所有 pane 活着 | 继续推进 |
| running/ + 部分 pane 消失 | **PANE_LOST** + 用户决策 |
| PANE_LOST 24h 超时 | cleanup → ABORTED |


> **v2.1.3 删除**：`human_pending/` 目录扫描 + HUMAN_DECIDE 4h 超时行（HUMAN_DECIDE 移除，无 human_pending 目录）；review opinions 文件恢复增强（review opinions 落盘整组移除，review findings 直接从 review pane 的 `state.json.output` 解析入 history）。
> **v2.1.6 删除**：PAUSED 态 + pauseHistory + reconciler 到点唤醒 + liveness 检查整组移除（429 简化为 blocked 一律 ABORTED，详见状态机 §4.3/§5.1 + 附录 C.9）。reconciler 现只处理 PANE_LOST 24h 超时 + pane 存活检查。

**实施备注（v2.1.3 补充）**：

1. **PANE_LOST 24h 触发机制**：reconciler 每 60s 扫 running/ 中所有 PANE_LOST pipeline，对每个比较 `Date.now() - new Date(lostPane.detectedAt).getTime() >= 24 * 3600 * 1000` → 走 cleanup → ABORTED 路径（`reason=pane_lost_timeout`，移到 aborted/）。`detectedAt` 由 §4.4 reconcile 首次发现 pane 缺失时写入（基于 `state.json.state ∈ {failed, stopped}` 或 `readJobState` 返回 null）。

2. **FIXING 幂等匹配规则**：`source + inputIssues` 都匹配的判定：
   - `source` 必须完全相等（`'SELF_REVIEW_R1'` 或 `'SELF_REVIEW_R2'`）
   - `inputIssues` 用**无序指纹集合比较**（v2.1.5 P2-4：原有序数组比较在模型重排 issues 顺序时误判为新 FIXING）：对每个 issue 计算 `fingerprint = SHA256(role:severity:location:description).slice(0,8)`，用 Set 比较（两集合大小相同 + 每个元素都在对方集合中）才认为匹配
   - 任一不匹配 → 视为新 FIXING（不跳过，正常推进）

3. **Issue ID 分配规则**（v2.1.5 P1-4 + P2-8 统一）：work + review 的 `Issue.id` **统一由 engine 用 fingerprint 分配**（`SHA256(role:severity:location:description)` 前 8 位），模型**不生成 id**。模型只输出 severity/location/description，engine 收到后算 fingerprint 填 id。
   - review 模型 `per_issue[]` 用 `issueId` 引用 engine 分配的 id（engine 先建 issues[].id 再 match per_issue）
   - `externalReviewConverges` 用 `per_issue.severity` 判定（v2.1.5 P1-4 内嵌），不反查 issue_id，避免模型 id 拼错假收敛
   - engine parse 时若 per_issue.issueId 对不上 issues[].id，按数组顺序对齐 fallback；对不上的项保守视为 real+blocking（不收敛）

**PANE_LOST retry**：
- review pane 丢失 → 重新 spawn
- work pane 丢失 → spawn 新 work session + 回到 R1 entry（检查 max_rounds）

### 6.4.1 `review resume <id>` 重挂流程（v2.1.5 P1-5）

engine 崩溃后 `running/` 残留 pipeline，`review resume <id>` 重新挂载并驱动。流程：

1. **校验 engine 死了**：读 `engine.pid`，`kill -0` 失败（或 PID 已被无关进程复用，见 §6.4.2）才允许 resume；engine 还活着则提示"已在跑，用 `status --follow` 查看"拒绝。
2. **读 PipelineRecord.state**：确定当前 ReviewState + 当前 pane 的 shortId（`panes.work.currentRoundShortId` 或 `panes.review.shortId`）。
3. **探测 bg 当前态**（resume 的关键--engine 死期间 bg 在 daemon 下继续跑可能已变）：
   - `readJobState(shortId)` -> null/failed/stopped = bg 死 -> **PANE_LOST**
   - state=`done` -> bg 已完成、engine 没来得及 emit -> 直接 emit 对应完成事件推进状态机（如 work done -> 进 R1，v2.1.6 不打 checkpoint）
   - state=`blocked` -> ABORTED `unexpected_blocked`（v2.1.6：blocked 一律 abort，不区分 429）
   - state=`running`/`working` -> 续 poll 同一 shortId
4. **fork 新 engine 子进程**接管：新 engine 进程内长驻循环续跑状态机 + 60s reconcile，写新 `engine.pid`。

> resume 只对 `running/` 中的 pipeline；`done/`/`failed/`/`aborted/` 拒绝（终态不可逆）。FAILED 状态的 running/ pipeline 也可 resume（重试网络类瞬态错误）。

### 6.4.2 engine.pid PID 复用风险（v2.1.5 P1-5）

engine 崩溃后 pidfile 残留，OS 可能把同一 PID 分配给无关进程 -> `review abort/resume` 的 SIGTERM 误杀无辜。

**缓解**：pidfile 写 `{ pid, startTime }`（startTime = engine 进程启动 wall-clock）。SIGTERM/`kill -0` 前先校验进程身份：
- macOS/Linux：读 `/proc/$pid/stat`（Linux）的 start time，或 `ps -o lstart= -p $pid`（macOS）比对 startTime
- 不匹配（PID 被复用）= 原 engine 已死，视为"engine 死了"走 resume/abort 的"无 engine"分支，**不**对 $pid 发信号
- 匹配才 SIGTERM

> Phase 1 可先用简化版（`ps -o command= -p $pid` 含 `cc-linker`/`review` 字样才认），Phase 3 升级 startTime 严格比对。

### 6.5 并发控制

默认 1 个 pipeline 同时跑，profile 可配 `guards.max_concurrent_pipelines = 3`。

> **v2.1.2 修正（P1-7）：超出并发上限时的排队机制**
>
> 当 `running/` 目录中 pipeline 数量 ≥ `max_concurrent_pipelines` 时，新提交的 pipeline 进入排队：
>
> ```
> ~/.cc-linker/review-pipelines/
> ├── running/         # 正在跑（≤ max_concurrent_pipelines 个）
> ├── queued/          # 排队等待（FIFO）
> │   └── <pipelineId>/pipeline.json
> ├── done/  failed/  aborted/
> ```
>
> **排队流程**：
> 1. `review run` 检测 `running/` 目录数量 → 超限 → 写入 `queued/` 而非 `running/`
> 2. CLI 输出 `⏳ Pipeline queued at position N (max_concurrent_pipelines=M)`
> 3. Reconciler 每 60s 检查：`running/` 有空位 → 将 `queued/` 中最旧的 pipeline 移入 `running/` 并启动
> 4. `review status <id>` 对 queued pipeline 显示 `QUEUED (position=N)`
> 5. `review cancel <id>` 对 queued pipeline 直接移到 `aborted/`（不需要 cleanup panes）
>
> ** queued/ 不占 worker slot**：queued pipeline 没有 bg session，不消耗 Claude CLI 资源。

### 6.6 Abort / Cleanup 流程

**触发**：用户 cancel / max_rounds / PANE_LOST 24h（v2.1.3：删 HUMAN_DECIDE 4h 触发）。

**步骤**：
1. `abortController.abort()` 打断 polling
2. 收集所有 active pane shortIds（work + 1 review）
3. `Promise.allSettled(paneShortIds.map(shortId => adapter.stop(shortId)))`
4. 通知 cli-watch 客户端
5. 关闭文件锁 + 清理 in-memory state
6. **SIGTERM engine 子进程**（v2.1.5 P0-1：若 engine 还活着，读 `engine.pid` 发 SIGTERM，等 3s 不退 SIGKILL）+ 删 `engine.pid`

---

## 7. ReviewProfile

### 7.1 存储位置

`~/.cc-linker/review-profiles/<name>.toml`

### 7.2 完整配置示例

```toml
[meta]
name = "default"
description = "通用默认：sonnet 工作 + kimi 单 Review"

[work]
provider = "claude-sonnet-4"

[review]
provider = "kimi-for-coding"

[guards]
max_rounds = 6
max_concurrent_pipelines = 1

# parse retry
parse_retry_timeout_ms = 15000

# v2.1.6 删除：rate_limit_resume_poll_interval_ms / rate_limit_fallback_interval_ms（PAUSED 态移除，429 一律 ABORTED）

# Phase 3 预留（当前 engine 未消费，实施时可忽略）
# max_token_in = 500000                # 单 pipeline input token 上限
# max_token_out = 100000               # 单 pipeline output token 上限
# api_rate_limit_strategy = "backoff"  # "backoff" | "fail-fast"
# api_rate_limit_429_backoff_ms = [2000, 4000, 8000, 16000]

# 模型 context 上限覆盖（v2.1.3：仅供报告展示，不驱动任何逻辑；v2.1.5 P3-5：与 parseModelFromRespawnFlags 的 contextHint 冲突时以 respawnFlags 为准）
[context_limits]
"claude-sonnet-4-5" = 1000000
"kimi-for-coding" = 256000
```

> **v2.1.3 删除的配置**：`human_decide_timeout_ms` / `p0_p1_reject_threshold`（HUMAN_DECIDE + JUDGE 移除）；`context_overflow_threshold_1m` / `context_overflow_threshold_percent` / `context_overflow_strategy` / `max_compact_attempts` / `compact_timeout_ms` / `max_injected_issues` / `max_context_resets_per_pipeline` / `max_reset_duration_ms`（context cascade 整组移除）；`max_cost_usd`（成本统计整组移除，实测 state.json 无 cost_usd）。`[context_limits]` 保留但仅供报告展示，不再驱动任何阈值判断。

**prompts 模板**见 [state-machine.md → §5.4](./state-machine.md#54-clean-判定与收敛逻辑v213-重写)（v2.1.3：clean 判定 + EXTERNAL_REVIEW 收敛逻辑）和以下 prompt 模板：

```toml
[prompts.work.produce.system]
template = """
你正在编写一份 {phase} 阶段的产出。需求描述：{task}

操作步骤（P1-2，**严格按序执行，不要跳步**）：
1. **理解任务**：读 `{task}`（如果是路径，先 `cat <cwd>/<task>`；如果是 1 句话需求，直接读）
2. **定位上下文**（code phase 必走）：
   - `git -C <cwd> log -5 --oneline` 看最近 commit 历史
   - `git -C <cwd> diff HEAD~3` 看近期改动（P1-3 强制 clean tree，工作区无 WIP）
   - 如果 task 提到具体文件/函数/错误：`find <cwd> -name '<pattern>'` + `cat <相关文件>`
   - 如果 task 是 bug 类（"fix NPE in auth.ts"）：`cat <cwd>/auth.ts` + 跑测试复现
3. **撰写产出**（按 phase）：
   - **spec phase**：写 `.md` 文档（需求/接口/验收标准）
   - **plan phase**：写 `.md` 设计文档（架构/数据流/边界 case）
   - **code phase**：直接修改/新建源文件 + 跑测试验证
4. **输出**：对 code phase 简述改了哪些文件 + 测试结果；对 spec/plan phase 写完整文档

约束：
- 不要执行 git commit/stash（v2.1.6：engine 也不碰 git，改动直接落你当前分支；回滚由用户用 review 前的 HEAD）
- cwd 是 `Bun.spawn({cwd})` 控制的，与 `process.cwd()` 一致
"""

[prompts.work.self_review.system]
template = """
你是工作模型，对自己的产出做自查（identify only，不要修改文件）。
需求基准（spec/plan 或需求描述）：{task}

请先 cat 上述 spec/plan 理解需求，再用以下命令查看当前代码/产出状态（自己决定查看范围，全面审查）：
  - git -C <cwd> log -5 --oneline   # 看最近改动历史
  - git -C <cwd> diff HEAD~N        # 看本轮 produce/fix 的改动（N 自行判断，覆盖本轮所有改动）
  - cat <相关文件>                  # 按需读文件确认

（v2.1.6：engine 不打 checkpoint、不注入 diff baseline。你基于需求 {task} + 当前代码状态全面 review，
 自己 git diff/git log/cat 查看本轮所有改动。非 git repo 时直接读文件比对。）

判断改动是否符合需求、有无 bug，识别问题（不要修改文件）。

{r1_or_r2_instruction}

输出 JSON:
{ "issues": [{ "severity","location","description" }] }
"""
# v2.1.5 P2-7：删 unfixed_count（identify-only 无"未修复"概念）；P2-8 issues 不输出 id（engine fingerprint 分配）
# {r1_or_r2_instruction} 在 engine 端替换：
# R1 initial:  "第一次自查，全面审查产出是否符合需求"
# R2 initial:  "审查修复后的整体状态是否符合需求、有无新问题"
# R1 postfix:  "postfix 循环：全面复查上一轮 external review 修复后的整体状态"
# R2 postfix:  "审查 postfix 修复后的整体状态"

[prompts.work.fixing.system]
template = """
你是修复节点（FIXING）。调用来源：{source}
需求基准：{task}
待处理的问题列表：{input_issues}

严格 verify-first 流程：
1. 重新阅读相关代码，判断 real 还是 hallucination
2. 修复（仅 real），修改要最小化
3. 验证修复正确

直接在当前分支改文件，不要做 git 操作（v2.1.6：engine 不打 checkpoint，改动直接落用户分支）。

输出 JSON:
{ "per_issue": [...], "all_real_fixed": bool, "remaining_real_unfixed_count": N }
"""

# v2.1.6：engine 不打 checkpoint（删 preamble 体系）；FIXING 改 resumeWorkSession（v2.1.5 P1-1）
# v2.1.3：删 prompts.work.judge.system（JUDGE_BY_WORK 移除）

[prompts.review.code.system]
template = """
你是外部 Review 模型，对工作模型的产出做交叉评审并**直接修复**（v2.1.3：review 既审又修）。
需求基准（spec/plan 或需求描述）：{task}

请先 cat 上述 spec/plan 理解需求，再用以下命令查看当前代码/产出状态（自己决定查看范围，全面审查）：
  - git -C <cwd> log -5 --oneline   # 看最近改动历史
  - git -C <cwd> diff HEAD~N        # 看本轮 work produce + fix 的全部改动（N 自行判断）
  - cat <相关文件>                  # 按需读文件确认

（v2.1.6：engine 不打 checkpoint、不注入 diff baseline。你基于需求 {task} + 当前代码状态全面 review，
 自己 git diff/git log/cat 查看本轮所有改动。非 git repo 时直接读文件。）

Severity 判定标准（per phase，P1-1）：
- **spec phase**：P0=需求理解错误/与相邻 spec 段落严重矛盾；P1=语义不清/缺关键边界 case；P2=格式错误/术语不一致；P3=小瑕疵
- **plan phase**：P0=架构根本不可行/关键数据流错误；P1=缺重要边界 case/性能问题；P2=术语不一致/可读性问题；P3=小瑕疵
- **code phase**：P0=bug/crash/安全漏洞/数据丢失；P1=明显功能错误/性能严重问题；P2=边界 case 未处理/可维护性问题；P3=代码风格/命名

对每条 issue：
1. 识别问题，按上述 per-phase 标准分级
2. 逐条确认问题是否 real（避免 hallucination）：**spec phase re-read 全文 + 检查语义一致性**；**plan phase 验证关键数据流**；**code phase 跑测试或检查边界**
3. 对 real 问题直接修改（最小化改动），并按 per-phase verify 标准重新验证：
   - spec phase：re-read 改后段落，确保与其他段落语义连贯
   - plan phase：对照需求走一遍关键场景，确认数据流通顺
   - code phase：跑测试 + 检查边界 case
4. P3 问题可修可不修（不阻塞收敛，由你判断性价比）

直接在当前分支改文件，不要做 git 操作（v2.1.6：engine 不打 checkpoint，改动直接落用户分支）。

输出 JSON:
{
  "issues": [{ "severity", "location", "description", "suggestion"? }],
  "per_issue": [{ "issue_id", "severity", "verdict": "real"|"hallucination", "verdict_reason", "fix_applied": bool, "fix_summary"? }],
  "reasoning": "..."
}
"""
# 注：issues / per_issue 均不输出 id 字段（v2.1.5 P2-8：id 由 engine 用 fingerprint 分配）；per_issue 内嵌 severity（v2.1.5 P1-4：收敛判定直接用，不反查 issue_id）
# spec/plan phase 用 prompts.review.spec.system / prompts.review.plan.system，结构同上（{task} + 当前状态全面 review + 直接修 + per-phase verify 标准）

[phase_overrides.code]
review.provider = "kimi-for-coding"
guards.max_rounds = 6
```

> **v2.1.3 prompt 变更**：
> - 删 `prompts.work.judge.system`（JUDGE_BY_WORK 移除）
> - 删 `prompts.work.compact_continue.system`（cascade 移除）
> - 删 `prompts.work.fixing.preamble` + `prompts.review.code.preamble` -- **v2.1.6：engine 完全不打 checkpoint**（原 v2.1.3 改由 engine 打，v2.1.6 进一步删除：基于 {task}+当前状态全面 review，无需 diff baseline 锚点），模型只管改文件、不碰 git
> - v2.1.6：`prompts.work.self_review.system` + `prompts.review.code.system` 统一为"基于 {task} + 当前代码状态全面 review"，模型自己 `git diff`/`git log`/`cat` 查看本轮改动，**engine 不打 checkpoint、不注入 diff baseline SHA、不构造 artifact**
> - `prompts.work.fixing.system` 去掉 @file 引用，改回 inline `{input_issues}`，加 `{task}` 上下文
> - `prompts.review.code.system` 从"只识别 issues"升级为"识别 + 确认 + 直接修 + verify"，输出 JSON 删 `checkpoint_sha`（engine 持有，不依赖模型自报）
> - v2.1.6：删两类 checkpoint SHA（engine 不打），`HistoryEvent.checkpointSha` 字段移除

### 7.2.1 改动落盘与回滚（v2.1.6 重写）

> v2.1.6：engine **不打 git checkpoint**。work FIXING 与 review EXTERNAL_REVIEW 的改动直接落用户原开发分支（不传 `--worktree`）。回滚靠用户跑 review 前的 HEAD（P1-3 强制 clean tree 保证 HEAD 干净）。

| 场景 | 处理 |
|------|------|
| 改动落盘 | bg 直接在用户原分支改文件，`git diff` / `git log` 可见全部改动 |
| 回滚到 review 前 | 用户跑 review 前的 HEAD 即天然回滚点：`git reset --hard <review前的commit>`（P1-3 强制 clean tree 保证 HEAD 干净，无 WIP 丢失风险） |
| cwd 不是 git 仓库 | 改动直接落 cwd 文件，无 git 历史；报告标注"非 git repo，无回滚锚点，改动直接落盘" |
| 工作区有未提交改动（v2.1.5 P1-3）| doctor 启动时校验 `git status --porcelain` 为空，有改动则**报错拒绝启动**--engine 不自动 stash |
| worktree 误建 | 不会发生--adapter 不传 `--worktree`（worktree 由显式 flag 触发） |
| 模型自选 diff 看漏改动 | prompt 明确要求 `git log` + `git diff HEAD~N` 覆盖本轮所有改动；work postfix R1 全面复查兜底 |

### 7.3 per-phase 深度 merge 规则

- 标量字段：phase 值完全覆盖 top-level
- table 字段（prompts）：深度 merge

### 7.4 Provider 字段 -> settingsPath 映射

> **v2.1.3（F9）**：不新写 `resolveSettingsPath`，直接复用现有 `providerManager.resolve(alias).path`（`src/utils/providers.ts:38-49`，`feishu/bot.ts` 已有调用先例）。

```typescript
import { providerManager } from '../utils/providers';

async function resolveSettingsPath(providerAlias: string): Promise<string> {
  await providerManager.scan();                        // 扫 ~/.claude/providers/*.json
  const cfg = providerManager.resolve(providerAlias);  // -> { alias, name, path, isTemp }
  if (!cfg) {
    throw new ProfileError({
      code: 'PROVIDER_NOT_FOUND',
      message: `provider '${providerAlias}' 不在 ~/.claude/providers/`,
      remediation: `放置 ~/.claude/providers/${providerAlias}.json`,
    });
  }
  return cfg.path;   // settings 文件绝对路径，直接喂 --settings
}
```

**模型 context 上限来源**（v2.1.3：仅供报告展示，不再驱动任何阈值判断）：

| 来源 | 用途 |
|------|------|
| `state.json.respawnFlags` 的 `--model`（如 `glm-5.2[1m]`） | `parseModelFromRespawnFlags` 解析为 `ModelInfo`，写入报告（实测：respawnFlags 由 CLI 从 settings 解析写入，可信；`providerEnv` 不可信） |
| provider 文件名后缀 | 备用（respawnFlags 无 `--model` 时） |
| profile `[context_limits]` 覆盖 | profile 级显式声明，仅供报告 |

> **v2.1.3 变更**：模型名从 `respawnFlags` 取（非 `providerEnv`，实测 F3）；删内置 `KNOWN_CONTEXT_LIMITS` 表（context 上限不再用于阈值检测）；删 cost 价格表（成本统计整组移除）。

### 7.5 Output Contract

#### 7.5.1 数据来源

`state.json.output` 是 `{ result: string }` 对象，文本在 `.result` 字段。

#### 7.5.2 JSON 提取策略

```typescript
function extractJsonBlock(output: string): unknown {
  // 策略 1: ```json ... ``` markdown fence
  // 策略 2: 括号深度匹配取最后一个完整 {...}（v2.1.5 P2-5：原"最后一个 {…} 块"用正则会被嵌套花括号搞错，review 输出 JSON 含嵌套对象；改用 depth counter 从最后一个 '{' 起扫描匹配 '}'）
  // 策略 3: 直接 JSON.parse
}
```

#### 7.5.3 Zod Schemas

```typescript
const SelfReviewOutputSchema = z.object({
  issues: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    location: z.string(),
    description: z.string(),
  })),  // v2.1.5 P2-7：删 unfixed_count（self_review identify-only 无"未修复"概念）；P2-8 id 由 engine fingerprint 分配
});

const FixingOutputSchema = z.object({
  per_issue: z.array(z.object({
    issue_id: z.string(),
    verdict: z.enum(['real', 'hallucination']),
    verdict_reason: z.string(),
    fix_applied: z.boolean(),
    fix_summary: z.string().optional(),
  })),
  all_real_fixed: z.boolean(),
  remaining_real_unfixed_count: z.number(),
});

const ReviewOutputSchema = z.object({
  issues: z.array(z.object({
    // v2.1.5 P2-8：id 由 engine fingerprint 分配，模型不输出；schema 不要求 id
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    location: z.string(),
    description: z.string(),
    suggestion: z.string().optional(),
  })),
  per_issue: z.array(z.object({
    issue_id: z.string(),   // engine 分配后回填
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),  // v2.1.5 P1-4：内嵌，收敛判定用
    verdict: z.enum(['real', 'hallucination']),
    verdict_reason: z.string(),
    fix_applied: z.boolean(),
    fix_summary: z.string().optional(),
  })),
  reasoning: z.string(),
});
```

> **v2.1.3 schema 变更**：删 `JudgeOutputSchema`（JUDGE_BY_WORK 移除）；`ReviewOutputSchema` 从"只输出 issues"升级为"issues + per_issue(含 fix_applied) + reasoning"（review 既审又修，删 checkpoint_sha--engine 打）。`SelfReviewOutputSchema` / `FixingOutputSchema` 保持不变。
>
> **v2.1.5 P1-7 命名约定**：JSON wire 格式（模型输出 + state.json）= **snake_case**（`issue_id` / `verdict_reason` / `fix_applied`）；TS 内存类型 = **camelCase**（`issueId` / `verdictReason` / `fixApplied`，见 §6.0 `ReviewFixOutput.perIssue`）。engine 在 `parseBgOutputWithRetry` parse 后做一次 snake->camel 转换（Zod 的 `transform` 或显式 map）。`Issue.id` / `severity` / `location` / `description` 两边同名无需转换。

#### 7.5.4 Parse 失败处理

```typescript
async function parseBgOutputWithRetry<T>(
  bg: ClaudeBGHandle,
  schema: z.ZodSchema<T>,
  opts: ParseRetryOptions,
): Promise<ParseResult<T>> {
  // 第 1 次 parse
  // 失败 -> retry 1 次（resumeWorkSession 重生成，timeoutMs 默认 15s）
  // 仍失败 → 返 ok:false + parseDegraded:true
}
```

**降级策略**：

| 场景 | v2.1.3 处理 |
|------|------------|
| Review pane parse 失败（EXTERNAL_REVIEW） | retry → 仍失败 → `parse_degraded: true` + **ABORTED**（review 既审又修，parse 失败无法判断是否已改代码，不能静默 DONE）|
| Work R1/R2 parse 失败 | retry → 仍失败 → ABORTED `r1_parse_degraded`（不静默 DONE） |
| FIXING parse 失败 | retry → 仍失败 → 视为 all_real_fixed=true（保守推进到 R2 全面复查；v2.1.6：R2 基于当前代码状态全面 review，能兜住 FIXING 改坏的问题） |

> **v2.1.3 变更**：删 JUDGE parse 失败行（JUDGE_BY_WORK 移除）；Review pane parse 失败从"排除该 review"升级为 ABORTED——因为 review 现在会直接改代码，parse 失败时无法确认 review 是否已落盘修改，静默推进会让未验证的改动混入产物。

#### 7.5.5 Prompt 工程配合

所有 prompt 模板末尾都包含 "输出 JSON:" 指令 + 明确的 JSON schema 示例。Engine 不依赖 LLM 一定输出合法 JSON，而是通过 Zod validate + 降级策略保证状态机不会因 parse 失败而卡死。

#### 7.5.6 `JobStateFile` 接口扩展

Phase 1 走 `ExtendedJobStateFile`（Review Engine 内部声明，不污染 Agent View）：

```typescript
type ExtendedJobStateFile = JobStateFile & {
  output?: { result: string } | null;
  children?: unknown;
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
};
```

#### 7.5.7 Context Window 策略 — 已移除（v2.1.3）

> **v2.1.3 整组删除**：context-OK 判断与三档 cascade（compact / reset / abort）+ review opinions 落盘 / @file 引用，随『裸奔』决策整组移除。
>
> 移除理由：删 JUDGE_BY_WORK 后 work 不再做 judge / 外审 fix，context 累积速度大幅下降；常规 2-4 轮不会 overflow，主动检测 + cascade 的复杂度不再划算。极端情况下由 `max_rounds` 兜底收敛（v2.1.3 删成本统计，无 max_cost_usd）。
>
> 删除的模块：`context-overflow.ts` / `build-context-reset-prompt.ts` / `build-context-compact-prompt.ts` / `review-opinions-writer.ts`。
> 删除的 adapter API：`getContextUsage`。
> 删除的配置 / 字段：见 §7.2 / §6.0 / §6.1 注释。
---

## 9. PhaseDetector

> **v2.1.2 修正（P1-9）：明确启发式优先级**
>
> 规则按优先级从高到低排列。命中即返回，不继续匹配后续规则。

```typescript
function detect(input: { rawInput: string; filePath?: string; gitRef?: string }): 'spec' | 'plan' | 'code' {
  // 优先级 0: 用户显式 --phase flag（CLI 层已处理，不进 detect）

  // 优先级 1: git ref → 强制 code（有 git ref 说明是代码变更）
  if (input.gitRef) return 'code';

  // 优先级 2: 文件后缀 / 行号引用 → 强制 code（如 "auth.ts:42"）
  if (/\.(\w+):\d+/.test(input.rawInput)) return 'code';

  // 优先级 3: 文件路径后缀 / 目录名
  //   - *.md 在 docs/ 或 *.spec.md → spec
  //   - *.md 在 plans/ 或 *.plan.md → plan
  //   - *.ts / *.js / *.py 等源码后缀 → code
  if (input.filePath) {
    if (/docs\/.*\.md$|\.spec\.md$/.test(input.filePath)) return 'spec';
    if (/plans\/.*\.md$|\.plan\.md$/.test(input.filePath)) return 'plan';
    if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|swift|kt)$/.test(input.filePath)) return 'code';
  }

  // 优先级 4: 关键词匹配（v2.1.5 P2-3 加中文，飞书中文用户输入不再必 throw）
  // 中文关键词（cc-linker 面向飞书中文用户，英文不匹配时兜底）
  if (/(需求|规格|PRD|规格说明书)/.test(input.rawInput)) return 'spec';
  if (/(设计|架构|方案|实现方案|技术方案)/.test(input.rawInput)) return 'plan';
  if (/(修|修复|改|重构|实现|优化|bug|崩溃|报错|异常)/.test(input.rawInput)) return 'code';
  // 英文关键词
  if (/\b(spec|specification|requirements|PRD)\b/i.test(input.rawInput)) return 'spec';
  if (/\b(plan|design|architecture|implementation\s+plan)\b/i.test(input.rawInput)) return 'plan';
  if (/\b(fix|bug|refactor|implement|code|NPE|crash|error)\b/i.test(input.rawInput)) return 'code';

  // 未命中 → Phase 3 可加 LLM 分类（当前注释掉）
  throw new PhaseUnknownError(input.rawInput);
}
```

## 10. 错误处理

### 10.1 错误分类

| 错误类别 | 处理 |
|---------|------|
| Provider 不可用 | doctor fail fast |
| CLI 版本过低 | doctor fail fast |
| daemon 不健康 | PANE_LOST |
| bg session 消失 | PANE_LOST |
| 网络瞬态 503 | retry 3 次 + backoff -> FAILED `network_timeout` |
| JSON parse 失败 | retry 1 次 -> parse_degraded |
| max_rounds 达到 | ABORTED |
| review pane parse 失败 | retry -> 仍失败 -> ABORTED（review 已改代码，不能静默推进，详见 §7.5.4） |
| bg blocked（含 429 限流长 blocked / permission / 等输入） | ABORTED `unexpected_blocked`（v2.1.6：blocked 一律 abort；429 由 claude code 自身重试，长 blocked 才到此；详见 §4.3） |
| bg spawn 无效选项（如 `--cwd`） | FAILED（state=failed，实测 exit 1 before init） |

> **v2.1.3 删除**：`Context window 超限`（cascade 整组移除，裸奔）+ `Review opinions 写文件失败`（落盘整组移除）+ `cost 超 max_cost_usd`（成本统计整组移除）三行。
> **v2.1.3 新增（v2.1.6 简化）**：原 429 -> PAUSED + blocked 三分流（rate_limited/permission/unexpected）简化为 **blocked 一律 ABORTED unexpected_blocked**（429 由 claude code 自身重试，详见 §4.3/附录 C.9）；spawn 无效选项 -> FAILED（实测 `--cwd` 不可用）。

### 10.2 修复者不变量（v2.1.3 重写）

> 原 §10.2 "cascade 模式约束"（compact/reset 共享的 3 不变量）随 cascade 移除。v2.1.3 下不变量简化为：

1. **work 是自查自修的修复者**（R1/R2 -> FIXING，sessionId 跨轮不变）
2. **review 是外审+外修的修复者**（EXTERNAL_REVIEW 内 review 模型直接改代码，每轮新 session；v2.1.6：engine 不打 checkpoint，改动直接落用户分支）
3. **跨模型校验靠 postfix 复查闭环**：review 修完 -> work 下一轮 R1 复查 review 改动；verify-first 在两处都生效（work FIXING + review EXTERNAL_REVIEW）
4. **work/review 都不传 `--worktree`（不建 worktree）在原开发分支改文件，保留 CLAUDE.md/hook/LSP**；v2.1.6：engine 不打 checkpoint，改动直接落用户分支，回滚靠 review 前 HEAD

### 10.3 Graceful degradation vs fail fast

| 错误 | 处理 |
|------|------|
| Review pane 启动失败（spawn） | Fail fast：FAILED（外审是收敛必经节点，v2.1.3 无论如何都跑一轮，无法降级跳过） |
| Review pane parse 失败 | ABORTED（review 已改代码，不能静默推进，详见 §7.5.4 / §10.1） |
| Work pane 启动失败 | Fail fast：FAILED |
| Profile 加载失败 | Fail fast：exit 1 |

### 10.4 Retry 策略

> Review Engine 不复用 ClaudeSessionManager（后者是 Feishu 通道的），自建两层 retry：

```typescript
// Layer 1: parseBgOutputWithRetry（§7.5.4）- JSON parse 失败重试 1 次（resumeWorkSession 重生成；v2.1.5 P1-1：FIXING 改 resumeWorkSession，injectReply 退场）
// Layer 2: adapter 网络重试 — 503/502/timeout 重试 3 次，backoff 2s/4s/8s
// Layer 3: engine 级重试 — PANE_LOST → user retry → respawn（§5.3.3）
```

### 10.5 `cc-linker review doctor`

```bash
cc-linker review doctor
# ✓ Claude CLI: 2.1.207 (≥ 2.1.139)
# ✓ Daemon: healthy
# ✓ Profile 'default' loaded
# ✓ Provider 'claude-sonnet-4' (work): exists
# ✓ Provider 'kimi-for-coding' (review): exists
# ✓ Pipeline dir: writable
```

退出码 0 = 全通过，1 = 至少一个失败。

---

> **继续阅读**：[ux-and-plan.md](./ux-and-plan.md)（CLI UX / 测试 / 排期 / Checklist / 风险）
