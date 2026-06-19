# cc-linker Multi-Model Review Engine v2.1.1 Patch

> **⚠️ 本文件已合并到 design.md（2026-06-17）**
>
> 本文件原是 v2.1 → v2.1.1 的"变更叙事"（动机 + 详细实现 + 影响清单），与 design.md 长期分叉造成理解成本。2026-06-17 评审反馈后整段并入 `docs/superpowers/specs/2026-06-15-multi-model-review-engine-v2.1.1-design.md` 作为**附录 C**（v2.1 → v2.1.1 变更背景与细节）+ **附录 D**（评审反馈汇总）。
>
> **保留本文件的原因**：
> 1. git history 追溯：6 项 v2.1.1 变更的原始定义
> 2. 链接兼容：旧 PR 评论 / commit message 里引用的 `v2.1.1-patch.md` 路径仍能跳转
> 3. archive 价值：v2.1 → v2.1.1 → v2.1.1 I9 的完整决策链
>
> **请阅读 design.md 的 1-16 章 + 附录 C/D 获取最新内容**。本文件仅供历史参考。

---

**日期：** 2026-06-15
**基础版本：** v2.1（`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md`）
**状态：** ⚠️ 已合并到 design.md（见上）
**作者：** Claude Code（基于 v2.1 评审反馈 + 用户拍板）

## 修订记录（追加到 v2.1 修订记录表末尾）

| 版本 | 日期 | 关键变更 |
|---|---|---|
| **v2.1.1** | **2026-06-15** | **本次 patch。6 项变更：**<br>1) **§3.1/§6.1 单一 Review 模型** —— EXTERNAL_REVIEW 阶段只 spawn 1 个 review bg session（之前是 N 个并行）。`review.providers` 数组改为 `review.provider` 标量。显著简化状态机、PaneRegistry、并发控制、错误处理、JUDGE verdict 计算<br>2) **§7.2 commit 前置指令** —— FIXING prompt 模板前面追加 "先 `git add -A && git commit -m 'pre-fix checkpoint by review engine'`，记录 checkpoint SHA 作为修复 baseline"，让用户能一键 `git reset --hard <sha>` 回滚<br>3) **§7.5.4 JSON parse 失败不静默** —— parse 失败 → retry 1 次（追加"严格按 JSON schema 输出"提示让 bg 重生成）→ 仍失败 → 标记 `parse_degraded: true` + 终端告警 + **排除该 review**（不再视为 0 issues）。PipelineRecord 新增 `parseDegraded[]` 字段<br>4) **§5.3/§10.1 Context Window 策略** —— 新增 context 用量检查（在 EXTERNAL_REVIEW 完成后、JUDGE_BY_WORK 注入前触发）。Profile 新增 `[guards]` 三个字段：`context_overflow_threshold_1m` / `context_overflow_threshold_default` / `context_overflow_strategy`（`reset` / `review_fix` / `abort`，默认 `reset`）<br>5) **§3.2 adapter 新增 `getContextUsage(shortId)` API** —— 读 linkScanPath 指向的 jsonl 末条 + 解析 usage；解析 `providerEnv.ANTHROPIC_MODEL` 后缀（`[1m]` / `[256k]`）拿 context 上限；复用现有 `src/agent-view/jsonl-last-assistant.ts` 解析逻辑<br>6) **§10.1 review_fix 模式约束自然满足** —— v2.1.1 单一 Review 模型后，review_fix 模式天然就是单 session 串行执行，不再有 v2.1 中"多 review 并发写文件"的协调问题；spec 中显式说明此约束的简化 |

---

## 变更 1：单一 Review 模型（重大简化）

### 1.1 动机

v2.1 的多 review 模型并行设计带来以下复杂度（v2.1 评审中识别）：
- **并发写冲突**：如果"context 超限后让 review 模型 fix"，N 个 review 并发写文件会撕裂
- **JUDGE verdict 算法需要 N 视角综合**，但多视角的"权重"和"重叠度"难以界定
- **PANE_LOST 状态需要追踪 N 个 pane 的存活**，lostPanes 数组的管理复杂
- **API 调用和 token 成本翻倍**，但实际收益不显著（2-3 个 review 高度同质化时价值有限）
- **P0/P1 rejection ratio 算法在 N 视角下不直观**（"两个 reviewer 都提的 issue"和"只有一个 reviewer 提的"权重应该不同，但方案没区分）

**简化决策**（用户拍板）：v2.1.1 限定为**单一 review 模型**。"多模型交叉 review"的价值由"work 模型 + 1 个 review 模型"提供（2 个模型），不再追求 N 个 review 模型并行。

### 1.2 Profile 配置变化

**v2.1**：
```toml
[review]
mode = "parallel"
providers = ["kimi-for-coding", "bailian-qwen3.6"]   # 数组决定 EXTERNAL_REVIEW 几个 pane
```

**v2.1.1**：
```toml
[review]
provider = "kimi-for-coding"   # 单数标量；EXTERNAL_REVIEW 只 spawn 1 个 review pane
```

### 1.3 状态机变化

#### 1.3.1 `EXTERNAL_REVIEW` 状态

**v2.1**：
```typescript
{ kind: 'EXTERNAL_REVIEW'; pipelineId; round; cycle: 'initial' | 'postfix';
  panes: { role: 'review-A' | 'review-B' | ...; shortId: string }[] }
```

**v2.1.1**：
```typescript
{ kind: 'EXTERNAL_REVIEW'; pipelineId; round; cycle: 'initial' | 'postfix';
  pane: { role: 'review'; shortId: string } }  // 单数
```

