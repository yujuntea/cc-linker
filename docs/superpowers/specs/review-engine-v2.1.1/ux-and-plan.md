# Review Engine v2.1.1 — UX / 测试 / 排期 / 风险

> 属于 [overview.md](./overview.md) 的下游文件。

## 8. Phase 1 电脑端 UX

### 8.1 CLI 主输出：rich terminal

```bash
cc-linker review run "帮我修 NPE in auth.ts" --phase code --profile default

# ╭─ cc-linker Review Engine v2.1.3 ───────────────────────────────╮
# │ Pipeline: 01HXYZK9... │ Phase: code │ Profile: default          │
# │ Round: 3/6  │ ⏱ 12:34  │ State: EXTERNAL_REVIEW                  │
# ╰──────────────────────────────────────────────────────────────────╯
#
# Pane Status:
#   🔧 work       short2 (MiniMax-M3)  done       8.2s
#   👁 review     short5 (glm-5.2)     busy       4.2s
#
# Timeline:
#   [12:30] ✓ PRODUCING (short1, MiniMax-M3)         2.3s
#   [12:31] ✓ SELF_REVIEW_R1 (short2, MiniMax-M3)    1.8s
#   [12:32] ⚠ SELF_REVIEW_R2 (short2, MiniMax-M3)    2.1s  (2 issues)
#   [12:33] ⟳ EXTERNAL_REVIEW (short5, glm-5.2)      -
#
# [Ctrl-C] detach; pipeline 继续在后台跑
# 重连: cc-linker review status 01HXYZK9... --follow
```

**设计**：
- chalk + ANSI（复用 cc-linker 现有依赖）
- 状态变更才重绘（不刷屏）
- Ctrl-C 友好：pipeline 后台继续
- 不依赖 TUI 框架

### 8.2 错误时的 UX

| 错误 | 终端输出 |
|------|---------|
| Provider 找不到 | ❌ + remediation |
| CLI 版本过低 | ❌ + `claude update` |
| daemon crash | ⚠️ PANE_LOST |
| bg session 启动失败 / `--cwd` 无效选项 | ❌ FAILED（state=failed） |
| 网络瞬态 503 | 🔄 retry 3 次 -> FAILED |
| review pane parse 失败 | ❌ ABORTED（review 已改代码，不能静默推进） |
| max_rounds 达到 | ⚠️ ABORTED `max_rounds_exceeded` |
| 429 限额耗尽 | ⏸ PAUSED（显示重置时间，到点自动恢复） |
| blocked 权限拒绝/异常 | ❌ ABORTED `permission_denied`/`unexpected_blocked` |

### 8.3 飞书交互

review 跑期间飞书聊天暂时禁用（被 engine 占用）。review 完成后自动恢复。

### 8.4 review 产物

```
<cwd>/.claude/reviews/<pipelineId>.md
├── Header: pipelineId / createdAt / phase / profile
├── Checkpoints: 每个 FIXING（work）与每个 EXTERNAL_REVIEW（review）的 checkpoint SHA（engine 打）
├── Parse Degradation Events（如有）
├── Timeline: 所有 state transition 摘要（含 PAUSED 挂起/恢复事件）
├── Issues: 去重 + 按 severity 排序（含 P3 记录，标注是否阻塞收敛）
├── Fixes: 每个 real issue 的 verdict + fix_applied + 来源（work FIXING / review EXTERNAL_REVIEW）
└── Report: 自然语言总结
```

work FIXING 与 review EXTERNAL_REVIEW 均用 `--bare` 在原开发分支做最小化修改（engine 在阶段切换前打 git checkpoint，`git diff <checkpoint>` 可查看、`git checkout <checkpoint>` 回滚）。自动 commit/PR 留 Phase 2。

## 11. 测试策略

### 11.1 测试分层

| 层级 | 覆盖 | 工具 |
|------|------|------|
| 单元测试 | 状态机转换 / Profile / PhaseDetector / prompt 替换 / max_rounds | `bun:test` |
| 集成测试 | Adapter + Engine + PipelineStore + CLI watch | `bun:test` + fixtures |
| 持久化测试 | Reconciler 恢复 | 真 PipelineStore + mock Adapter |
| E2E 测试 | CLI → mini pipeline → 验证产出 | `bun:test` + 真实 claude CLI |

