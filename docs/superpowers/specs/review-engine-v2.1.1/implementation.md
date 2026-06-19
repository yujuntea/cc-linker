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
  strategy: 'reset' | 'abort';
  checkpointSha: string | null;
  injectedIssueCount?: number;
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

# context overflow 策略
context_overflow_threshold_1m = 512000
context_overflow_threshold_default = 200000
context_overflow_strategy = "reset"          # "reset" | "abort"
context_overflow_hysteresis_rounds = 1
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

##### 7.5.7.1 触发点

在 `onExternalReviewComplete` 内同步调用 `checkContextOverflow()`：

```typescript
async function onExternalReviewComplete(pipeline: PipelineRecord): Promise<void> {
  const contextCheck = await checkContextOverflow(workShortId, profile, pipeline.totalCostUsd);

  if (!contextCheck.overflow) {
    await transitionTo(pipeline, 'JUDGE_BY_WORK');
    return;
  }

  switch (profile.guards.context_overflow_strategy) {
    case 'reset': await executeContextReset(pipeline, contextCheck, profile); break;
    case 'abort': await executeContextAbort(pipeline, contextCheck); break;
  }
}
```

##### 7.5.7.2 阈值判断

```typescript
async function checkContextOverflow(workShortId, profile, currentCostUsd): Promise<ContextCheckResult> {
  const usage = await adapter.getContextUsage(workShortId);
  if (!usage) return { overflow: false, reason: 'no_usage_data', ... };

  const maxContext = profile.contextLimits?.[usage.model] ?? usage.max;
  const threshold = maxContext >= 1_000_000
    ? profile.guards.context_overflow_threshold_1m ?? 512_000
    : profile.guards.context_overflow_threshold_default ?? 200_000;

  return { overflow: usage.used >= threshold, usage, threshold, ... };
}
```

##### 7.5.7.3 策略 1：`reset`（默认）

杀 work → spawn 新 work → 注入 review issues + history + docs → worker verify+fix → DONE。

**3 个不变量**：
1. work session 仍是唯一修复者
2. context fresh 但 issue 记忆保留
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

    // 1. snapshot cwd
    const checkpointSha = await snapshotCwd(pipeline.input.cwd, `pre-context-reset for pipeline ${pipeline.pipelineId}`);
    checkAbort();

    // 2. 收集给新 worker 的"外部记忆"
    const { issues: injectedIssues, truncatedCount } = collectAllExternalReviewIssues(pipeline, profile);
    const historySummary = generateRoundSummary(pipeline);
    const relatedDocs = collectRelatedDocs(pipeline, injectedIssues);
    checkAbort();

    // 3. kill work session
    await adapter.stop(workShortId);
    checkAbort();

    // 4. spawn 新 work session with 完整 context
    const newWorkPrompt = buildContextResetPrompt({
      pipelineId: pipeline.pipelineId,
      contextUsage: contextCheck.usage,
      checkpointSha,
      historySummary,
      injectedIssues,
      relatedDocs,
      truncatedCount,
      nextRound: pipeline.state.round + 1,
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
      contextReset: true,
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

##### 7.5.7.4 策略 2：`abort`

cleanup → ABORTED reason=`context_overflow`。

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
| Context window 超限 | reset / abort 二策略 |

### 10.2 reset 模式约束

**3 个不变量**：
1. work session 仍是唯一修复者
2. context fresh + issue 记忆保留（injectedIssues + history + relatedDocs）
3. verify-first 不变

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
