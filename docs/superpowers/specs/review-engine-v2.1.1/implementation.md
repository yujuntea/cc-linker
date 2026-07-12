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
  checkpointSha: string | null;            // review preamble 打的 checkpoint（非 git repo → null）
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
  totalCostUsd: number;
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
  costUsd: number;
  durationMs: number;
  issues?: Issue[];
  checkpointSha?: string | null;    // v2.1.3：FIXING 与 EXTERNAL_REVIEW 各自 preamble 打的 checkpoint
}
```

> **v2.1.3 删除的字段**：`PipelineRecord.contextResets` / `contextOverflowCount` / `contextFiles` 全部移除（context cascade + review opinions 落盘整组移除）；`PaneRegistry.review.cycle` 移除（review pane 不再区分 initial/postfix，每轮新 session）；`HistoryEvent.verdict` / `fixingCheckpointSha` 合并重命名为统一 `checkpointSha`（FIXING 与 EXTERNAL_REVIEW 共用）。

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

> **v2.1.3 删除**：`human_pending/` 目录扫描 + HUMAN_DECIDE 4h 超时行（HUMAN_DECIDE 移除，无 human_pending 目录）；review opinions 文件恢复增强（review opinions 落盘整组移除，review findings 直接从 review pane 的 `state.json.output` 解析入 history）。

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

# 成本硬约束
max_cost_usd = 5.00

# Phase 3 预留（v2.1.2 评审标注：当前 engine 未消费，实施时可忽略）
# max_token_in = 500000                # 单 pipeline input token 上限
# max_token_out = 100000               # 单 pipeline output token 上限
# api_rate_limit_strategy = "backoff"  # "backoff" | "fail-fast"
# api_rate_limit_429_backoff_ms = [2000, 4000, 8000, 16000]

# 模型 context 上限覆盖（v2.1.3：仅供报告展示，不再用于阈值检测）
[context_limits]
"claude-sonnet-4-5" = 1000000
"kimi-for-coding" = 256000
```

> **v2.1.3 删除的配置**：`human_decide_timeout_ms` / `p0_p1_reject_threshold`（HUMAN_DECIDE + JUDGE 移除）；`context_overflow_threshold_1m` / `context_overflow_threshold_percent` / `context_overflow_strategy` / `max_compact_attempts` / `compact_timeout_ms` / `max_injected_issues` / `max_context_resets_per_pipeline` / `max_reset_duration_ms`（context cascade 整组移除）。`[context_limits]` 保留但仅供报告展示，不再驱动任何阈值判断。

