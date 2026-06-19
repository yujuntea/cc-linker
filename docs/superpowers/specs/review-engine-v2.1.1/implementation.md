# Review Engine v2.1.1 — 实现细节

> 属于 [overview.md](./overview.md) 的下游文件。

## 6. PipelineStore & Reconciler

### 6.0 共享类型定义

```typescript
/** Review issue（核心类型，贯穿全流程） */
interface Issue {
  id: string;                              // engine 分配的稳定 id（fingerprint 匹配，跨轮不变）
  role: 'work' | 'review';                 // 来源角色
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  location: string;                        // 文件路径 + 行号
  description: string;
  suggestion?: string;
  fingerprint: string;                     // SHA256(role:severity:location:description) 前 8 位
}

/** Context overflow 检测结果（§7.5.7） */
interface ContextCheckResult {
  overflow: boolean;
  reason: 'no_usage_data' | 'usage_above_threshold';
  usage: { used: number; max: number; model: string } | null;
  threshold: number;
  model: string;
  costIncurred: number;
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

/** Review 意见（EXTERNAL_REVIEW 产出） */
interface ReviewOpinion {
  role: 'review';
  issues: Issue[];
}

/** Work session 对 issue 的决策（JUDGE_BY_WORK 产出） */
interface WorkDecision {
  issue_id: string;
  decision: 'accept' | 'reject' | 'partial';
  reason: string;
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
  contextResets?: ContextResetEvent[];
  /** v2.1.2：context overflow 累计触发次数（每次 EXTERNAL_REVIEW.done 超阈值 +1） */
  contextOverflowCount?: number;
  /** v2.1.2：EXTERNAL_REVIEW opinions 落盘路径（worker 通过 @file 引用） */
  contextFiles?: {
    externalReviewJson?: string;
    externalReviewMd?: string;
  };
}

interface PaneRegistry {
  work?: {
    sessionId: string;          // 跨轮不变
    currentRoundShortId?: string;
    provider: string;
    startedAt: string;
    roundShortIds: string[];
  };
  review?: {                    // v2.1.1 单数
    role: 'review';
    shortId: string;
    sessionId: string;
    provider: string;
    round: number;
    cycle: 'initial' | 'postfix';
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

interface ContextResetEvent {
  ts: string;
  triggerRound: number;
  usageBefore: { used: number; max: number; model: string };
  /** v2.1.2：增加 'compact' 档 */
  strategy: 'compact' | 'reset' | 'abort';
  checkpointSha: string | null;   // compact 档为 null（无需 git checkpoint）
  injectedIssueCount?: number;
  /** v2.1.2：compact 档记录 post-compact usage，用于验证 compact 是否有效 */
  postUsage?: { used: number; max: number; model: string };
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
  verdict?: 'accept' | 'reject';
  fixingCheckpointSha?: string | null;
}
```

### 6.2 持久化目录

```
~/.cc-linker/review-pipelines/
├── running/         # 正在跑（最多 max_concurrent_pipelines 个）
├── human_pending/   # 等待人工决策
├── done/            # 已完成
├── failed/          # 失败
└── aborted/         # 中止
```

**5 目录**（不使用 pending/）。原子写规则：写 `.tmp` 再 `rename`。

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
4. **文件锁**：`~/.cc-linker/review-pipelines/<pipelineId>.lock`（per-pipeline，`proper-lockfile`）

**FIXING source-aware 幂等性**：FIXING 必须 source + inputIssues 都匹配才算幂等。

### 6.4 Reconciler

**触发时机**：daemon 启动 / 每 60s / daemon crash 后 / 用户手动 `reconcile`。

