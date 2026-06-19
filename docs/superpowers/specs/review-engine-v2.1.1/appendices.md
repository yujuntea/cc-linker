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

## 附录 B：复用的 Agent View 模块清单

| 模块 | 路径 | 复用方式 |
|------|------|---------|
| `readJobState` | `src/agent-view/job-state.ts` | adapter / engine / cli-watch 全调 |
| `RendezvousClient.injectReply` | `src/agent-view/rendezvous-client.ts` | adapter JUDGE/FIXING 注入 |
| `resolvePeekContent` | `src/agent-view/manager.ts` | cli-watch pane 详情（4 级降级） |
| `AgentSnapshotFetcher.fetch` | `src/agent-view/snapshot-fetcher.ts` | cli-watch 列表 |
| `VersionGuard.check` | `src/agent-view/version-guard.ts` | doctor 校验 CLI 版本 |
| `DaemonProbe.check` | `src/agent-view/daemon-probe.ts` | doctor 校验 daemon 健康 |
| `CLAUDE_JOBS_DIR` | `src/utils/paths.ts` | adapter / cli-watch |
| `readLastAssistantTurn` | `src/agent-view/jsonl-last-assistant.ts` | adapter getContextUsage |

## 附录 C：v2.1 → v2.1.1 变更背景（动机 + 决策 + 章节索引）

> 本附录保留"为什么这么改 + 关键决策"。实现细节请直接看主文对应章节。

### C.1 变更 1：单一 Review 模型

**动机**：多 review 并行带来 5 类复杂度（并发写冲突 / JUDGE 权重难定 / PANE_LOST 复杂 / 成本翻倍 / ratio 不直观）。

**决策**：限定为 1+1（work + 1 review）。

**实现**：见 [implementation.md §6.1](./implementation.md#61-pipelinerecord-数据结构) PaneRegistry.review 单数、[state-machine.md §5.1](./state-machine.md#51-reviewstate-枚举) EXTERNAL_REVIEW 单数。

### C.2 变更 2：commit 前置指令

**动机**：FIXING 在 cwd 修改源文件，verify-first 不保证 100% 无错。需要回滚锚点。

**决策**：FIXING 启动前 git commit → checkpoint SHA。

**实现**：见 [implementation.md §7.2](./implementation.md#72-完整配置示例) `[prompts.work.fixing.preamble]`。

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
3. **abort**（n≥3）：reason=`context_overflow_max_attempts`

**配套改进**：
- 阈值规则修 bug（v2.1.1 对 128K 模型**永不会触发** overflow 检查；200K 模型只在 100% 才触发）
- 新增 review opinions 落盘（worker 用 @file 引用，避免 prompt 膨胀）

**实现**：见 [implementation.md §7.5.7](./implementation.md#757-context-window-策略化处理)、[§7.5.8](./implementation.md#758-review-opinions-落盘v212-新增)。

### C.5 变更 5：`adapter.getContextUsage` API

**动机**：C.4 需要 engine 查 work session context 用量。

**实现**：见 [overview.md §3.2](./overview.md#32-新建层13-个模块) adapter.ts 说明。

### C.6 完整决策链

| 时点 | 决策 |
|---|---|
| 2026-06-06 | v1：13 个新模块全栈自建 |
| 2026-06-13 | v2：复用 Agent View，新建 7 个模块 |
| 2026-06-14 | v2.1：19 项修正 + 10 项评审修正 |
| 2026-06-15 | v2.1.1：6 项 patch |
| 2026-06-17 | 评审反馈 7 P0 + 11 P1 + I9 重设计 |
| 2026-06-19 | v2.1.2：I9 三档 cascade（compact → reset → abort）+ review opinions 落盘 + 阈值规则修 bug |

### C.7 v2.1.2 变更动机 + 决策（本轮）

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

- ❌ 没用 profile 内 `[context_limits]` 改 max 模型表（保留 v2.1.1 的 KNOWN_CONTEXT_LIMITS 内置表）
- ❌ 没改 max_rounds 默认值（仍是 code=8 / plan=5 / spec=4 / global=6）
- ❌ 没动 HUMAN_DECIDE 4h timeout（I10 已在 v2.1.1 调到 4h）
- ❌ 没动 parse_retry_timeout 15s（I11 已在 v2.1.1 调到 15s）

## 附录 D：v2.1.1 评审反馈汇总（2026-06-17）

> 索引表，详细修复见主文对应章节。

| ID | 类别 | 问题 | 修复位置 |
|---|---|---|---|
| B1 | P0 | `output` 类型错 | [implementation.md §7.5.1](./implementation.md#751-数据来源) |
| B2 | P0 | 函数名错 `readLastAssistantUsage` | [overview.md §3.2](./overview.md#32-新建层13-个模块) |
| B3 | P0 | 引用未定义变量 | [implementation.md §7.5.7](./implementation.md#757-context-window-策略化处理) |
| B4 | P0 | model-parser 公式冗余 | [overview.md §3.2](./overview.md#32-新建层13-个模块) |
| B5 | P0 | source 枚举不完整 | [state-machine.md §5.1](./state-machine.md#51-reviewstate-枚举) |
| B6 | P0 | injectReply signal 不可达 | [overview.md §3.2](./overview.md#32-新建层13-个模块) |
| B7 | P0 | executeContextReset 签名缺 profile | [implementation.md §7.5.7.3](./implementation.md#7573-策略-1reset默认) |
| I1 | P1 | v2.1 review-A/B 残留 | 全文清理 |
| I2 | P1 | 注释与代码不一致（模块计数 9→13） | [overview.md §3.2](./overview.md#32-新建层13-个模块) |
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
