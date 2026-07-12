# Review Engine v2.1.1 — 实现细节

> 属于 [overview.md](./overview.md) 的下游文件。

## 6. PipelineStore & Reconciler

### 6.0 共享类型定义

```typescript
/** Review issue（核心类型，贯穿全流程） */
interface Issue {
  id: string;                              // engine 分配的稳定 id（fingerprint 匹配，跨轮不变）
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
// adapter.poll 检测 state=blocked 时，按 needs/detail 分流（实测 F4）
interface BlockedResult {
  kind: "rate_limited" | "permission" | "unexpected";
  resumeAt?: string;   // rate_limited 时：从 detail/needs parse 出的重置时间（ISO）
  raw: string;         // 原始 needs/detail
}
// - needs 含 rate limited/429/使用上限/重置 -> rate_limited（engine 进 PAUSED）
// - needs 含 permission/allow/denied -> permission（engine ABORTED permission_denied）
// - 其他 -> unexpected（engine ABORTED unexpected_blocked）
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
}

interface PaneRegistry {
  work?: {
    sessionId: string;          // 跨轮不变
    currentRoundShortId?: string;
    provider: string;
    startedAt: string;
    roundShortIds: string[];
  };
  review?: {                    // v2.1.1 单数；v2.1.3 review 现在直接修代码
    role: 'review';
    shortId: string;
    sessionId: string;
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
  checkpointSha?: string | null;    // v2.1.3：engine 在阶段切换前打的 checkpoint（work FIXING / review EXTERNAL_REVIEW 各一次）
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

**触发时机**：daemon 启动 / 每 60s / daemon crash 后 / 用户手动 `reconcile`。

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
| running/ + state=PAUSED + resumeAt 已到 | 唤醒：回到 pausedFrom，继续 poll 同一 bg session（v2.1.3 新增） |
| running/ + state=PAUSED + resumeAt 未到 | 跳过（等下次轮询，间隔 `rate_limit_resume_poll_interval_ms`） |

> **v2.1.3 删除**：`human_pending/` 目录扫描 + HUMAN_DECIDE 4h 超时行（HUMAN_DECIDE 移除，无 human_pending 目录）；review opinions 文件恢复增强（review opinions 落盘整组移除，review findings 直接从 review pane 的 `state.json.output` 解析入 history）。
> **v2.1.3 新增**：PAUSED 唤醒--reconciler 每 `rate_limit_resume_poll_interval_ms`（默认 60s）扫描 running/ 中 state=PAUSED 的 pipeline，resumeAt 已到则回到 pausedFrom 继续 poll（bg session 未杀，保持 blocked，唤醒后自然推进）。PAUSED 态不占新 bg，不消耗配额。

**PANE_LOST retry**：
- review pane 丢失 → 重新 spawn
- work pane 丢失 → spawn 新 work session + 回到 R1 entry（检查 max_rounds）

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

# 429 限额挂起（v2.1.3 新增 PAUSED 态）
rate_limit_resume_poll_interval_ms = 60000   # PAUSED 态 reconciler 检查 resumeAt 的轮询间隔

# Phase 3 预留（当前 engine 未消费，实施时可忽略）
# max_token_in = 500000                # 单 pipeline input token 上限
# max_token_out = 100000               # 单 pipeline output token 上限
# api_rate_limit_strategy = "backoff"  # "backoff" | "fail-fast"
# api_rate_limit_429_backoff_ms = [2000, 4000, 8000, 16000]

# 模型 context 上限覆盖（v2.1.3：仅供报告展示，不再用于阈值检测）
[context_limits]
"claude-sonnet-4-5" = 1000000
"kimi-for-coding" = 256000
```

> **v2.1.3 删除的配置**：`human_decide_timeout_ms` / `p0_p1_reject_threshold`（HUMAN_DECIDE + JUDGE 移除）；`context_overflow_threshold_1m` / `context_overflow_threshold_percent` / `context_overflow_strategy` / `max_compact_attempts` / `compact_timeout_ms` / `max_injected_issues` / `max_context_resets_per_pipeline` / `max_reset_duration_ms`（context cascade 整组移除）；`max_cost_usd`（成本统计整组移除，实测 state.json 无 cost_usd）。`[context_limits]` 保留但仅供报告展示，不再驱动任何阈值判断。