**prompts 模板**见 [state-machine.md → §5.4](./state-machine.md#54-clean-判定与收敛逻辑v213-重写)（v2.1.3：clean 判定 + EXTERNAL_REVIEW 收敛逻辑）和以下 prompt 模板：

```toml
[prompts.work.produce.system]
template = """
你正在编写一份 {phase}。
{task}
"""

[prompts.work.self_review.system]
template = """
你的产出（来自 {previous_stage} 阶段）：
{artifact}

{r1_or_r2_instruction}

请审查并识别问题（不要修改文件）：
输出 JSON: { "issues": [...], "unfixed_count": N }
"""
# {r1_or_r2_instruction} 在 engine 端替换：
# R1 initial:  "第一次自查，全面审查"
# R2 initial:  "审查修复后的状态"
# R1 postfix:  "postfix 循环第一轮自查"
# R2 postfix:  "审查 postfix 修复后的状态"

[prompts.work.fixing.system]
template = """
你是修复节点（FIXING）。调用来源：{source}
待处理的问题列表：{input_issues}

严格 verify-first 流程：
1. 重新阅读相关代码，判断 real 还是 hallucination
2. 修复（仅 real），修改要最小化
3. 验证修复正确

输出 JSON:
{ "per_issue": [...], "all_real_fixed": bool, "remaining_real_unfixed_count": N }
"""

[prompts.work.fixing.preamble]
enabled = true
template = """
在做任何修改前：
1. git status --porcelain 检查工作区
2. 如有用户未提交改动 → git stash
3. 只 add FIXING 改的文件（不要 git add -A）
4. git commit -m "pre-fix checkpoint by review engine"
5. 捕获 checkpoint SHA
6. 然后开始 verify-first + fix
"""

# v2.1.3：删 prompts.work.judge.system（JUDGE_BY_WORK 移除）

[prompts.review.code.system]
template = """
你是外部 Review 模型。对工作产物做交叉评审并**直接修复**（v2.1.3：review 既审又修）。
工作产物：{artifact}

流程（单个 turn 内完成）：
1. 识别问题，按 severity 分级（P0=Critical / P1=High / P2=Medium / P3=Low）
2. 逐条确认问题是否 real（避免 hallucination）
3. 对 real 问题直接修改代码（最小化改动），verify 修复正确
4. P3 问题可修可不修（不阻塞收敛，由你判断性价比）

输出 JSON:
{
  "issues": [{ "id", "severity", "location", "description", "suggestion" }],
  "per_issue": [{ "issue_id", "verdict": "real"|"hallucination", "verdict_reason", "fix_applied": bool, "fix_summary"? }],
  "checkpoint_sha": "<git preamble 打的 SHA，非 git repo 则 null>",
  "reasoning": "..."
}
"""

[prompts.review.code.preamble]
enabled = true
template = """
在做任何修改前：
1. git status --porcelain 检查工作区
2. 如有用户未提交改动 → git stash
3. 只 add review 改的文件（不要 git add -A）
4. git commit -m "pre-review-fix checkpoint by review engine"
5. 捕获 checkpoint SHA 填入输出 JSON 的 checkpoint_sha
6. 然后开始识别 + verify-first + 修复
"""

[phase_overrides.code]
review.provider = "kimi-for-coding"
guards.max_rounds = 8
```

> **v2.1.3 prompt 变更**：
> - 删 `prompts.work.judge.system`（JUDGE_BY_WORK 移除）
> - 删 `prompts.work.compact_continue.system`（cascade 移除）
> - `prompts.work.fixing.system` 去掉对 review opinions 文件的 @file 引用，改回 inline `{input_issues}`（review opinions 落盘移除）
> - `prompts.review.code.system` 从"只识别 issues"升级为"识别 + 确认 + 直接修 + verify + 输出 checkpoint_sha"
> - 新增 `prompts.review.code.preamble`：review 修复前打 checkpoint（与 work FIXING 同构，便于回滚）
> - `prompts.work.fixing.preamble` 的 commit message 保持 `pre-fix checkpoint`，review 用 `pre-review-fix checkpoint`，报告里区分两类 SHA

### 7.2.1 commit preamble 边界 case

> v2.1.3：preamble 现有两处——work FIXING 与 review EXTERNAL_REVIEW，规则同构，下表对两者都适用。

| 场景 | 处理 |
|------|------|
| cwd 不是 git 仓库 | `checkpoint_sha: null` |
| `preamble.enabled = false` | 跳过前置指令 |
| commit 失败 | `checkpoint_sha: null` + warn |

### 7.3 per-phase 深度 merge 规则

- 标量字段：phase 值完全覆盖 top-level
- table 字段（prompts）：深度 merge

### 7.4 Provider 字段 → settingsPath 映射

```typescript
async function resolveSettingsPath(provider: string): Promise<string> {
  const path = `${process.env.HOME}/.claude/providers/${provider}.json`;
  if (!existsSync(path)) {
    throw new ProfileError({
      code: 'PROVIDER_NOT_FOUND',
      message: `provider '${provider}' 不在 ~/.claude/providers/`,
      remediation: `放置 ~/.claude/providers/${provider}.json`,
    });
  }
  return path;
}
```

**模型 context 上限来源**（v2.1.3：仅供报告展示，不再驱动任何阈值判断）：

| 来源 | 用途 |
|------|------|
| provider 文件名后缀（如 `kimi-for-coding[256k]`） | `parseModelFromProviderEnv` 解析为 `contextHint`，写入报告 |
| profile `[context_limits]` 覆盖 | profile 级显式声明，优先于后缀 |
| 都没有 | `contextHint = null`，报告中显示 "unknown" |

> **v2.1.3 变更**：删除内置 `KNOWN_CONTEXT_LIMITS` 表（context 上限不再用于阈值检测）。原表中的常见模型上限仍可作为 profile `[context_limits]` 的参考值填写，但 engine 不再内置硬编码。

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
  checkpoint_sha: z.string().nullable(),
  reasoning: z.string(),
});
```

> **v2.1.3 schema 变更**：删 `JudgeOutputSchema`（JUDGE_BY_WORK 移除）；`ReviewOutputSchema` 从"只输出 issues"升级为"issues + per_issue(含 fix_applied) + checkpoint_sha + reasoning"（review 既审又修）。`SelfReviewOutputSchema` / `FixingOutputSchema` 保持不变。

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
> 移除理由：删 JUDGE_BY_WORK 后 work 不再做 judge / 外审 fix，context 累积速度大幅下降；常规 2-4 轮不会 overflow，主动检测 + cascade 的复杂度不再划算。极端情况下由 `max_rounds` + `max_cost_usd` 兜底收敛。
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
| 网络瞬态 503 | retry 3 次 + backoff → FAILED `network_timeout` |
| JSON parse 失败 | retry 1 次 → parse_degraded |
| max_rounds 达到 | ABORTED |
| review pane parse 失败 | retry → 仍失败 → ABORTED（review 已改代码，不能静默推进，详见 §7.5.4） |
| cost 超 max_cost_usd | ABORTED `budget_exceeded` |

> **v2.1.3 删除**：`Context window 超限`（cascade 整组移除，裸奔）+ `Review opinions 写文件失败`（落盘整组移除）两行。

### 10.2 修复者不变量（v2.1.3 重写）

> 原 §10.2 "cascade 模式约束"（compact/reset 共享的 3 不变量）随 cascade 移除。v2.1.3 下不变量简化为：

1. **work 是自查自修的唯一修复者**（R1/R2 → FIXING，sessionId 跨轮不变）
2. **review 是外审+外修的修复者**（EXTERNAL_REVIEW 内 review 模型直接改代码，每轮新 session + 自己的 checkpoint）
3. **跨模型校验靠 postfix 复查闭环**：review 修完 → work 下一轮 R1 复查 review 改动；verify-first 在两处都生效（work FIXING + review EXTERNAL_REVIEW）

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
# ✓ Claude CLI: 2.1.163
# ✓ Daemon: healthy
# ✓ Profile 'default' loaded
# ✓ Provider 'claude-sonnet-4' (work): exists
# ✓ Provider 'kimi-for-coding' (review): exists
# ✓ Pipeline dir: writable
```

退出码 0 = 全通过，1 = 至少一个失败。

---

> **继续阅读**：[ux-and-plan.md](./ux-and-plan.md)（CLI UX / 测试 / 排期 / Checklist / 风险）