```typescript
async function reconcile(): Promise<ReconcileResult> {
  await acquireLock('~/.cc-linker/review-pipelines/.lock');
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
| human_pending/ | 发 CLI watch 通知 |
| HUMAN_DECIDE 4h 超时 | cleanup → ABORTED |
| PANE_LOST 24h 超时 | cleanup → ABORTED |

**PANE_LOST retry**：
- review pane 丢失 → 重新 spawn
- work pane 丢失 → spawn 新 work session + 回到 R1 entry（检查 max_rounds）

### 6.5 并发控制

默认 1 个 pipeline 同时跑，profile 可配 `guards.max_concurrent_pipelines = 3`。

### 6.6 Abort / Cleanup 流程

**触发**：用户 cancel / max_rounds / HUMAN_DECIDE 4h / PANE_LOST 24h。

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
human_decide_timeout_ms = 14400000   # 4h 默认
p0_p1_reject_threshold = 0.30

# context overflow 策略（v2.1.2 cascade）
context_overflow_threshold_1m = 460000         # 1M 模型阈值（>512K 模型效率显著下降，故降到 460K）
context_overflow_threshold_percent = 0.80     # 非 1M 模型：max * 80%（修 128K/200K 模型 bug）
context_overflow_strategy = "cascade"         # v2.1.2：唯一策略 = cascade（compact → reset → abort）
max_compact_attempts = 1                      # v2.1.2：compact 档最多尝试次数（n=1 试 compact，n≥2 直接 reset）
compact_timeout_ms = 30000                    # /compact 单次超时（30s）
max_injected_issues = 20

# parse retry
parse_retry_timeout_ms = 15000

# 成本/性能硬约束
max_cost_usd = 5.00
max_context_resets_per_pipeline = 1
max_reset_duration_ms = 120000
max_token_in = 500000
max_token_out = 100000
api_rate_limit_strategy = "backoff"          # "backoff" | "fail-fast"
api_rate_limit_429_backoff_ms = [2000, 4000, 8000, 16000]

# 模型 context 上限覆盖
[context_limits]
"claude-sonnet-4-5" = 1000000
"kimi-for-coding" = 256000
```