### 11.2 关键测试场景

**v2.1 新增 4 个**：

1. `claude --bg` spawn 集成
2. `RendezvousClient.injectReply` 集成
3. PANE_LOST 状态转换
4. `cc-linker review doctor` 完整性

**v2.1.1 新增 4 个**：

5. 单一 review pane 流程
6. commit preamble + checkpoint SHA（v2.1.3：改由 engine 打，非模型）
7. JSON parse retry + parse_degraded
8. ~~context overflow 策略 + injectedIssues~~（v2.1.3 删除）

**v2.1.3 新增 13 个**（本轮，替换原 v2.1.2 cascade / review opinions 系列 + 实测修正）：

9. **`--bare` spawn 集成**：bg 直接在原分支改文件，不建 worktree；`git diff` 可见改动（实测：不加 --bare 会建隔离 worktree）
10. **`--cwd` 不可用实测**：adapter 用 `Bun.spawn({cwd})` 控 cwd，不传 `--cwd`（实测 unknown option -> failed）
11. **模型名从 respawnFlags 取**：`parseModelFromRespawnFlags` 读 `--model`，非 providerEnv（实测 providerEnv 不可信）
12. EXTERNAL_REVIEW review+fix 单 turn：review 模型识别 + 确认 + verify-first 直接修 + 输出 JSON（无 checkpoint_sha，engine 打 checkpoint）
13. EXTERNAL_REVIEW 收敛判定：real P0/P1/P2 == 0 -> DONE；> 0 -> SELF_REVIEW_R1(postfix, round+1)
14. work postfix 复查：review 修完 -> work R1 复查发现新 P0/P1/P2 -> FIXING -> R2 -> EXTERNAL_REVIEW，构成跨模型闭环
15. clean 标准边界：R1/R2 只发现 P3 -> clean -> EXTERNAL_REVIEW；EXTERNAL_REVIEW 只发现 P3/hallucination -> DONE（P3 不触发新一轮）
16. 无论如何都跑一轮外审：R1 clean / R2 clean 不再 -> DONE，一律进 EXTERNAL_REVIEW
17. review pane parse 失败 -> ABORTED（非静默，review 已改代码）
18. **429 限额 -> PAUSED**：adapter.poll 检测 blocked + needs rate limited -> parse 重置时间 -> PAUSED；reconciler 到 resumeAt 唤醒 -> 回到 pausedFrom 继续（实测国产模型周/月限额）
19. **blocked 分流**：rate limited -> PAUSED；permission -> ABORTED permission_denied；其他 -> ABORTED unexpected_blocked
20. **engine checkpoint**：阶段切换前 engine 打 git commit，模型不碰 git；非 git repo -> null + warn
21. **review 输入用 spec/plan + 自选 diff**：engine 不构造 artifact，模型自己 cat spec + 自选 git diff 范围

**v2.1.2 评审修正保留 3 个**（v2.1.3 仍适用）：

15. per-pipeline 目录迁移：running→done/failed/aborted 原子性（v2.1.3：无 state/ 子目录）
16. `queued/` 排队：超限 pipeline 入队 + 前一个完成后自动启动
17. PhaseDetector 优先级：git ref > 文件:行号 > 路径后缀 > 关键词 > throw

**v2.1.3 删除的测试场景**（原 v2.1.2 第 9-14 + 评审修正 16-17、20）：

- ~~cascade compact 成功 / 失败 → reset / 二次超阈值 → reset / 三次超阈值 → abort~~（cascade 整组移除）
- ~~review opinions 落盘 json+md / Reconciler 恢复读文件~~（落盘整组移除）
- ~~阈值规则边界：128K/200K/1M 模型触发~~（阈值检测移除）
- ~~`max_context_resets_per_pipeline` → reset_loop~~ / ~~`max_reset_duration_ms` → reset_timeout~~（reset 移除）
- ~~`state.json.output` 格式实测 + ExtendedJobStateFile~~（cost 解析改在 adapter.poll，不再依赖 getContextUsage，但 output 格式实测仍建议在 W1 做一次，归入场景 20 的轻量版）

