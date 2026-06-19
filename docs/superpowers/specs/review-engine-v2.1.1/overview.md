# cc-linker Multi-Model Review Engine v2.1.1 设计

**日期：** 2026-06-15
**基础版本：** v2.1（`docs/superpowers/specs/2026-06-14-multi-model-review-engine-v2.1-design.md`）
**版本：** v2.1.1（v2.1 patch：6 项重大变更）
**状态：** 待评审
**作者：** Claude Code（基于 v2.1 + 用户拍板）

## 文档结构

本设计拆分为 5 个文件，方便不同角色的读者按需阅读：

| 文件 | 内容 | 适合谁 |
|------|------|--------|
| **overview.md**（本文件） | 问题陈述 + 目标 + 架构总览 | 所有人（入口） |
| [state-machine.md](./state-machine.md) | 数据流 + 状态机 + Verdict 算法 | 实施者 / 评审者 |
| [implementation.md](./implementation.md) | PipelineStore / Profile / PhaseDetector / 错误处理 | 实施者 |
| [ux-and-plan.md](./ux-and-plan.md) | CLI UX / 测试 / 排期 / Checklist / 风险 | 评审者 / PM |
| [appendices.md](./appendices.md) | 实测行为 / 复用清单 / 变更背景 / 评审反馈 | 维护者 / 追溯 |

## 修订记录（简版）

| 版本 | 日期 | 一句话 |
|------|------|--------|
| v1 | 2026-06-06 | 初版，13 个新模块全栈自建 |
| v2 | 2026-06-13 | 复用 Agent View；新建 7 个模块；CLI 主输出 |
| v2.1 | 2026-06-14 | 19 项修正（`claude --bg` 实测 + FIXING 节点 + 删 ARBITRATION）+ 10 项评审修正 |
| **v2.1.1** | **2026-06-15** | **6 项 patch：单一 review 模型 / commit preamble / parse retry / context overflow / getContextUsage / review_fix 约束** |
| v2.1.1 评审反馈 | 2026-06-17 | 7 P0 + 11 P1 修复 + I9 重设计（删 review_fix，reset 改为注入 issues + worker verify+fix）+ I10/I11 参数调整 |