**prompts 模板**见 [state-machine.md → §5.4](./state-machine.md#54-verdict-decision-logic) 和以下 prompt 模板：

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

[prompts.work.judge.system]
template = """
工作产物：{artifact}
外部 review issues：{reviews_json_for_each_role}
逐条评估：accept / reject / partial
输出 JSON: { "per_issue": [...], "reasoning": "..." }
"""

[prompts.review.code.system]
template = """
Review 代码变更。{artifact}
输出 JSON: { issues: [{ severity, category, location, description, suggestion }] }
"""

[phase_overrides.code]
review.provider = "kimi-for-coding"
guards.max_rounds = 8
```

### 7.2.1 commit preamble 边界 case

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

**模型 context 上限映射表**：

| Provider | Context 上限 | 来源 |
|----------|-------------|------|
| `claude-sonnet-4` | 200k | 内置 |
| `claude-sonnet-4-5` | 1M | 内置 |
| `claude-opus-4` | 200k | 内置 |
| `kimi-for-coding` | 256k | 内置 |
| `bailian-qwen3.6` | 128k | 内置 |
| `MiniMax-M3` / `M3.5` | 1M | 内置 |
| 自定义 | profile `[context_limits]` 覆盖 | profile 级优先 |

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

const JudgeOutputSchema = z.object({
  per_issue: z.array(z.object({
    issue_id: z.string(),
    decision: z.enum(['accept', 'reject', 'partial']),
    reason: z.string(),
  })),
  reasoning: z.string(),
});

const ReviewOutputSchema = z.object({
  issues: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    category: z.string().optional(),
    location: z.string(),
    description: z.string(),
    suggestion: z.string().optional(),
  })),
});
```

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

| 场景 | v2.1.1 处理 |
|------|------------|
| Review pane parse 失败 | retry → 仍失败 → `parse_degraded: true` + 排除该 review |
| Work R1/R2 parse 失败 | retry → 仍失败 → ABORTED `r1_parse_degraded`（不静默 DONE） |
| JUDGE parse 失败 | retry → 仍失败 → 视为全部 accept |
| FIXING parse 失败 | retry → 仍失败 → 视为 all_real_fixed=true |

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

#### 7.5.7 Context Window 策略化处理

##### 7.5.7.1 触发点（v2.1.2 cascade 入口）

> **档位随配置变化**（重要）：默认 `max_compact_attempts = 1` → **3 档**（compact / reset / abort）；如果配置 `max_compact_attempts = N`，实际档位是 **N + 2**（N 次 compact / 1 次 reset / 1 次 abort）。配错会导致行为不符合直觉：例如 `max_compact_attempts=2` 会在 n=1 和 n=2 都试 compact，n=3 才 reset，n≥4 abort。

在 `onExternalReviewComplete` 内同步调用 `checkContextOverflow()` + cascade dispatch：

```typescript
async function onExternalReviewComplete(pipeline: PipelineRecord): Promise<void> {
  const contextCheck = await checkContextOverflow(pipeline.panes.work!.currentRoundShortId!, profile);

  if (!contextCheck.overflow) {
    // context OK：先写文件（让后续 JUDGE_BY_WORK 可以 @file 引用），再正常推进
    await writeReviewOpinionsToFile(pipeline, currentReviewOpinions(pipeline));
    await transitionTo(pipeline, 'JUDGE_BY_WORK');
    return;
  }

  // 超阈值：累计 +1，进入 cascade
  pipeline.contextOverflowCount = (pipeline.contextOverflowCount ?? 0) + 1;
  const n = pipeline.contextOverflowCount;

  // 无论哪一档，都先写 review opinions 文件（compact/reset 都要用）
  await writeReviewOpinionsToFile(pipeline, currentReviewOpinions(pipeline));

  // 3 档 cascade dispatch
  const maxCompact = profile.guards.max_compact_attempts ?? 1;
  if (n <= maxCompact) {
    // n=1: 试 compact
    const compactOk = await executeContextCompact(pipeline, contextCheck, profile);
    if (!compactOk) {
      // compact 失败 / 仍超阈值 → 升级到 reset
      await executeContextReset(pipeline, contextCheck, profile);
    }
  } else if (n === maxCompact + 1) {
    // n=2: 直接 reset（不再试 compact，避免重复失败）
    await executeContextReset(pipeline, contextCheck, profile);
  } else {
    // n≥3: abort（max attempts reached）
    await executeContextAbort(pipeline, contextCheck);
  }
}
```

**为什么 compact 失败也要 cascade 内升级到 reset？**
- compact 失败说明 context 已极度饱和（剩余空间不够 summarization）
- 此时再试 compact 没意义，直接 reset 是唯一出路
- 这避免"compact → 失败 → 再 compact → 再失败"的循环

##### 7.5.7.2 阈值判断（v2.1.2 修 bug）

**问题**：原版 `maxContext >= 1_000_000` 分支绝对值阈值（512K / 200K）在 128K 模型上**永不会触发**（max < threshold）。

**新规则**：百分比 + 绝对值混合，按模型 context 上限分档：

```typescript
function resolveThreshold(usage: ContextUsage, profile: ReviewProfile): number {
  const max = profile.contextLimits?.[usage.model] ?? usage.max;

  if (max >= 1_000_000) {
    // 1M+ 模型：固定 460K（>512K 模型效率显著下降，故降到 460K 提前干预）
    return profile.guards.context_overflow_threshold_1m ?? 460_000;
  }
  // 其他模型：百分比（默认 80%），正确处理 128K / 200K / 256K 模型
  const percent = profile.guards.context_overflow_threshold_percent ?? 0.80;
  return Math.floor(max * percent);
}

async function checkContextOverflow(workShortId, profile): Promise<ContextCheckResult> {
  const usage = await adapter.getContextUsage(workShortId);
  if (!usage) return { overflow: false, reason: 'no_usage_data', ... };

  const threshold = resolveThreshold(usage, profile);
  return { overflow: usage.used >= threshold, usage, threshold, ... };
}
```

**修复前后对比**：

| 模型 | max | v2.1.1 threshold | v2.1.2 threshold | v2.1.2 触发点 | 评估 |
|------|-----|-----------------|------------------|--------------|------|
| `MiniMax-M3` | 1M | 512K (50%) | 460K (46%) | used ≥ 460K | ✅ 提前干预 |
| `claude-sonnet-4-5` | 1M | 512K (50%) | 460K (46%) | used ≥ 460K | ✅ 提前干预 |
| `claude-sonnet-4` | 200K | 200K (100%) | 160K (80%) | used ≥ 160K | ✅ 修太晚触发 |
| `kimi-for-coding` | 256K | 200K (78%) | 204K (80%) | used ≥ 204K | ✅ 略晚于原版 |
| `bailian-qwen3.6` | 128K | 200K (不可能) | 102K (80%) | used ≥ 102K | ✅ 修永不会触发 |

##### 7.5.7.3 策略 1：`compact`（v2.1.2 新增，第 1 档）

**触发**：cascade n=1（首次超阈值）

**做法**：在同 session 内 injectReply `/compact` → 等 compact 完成 → 重新检查 usage → 若降到阈值以下则注入 JUDGE prompt（同 session 继续）。

**前置条件**：work session 必须还活着 + `/compact` CLI 支持（Claude CLI ≥ 2.1.163 满足）。

**4 个不变量**：
1. work session 仍是唯一修复者（sessionId 跨 compact 不变）
2. context 缩到阈值以下，但 issue 记忆通过 `writeReviewOpinionsToFile` 保留（worker 用 @file 引用）
3. verify-first 不变
4. 同 session 连续，pipeline 不增 round

```typescript
async function executeContextCompact(
  pipeline: PipelineRecord,
  contextCheck: ContextCheckResult,
  profile: ReviewProfile,
): Promise<boolean> {  // 返回 true = compact 成功，false = 失败需升级
  const signal = pipelineState.get(pipeline.pipelineId)?.abortController.signal;
  const checkAbort = () => {
    if (signal?.aborted) throw new AbortError('compact aborted by user cancel');
  };

  const workShortId = pipeline.panes.work!.currentRoundShortId!;

  try {
    // 1. injectReply /compact（不需要新 prompt template，复用 CLI 内置命令）
    await adapter.injectReply({
      shortId: workShortId,
      text: '/compact',
    });
    checkAbort();

    // 2. 等 compact 完成（poll state.json 到 done/blocked）
    const compactTimeout = profile.guards.compact_timeout_ms ?? 30_000;
    await adapter.poll(workShortId, compactTimeout);
    checkAbort();

    // 3. 重新测 usage
    const postUsage = await adapter.getContextUsage(workShortId);
    if (!postUsage) {
      logger.warn(`Compact ${workShortId}: post-compact usage unavailable, escalating to reset`);
      return false;
    }

    if (postUsage.used >= contextCheck.threshold) {
      logger.warn(`Compact ${workShortId}: post-compact usage ${postUsage.used} >= threshold ${contextCheck.threshold}, escalating`);
      return false;
    }

    // 4. compact 成功：注入 JUDGE prompt（用 @file 引用 review 文件）
    const continuePrompt = buildCompactContinuePrompt({
      pipelineId: pipeline.pipelineId,
      externalReviewMdPath: pipeline.contextFiles!.externalReviewMd!,
      externalReviewJsonPath: pipeline.contextFiles!.externalReviewJson!,
      contextUsageBefore: contextCheck.usage!,
      contextUsageAfter: postUsage,
      round: pipeline.state.round,
    });
    await adapter.injectReply({
      shortId: workShortId,
      text: continuePrompt,
    });
    checkAbort();

    // 5. 更新 state：EXTERNAL_REVIEW → JUDGE_BY_WORK（同 session）
    pipeline.state = {
      kind: 'JUDGE_BY_WORK',
      pipelineId: pipeline.pipelineId,
      round: pipeline.state.round,
      pane: 'work',
      contextOverflowApplied: 'compact',
    };

    // 6. 记录 context overflow 事件（checkpointSha=null 因为同 session 无需 commit）
    pipeline.contextResets = pipeline.contextResets ?? [];
    pipeline.contextResets.push({
      ts: new Date().toISOString(),
      triggerRound: pipeline.state.round,
      usageBefore: contextCheck.usage!,
      strategy: 'compact',
      checkpointSha: null,
      injectedIssueCount: countIssuesInReviewOpinions(currentReviewOpinions(pipeline)),
      postUsage: { used: postUsage.used, max: postUsage.max, model: postUsage.model },
    });

    await pipelineStore.saveRunning(pipeline);
    return true;
  } catch (err) {
    // compact 失败（超时、CLI error、PANE_LOST 等）→ 升级 reset
    logger.warn(`Compact ${workShortId} failed: ${err.message}, escalating to reset`);
    return false;
  }
}
```

**compact prompt 模板**：

```toml
[prompts.work.compact_continue.system]
template = """
你的 context 在前一轮 EXTERNAL_REVIEW 后已 compact：
- compact 前 usage: {context_usage_before_used} / {context_usage_before_max} tokens
- compact 后 usage: {context_usage_after_used} / {context_usage_after_max} tokens

外部 review 意见已写入文件（请用 @file 引用，不要 inline 复制）：
- 可读版: @{external_review_md_path}
- 结构化: @{external_review_json_path}

请先 cat 可读版了解 review 意见，然后逐条判断 accept / reject / partial。
输出 JSON: { "per_issue": [...], "reasoning": "..." }
"""
```

##### 7.5.7.4 策略 2：`reset`（v2.1.2 第 2 档）

**触发**：cascade n=2（compact 失败或二次超阈值）

**做法**：杀 work → spawn 新 work → 注入 review issues + history + docs → worker verify+fix → DONE。

**3 个不变量**：
1. work session 仍是唯一修复者（新 sessionId）
2. context fresh + issue 记忆保留（injectedIssues + history + relatedDocs + @file 引用 review opinions）
3. verify-first 不变

```typescript
async function executeContextReset(
  pipeline: PipelineRecord,
  contextCheck: ContextCheckResult,
  profile: ReviewProfile,
): Promise<void> {
  const signal = pipelineState.get(pipeline.pipelineId)?.abortController.signal;
  const checkAbort = () => {
    if (signal?.aborted) throw new AbortError('reset aborted by user cancel');
  };

  try {
    const workShortId = pipeline.panes.work!.currentRoundShortId!;

    // 1. snapshot cwd（compact 升级到 reset 时也走这一步）
    const checkpointSha = await snapshotCwd(pipeline.input.cwd, `pre-context-reset for pipeline ${pipeline.pipelineId} (cascade n=${pipeline.contextOverflowCount})`);
    checkAbort();

    // 2. 收集给新 worker 的"外部记忆"
    const { issues: injectedIssues, truncatedCount } = collectAllExternalReviewIssues(pipeline, profile);
    const historySummary = generateRoundSummary(pipeline);
    const relatedDocs = collectRelatedDocs(pipeline, injectedIssues);
    checkAbort();

    // 3. kill work session
    await adapter.stop(workShortId);
    checkAbort();

    // 4. spawn 新 work session with 完整 context（@file 引用 review opinions）
    const newWorkPrompt = buildContextResetPrompt({
      pipelineId: pipeline.pipelineId,
      contextUsage: contextCheck.usage,
      checkpointSha,
      historySummary,
      injectedIssues,
      relatedDocs,
      truncatedCount,
      nextRound: pipeline.state.round + 1,
      externalReviewMdPath: pipeline.contextFiles?.externalReviewMd,
      externalReviewJsonPath: pipeline.contextFiles?.externalReviewJson,
    });
    const newWork = await adapter.startSession({
      role: 'work',
      provider: profile.work.provider,
      prompt: newWorkPrompt,
      cwd: pipeline.input.cwd,
    });
    checkAbort();

    // 5. 更新 panes + state
    pipeline.panes.work = {
      sessionId: newWork.sessionId,
      currentRoundShortId: newWork.shortId,
      provider: profile.work.provider,
      startedAt: new Date().toISOString(),
      roundShortIds: [newWork.shortId],
    };
    pipeline.state = {
      kind: 'SELF_REVIEW_R1',
      pipelineId: pipeline.pipelineId,
      round: pipeline.state.round + 1,
      cycle: 'postfix',
      pane: 'work',
      contextOverflowApplied: 'reset',
      injectedIssues,
    };

    // 6. 记录 context overflow 事件
    pipeline.contextResets = pipeline.contextResets ?? [];
    pipeline.contextResets.push({
      ts: new Date().toISOString(),
      triggerRound: pipeline.state.round - 1,
      usageBefore: { used: contextCheck.usage.used, max: contextCheck.usage.max, model: contextCheck.usage.model },
      strategy: 'reset',
      checkpointSha,
      injectedIssueCount: injectedIssues.length,
    });

    await pipelineStore.saveRunning(pipeline);
  } catch (err) {
    // spawn 失败 → ABORTED reason=context_reset_spawn_failed
    await cleanupPipeline(pipeline.pipelineId, 'context_reset_spawn_failed');
    pipeline.state = {
      kind: 'ABORTED',
      pipelineId: pipeline.pipelineId,
      round: pipeline.state.round,
      reason: 'context_reset_spawn_failed',
      abortedBefore: 'EXTERNAL_REVIEW',
    };
    await pipelineStore.saveRunning(pipeline);
  }
}
```

##### 7.5.7.5 策略 3：`abort`（v2.1.2 第 3 档）

**触发**：cascade n≥3（max attempts reached）

cleanup → ABORTED reason=`context_overflow_max_attempts`。

```typescript
async function executeContextAbort(
  pipeline: PipelineRecord,
  contextCheck: ContextCheckResult,
): Promise<void> {
  await cleanupPipeline(pipeline.pipelineId, 'context_overflow_max_attempts');
  pipeline.state = {
    kind: 'ABORTED',
    pipelineId: pipeline.pipelineId,
    round: pipeline.state.round,
    reason: 'context_overflow_max_attempts',   // v2.1.2：从 'context_overflow' 区分
    abortedBefore: 'EXTERNAL_REVIEW',
  };
  pipeline.contextResets!.push({
    ts: new Date().toISOString(),
    triggerRound: pipeline.state.round,
    usageBefore: contextCheck.usage!,
    strategy: 'abort',
    checkpointSha: null,
  });
  await pipelineStore.saveRunning(pipeline);
}
```

---

#### 7.5.8 Review Opinions 落盘（v2.1.2 新增）

**动机**：EXTERNAL_REVIEW 完成时，review opinions 之前只在内存里，injectReply 时塞进 prompt。问题：
- prompt 膨胀（review issues >10 条时 prompt 可能超 30K tokens）
- worker 无法用 `@file` 精确定位
- 跨崩溃恢复时 Reconciler 拿不到 review 历史

**方案**：EXTERNAL_REVIEW 完成时，把 opinions 写到 `~/.cc-linker/review-pipelines/<pipelineId>/state/external-review-r<N>.{json,md}`，JUDGE/FIXING prompt 改用 `@file` 引用。

##### 7.5.8.1 路径规则

```
~/.cc-linker/review-pipelines/
└── <pipelineId>/
    ├── running.json                    # PipelineRecord 主文件
    ├── state/                          # v2.1.2 新增：context-related artifacts
    │   ├── external-review-r1.json     # 第 1 轮 external review 产出（结构化）
    │   ├── external-review-r1.md       # 第 1 轮（可读）
    │   ├── external-review-r2.json     # 第 2 轮（如有）
    │   ├── external-review-r2.md
    │   └── ...
    ├── context-reset-r2.json           # 第 2 轮 reset 时的 injected context 快照（可选，便于 debug）
    └── done.md / failed.md / aborted.md   # 最终报告（既有 §8.4）
```

##### 7.5.8.2 JSON Schema（结构化版）

```typescript
interface ReviewOpinionsFile {
  pipelineId: string;
  round: number;
  generatedAt: string;
  threshold: { used: number; max: number; model: string };
  reviews: ReviewOpinion[];
}

interface ReviewOpinion {
  role: 'review';
  provider: string;
  sessionId: string;
  shortId: string;
  completedAt: string;
  issues: Issue[];
  /** context overflow 触发时，记录 cascade n */
  cascadeN?: number;
  /** context overflow 触发时，记录策略 */
  cascadeStrategy?: 'compact' | 'reset' | 'none';
}
```

##### 7.5.8.3 MD 渲染（可读版）

```markdown
# External Review — Pipeline <pipelineId> Round <N>

**Generated**: <ISO timestamp>
**Provider**: <kimi-for-coding>
**Session**: <uuid>
**Context at trigger**: <used>/<max> tokens

## P0 (Critical) — 3 issues

### P0-1: NPE in auth.ts:42
- **Location**: src/auth.ts:42
- **Description**: ...
- **Suggestion**: ...

### P0-2: ...

## P1 (High) — 2 issues

...

## P2 (Medium) — 1 issue

...

## P3 (Low) — 0 issues
```

##### 7.5.8.4 写入实现

```typescript
async function writeReviewOpinionsToFile(
  pipeline: PipelineRecord,
  reviews: ReviewOpinion[],
): Promise<{ jsonPath: string; mdPath: string }> {
  const dir = path.join(
    expandPath('~/.cc-linker/review-pipelines'),
    pipeline.pipelineId,
    'state',
  );
  await fs.mkdir(dir, { recursive: true });

  const round = pipeline.state.round;
  const baseName = `external-review-r${round}`;
  const jsonPath = path.join(dir, `${baseName}.json`);
  const mdPath = path.join(dir, `${baseName}.md`);

  // 收集 context 状态（用于 header）
  const usage = await adapter.getContextUsage(pipeline.panes.work!.currentRoundShortId!);
  const threshold = usage ? resolveThreshold(usage, profileOf(pipeline)) : null;

  const file: ReviewOpinionsFile = {
    pipelineId: pipeline.pipelineId,
    round,
    generatedAt: new Date().toISOString(),
    threshold: usage
      ? { used: usage.used, max: usage.max, model: usage.model }
      : { used: 0, max: 0, model: 'unknown' },
    reviews: reviews.map(r => ({
      ...r,
      cascadeN: pipeline.contextOverflowCount,
      cascadeStrategy: pipeline.contextOverflowCount
        ? (pipeline.contextOverflowCount === 1 ? 'compact' : 'reset')
        : 'none',
    })),
  };

  // 原子写
  await Bun.write(`${jsonPath}.tmp`, JSON.stringify(file, null, 2));
  await fs.rename(`${jsonPath}.tmp`, jsonPath);

  await Bun.write(`${mdPath}.tmp`, renderReviewOpinionsMd(file));
  await fs.rename(`${mdPath}.tmp`, mdPath);

  // 更新 PipelineRecord 引用
  pipeline.contextFiles = {
    externalReviewJson: jsonPath,
    externalReviewMd: mdPath,
  };

  return { jsonPath, mdPath };
}
```

##### 7.5.8.5 JUDGE/FIXING prompt 改造

**原版 prompt**（v2.1.1）：inline 塞 review opinions JSON
```
外部 review issues：{reviews_json_for_each_role}   # 可能 5K-30K tokens
```

**新版 prompt**（v2.1.2）：@file 引用
```toml
[prompts.work.judge.system]
template = """
外部 review 意见已写入文件（请用 @file 引用，不要 inline 复制）：
- 可读版: @{external_review_md_path}
- 结构化: @{external_review_json_path}

请先 cat 可读版了解每条 issue 的 severity / location / description，
然后参考结构化版获取 issue_id 用于 per_issue 决策。

工作产物：{artifact}

逐条评估：accept / reject / partial
输出 JSON: { "per_issue": [...], "reasoning": "..." }
"""

[prompts.work.fixing.system]   # injectReply 用，引用同一文件
template = """
待修复的 issues 已写入文件：
- 可读版: @{external_review_md_path}

请先 cat 了解要修什么，然后 verify-first 流程：
1. 重新阅读相关代码，判断 real 还是 hallucination
2. 修复（仅 real），修改要最小化
3. 验证修复正确

输出 JSON: { "per_issue": [...], "all_real_fixed": bool, ... }
"""
```

##### 7.5.8.6 Reconciler 恢复增强

启动时扫描 `state/external-review-r*.json`，可以直接看到每轮 EXTERNAL_REVIEW 的产出，无需重新 parse review pane。

##### 7.5.8.7 边界 case

| 场景 | 处理 |
|------|------|
| 写文件失败（磁盘满 / 权限） | **不再 fallback inline**（inline 注入会二次撑爆 context）→ `cleanupPipeline + ABORTED reason=review_opinions_write_failed`，cli-watch 提示用户手动 `cat ~/.cc-linker/review-pipelines/<id>/state/` 排查 |
| json 文件损坏 | Reconciler 检测 + 跳过 + warn（不影响 pipeline 恢复） |
| MD 渲染失败（issues 字段缺失） | 降级：只写 json，MD 留 `.md.disabled` 占位 |
| `external_review_md_path` 不存在（首次写） | prompt 模板降级到 inline 注入（仅首次，cascade 触发的二次 EXTERNAL_REVIEW 仍走写文件路径） |
| 写文件成功但磁盘随后被清（pipeline 跨崩溃恢复时） | Reconciler 检测 `@file` 路径不存在 → prompt 模板降级到 inline 注入 + warn |

---

## 9. PhaseDetector

```typescript
function detect(input: { rawInput: string; filePath?: string; gitRef?: string }): 'spec' | 'plan' | 'code' {
  // 启发式 1: 文件路径后缀 / 目录名
  // 启发式 2: git ref → code
  // 启发式 3: 关键词匹配
  // 启发式 4: 文件后缀 / 行号引用 → 强制 code
  // 启发式 5: LLM 分类（Phase 3，当前注释掉）
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
| Context window 超限 | cascade 三档（compact → reset → abort，详见 §7.5.7） |
| Review opinions 写文件失败 | v2.1.2 新增：ABORTED `review_opinions_write_failed`（不再 fallback inline 防 context 二次超限） |

### 10.2 cascade 模式约束（v2.1.2：从 reset 扩展为 cascade）

**3 个不变量**（compact / reset 两档共享）：
1. work session 仍是唯一修复者（compact 同 session、reset 新 session）
2. context 健康 + issue 记忆保留（compact 靠 `/compact` + @file 引用；reset 靠 injectedIssues + history + relatedDocs + @file）
3. verify-first 不变（cascade 不绕过 verify-first）

### 10.3 Graceful degradation vs fail fast

| 错误 | 处理 |
|------|------|
| 单个 review pane 启动失败 | 降级：用 0 opinions 推进 |
| Work pane 启动失败 | Fail fast：FAILED |
| Profile 加载失败 | Fail fast：exit 1 |

### 10.4 Retry 策略

```typescript
// Layer 1: ClaudeSessionManager 内部 1 次重试
// Layer 2: 网络瞬态 503 重试（adapter 包装，3 次，backoff 2s/4s/8s）
```

### 10.5 HUMAN_DECIDE 接收方式

CLI `cc-linker review decide <id> --accept-all | --accept "1,3" | --reject-all`。

默认 4h 超时 → 自动 ABORTED。

### 10.6 `cc-linker review doctor`

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