> 基础 12 个场景定义在 v2.1 spec（`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md` §11.2），此处仅列出 v2.1/v2.1.1/v2.1.3 增量。

### 11.3 单测覆盖目标

| 模块 | 行覆盖率 |
|------|---------|
| `engine.ts` | 90%+ |
| `adapter.ts` | 85%+ |
| `profile.ts` | 95%+ |
| `pipeline-store.ts` | 90%+ |
| `reconciler.ts` | 85%+ |
| `phase-detect.ts` | 90%+ |
| `model-parser.ts` | 90%+ |
| `output-contract.ts` | 85%+ |

> **v2.1.3 删除的覆盖目标行**：`context-overflow.ts` / `build-context-reset-prompt.ts` / `build-context-compact-prompt.ts` / `review-opinions-writer.ts`（4 个模块整组移除）。`engine.ts` 覆盖目标不变（状态变少，更易达标）。

---

## 12. 分阶段路线

### 12.1 Phase 1：MVP（6-7 周）

### 12.1 Phase 1：MVP（5-6 周，v2.1.3 缩减）

| Week | 任务 | 交付 |
|------|------|------|
| W1 | T1 Profile + doctor | `profile.ts` + `review-doctor.ts` + 单测 |
| W1 | T2 PipelineStore + Reconciler | `pipeline-store.ts` + `reconciler.ts` + 集成测试 |
| W2 | T3 PhaseDetector | `phase-detect.ts` + 单测 |
| W2 | T4 Adapter | `adapter.ts` + 集成测试（5 API，无 getContextUsage）|
| W3-W4 | T5 Engine 5 active states | `engine.ts` + 单测（v2.1.3：删 JUDGE/HUMAN/cascade，状态少 4 个）|
| W5 | T7 CLI 命令 | `review.ts` 子命令（v2.1.3：删 `decide`）|
| W5-W6 | T8 CLI `--watch` | `cli-watch.ts` |

> **v2.1.3 排期变化**：删 T6（HUMAN_DECIDE + 集成测试）+ 删 context-overflow / build-*-prompt / review-opinions-writer 4 模块的实现与测试 → 从 6-7 周缩到 5-6 周。

**依赖**：T1/T2/T3/T4 可并行 → T5 → T7/T8 可并行 → E2E（T6 移除，不再有 T5→T6→T7 串行链）。

### 12.2 Phase 2：体验优化（+4-5 周）

IDE / 飞书集成 / 自动 apply fixes / 报告生成（v2.1.3：删 "HUMAN_DECIDE IDE 按钮"，HUMAN_DECIDE 已移除）。

### 12.3 Phase 3：进阶（+2-3 周）

LLM 分类 / 配置热更新 / Pipeline 并行 / Token 预算 / Review 去重 / 可选 context 用量监测（v2.1.3 移除的 cascade 若实践中确实撑爆，可作为 Phase 3 重新引入的轻量 abort 兜底）。

---

## 13. 评审 Checklist

### 13.1 架构（v1/v2 保留）

- [ ] 状态机转换是否覆盖所有设计路径？
- [ ] max_rounds 计数规则是否一致？
- [ ] PipelineStore 5 目录（running/queued/done/failed/aborted）是否覆盖所有状态？（v2.1.3：删 human_pending）
- [ ] Reconciler 幂等性是否充分？
- [ ] per-phase 覆盖机制是否清晰？
- [ ] 错误处理是否覆盖常见故障？

### 13.2 实现（v2.1 新增）

- [ ] `claude --bg` spawn 行为是否稳定？
- [ ] `RendezvousClient.injectReply` 是否正确接收 + 处理？（v2.1.3：仅 work FIXING 用）
- [ ] work session 跨轮 sessionId 是否一致？
- [ ] doctor fail fast 是否覆盖所有启动错误？
- [ ] Output Contract：模型是否能稳定输出 JSON？
- [ ] ~~Context window 膨胀：reset 策略是否充分？~~（v2.1.3 删除，裸奔）

