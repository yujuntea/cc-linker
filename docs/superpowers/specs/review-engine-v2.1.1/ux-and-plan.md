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

> 基础 12 个场景定义在 v2.1 spec（`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md` §11.2），此处仅列出 v2.1/v2.1.1 增量。

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
- [ ] PipelineStore 5 目录是否覆盖所有状态？
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

---

## 14. 关键风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| CLI 版本 < 2.1.163 | `claude --bg` 不可用 | doctor fail fast |
| `claude --bg` 行为变化 | spawn 行为改变 | VersionGuard + 测试 |
| work session resume 链断裂 | sessionId 变化 | Adapter 每次 resume 前验证 |
| Provider 中途修改 | 走错模型 | PipelineRecord 锁住 provider + snapshot |
| daemon crash | 所有 bg session 瘫 | Reconciler → PANE_LOST |
| Context window 膨胀 | 注意力稀释 | reset/abort 二策略 |
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
| §12.1 | 排期 5-6 周 → 6-7 周 | 中 |

**新增文件**：
- `src/review/model-parser.ts`
- `src/review/context-overflow.ts`
- `src/review/build-context-reset-prompt.ts`

**修改文件**：
- `src/review/adapter.ts`（+getContextUsage）
- `src/review/engine.ts`（+context check +parseWithRetry）
- `src/review/types.ts`（单数 + 新字段）
- `src/review/output-contract.ts`（parseBgOutputWithRetry）
- `src/review/profile.ts`（新配置）
- `src/cli/commands/review.ts`（doctor 扩展）

---

## 16. 文档链接

- v2.1 spec（基础版本）：`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md`
- v2.1.1 spec（单文件完整版，含修复）：`docs/superpowers/specs/2026-06-15-multi-model-review-engine-v2.1.1-design.md`
- v2.1.1 spec（拆分版，本文件）：`docs/superpowers/specs/review-engine-v2.1.1/overview.md`
- 复用的 Agent View spec：`docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md`

---

> **继续阅读**：[appendices.md](./appendices.md)（实测行为 / 复用清单 / 变更背景 / 评审反馈）