#### 1.3.2 `PANE_LOST` 状态

**v2.1**：
```typescript
{ kind: 'PANE_LOST'; pipelineId; round;
  lostPanes: Array<{ role: 'work' | 'review-A' | 'review-B' | ...; shortId: string }>;
  detectedAt: string; retryTarget: ReviewState['kind'] }
```

**v2.1.1**：
```typescript
{ kind: 'PANE_LOST'; pipelineId; round;
  lostPane?: { role: 'work' | 'review'; shortId: string };  // 可选单数（通常只有 1 个 pane 丢失）
  detectedAt: string; retryTarget: ReviewState['kind'] }
```

简化效果：`lostPanes` 数组相关逻辑（`for of`、`Promise.all` 清理、`retryPANE_LOST` 循环）都退化为单对象处理。

#### 1.3.3 状态转换表更新

v2.1 §5.3.4 表格中：
- `EXTERNAL_REVIEW all N reviews state=done → JUDGE_BY_WORK` 改为 `EXTERNAL_REVIEW pane state=done → JUDGE_BY_WORK`
- `lostPanes` 字段相关行改为 `lostPane`

### 1.4 PaneRegistry 变化

**v2.1** §6.1：
```typescript
interface PaneRegistry {
  work?: { ... };
  reviews: {
    role: 'review-A' | 'review-B' | ...;
    shortId: string; sessionId: string;
    provider: string; round: number; cycle: 'initial' | 'postfix';
  }[];
}
```

**v2.1.1**：
```typescript
interface PaneRegistry {
  work?: { ... };
  review?: {                                    // 单数，可选
    role: 'review';                             // 单一 role
    shortId: string; sessionId: string;
    provider: string; round: number; cycle: 'initial' | 'postfix';
  };
}
```

### 1.5 影响的章节清单

| 章节 | 变更 |
|------|------|
| §2.1 目标 G7 | "1+N pane 飞书列表" 改为 "1+1 pane" |
| §3.1 复用层 | 删除 ARBITRATION 关联注释（v2.1 已删，本节确认） |
| §4.1 数据流 | T31-T34 重写：单 review pane 流程 |
| §4.4 并发控制 | "EXTERNAL_REVIEW 轮次内 review-A/B Promise.all 并行" 改为 "EXTERNAL_REVIEW 单 review session" |
| §5.1 ReviewState 枚举 | 见上文 |
| §5.3 状态机 Mermaid 图 | EXTERNAL_REVIEW 节点从 `panes[]` 改为 `pane{}` |
| §5.3.2 ASCII 备查版 | review-A/B 节点合并为单 review 节点 |
| §5.3.4 转换表 | lostPanes → lostPane 等 |
| §5.3.5 走查示例 | 重写为单 review pane 流程 |
| §6.1 PipelineRecord | PaneRegistry 见上文 |
| §7 ReviewProfile | review.providers → review.provider |
| §7.2 完整配置示例 | review.providers 改单数 |
| §7.3 per-phase 深度 merge | "review.providers 完全替换" 改为 "review.provider 完全替换" |
| §7.4 Provider 字段映射 | 不变 |

---

## 变更 2：commit 前置指令

### 2.1 动机

FIXING 阶段由 work session 修改用户 cwd 中的源文件。即使 verify-first 流程过滤了 hallucination，仍可能：
- "real" 判定本身有误（work session 在 verify 阶段也可能犯错）
- fix 引入新 issue（R1 / R2 后续轮可能发现）
- 多 FIXING 节点（R1→R2→JUDGE）串行修改同一工作目录，错误雪球累积

`git diff` + `git checkout` 可回滚已跟踪文件，但不能保护 untracked / 新建 / `.gitignore` 内的文件。**强制 checkpoint commit** 把"修复前状态"固化为一个 commit，作为一键回滚锚点。

### 2.2 实现

#### 2.2.1 Profile 配置（v2.1.1 §7.2 新增）

```toml
[prompts.work.fixing.preamble]
enabled = true   # 默认 true；用户可禁用（如果项目不是 git 仓库或不想 commit）
template = """
⚠️ 在做任何修改前，请按以下步骤操作：

1. 运行 `git status` 检查当前工作区状态
2. 如果有未提交的改动（包括 untracked / modified / staged），执行：
   git add -A && git commit -m "pre-fix checkpoint by review engine (pipeline: {pipelineId})"
3. 捕获这次 checkpoint commit 的 SHA（如 `abc1234`），作为修复 baseline
4. 在 FIXING 输出 JSON 中加入 `checkpoint_sha: "abc1234..."` 字段
5. 然后开始 verify-first + fix 流程

**为什么需要这一步**：
- FIXING 可能在 verify 阶段发现 hallucination 后不修改，但即使修改了，verify-first 流程也无法保证 100% 无错
- 多轮 FIXING（R1→R2→JUDGE）可能累积错误，需要可回滚锚点
- 用户可以一键 `git reset --hard <checkpoint_sha>` 回滚到修复前状态

**注意**：如果 cwd 不是 git 仓库，请输出 `checkpoint_sha: null` 并继续（不要失败）。
"""
```

#### 2.2.2 Engine 行为