### 13.3 v2.1.1 新增

- [ ] 单一 review 模型迁移是否平滑？
- [ ] commit preamble 是否会让"不想 commit"的用户卡住？（v2.1.3：work + review 两处 preamble）
- [ ] JSON parse retry 15s 是否合理？
- [ ] ~~context overflow reset 延迟 + round 增加是否可接受？~~（v2.1.3 删除）

### 13.4 v2.1.3 新增（本轮）

- [ ] **`--bare` 是否真的禁 worktree**？bg 改动是否直接落在原开发分支、`git diff` 可见？（实测：不加 --bare 会建隔离 worktree）
- [ ] **adapter 不传 `--cwd`**？cwd 由 `Bun.spawn({cwd})` 控制？（实测 `--cwd` -> failed）
- [ ] **模型名从 respawnFlags 取**？providerEnv 不可信是否规避？
- [ ] EXTERNAL_REVIEW 单 turn 内 review+fix 是否稳定？review 既审又修的输出 JSON 是否可靠？（无 checkpoint_sha，engine 打）
- [ ] work postfix 复查是否真正构成跨模型闭环（review 修 -> work 复查 -> 不一致再修）？
- [ ] clean 标准统一：P0/P1/P2 阻塞、P3 不阻塞，三处（R1/R2/EXTERNAL_REVIEW）判定是否一致？
- [ ] 无论如何都跑一轮外审：R1 clean / R2 clean 是否都正确进 EXTERNAL_REVIEW 而非 DONE？
- [ ] review pane parse 失败 -> ABORTED（非静默）是否覆盖？避免未验证的 review 修改混入产物。
- [ ] review 与 work 都在原分支改代码，是否串行不冲突？（状态机保证 work done 才 spawn review；engine checkpoint 隔离各阶段）
- [ ] 删 JUDGE/HUMAN 后 max_rounds 兜底是否足够？反复分歧场景是否在 max_rounds 内 ABORTED？
- [ ] **429 -> PAUSED**：adapter.poll 检测 blocked + needs rate limited 是否准确？parse 重置时间是否健壮（不同 provider 文案）？reconciler 到点唤醒是否可靠？PAUSED 期间 bg session 是否保持 blocked 不死？
- [ ] **blocked 分流**：rate limited / permission / unexpected 三类是否正确区分？
- [ ] **engine checkpoint**：阶段切换前 git commit 是否成功？非 git repo 降级是否正确？用户未提交改动 stash 是否安全？
- [ ] **review 输入 spec/plan + 自选 diff**：模型是否能稳定 cat spec + 自选合理 diff 范围？是否会出现看漏 diff？
- [ ] **P1-7 验证**：超出 `max_concurrent_pipelines` 时新 pipeline 进入 `queued/`；前一个完成后 queued 自动启动。
- [ ] **P1-9 验证**：PhaseDetector 优先级：git ref > 文件后缀:行号 > 路径后缀 > 关键词 > throw。
## 14. 关键风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| CLI 版本 < 2.1.139 | `claude --bg` 不可用 | doctor fail fast |
| `claude --bg` 行为变化（如 worktree 默认行为） | spawn 行为改变 | VersionGuard + `--bare` 强制 + 测试 |
| work session resume 链断裂 | sessionId 变化 | Adapter 每次 resume 前验证 |
| Provider 中途修改 | 走错模型 | PipelineRecord 锁住 provider + snapshot |
| daemon crash | 所有 bg session 瘫 | Reconciler -> PANE_LOST |
| JSON parse 退化 | 静默 false positive | retry + parse_degraded 标记 |
| **review 既审又修质量回归**（v2.1.3 反转 I9） | review 模型改未写过的代码，fix 质量不如 work | work postfix R1 复查闭环 + verify-first + max_rounds 兜底 |
| **context 裸奔**（v2.1.3 删 cascade） | 极端长任务可能撑爆 context 无主动干预 | max_rounds 兜底（v2.1.3 删成本统计，无 max_cost_usd）；Phase 3 可重引入轻量 abort |
| **review 改代码与 work 串行假设破坏** | 若 work bg 未 done 就 spawn review，并发改文件冲突 | engine 确保 work state=done 后才进 EXTERNAL_REVIEW；串行由状态机保证；engine checkpoint 隔离各阶段 |
| **429 限额耗尽**（实测国产模型常态） | review/work bg 卡 blocked，pipeline 停滞 | PAUSED 态 + reconciler 到点唤醒（不 retry 烧配额） |
| **PAUSED 期间 bg session 死亡** | 限额恢复后唤醒发现 bg 已死 | reconciler 唤醒时先 readJobState 校验 session 活着，死了则 PANE_LOST -> respawn |
| **模型自选 diff 看漏改动**（review 输入用 spec/plan） | review 漏看部分 diff，遗漏问题 | work postfix R1 复查兜底；prompt 明确要求 `git diff` 查看全部改动 |
| **engine checkpoint 失败**（非 git repo / commit 失败） | 阶段改动无回滚锚点 | 降级 null + warn，阶段继续；报告标注无 checkpoint |

