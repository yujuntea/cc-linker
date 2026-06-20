# Review Engine v2.1.1 — UX / 测试 / 排期 / 风险

> 属于 [overview.md](./overview.md) 的下游文件。

## 8. Phase 1 电脑端 UX

### 8.1 CLI 主输出：rich terminal

```bash
cc-linker review run "帮我修 NPE in auth.ts" --phase code --profile default

# ╭─ cc-linker Review Engine v2.1 ─────────────────────────────────╮
# │ Pipeline: 01HXYZK9... │ Phase: code │ Profile: default          │
# │ Round: 3/8  │ Cost: $0.42  │ ⏱ 12:34  │ State: EXTERNAL_REVIEW  │
# ╰──────────────────────────────────────────────────────────────────╯
#
# Pane Status:
#   🔧 work       short2 (claude-sonnet-4)  done       $0.10  8.2s
#   👁 review     short5 (kimi-for-coding)  busy       $0.05  4.2s
#
# Timeline:
#   [12:30] ✓ PRODUCING (short1, sonnet)         $0.012  2.3s
#   [12:31] ✓ SELF_REVIEW_R1 (short2, sonnet)    $0.008  1.8s
#   [12:32] ⚠ SELF_REVIEW_R2 (short2, sonnet)    $0.009  2.1s  (2 issues)
#   [12:33] ⟳ EXTERNAL_REVIEW (short5, kimi)     -       -
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
| bg session 启动失败 | ❌ FAILED |
| 网络瞬态 503 | 🔄 retry 3 次 → FAILED |
| HUMAN_DECIDE 4h 超时 | ABORTED |

### 8.3 飞书交互

review 跑期间飞书聊天暂时禁用（被 engine 占用）。review 完成后自动恢复。

### 8.4 review 产物

```
<cwd>/.claude/reviews/<pipelineId>.md
├── Header: pipelineId / createdAt / phase / profile / totalCostUsd
├── Checkpoints: pre-fix R1 SHA / pre-fix JUDGE SHA
├── Parse Degradation Events（如有）
├── Timeline: 所有 state transition 摘要
├── Issues: 去重 + 按 severity 排序
├── Decisions: 每个 issue 的 verdict + 理由
└── Report: 自然语言总结
```

FIXING 做最小化修改（`git diff` 可查看、`git checkout` 可回滚）。自动 commit/PR 留 Phase 2。

---

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
6. commit preamble + checkpoint SHA
7. JSON parse retry + parse_degraded
8. context overflow 策略 + injectedIssues

**v2.1.2 新增 5 个**（本轮）：

9. cascade compact 成功（同 session 继续 + usage 降到阈值下）
10. cascade compact 失败 → reset 升级（写文件 + 新 session + @file 引用）
11. cascade 二次超阈值 → 直接 reset（跳过 compact）
12. cascade 三次超阈值 → abort（max attempts reached）
13. review opinions 落盘：json + md 正确性 + Reconciler 恢复时可直接读
14. 阈值规则边界：128K 模型 / 200K / 1M 模型分别在边界 usage 下触发正确

**v2.1.2 评审修正新增 6 个**：

15. per-pipeline 目录迁移：running→done/failed/aborted 原子性 + state/ 随迁
16. `max_context_resets_per_pipeline` 超限 → ABORTED `reset_loop`
17. `max_reset_duration_ms` 超时 → ABORTED `reset_timeout`
18. `queued/` 排队：超限 pipeline 入队 + 前一个完成后自动启动
19. PhaseDetector 优先级：git ref > 文件:行号 > 路径后缀 > 关键词 > throw
20. `state.json.output` 格式实测 + `ExtendedJobStateFile` 类型验证

> 基础 12 个场景定义在 v2.1 spec（`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md` §11.2），此处仅列出 v2.1/v2.1.1/v2.1.2 增量。

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
| `context-overflow.ts` | 85%+ |
| `output-contract.ts` | 85%+ |
| `build-context-reset-prompt.ts` | 80%+ |
| `build-context-compact-prompt.ts` | 80%+（v2.1.2 新增） |
| `review-opinions-writer.ts` | 85%+（v2.1.2 新增） |

---

## 12. 分阶段路线

### 12.1 Phase 1：MVP（6-7 周）

| Week | 任务 | 交付 |
|------|------|------|
| W1 | T1 Profile + doctor | `profile.ts` + `review-doctor.ts` + 单测 |
| W1 | T2 PipelineStore + Reconciler | `pipeline-store.ts` + `reconciler.ts` + 集成测试 |
| W2 | T3 PhaseDetector | `phase-detect.ts` + 单测 |
| W2 | T4 Adapter | `adapter.ts` + 集成测试 |
| W3-W4 | T5 Engine 基础 9 states | `engine.ts` + 单测 |
| W4 | T6 Engine 扩展 1 state | HUMAN_DECIDE + 集成测试 |
| W5 | T7 CLI 命令 | `review.ts` 7 个子命令 |
| W5-W6 | T8 CLI `--watch` | `cli-watch.ts` |

**依赖**：T1/T2/T3/T4 可并行 → T5 → T6 → T7/T8 可并行 → E2E。

### 12.2 Phase 2：体验优化（+4-5 周）

IDE / 飞书集成 / 自动 apply fixes / 报告生成 / HUMAN_DECIDE IDE 按钮。

### 12.3 Phase 3：进阶（+2-3 周）

LLM 分类 / 配置热更新 / Pipeline 并行 / Token 预算 / Review 去重。

---

## 13. 评审 Checklist

### 13.1 架构（v1/v2 保留）

- [ ] 状态机转换是否覆盖所有设计路径？
- [ ] max_rounds 计数规则是否一致？
- [ ] PipelineStore 6 目录（running/queued/human_pending/done/failed/aborted）是否覆盖所有状态？
- [ ] Reconciler 幂等性是否充分？
- [ ] per-phase 覆盖机制是否清晰？
- [ ] 错误处理是否覆盖常见故障？

### 13.2 实现（v2.1 新增）

- [ ] `claude --bg` spawn 行为是否稳定？
- [ ] `RendezvousClient.injectReply` 是否正确接收 + 处理？
- [ ] work session 跨轮 sessionId 是否一致？
- [ ] doctor fail fast 是否覆盖所有启动错误？
- [ ] Output Contract：模型是否能稳定输出 JSON？
- [ ] Context window 膨胀：reset 策略是否充分？

### 13.3 v2.1.1 新增

- [ ] 单一 review 模型迁移是否平滑？
- [ ] commit preamble 是否会让"不想 commit"的用户卡住？
- [ ] JSON parse retry 15s 是否合理？
- [ ] context overflow reset 延迟 + round 增加是否可接受？

### 13.4 v2.1.2 新增（本轮）

- [ ] cascade compact 成功后 worker 是否真的能继续？verify-first 是否仍生效？
- [ ] compact 失败时升级 reset 是否平滑（不会让 worker 看到 reset 消息后困惑）？
- [ ] review opinions 落盘的 json / md 内容是否一致？md 渲染对 P0/P1/P2/P3 分组是否清晰？
- [ ] 128K / 200K / 1M 模型分别在边界 usage 下 cascade 是否触发正确？
- [ ] cascade n 计数是否正确：compact 失败升级到 reset 后，n 是否还是 1（不变成 2）？
- [ ] prompt 模板里的 @file 引用路径是否存在（pipeline 跨崩溃恢复时）？
- [ ] **P0-1 验证**：per-pipeline 目录迁移（running→done/failed/aborted）是否原子？state/ 子目录是否随迁？
- [ ] **P0-2 验证**：`max_context_resets_per_pipeline` 超限是否触发 `reset_loop` ABORTED？`max_reset_duration_ms` 超时是否触发 `reset_timeout` ABORTED？
- [ ] **P0-3 验证**：`max_compact_attempts=2` 时 4 档 cascade 行为是否符合 §5.3.5.3 走查？
- [ ] **P0-4 验证**：初始写文件失败 → ABORTED；跨崩溃恢复文件丢失 → inline fallback + warn。两种路径分别测试。
- [ ] **P1-7 验证**：超出 `max_concurrent_pipelines` 时新 pipeline 进入 `queued/`；前一个完成后 queued 自动启动。
- [ ] **P1-8 验证**：`injectReply` 传 `@{path}` — daemon 是否自动展开？不展开则 Engine 侧 `expandFileRefs` 预展开。
- [ ] **P1-9 验证**：PhaseDetector 优先级：git ref > 文件后缀:行号 > 路径后缀 > 关键词 > throw。
- [ ] **P1-10 验证**：`state.json.output` 实际类型是否与 `ExtendedJobStateFile` 声明一致？

---

## 14. 关键风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| CLI 版本 < 2.1.163 | `claude --bg` 不可用 | doctor fail fast |
| `claude --bg` 行为变化 | spawn 行为改变 | VersionGuard + 测试 |
| work session resume 链断裂 | sessionId 变化 | Adapter 每次 resume 前验证 |
| Provider 中途修改 | 走错模型 | PipelineRecord 锁住 provider + snapshot |
| daemon crash | 所有 bg session 瘫 | Reconciler → PANE_LOST |
| Context window 膨胀 | 注意力稀释 | cascade 三档（compact → reset → abort）+ 阈值按模型分档（1M=460K / 其他=80%） |
| JSON parse 退化 | 静默 false positive | retry + parse_degraded 标记 |

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
| §12.1 | 排期 5-6 周 → 6-7 周 → **7-8 周（v2.1.2 加 1 周）** | 中 |

**新增文件**：
- `src/review/model-parser.ts`
- `src/review/context-overflow.ts`
- `src/review/build-context-reset-prompt.ts`
- `src/review/build-context-compact-prompt.ts`（v2.1.2 新增）
- `src/review/review-opinions-writer.ts`（v2.1.2 新增）

**修改文件**：
- `src/review/adapter.ts`（+getContextUsage）
- `src/review/engine.ts`（+context check +parseWithRetry）
- `src/review/types.ts`（单数 + 新字段，v2.1.2 +contextOverflowCount +contextFiles）
- `src/review/output-contract.ts`（parseBgOutputWithRetry）
- `src/review/profile.ts`（新配置，v2.1.2 cascade 默认值）
- `src/cli/commands/review.ts`（doctor 扩展）

---

## 16. 文档链接

- v2.1 spec（基础版本）：`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md`
- v2.1.1 spec（单文件完整版，含修复）：`docs/superpowers/specs/2026-06-15-multi-model-review-engine-v2.1.1-design.md`
- v2.1.1 spec（拆分版，本文件）：`docs/superpowers/specs/review-engine-v2.1.1/overview.md`
- 复用的 Agent View spec：`docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md`

---

> **继续阅读**：[appendices.md](./appendices.md)（实测行为 / 复用清单 / 变更背景 / 评审反馈）