```typescript
// engine.ts: FIXING 状态启动前
async function enterFIXING(pipeline: PipelineRecord, source: 'R1' | 'R2' | 'JUDGE' | 'HUMAN'): Promise<void> {
  const profile = await profile.load(pipeline.input.profile);
  if (!profile.prompts?.work?.fixing?.preamble?.enabled) {
    // 用户禁用 preamble，跳过
    return;
  }
  // 在 injectReply 的 prompt 前面追加 preamble
  const preamble = renderTemplate(profile.prompts.work.fixing.preamble.template, {
    pipelineId: pipeline.pipelineId,
  });
  const fixingPrompt = `${preamble}\n\n---\n\n${renderFixingPrompt(pipeline)}`;
  await adapter.injectReply({
    shortId: pipeline.panes.work!.currentRoundShortId!,
    text: fixingPrompt,
    timeoutMs: 300_000,  // 5min，比普通注入长（work session 需要做 git 操作 + fix）
  });
}

// FIXING 完成后，engine 解析 output 并提取 checkpoint_sha
const fixingOutput = await parseBgOutput(bg.output, FixingOutputSchema);
pipeline.history.push({
  ...
  fixingCheckpointSha: fixingOutput.data?.checkpoint_sha ?? null,
});
```

#### 2.2.3 Markdown 报告新增字段

`<cwd>/.claude/reviews/<pipelineId>.md` 的 header 区域增加：
```markdown
## Checkpoints

- pre-fix R1: abc1234... (2026-06-15 12:34:56)
- pre-fix JUDGE: def5678... (2026-06-15 12:42:30)

用户可 `git reset --hard <sha>` 回滚到任意 checkpoint。
```

### 2.3 边界 case

| 场景 | 处理 |
|------|------|
| cwd 不是 git 仓库 | work session 输出 `checkpoint_sha: null`；报告里标注 "non-git repo, no rollback anchor" |
| 用户 `preamble.enabled = false` | 跳过前置指令；用户自负风险 |
| commit 失败（如 git 锁定） | work session 输出 `checkpoint_sha: null` + warn；继续 fix；报告标注 "checkpoint commit failed" |
| 修复后想回滚到 checkpoint | 用户在 CLI watch 看到 SHA 摘要，或读 Markdown 报告 |

---

## 变更 3：JSON parse 失败不静默

### 3.1 动机

v2.1 §7.5.4 的降级策略有严重隐患：
- "Review parse 失败 → 视为 0 issues"：模型不能输出 JSON 时静默通过 review，pipeline 看起来一切正常实际什么都没 review
- "JUDGE parse 失败 → 视为全部 accept"：同上
- "FIXING parse 失败 → 视为 all_real_fixed=true"：可能让"没修完"误判为"已修完"

这些降级在生产中会造成"silent false positive"——**最危险的失败模式**。

### 3.2 实现

#### 3.2.1 新增 `parseBgOutputWithRetry`（替换 v2.1 §7.5.4 的 `parseBgOutput`）

```typescript
// src/review/output-contract.ts（v2.1.1 重写）

interface ParseRetryOptions {
  role: 'work' | 'review';
  round: number;
  retryPrompt?: string;  // 默认追加的 retry 提示
  maxRetries?: number;   // 默认 1
}

interface ParseSuccess<T> { ok: true; data: T; retries: number }
interface ParseFailure { ok: false; parseDegraded: true; reason: string; raw: string }
type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/**
 * v2.1.1 行为：
 *   第 1 次：正常 parse
 *   失败 → retry N 次（默认 1 次）：注入 retry prompt 让 bg 重新生成
 *   仍失败 → 返 ok:false + parseDegraded:true，调用方按"排除该 review"处理
 *
 * 与 v2.1 区别：v2.1 直接静默降级为 0 issues；v2.1.1 必须显式 degraded 标记。
 */
async function parseBgOutputWithRetry<T>(
  bg: ClaudeBGHandle,
  schema: z.ZodSchema<T>,
  opts: ParseRetryOptions,
): Promise<ParseResult<T>> {
  const maxRetries = opts.maxRetries ?? 1;
  const retryPrompt = opts.retryPrompt ?? `
你的上一次输出无法被解析（JSON 提取失败或 schema 不匹配）。
请严格按指定的 JSON schema 输出，只输出 \`\`\`json ... \`\`\`，不要添加自然语言前缀。
`;

  // 第 1 次 parse
  const firstAttempt = tryParse(bg.output, schema);
  if (firstAttempt.ok) return { ok: true, data: firstAttempt.data, retries: 0 };

  if (maxRetries === 0) {
    return {
      ok: false, parseDegraded: true,
      reason: firstAttempt.error,
      raw: bg.output,
    };
  }

  // Retry：注入提示让 bg 重新生成
  logger.warn(`[output-contract] ${opts.role} round ${opts.round} parse failed, retrying: ${firstAttempt.error}`);
  await bg.injectReply(retryPrompt, { timeoutMs: 30_000 });
  // 等 bg 处理完（state=done）
  await bg.waitForState('done', 30_000);

  // 第 2 次 parse
  const secondAttempt = tryParse(bg.output, schema);
  if (secondAttempt.ok) return { ok: true, data: secondAttempt.data, retries: 1 };

  return {
    ok: false, parseDegraded: true,
    reason: `after 1 retry: ${firstAttempt.error} → ${secondAttempt.error}`,
    raw: bg.output,
  };
}