---

## 15. 影响清单（v2.1 → v2.1.1）

| 章节 | 变更 | 重要度 |
|------|------|--------|
| §2.1 | G7 改 "1+1 pane"；新增 G9 | 中 |
| §3.2 | adapter +1 API + 新增 model-parser | 中 |
| §5.1 | 单数化 + 删 CONTEXT_CHECK | 中 |
| §6.1 | PaneRegistry 单数 + 新字段 | 中 |
| §7 | review.provider 单数 + 新配置 | 大 |
| §7.5.4 | parseBgOutputWithRetry 重写 | 大 |
| §7.5.7 | I9 重设计 reset 策略 | 大 |
| §7.5.7 (v2.1.2) | **I9 cascade 三档：新增 compact + reset 升级 + abort** | **大** |
| §7.5.7.2 (v2.1.2) | **阈值函数重写：1M=460K / 其他=80%** | **大** |
| §7.5.8 (v2.1.2) | **新增 review opinions 落盘规范** | **大** |
| §6.2 (v2.1.2 评审修正) | **PipelineStore 改为 6 目录 per-pipeline 结构**（P0-1） | **大** |
| §7.5.7.4 (v2.1.2 评审修正) | **executeContextReset 增加 max_resets 检查 + timeout**（P0-2） | 中 |
| §5.3.5.3 (v2.1.2 评审修正) | **新增 max_compact_attempts=2 走查示例**（P0-3） | 小 |
| §7.5.8.7 (v2.1.2 评审修正) | **边界 case 区分初始写失败 vs 恢复时丢失**（P0-4） | 中 |
| §7.5.8.4.1 (v2.1.2 评审修正) | **新增辅助函数定义 profileOf / collectRelatedDocs / generateRoundSummary**（P1-1/P1-2） | 中 |
| §7.5.8.2 (v2.1.2 评审修正) | **ReviewOpinionsFile.threshold → usageAtTrigger 重命名**（P1-3） | 小 |
| §7.5.8 (v2.1.2 评审修正) | **明确 review opinions 总是写（不仅 overflow 时）**（P1-4） | 小 |
| §5.1 (v2.1.2 评审修正) | **FIXING inputIssues 语义：每轮替换，不累积**（P1-5） | 小 |
| §3.2.1 (v2.1.2 评审修正) | **成本数据来源：state.json.output.cost_usd 优先，JSONL 降级**（P1-6） | 中 |
| §6.5 (v2.1.2 评审修正) | **新增 queued/ 目录 + 排队机制**（P1-7） | 中 |
| §7.5.8.5 (v2.1.2 评审修正) | **@file 引用双轨策略 + 实测验证计划**（P1-8） | 中 |
| §9 (v2.1.2 评审修正) | **PhaseDetector 优先级明确定义**（P1-9） | 小 |
| §12.1 | 排期 5-6 周 → 6-7 周 → 7-8 周（v2.1.2 加 1 周） → **5-6 周（v2.1.3 缩减）** | 中 |
| **§2.1 / §2.2 (v2.1.3)** | **删 G9；G2 改"自评自修+外审外修+postfix 复查"；review-fix 反转；--bare 在原分支改；删成本统计；加 PAUSED** | **大** |
| **§3.2 / §3.2.1 (v2.1.3)** | **模块 15->11；删 getContextUsage；model-parser 瘦身（删 KNOWN_CONTEXT_LIMITS + cost 表）；spawn 用 --bare；模型从 respawnFlags 取；复用 providerManager.resolve** | **大** |
| **§5.1 / §5.3 / §5.4 (v2.1.3)** | **删 JUDGE/HUMAN/DecisionContext；加 PAUSED 态；删 EXTERNAL_REVIEW.cycle；状态机重画；§5.4 重写为 clean 判定+收敛；§4.3 blocked 分流** | **大** |
| **§6.0 / §6.1 / §6.2 (v2.1.3)** | **删 ContextCheckResult/WorkDecision/ContextResetEvent；加 BlockedResult；PipelineRecord 砍 context/cost 字段；目录 6->5；§6.4 加 PAUSED 唤醒** | **大** |
| **§7.2 / §7.4 / §7.5.3 (v2.1.3)** | **删 context/cascade/cost 配置；review prompt 改 spec/plan 输入+自选 diff；engine 打 checkpoint（删 preamble）；ReviewOutputSchema 升级删 checkpoint_sha；§7.4 复用 providerManager.resolve** | **大** |
| **§7.5.7 / §7.5.8 (v2.1.3)** | **整组删除：context cascade + review opinions 落盘** | **大** |
| **§10 (v2.1.3)** | **错误分类删 context/review-opinions/cost 行，加 429 PAUSED + blocked 分流 + spawn 无效选项；§10.2 重写为修复者不变量（+--bare 原分支）** | 中 |