**prompts 模板**见 [state-machine.md → §5.4](./state-machine.md#54-clean-判定与收敛逻辑v213-重写)（v2.1.3：clean 判定 + EXTERNAL_REVIEW 收敛逻辑）和以下 prompt 模板：

```toml
[prompts.work.produce.system]
template = """
你正在编写一份 {phase}。
{task}
"""

[prompts.work.self_review.system]
template = """
你是工作模型，对自己的产出做自查（identify only，不要修改文件）。
需求基准（spec/plan 或需求描述）：{task}

请先 cat 上述 spec/plan 理解需求，再自己决定 git diff 范围查看当前改动，
判断改动是否符合需求、有无 bug，识别问题（不要修改文件）。

{r1_or_r2_instruction}

输出 JSON: { "issues": [{ "id","severity","location","description" }], "unfixed_count": N }
"""
# {r1_or_r2_instruction} 在 engine 端替换：
# R1 initial:  "第一次自查，全面审查"
# R2 initial:  "审查修复后的状态"
# R1 postfix:  "postfix 循环：复查上一轮 external review 的修复"
# R2 postfix:  "审查 postfix 修复后的状态"

[prompts.work.fixing.system]
template = """
你是修复节点（FIXING）。调用来源：{source}
需求基准：{task}
待处理的问题列表：{input_issues}

严格 verify-first 流程：
1. 重新阅读相关代码，判断 real 还是 hallucination
2. 修复（仅 real），修改要最小化
3. 验证修复正确

直接在当前分支改文件，不要做 git 操作（checkpoint 由 engine 管理）。

输出 JSON:
{ "per_issue": [...], "all_real_fixed": bool, "remaining_real_unfixed_count": N }
"""

# v2.1.3：删 prompts.work.fixing.preamble -- checkpoint 由 engine 在 injectReply FIXING 前自己打
# v2.1.3：删 prompts.work.judge.system（JUDGE_BY_WORK 移除）

[prompts.review.code.system]
template = """
你是外部 Review 模型，对工作模型的产出做交叉评审并**直接修复**（v2.1.3：review 既审又修）。
需求基准（spec/plan 或需求描述）：{task}

请先 cat 上述 spec/plan 理解需求，再自己决定 git diff 范围查看当前改动，然后：
1. 识别问题，按 severity 分级（P0=Critical / P1=High / P2=Medium / P3=Low）
2. 逐条确认问题是否 real（避免 hallucination）
3. 对 real 问题直接修改代码（最小化改动），verify 修复正确
4. P3 问题可修可不修（不阻塞收敛，由你判断性价比）

直接在当前分支改文件，不要做 git 操作（checkpoint 由 engine 管理）。

输出 JSON:
{
  "issues": [{ "id", "severity", "location", "description", "suggestion" }],
  "per_issue": [{ "issue_id", "verdict": "real"|"hallucination", "verdict_reason", "fix_applied": bool, "fix_summary"? }],
  "reasoning": "..."
}
"""
# spec/plan phase 用 prompts.review.spec.system / prompts.review.plan.system，结构同上（{task} + 自选 diff + 直接修）

# v2.1.3：删 prompts.review.code.preamble -- checkpoint 由 engine 在 spawn review 前自己打

[phase_overrides.code]
review.provider = "kimi-for-coding"
guards.max_rounds = 6
```

> **v2.1.3 prompt 变更**：
> - 删 `prompts.work.judge.system`（JUDGE_BY_WORK 移除）
> - 删 `prompts.work.compact_continue.system`（cascade 移除）
> - 删 `prompts.work.fixing.preamble` + `prompts.review.code.preamble` -- **checkpoint 改由 engine 在阶段切换前自己打**（实测模型 git commit 行为不可控：会自建分支/worktree、commit message 乱来），模型只管改文件、不碰 git
> - `prompts.work.self_review.system` + `prompts.review.code.system` 统一用 `{task}`（spec/plan 或需求文本）作需求基准，模型自己 cat + 自选 `git diff` 范围，**engine 不构造 `{artifact}`**（删 per-phase artifact 构造逻辑）
> - `prompts.work.fixing.system` 去掉 @file 引用，改回 inline `{input_issues}`，加 `{task}` 上下文
> - `prompts.review.code.system` 从"只识别 issues"升级为"识别 + 确认 + 直接修 + verify"，输出 JSON 删 `checkpoint_sha`（engine 持有，不依赖模型自报）
> - 两类 checkpoint SHA（work `pre-fix` / review `pre-review`）由 engine 打，写入 `HistoryEvent.checkpointSha`，报告区分

### 7.2.1 engine checkpoint 边界 case

> v2.1.3：checkpoint 由 **engine** 在每个阶段切换前打（work FIXING 前一次、review EXTERNAL_REVIEW 前一次），模型不做 git 操作。engine 跑 `git -C <cwd> add -A && git commit -m "pre-<stage> checkpoint by review engine"`，捕获 SHA 写入 `HistoryEvent.checkpointSha`。

| 场景 | 处理 |
|------|------|
| cwd 不是 git 仓库 | 跳过 checkpoint，`checkpointSha: null`，报告标注"非 git repo，改动无回滚锚点" |
| 工作区有用户未提交改动 | engine 先 `git stash`（保护用户改动）再打 checkpoint，阶段结束不自动 pop（用户手动 pop） |
| commit 失败 | `checkpointSha: null` + warn，阶段继续（改动仍可 `git diff` 查看，只是无回滚锚点） |
| 非 `--bare` 误用导致 worktree | 不会发生--adapter 强制 `--bare`，doctor 校验 |

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
  // 策略 2: 最后一个 { ... } 块
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
  })),
  unfixed_count: z.number(),
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
    id: z.string(),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    location: z.string(),
    description: z.string(),
    suggestion: z.string().optional(),
  })),
  per_issue: z.array(z.object({
    issue_id: z.string(),
    verdict: z.enum(['real', 'hallucination']),
    verdict_reason: z.string(),
    fix_applied: z.boolean(),
    fix_summary: z.string().optional(),
  })),
  reasoning: z.string(),
});
```

> **v2.1.3 schema 变更**：删 `JudgeOutputSchema`（JUDGE_BY_WORK 移除）；`ReviewOutputSchema` 从"只输出 issues"升级为"issues + per_issue(含 fix_applied) + reasoning"（review 既审又修，删 checkpoint_sha--engine 打）。`SelfReviewOutputSchema` / `FixingOutputSchema` 保持不变。

#### 7.5.4 Parse 失败处理

```typescript
async function parseBgOutputWithRetry<T>(
  bg: ClaudeBGHandle,
  schema: z.ZodSchema<T>,
  opts: ParseRetryOptions,
): Promise<ParseResult<T>> {
  // 第 1 次 parse
  // 失败 → retry 1 次（注入 retry prompt，等 bg 重生成，timeoutMs 默认 15s）
  // 仍失败 → 返 ok:false + parseDegraded:true
}
```

**降级策略**：

| 场景 | v2.1.3 处理 |
|------|------------|
| Review pane parse 失败（EXTERNAL_REVIEW） | retry → 仍失败 → `parse_degraded: true` + **ABORTED**（review 既审又修，parse 失败无法判断是否已改代码，不能静默 DONE）|
| Work R1/R2 parse 失败 | retry → 仍失败 → ABORTED `r1_parse_degraded`（不静默 DONE） |
| FIXING parse 失败 | retry → 仍失败 → 视为 all_real_fixed=true（保守推进到 R2/EXTERNAL_REVIEW 复查） |

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

  // 优先级 4: 关键词匹配
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
| 429 限额耗尽（blocked + needs rate limited） | PAUSED（parse 重置时间，reconciler 到点唤醒，详见 §5/§6.4） |
| blocked + needs permission/allow | ABORTED `permission_denied`（--bare 无 permission 通道） |
| blocked + needs 其他 | ABORTED `unexpected_blocked`（review engine 无交互通道） |
| bg spawn 无效选项（如 `--cwd`） | FAILED（state=failed，实测 exit 1 before init） |

> **v2.1.3 删除**：`Context window 超限`（cascade 整组移除，裸奔）+ `Review opinions 写文件失败`（落盘整组移除）+ `cost 超 max_cost_usd`（成本统计整组移除）三行。
> **v2.1.3 新增**：429 限额耗尽 -> PAUSED（国产模型周/月限额常态，实测）；blocked 分流（permission/unexpected -> ABORTED）；spawn 无效选项 -> FAILED（实测 `--cwd` 不可用）。

### 10.2 修复者不变量（v2.1.3 重写）

> 原 §10.2 "cascade 模式约束"（compact/reset 共享的 3 不变量）随 cascade 移除。v2.1.3 下不变量简化为：

1. **work 是自查自修的修复者**（R1/R2 -> FIXING，sessionId 跨轮不变）
2. **review 是外审+外修的修复者**（EXTERNAL_REVIEW 内 review 模型直接改代码，每轮新 session；checkpoint 由 engine 打）
3. **跨模型校验靠 postfix 复查闭环**：review 修完 -> work 下一轮 R1 复查 review 改动；verify-first 在两处都生效（work FIXING + review EXTERNAL_REVIEW）
4. **work/review 都用 `--bare` 在原开发分支改文件**，不建 worktree；engine 用 git checkpoint 隔离各阶段改动

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
// Layer 1: parseBgOutputWithRetry（§7.5.4）— JSON parse 失败重试 1 次（injectReply 重生成；v2.1.3：injectReply 仅 work FIXING 用）
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