function tryParse<T>(output: string, schema: z.ZodSchema<T>): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const json = extractJsonBlock(output);
    const data = schema.parse(json);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractJsonBlock(output: string): unknown {
  // 策略 1: 查找 ```json ... ``` markdown fence
  const fenceMatch = output.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1]);
  // 策略 2: 查找最后一个完整的 { ... } 块
  const braceMatch = output.match(/\{[\s\S]*\}/);
  if (braceMatch) return JSON.parse(braceMatch[0]);
  // 策略 3: 尝试直接 JSON.parse
  return JSON.parse(output);
}
```

#### 3.2.2 降级策略修正（v2.1.1 §7.5.4 全文替换）

| 场景 | v2.1 处理 | v2.1.1 处理 |
|------|----------|------------|
| **Review pane JSON parse 失败** | 视为 0 issues | **retry 1 次 → 仍失败 → 标记 `parse_degraded: true` + 告警 + 排除该 review**（如果 review 是唯一 pane，直接 DONE） |
| **Work session R1/R2 parse 失败** | 视为 0 issues | **retry 1 次 → 仍失败 → 标记 `parse_degraded: true` + 告警**。**注意**：work session 是 owner，不能完全排除；该轮 R1/R2 视为"未识别 issues"（=0 issues 处理），但报告里清楚标注 |
| **Work session JUDGE parse 失败** | 视为全部 accept | **retry 1 次 → 仍失败 → 标记 `parse_degraded: true` + 告警 + 视为全部 accept**（保守：让 review 通过，避免"rejected 但无法判定"） |
| **Work session FIXING parse 失败** | 视为 all_real_fixed=true | **retry 1 次 → 仍失败 → 标记 `parse_degraded: true` + 告警 + 视为 all_real_fixed=true**（保守：认为修复已完成） |
| **Review pane JSON retry 后仍失败且 review 是唯一 pane** | N/A | **直接 DONE + 报告 "review 解析失败，无可决策的 issues"** |

#### 3.2.3 PipelineRecord 新增字段

```typescript
interface PipelineRecord {
  // ... 现有字段 ...
  parseDegraded: Array<{          // 累计所有 parseDegraded 事件
    role: 'work' | 'review';
    round: number;
    state: 'SELF_REVIEW_R1' | 'SELF_REVIEW_R2' | 'EXTERNAL_REVIEW' | 'JUDGE_BY_WORK' | 'FIXING';
    reason: string;               // parse 错误信息
    recoveredByRetry: boolean;    // true = retry 成功；false = 最终失败
    ts: string;
  }>;
}
```

终态时输出到 Markdown 报告：
```markdown
## Parse Degradation Events

- [12:35:12] work session SELF_REVIEW_R1 round 1: parse failed, recovered by retry (took 28s)
- [12:38:45] review pane EXTERNAL_REVIEW round 1: parse failed after 1 retry (raw output saved in debug/)

⚠️ 本次 pipeline 有 1 个 parse degraded 事件未恢复。Review 完整性可能受损。
```

#### 3.2.4 Raw 输出存档

`parseDegraded` 事件触发时，raw bg session output 存档到：
```
~/.cc-linker/review-pipelines/<terminal>/<pipelineId>/parse-failures/<role>-<state>-<ts>.txt
```

便于事后诊断模型输出问题。

---

## 变更 4：Context Window 策略

### 4.1 动机

v2.1 §7.5.7 识别了 work session 跨 8 轮 ~48 次注入可能超 200k tokens 的风险，但缓解策略（prompt 自包含 + 显式 issues 传递）只解决信息传递问题，没解决"模型注意力稀释导致 R1 漏掉真问题"——R1 在第 5 轮可能已"忘了"第 1 轮修了什么，这是恶性假收敛。

用户提议：context 超阈值后不再交回 R1，改为由 review 模型 fix。本变更实现三种可配策略。

### 4.2 Profile 配置（v2.1.1 §7 新增）

```toml
[guards]
# === v2.1 已有 ===
max_rounds = 6
max_concurrent_pipelines = 1
human_decide_timeout_ms = 3600000
p0_p1_reject_threshold = 0.30

# === v2.1.1 新增：context overflow 策略 ===
context_overflow_threshold_1m = 512000      # 1M+ 模型专用阈值（默认 512K ≈ 50%）
context_overflow_threshold_default = 200000 # 其他模型阈值（默认 200K = 100%）
context_overflow_strategy = "reset"         # "reset" | "review_fix" | "abort"
context_overflow_hysteresis_rounds = 1      # 触发后至少 N 轮不再检查（避免抖动）