> 详细变更动机 + 决策链：见 [appendices.md → 附录 C](./appendices.md#附录-cv21--v211-变更背景动机--决策--章节索引)

## Preconditions（v2.1.1）

- **Claude CLI ≥ 2.1.163**（`claude --bg` 稳定；老版本无此能力）
- **cc-linker ≥ 0.6.3**（当前 master，`c5a8b8d`）
- **`~/.claude/providers/` 至少配置 2 个 provider**（work + 1 review），缺失会由 `cc-linker review doctor` 报错
- **cwd 推荐为 git 仓库**（commit preamble 要求；如果非 git repo，preamble 会输出 `checkpoint_sha: null` 跳过 commit）
- **v2.1.1 P0-D2 修复：cwd 不能是 monorepo 子目录** —— 如果 cwd 的父级有 `.git` 目录（说明是 monorepo 子目录），doctor 会 warn：
  ```
  ⚠️ cwd 是 monorepo 子目录，git 操作可能影响整个 monorepo
     建议：cd 到 monorepo root 再跑 review，或用 --cwd /path/to/monorepo/root
  ```
  doctor 检查：`git rev-parse --show-toplevel` 返回的 root 如果等于 cwd，OK；如果不等于，warn

---

## 1. 问题陈述

使用 AI Coding（Claude Code 等）后，开发流程从"写代码 → 人审"变成了多轮自审 + 多模型交叉 Review 的工作流：

```
写 Spec → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修改 → 再 Review
写 Plan → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修改 → 再 Review
写代码 → AI 自查 → 模型 A 交叉 Review → 模型 B 交叉 Review → 修复 → 再 Review
```

由于 Claude Code 限制，不方便在终端直接切换不同模型（kimi-2.6、qwen3.6-plus、mimo-2.5-pro 等），每次评审都需手动换 settings、重新启动进程。同时，多个模型的交叉 Review 意见如何汇总、是否采纳、是否需要仲裁，缺少一个集中的"裁决 + 流程编排"机制。

**v2 的"0 行新代码复用"承诺在 v2.1 已兑现**（adapter 直接 spawn + RendezvousClient.injectReply）。

## 2. 目标与非目标

### 2.1 目标（本版必须支持）

| # | 目标 | 优先级 |
|---|------|--------|
| G1 | 多模型交叉 Review 编排：驱动"工作模型 → 外部 Review 模型 → 裁决 → 修复"的完整流水线 | P0 |
| G2 | 层次化裁决机制：工作模型自评 → 外部 Review → 工作模型评判意见 → 人工兜底 | P0 |
| G3 | 三阶段支持：Spec / Plan / Code，每个阶段可配置不同的提示词、护栏、Review 模型组合 | P0 |
| G4 | 电脑端便利：CLI 主输出 + `--watch` 模式（rich terminal）实时看 **1+1 pane** 状态（work + 1 review） | P0（Phase 1） |
| G5 | 可恢复状态机：每次 Review 是一个有状态的、跨进程崩溃可恢复的工作流 | P0 |
| G6 | **深度复用 Agent View**：实测 `claude --bg` + `--settings` + `--reply-on-resume` + `state.json` + `readJobState` + `RendezvousClient.injectReply` + `claude stop` 全部 0 行重复代码 | P0 |
| G7 | **1+1** 个 bg session 自动出现在 `~/.claude/jobs/`，飞书 `/agents` 列表**免费**看到（Phase 2 飞书集成） | P1 |
| G8 | **`cc-linker review doctor`** 启动前健康检查（profile 引用 + CLI 版本 + daemon 健康） | P0 |
| G9 | **Context window 超限自动处理**：检测 work session 上下文用量，两种可配策略（`reset` 重建 work session + 注入 review issues 让 worker verify+fix / `abort` 终止），避免恶性假收敛 | P0 |

### 2.2 非目标

- 不替代现有 `/new` `/list` `/switch` `/model` 等飞书命令
- 不修改 `ProviderManager` 已有逻辑
- 不修改 `ClaudeSessionManager` 签名（仅复用其接口）
- 不修改 `AgentViewManager` 任何代码（v2.1 设计 0 侵入 Agent View）
- 不做云端协同 / 团队共享（仍是单机单用户）
- **不做 Phase 1 IDE**（v2.1 砍掉，Phase 1 改 `--watch` rich terminal；Phase 2 单独排期）
- 不修改 `~/.claude/providers/*.json` 任何内容（只读取）
- **review 产出不自动 commit / 不创建 PR**（FIXING 节点会在用户 cwd 内修改文件（verify-first 最小化修改），所有修改可通过 `git diff` 查看、`git checkout` 回滚；自动 apply/commit/PR 留 Phase 2）
- **不**做 cloud-hosted multi-agent review（Anthropic 已有 `claude ultrareview` 但那是云端）

## 3. 架构总览

### 3.1 复用层（实测 0 行新代码）

**v2.1 关键修正**：v2 写"adapter.startSession 内部调 `ClaudeSessionManager.sendMessage`"——**实测错**。`sendMessage` 是 `claude -p`（前台一次性），不会产生 bg session。v2.1 重写为直接 `Bun.spawn(['claude', '--bg', ...])`。

| 能力 | 复用什么 | v2.1 验证状态 |
|------|---------|--------------|
| Spawn bg session（work / 单 review） | `Bun.spawn(['claude', '--bg', prompt, '--settings', settingsPath])` → 返回 `shortId` 落到 `~/.claude/jobs/<short>/state.json` | ✅ 实测 OK（见 [appendices.md → 附录 A](./appendices.md#附录-aclaude---bg-实测行为2026-06-14)） |
| Provider 切换 | `--settings ~/.claude/providers/<name>.json` | ✅ 实测 OK |
| Resume work session 跨 R1/R2/JUDGE/FIX | `--bg <newPrompt> --resume <sessionId> --reply-on-resume` | ✅ 实测 OK（每次新 shortId，sessionId 跨轮不变） |
| 注入 judge/fix prompt 到 work session | `RendezvousClient.injectReply({ short, text, rendezvousSock, timeoutMs, stateJsonPath })`（`src/agent-view/rendezvous-client.ts`）走 daemon socket + **state.json 轮询**（v2.4.x 新协议）。**必须传 `stateJsonPath`** 才走新协议 | ✅ 0 行逻辑新代码 |
| 读 pane 状态 | `readJobState(shortId)`（`src/agent-view/job-state.ts`）。**前置**：需扩展 `JobStateFile` 接口加 `output` 字段 | ✅ 0 行**逻辑**新代码 |
| 偷看 pane 输出 | `resolvePeekContent(shortId, maxChars)` **4 级降级** | ✅ 0 行新代码 |
| Stop 任意 pane | `Bun.spawn(['claude', 'stop', short])` | ✅ 实测 OK |
| Session 状态权威 | `~/.claude/jobs/<short>/state.json` | ✅ 0 行新代码 |

**v2.1 关键洞察**：v2 假设的"复用 `runChatSDK` / `ExpectedReplyState`"经实测均**不可复用**：
- `runChatSDK` Feishu 强耦合
- `ExpectedReplyState` 语义错配，需要新建 `PipelineReplyState`

### 3.2 新建层（13 个模块）

```
src/review/
├── engine.ts            # 状态机驱动（9 active states + 3 terminals）
├── pipeline-store.ts    # 持久化：5 目录（running / human_pending / done / failed / aborted）
├── pipeline-state.ts    # in-memory active pipeline Map
├── profile.ts           # ReviewProfile TOML 加载 + per-phase 深度 merge + provider 校验
├── phase-detect.ts      # 启发式：file path → git ref → 关键词 → 文件后缀/行号 → PhaseUnknownError
├── adapter.ts           # ClaudeBGAdapter 暴露 6 个 API（startSession / resumeWorkSession / injectReply / poll / stop / getContextUsage）
├── model-parser.ts      # parseModelFromProviderEnv + lookupContextLimit + KNOWN_CONTEXT_LIMITS
├── context-overflow.ts  # checkContextOverflow + reset/abort 策略
├── build-context-reset-prompt.ts  # 新 worker prompt 模板（history + injectedIssues + relatedDocs + checkpoint SHA）
├── output-contract.ts   # parseBgOutputWithRetry（带 retry 1 次 + timeoutMs）
├── cli-watch.ts         # CLI `--watch` 模式（chalk + ANSI）
├── review-doctor.ts     # `cc-linker review doctor` 命令
└── reconciler.ts        # 启动扫描 running/ + human_pending/ 恢复
```

**CLI 子命令注册**：`src/cli/commands/review.ts` 作为 subcommand group 入口（与 `daemon` / `hook` 一致）。

### 3.2.1 `adapter.getContextUsage` API

```typescript
interface ContextUsage {
  used: number;           // 当前 context tokens
  max: number;            // 模型 context 上限
  model: string;          // 模型名（如 "claude-sonnet-4-5"）
  percentUsed: number;    // 0.0 ~ 1.0
  source: 'jsonl' | 'unavailable';
  breakdown?: {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

// adapter.getContextUsage(shortId):
//   1. readJobState 拿 state.json
//   2. parseModelFromProviderEnv(state.providerEnv) 拿模型名 + context 上限
//   3. 读 linkScanPath 指向的 jsonl 末条
//   4. 调 readLastAssistantTurn 拿 usage（turn.usage）
//   5. 返回 ContextUsage（session 不存在 → null）
```

### 3.2.2 模型解析（`model-parser.ts`）

```typescript
interface ModelInfo {
  name: string;              // 纯模型名，如 "claude-sonnet-4-5"
  contextHint: number | null; // 从后缀解析的 context hint
}

// parseModelFromProviderEnv(env):
//   "MiniMax-M3"        → { name: "MiniMax-M3", contextHint: null }
//   "MiniMax-M3[1m]"    → { name: "MiniMax-M3", contextHint: 1_000_000 }
//   "kimi-for-coding[256k]" → { name: "kimi-for-coding", contextHint: 256_000 }

// KNOWN_CONTEXT_LIMITS 内置表：
const KNOWN_CONTEXT_LIMITS: Record<string, number> = {
  'MiniMax-M3': 1_000_000,  'MiniMax-M3.5': 1_000_000,
  'claude-sonnet-4': 200_000, 'claude-sonnet-4-5': 1_000_000,
  'claude-opus-4': 200_000, 'claude-haiku-4': 200_000,
  'kimi-for-coding': 256_000, 'bailian-qwen3.6': 128_000,
  'xiaomi-mimo': 128_000,
};
// lookupContextLimit(modelName, profileOverrides?): profile 级 > 内置 > 200_000 兜底
```

### 3.3 CLI 入口

```bash
cc-linker review run <task>     [--phase spec|plan|code] [--profile default] [--max-rounds N] [--watch] [--cwd <path>] [--inject-text "..."] [--max-cost 5.00]
cc-linker review status <id>    [--follow]
cc-linker review abort <id>
cc-linker review report <id>    [--format md|json] [--out <file>] [--partial]
cc-linker review decide <id>    --accept-all | --accept "1,3" | --reject-all
cc-linker review cancel <id>
cc-linker review skip <id>      [--reason "..."]
cc-linker review resume <id>    # 从当前 state 继续（FAILED network_timeout 后恢复）
cc-linker review doctor         # 启动前健康检查
cc-linker review profiles       # 列出 review profiles
```

### 3.4 启动方式

| 命令 | 行为 |
|------|------|
| `cc-linker review run <task>` | 一次性跑 pipeline（Phase 1 主力入口） |
| `cc-linker review status <id> --follow` | 每 500ms 复读 running JSON |
| `cc-linker review-server` | 长驻 Review Engine（Phase 2） |
| `cc-linker start` | **不**启动 Review Engine |

### 3.5 与现有模块的边界

| 现有模块 | 复用方式 | 新增代码 |
|---------|-------------|---------|
| `claude --bg` / `--settings` / `--resume` / `--reply-on-resume` / `stop` / `logs` | adapter 直接 spawn | 0 |
| `RendezvousClient.injectReply()` | adapter JUDGE/FIXING 注入用 | 0 |
| `readJobState(shortId)` | engine + adapter + cli-watch 都调 | 0（加类型声明） |
| `AgentSnapshotFetcher.fetch()` | cli-watch 拉 pane 列表 | 0 |
| `resolvePeekContent` | cli-watch 拉 pane 详情 | 0 |
| SpoolQueue 设计思想 | PipelineStore 照搬 | 80% |
| `Config` | 扩展 `[review]` 段 | 5% |

---

> **继续阅读**：
> - 状态机设计 → [state-machine.md](./state-machine.md)
> - 实现细节 → [implementation.md](./implementation.md)
> - UX / 测试 / 排期 → [ux-and-plan.md](./ux-and-plan.md)
> - 附录（实测 / 复用 / 变更背景 / 评审反馈） → [appendices.md](./appendices.md)