**新增文件**（v2.1.3 净变化）：
- `src/review/model-parser.ts`（保留，瘦身：仅 `parseModelFromRespawnFlags`）

**删除文件**（v2.1.3）：
- ~~`src/review/context-overflow.ts`~~
- ~~`src/review/build-context-reset-prompt.ts`~~
- ~~`src/review/build-context-compact-prompt.ts`~~
- ~~`src/review/review-opinions-writer.ts`~~

**修改文件**：
- `src/review/adapter.ts`（v2.1.3：删 getContextUsage，5 API；spawn 用 `--bare` + `Bun.spawn({cwd})`，不传 `--cwd`/`--model`；poll 加 blocked 分流返回 BlockedResult）
- `src/review/engine.ts`（v2.1.3：删 context check / JUDGE / HUMAN 分支；加 clean 判定 + EXTERNAL_REVIEW 收敛 + PAUSED 态 + engine 打 checkpoint）
- `src/review/types.ts`（v2.1.3：删 context/cost 字段、DecisionContext、WorkDecision；ReviewOpinion->ReviewFixOutput 去 checkpointSha；加 PAUSED/BlockedResult）
- `src/review/output-contract.ts`（v2.1.3：删 JudgeOutputSchema，ReviewOutputSchema 升级删 checkpoint_sha）
- `src/review/profile.ts`（v2.1.3：删 context/cascade/cost 配置；review prompt 改 spec/plan 输入；删 preamble）
- `src/review/model-parser.ts`（v2.1.3：parseModelFromProviderEnv -> parseModelFromRespawnFlags，删 KNOWN_CONTEXT_LIMITS + COST_TABLE）
- `src/cli/commands/review.ts`（v2.1.3：删 `decide` 子命令；doctor 加 `--bare`/spawn 校验）

## 16. 文档链接

- v2.1 spec（基础版本）：`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md`
- v2.1.1 spec（单文件完整版，含修复）：`docs/superpowers/specs/2026-06-15-multi-model-review-engine-v2.1.1-design.md`
- v2.1.1 spec（拆分版，本文件）：`docs/superpowers/specs/review-engine-v2.1.1/overview.md`
- 复用的 Agent View spec：`docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md`

---

> **继续阅读**：[appendices.md](./appendices.md)（实测行为 / 复用清单 / 变更背景 / 评审反馈）