# 可选：覆盖模型 context 上限（profile 级覆盖 adapter 内的 known map）
[context_limits]
"claude-sonnet-4-5" = 1000000
"kimi-for-coding" = 256000
```

### 4.3 触发时机与流程

#### 4.3.1 触发点

在 `EXTERNAL_REVIEW → JUDGE_BY_WORK` 转换前（即 EXTERNAL_REVIEW 状态的所有 review pane 都 done 后、注入 JUDGE prompt 前）：

```typescript
// engine.ts: EXTERNAL_REVIEW 状态完成回调
async function onExternalReviewComplete(pipeline: PipelineRecord): Promise<void> {
  const profile = await profile.load(pipeline.input.profile);
  const workShortId = pipeline.panes.work!.currentRoundShortId!;
  const contextCheck = await checkContextOverflow(workShortId, profile);

  if (!contextCheck.overflow) {
    // 正常路径：进入 JUDGE_BY_WORK
    await transitionTo(pipeline, 'JUDGE_BY_WORK');
    return;
  }

  // 触发 overflow 策略
  logger.warn(`[engine] pipeline ${pipeline.pipelineId} context overflow: ${contextCheck.usage.used}/${contextCheck.usage.max} (model=${contextCheck.model}, strategy=${profile.guards.context_overflow_strategy})`);

  switch (profile.guards.context_overflow_strategy) {
    case 'reset':
      await executeContextReset(pipeline, contextCheck);
      break;
    case 'review_fix':
      await executeReviewFix(pipeline, contextCheck);
      break;
    case 'abort':
      await executeContextAbort(pipeline, contextCheck);
      break;
  }
}
```

#### 4.3.2 三种策略实现

**策略 1：`reset`（默认，质量优先）**

```typescript
async function executeContextReset(
  pipeline: PipelineRecord,
  contextCheck: ContextCheckResult,
): Promise<void> {
  const workShortId = pipeline.panes.work!.currentRoundShortId!;

  // 1. snapshot cwd（work session 自身会做 git commit，但这里再保险一次）
  const checkpointSha = await snapshotCwd(pipeline.input.cwd, `pre-context-reset for pipeline ${pipeline.pipelineId}`);

  // 2. 生成 round summary
  const summary = generateRoundSummary(pipeline);  // 列出每轮修了什么 issue

  // 3. kill work session
  await adapter.stop(workShortId);
  pipeline.panes.work = undefined;  // 标记为已死

  // 4. spawn 新 work session with summary
  const newWorkPrompt = `
你的上一个 session 已被 reset（context 达到 ${contextCheck.usage.used}/${contextCheck.usage.max} tokens）。
之前的 round summary：
${summary}

Checkpoint SHA: ${checkpointSha ?? 'N/A (non-git repo)'}

请继续 review 当前 cwd 状态（从 git log 可以看到所有历史修改）。
你处于 SELF_REVIEW_R1 round=${pipeline.state.round + 1}，请全面审查当前代码。
`;
  const newWork = await adapter.startSession({
    role: 'work',
    provider: profile.work.provider,
    prompt: newWorkPrompt,
    cwd: pipeline.input.cwd,
  });
  pipeline.panes.work = {
    sessionId: newWork.sessionId,
    currentRoundShortId: newWork.shortId,
    provider: profile.work.provider,
    startedAt: new Date().toISOString(),
    roundShortIds: [newWork.shortId],
    cycle: 'initial',  // 重新进入 initial cycle
  };

  // 5. round += 1（进 R1 entry 时自然 +1）
  pipeline.state = {
    kind: 'SELF_REVIEW_R1',
    pipelineId: pipeline.pipelineId,
    round: pipeline.state.round + 1,
    cycle: 'initial',
    pane: 'work',
    contextReset: true,  // 标记这次 reset 事件
  };
  await pipelineStore.saveRunning(pipeline);
  await cliWatch.notify(pipeline.pipelineId, { type: 'context_reset', ... });
}
```

**优点**：
- work session 仍是主修复者（设计一致性）
- 不引入新的并发写问题（单 review 模型已解决，但保留 work session 主导也安全）
- context 完全 fresh，R1 质量恢复

**缺点**：
- 丢失跨轮 context（通过 summary 缓解）
- 重 spawn 慢（额外 60-90s）
- 可能"重新发现"已修过的 issue（summary 显式标注"已修"）

**策略 2：`review_fix`（速度优先）**

```typescript
async function executeReviewFix(
  pipeline: PipelineRecord,
  contextCheck: ContextCheckResult,
): Promise<void> {
  const reviewShortId = pipeline.panes.review!.shortId;

  // 1. injectReply 给 review model
  // 单 review 模型下，天然是单 session 串行执行，无并发写冲突
  const fixPrompt = `
你之前 review 提了 issues。Work session 因为 context 超限（${contextCheck.usage.used}/${contextCheck.usage.max}）无法继续处理。

请按优先级应用你提的 issues 的修复：

1. 先 \`git status\` 检查 + \`git commit\` 当前状态作为 checkpoint
2. 对每个 issue 应用最小化修复（verify-first：先读代码确认是 real 才修）
3. 输出 JSON: { file_changes: [{ file, action: 'modify'|'create'|'delete', old_text, new_text }], checkpoint_sha }

⚠️ 一次只改一个文件，避免大爆炸修改。
`;
  await adapter.injectReply({
    shortId: reviewShortId,
    text: fixPrompt,
    timeoutMs: 600_000,  // 10min
  });

  // 2. 解析 review model 的 fix 输出
  const fixOutput = await parseBgOutputWithRetry(
    { output: reviewOutput, injectReply: adapter.injectReply.bind(adapter), waitForState: adapter.waitForState.bind(adapter) },
    ReviewFixOutputSchema,
    { role: 'review', round: pipeline.state.round, maxRetries: 1 },
  );
  if (!fixOutput.ok) {
    logger.error(`[engine] review_fix parse failed, falling back to context_reset`);
    await executeContextReset(pipeline, contextCheck);  // 兜底
    return;
  }

  // 3. engine 顺序 apply file_changes
  for (const change of fixOutput.data.file_changes) {
    await applyFileChange(pipeline.input.cwd, change);
  }

  // 4. 跳过 R2/JUDGE，直接进 DONE
  pipeline.state = {
    kind: 'DONE',
    pipelineId: pipeline.pipelineId,
    round: pipeline.state.round,
    totalCostUsd: pipeline.totalCostUsd + contextCheck.costIncurred,
    issueTrail: pipeline.history.filter(e => e.issues).flatMap(e => e.issues ?? []),
    contextOverflowApplied: 'review_fix',  // 标记 fix 模式
  };
  await pipelineStore.saveRunning(pipeline);
  await pipelineStore.moveToTerminal(pipeline);
}
```

**优点**：
- 快（不重 spawn）
- review 模型的 review 输出是 fix 的"现成输入"（无需重新分析代码）

**缺点**：
- 失去 work session 的 fix 质量（work session 最懂自己写的代码）
- 没有新一轮 R1 验证，可能漏掉新引入的问题
- review 模型对 work session 的代码上下文理解不如 work session 自身

**v2.1.1 单 review 模型后**：review_fix 模式下天然是单 session 串行执行，无并发写问题。spec 中显式说明此简化。

**策略 3：`abort`（保守）**

```typescript
async function executeContextAbort(
  pipeline: PipelineRecord,
  contextCheck: ContextCheckResult,
): Promise<void> {
  logger.warn(`[engine] pipeline ${pipeline.pipelineId} context overflow, aborting per user config`);
  await cleanupPipeline(pipeline.pipelineId, 'context_overflow_abort');
  pipeline.state = {
    kind: 'ABORTED',
    pipelineId: pipeline.pipelineId,
    round: pipeline.state.round,
    reason: `context_overflow: ${contextCheck.usage.used}/${contextCheck.usage.max} on ${contextCheck.model}`,
    abortedBefore: 'JUDGE_BY_WORK',
  };
  await pipelineStore.saveRunning(pipeline);
  await pipelineStore.moveToTerminal(pipeline);
  // 终端输出
  cliWatch.notify(pipeline.pipelineId, {
    type: 'aborted',
    reason: 'context_overflow',
    suggestion: '建议：调整 max_rounds / 改用 context_overflow_strategy="reset" / 升级到 1M 模型',
  });
}
```

### 4.4 阈值判断逻辑

```typescript
async function checkContextOverflow(
  workShortId: string,
  profile: ReviewProfile,
): Promise<ContextCheckResult> {
  const usage = await adapter.getContextUsage(workShortId);
  if (!usage) {
    return { overflow: false, reason: 'no_usage_data', usage: null, threshold: 0, model: 'unknown' };
  }

  const profileLimit = profile.contextLimits?.[usage.model];
  const maxContext = profileLimit ?? usage.max;

  // 1M+ 模型用专用阈值；其他用 default
  const threshold = maxContext >= 1_000_000
    ? profile.guards.context_overflow_threshold_1m ?? 512_000
    : profile.guards.context_overflow_threshold_default ?? 200_000;

  return {
    overflow: usage.used >= threshold,
    usage,
    threshold,
    model: usage.model,
  };
}
```

### 4.5 PipelineRecord 字段扩展

```typescript
interface PipelineRecord {
  // ... 现有字段 ...
  contextResets: Array<{           // 累计所有 context reset / fix 事件
    ts: string;
    triggerRound: number;
    usageBefore: { used: number; max: number; model: string };
    strategy: 'reset' | 'review_fix' | 'abort';
    checkpointSha: string | null;
  }>;
}
```

### 4.6 影响的章节清单

| 章节 | 变更 |
|------|------|
| §2.1 目标 | 新增 G9："Context 超限自动处理（reset / review_fix / abort 三策略）" |
| §5.1 ReviewState | `SELF_REVIEW_R1` 增加可选 `contextReset: boolean` 字段 |
| §5.3 状态机 | 在 EXTERNAL_REVIEW → JUDGE_BY_WORK 之间增加 context 检查节点（条件分支） |
| §5.3.4 转换表 | 新增"EXTERNAL_REVIEW 完成 + context 超限"分支 |
| §6.1 PipelineRecord | 新增 `contextResets[]` 字段 |
| §7 ReviewProfile | 新增 `context_overflow_*` 配置 + `[context_limits]` 表 |
| §7.5.7 Context Window 风险 | 替换为"策略化处理"：检测 → 三选一 |
| §10.1 错误处理 | 新增"context_overflow" 错误类别 |
| §14 风险 | 重写 "Context window 膨胀" 风险行 |

---

## 变更 5：`getContextUsage` API

### 5.1 动机

state.json 中没有直接的 `usage` 字段，但 `linkScanPath` 指向的 jsonl 文件里有（已存在的 `src/agent-view/jsonl-last-assistant.ts` 就是干这个的）。v2.1.1 需要 engine 能查 work session 的当前 context 用量，作为变更 4 的判断输入。

### 5.2 API 定义

```typescript
// src/review/adapter.ts (v2.1.1 新增)

export interface ContextUsage {
  used: number;           // 当前 context tokens
  max: number;            // 模型 context 上限
  model: string;          // 模型名（如 "claude-sonnet-4-5"）
  percentUsed: number;    // 0.0 ~ 1.0
  source: 'jsonl' | 'estimate' | 'unavailable';
  breakdown?: {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

class ClaudeBGAdapter {
  // ... v2.1 已有的 5 个 API（startSession / resumeWorkSession / injectReply / poll / stop）...

  /**
   * v2.1.1 新增：读 work session 的当前 context 用量。
   * 
   * 行为：
   *   1. readJobState 拿 state.json
   *   2. 解析 providerEnv.ANTHROPIC_MODEL 拿模型名 + context 上限（从后缀 [1m]/[256k]）
   *   3. 读 linkScanPath 指向的 jsonl 末条
   *   4. 调 jsonl-last-assistant.ts 的 readLastAssistantUsage 拿 usage
   *   5. 返回 ContextUsage
   *
   * 失败处理：
   *   - session 不存在 → null
   *   - state.json 缺 linkScanPath → estimate（按累计 output chars / 4 估算）
   *   - jsonl 读失败 → estimate
   *   - 都失败 → unavailable
   */
  async getContextUsage(shortId: string): Promise<ContextUsage | null> {
    const state = await readJobState(shortId);
    if (!state) return null;

    const modelInfo = parseModelFromProviderEnv(state.state.providerEnv);
    if (!modelInfo) {
      return { used: 0, max: 200_000, model: 'unknown', percentUsed: 0, source: 'unavailable' };
    }

    const maxContext = lookupContextLimit(modelInfo.name) ?? 200_000;

    // 尝试读 jsonl 末条
    const linkScanPath = state.state.linkScanPath;
    if (linkScanPath && existsSync(linkScanPath)) {
      const usage = await readLastAssistantUsage(linkScanPath);  // 复用已有
      if (usage) {
        const used = (usage.input_tokens ?? 0)
                   + (usage.cache_creation_input_tokens ?? 0)
                   + (usage.cache_read_input_tokens ?? 0);
        return {
          used,
          max: maxContext,
          model: modelInfo.name,
          percentUsed: used / maxContext,
          source: 'jsonl',
          breakdown: {
            inputTokens: usage.input_tokens ?? 0,
            cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          },
        };
      }
    }

    return null;  // 调用方按 unavailable 处理
  }
}
```

### 5.3 模型解析

```typescript
// src/review/model-parser.ts (v2.1.1 新增)

interface ModelInfo {
  name: string;          // 纯模型名，如 "claude-sonnet-4-5"
  contextHint: number | null;  // 从后缀解析的 context hint，如 1_000_000（如果有）
}

/**
 * 解析 ANTHROPIC_MODEL="MiniMax-M3[1m]" 格式：
 *   "MiniMax-M3" → { name: "MiniMax-M3", contextHint: null }
 *   "MiniMax-M3[1m]" → { name: "MiniMax-M3", contextHint: 1_000_000 }
 *   "kimi-for-coding[256k]" → { name: "kimi-for-coding", contextHint: 256_000 }
 */
function parseModelFromProviderEnv(env: Record<string, string> | undefined): ModelInfo | null {
  if (!env) return null;
  const raw = env.ANTHROPIC_MODEL;
  if (!raw) return null;

  const match = raw.match(/^(.+?)(?:\[(\d+)([km]?)\])?$/);
  if (!match) return null;

  const name = match[1];
  const num = match[2] ? parseInt(match[2], 10) : null;
  const unit = match[3] ?? '';
  const contextHint = num ? (unit === 'm' ? num * 1_000_000 : num * (unit === 'k' ? 1_000 : 1)) : null;

  return { name, contextHint };
}

// 内置已知模型表
const KNOWN_CONTEXT_LIMITS: Record<string, number> = {
  'MiniMax-M3': 1_000_000,
  'MiniMax-M3.5': 1_000_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-5': 1_000_000,
  'claude-opus-4': 200_000,
  'claude-haiku-4': 200_000,
  'kimi-for-coding': 256_000,
  'bailian-qwen3.6': 128_000,
  'xiaomi-mimo': 128_000,
};

function lookupContextLimit(modelName: string, profileOverrides?: Record<string, number>): number {
  if (profileOverrides?.[modelName]) return profileOverrides[modelName];
  if (KNOWN_CONTEXT_LIMITS[modelName]) return KNOWN_CONTEXT_LIMITS[modelName];
  return 200_000;  // 兜底
}
```

### 5.4 复用现有代码

| 复用 | 位置 | 用法 |
|------|------|------|
| `readJobState` | `src/agent-view/job-state.ts` | 读 state.json |
| `readLastAssistantUsage` | `src/agent-view/jsonl-last-assistant.ts` | 解析 jsonl 末条 usage（已存在） |
| `CLAUDE_JOBS_DIR` | `src/utils/paths.ts` | 默认 jobs dir |

### 5.5 影响的章节清单

| 章节 | 变更 |
|------|------|
| §3.2 新建层 | adapter 增加 `getContextUsage` API |
| §7.5.7 Context Window | "读 state.json 的 usage 字段" 改为 "调 adapter.getContextUsage 读 jsonl 末条" |
| §7.4 Provider 字段映射 | 新增"模型 context 上限"映射表 |

---

## 变更 6：review_fix 模式约束（自然满足）

### 6.1 简化说明

v2.1 中，如果采用"由 review 模型 fix"策略，会引入 v2.1 §10.1 评审中识别的并发写问题：
- 多个 review pane 并行 fix → 同一文件可能被多个 process 同时写
- 需要复杂的 git branch / 3-way merge / 文件锁机制

**v2.1.1 单一 Review 模型后**，此问题自然消失：
- 只有 1 个 review session 在做 fix
- 串行执行（review session 是阻塞的 injectReply + waitForState）
- 即使 review_fix 策略下也无需额外并发控制

### 6.2 spec 显式说明

在 v2.1 §10.1 错误处理表"review pane 启动失败 → degraded 模式"条目后，新增：

> **v2.1.1 简化**：单一 Review 模型后，review_fix 模式天然满足"单 review session 串行执行"，无需 v2.1 设计的 git branch / merge 协调机制。如未来要重新支持多 review 模型，review_fix 模式下需要重新引入并发写约束（每个 review model 在独立 git branch 上 fix，engine 3-way merge 或人工合并）。

### 6.3 影响的章节清单

| 章节 | 变更 |
|------|------|
| §5.3.6 异常路径示例 | 重写 "review_fix 模式" 例（单 review session） |
| §10.1 错误处理 | 见 6.2 显式说明 |
| §10.2 Graceful degradation | 删 "Arbiter pane 启动失败" 行（v2.1 已删 arbiter，本变更确认） |

---

## v2.1 → v2.1.1 完整影响清单

按 v2.1 spec 章节顺序整理：

| v2.1 章节 | v2.1.1 变更 | 重要度 |
|----------|-----------|--------|
| §2.1 目标 | G7 改 "1+1 pane"；新增 G9（context overflow） | 中 |
| §3.1 复用层 | 不变 | — |
| §3.2 新建层 | adapter +1 API（`getContextUsage`） | 小 |
| §3.3 CLI 入口 | 不变 | — |
| §4.1 数据流 | T31-T34 重写（单 review pane） | 中 |
| §4.4 并发控制 | EXTERNAL_REVIEW 单 session | 小 |
| §5.1 ReviewState | panes 改单数、lostPanes 改 lostPane | 中 |
| §5.2 max_rounds | 不变 | — |
| §5.3 状态机 | 节点简化 + context 检查分支 | 中 |
| §5.3.4 转换表 | 多行更新 | 中 |
| §5.3.5 走查示例 | 重写 | 中 |
| §5.4 Verdict | 不变（单 review 也用 P0/P1 ratio） | — |
| §6.1 PipelineRecord | PaneRegistry.reviews → review 单数；新增 `contextResets[]` / `parseDegraded[]` | 中 |
| §6.2 持久化目录 | 不变 | — |
| §6.3 幂等性 | 不变 | — |
| §6.4 Reconciler | 简化（lostPanes → lostPane） | 小 |
| §6.5 并发控制 | 不变 | — |
| §6.6 Cleanup | 不变 | — |
| §7 ReviewProfile | review.providers[] → review.provider；新增 `context_overflow_*` / `[context_limits]` | 大 |
| §7.2 完整配置示例 | 重写（单 review.provider + commit preamble + context overflow 配置） | 大 |
| §7.3 per-phase merge | review.providers 改 review.provider | 小 |
| §7.4 Provider 映射 | 新增"模型 context 上限"表 | 中 |
| §7.5 Output Contract | §7.5.4 全文重写（parseWithRetry） | 大 |
| §7.5.7 Context Window | 替换为 §7.5.7 v2.1.1（context overflow 策略化处理） | 大 |
| §8 Phase 1 UX | 不变（CLI --watch 不动） | — |
| §9 PhaseDetector | 不变 | — |
| §10.1 错误处理 | 新增 context_overflow / parse_degraded 类别 | 中 |
| §10.2 Graceful degradation | 简化（删 arbiter 行） | 小 |
| §10.3 Retry 策略 | 不变 | — |
| §10.5 review doctor | 新增 "context overflow 配置" 检查 | 小 |
| §11 测试 | 新增 4 个场景：单 review pane 流程 / commit preamble / JSON retry / context overflow 三策略 | 中 |
| §12.1 Phase 1 排期 | T5/T6 engine 拆分更新（context overflow 状态机分支） | 中 |
| §13 评审 Checklist | 新增 4 条 v2.1.1 项 | 小 |
| §14 风险 | 新增 "JSON parse 退化" 行；重写 "Context window 膨胀" 行 | 中 |

---

## 实施影响

### 8.1 新增/修改文件

**新增**：
- `src/review/model-parser.ts` —— parseModelFromProviderEnv + lookupContextLimit
- `src/review/context-overflow.ts` —— checkContextOverflow + 三策略实现
- `tests/unit/review/model-parser.test.ts` —— 模型解析单测
- `tests/unit/review/context-overflow.test.ts` —— 三策略单测
- `tests/integration/review/get-context-usage.test.ts` —— adapter API 集成测试

**修改**：
- `src/review/adapter.ts` —— 新增 `getContextUsage` 方法
- `src/review/engine.ts` —— EXTERNAL_REVIEW 完成回调加 context 检查 + JSON parseWithRetry
- `src/review/types.ts` —— PaneRegistry.reviews → review 单数；新增 parseDegraded / contextResets 字段
- `src/review/output-contract.ts` —— 重写 parseBgOutput 为 parseBgOutputWithRetry
- `src/review/profile.ts` —— 新增 context_overflow_* / context_limits 配置解析
- `src/cli/commands/review.ts` —— doctor 检查 context 配置
- `docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md` —— 应用本 patch 的所有变更

### 8.2 排期影响

v2.1 §12.1 Phase 1 排期（5-6 周）需要延长：
- T4 Adapter 延长 1 天（新增 getContextUsage）
- T5/T6 Engine 增加 context overflow 状态机分支（2-3 天）
- T1 Profile 延长 1 天（context_overflow 配置 + commit preamble 配置）
- T7 Output Contract 重写（1 天）

**新总排期**：6-7 周（含 buffer）。

### 8.3 兼容性与回滚

- **profile 文件**：v2.1 用户的 `review.providers = ["x", "y"]` 配置在 v2.1.1 启动时检测到数组形式 → warn + 取第一个元素 + 继续（向后兼容）。v2.1.1 完整功能需要新配置
- **PipelineRecord**：在 reading 旧 v2.1 record 时检测到 `reviews[]` 数组 → 兼容转换为单数 `review`（仅读，写新格式）
- **回滚**：v2.1.1 引入的 parseWithRetry 在解析失败时 retry 1 次（比 v2.1 慢约 30s 但更安全），回滚到 v2.1 即放弃 retry 能力

---

## 文档链接

- **基础版本**：`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md`
- **v1 spec（历史）**：`docs/superpowers/specs/2026-06-06-multi-model-review-engine-design.md`
- **v2 spec（历史）**：`docs/superpowers/specs/2026-06-13-multi-model-review-engine-v2-design.md`
- **本 patch**：`docs/superpowers/specs/2026-06-15-multi-model-review-engine-v2.1.1-patch.md`
- **Plan（待写）**：`docs/superpowers/plans/2026-06-15-multi-model-review-engine-v2.1.1-plan.md`（writing-plans skill 输出）
