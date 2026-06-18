# cc-linker Feishu 端 Claude Code Slash 命令透传 设计

**日期：** 2026-06-18
**版本：** v2.5（基于当前 master `2f6c6b3`）
**状态：** 待评审
**作者：** Claude Code（brainstorming + 用户拍板）

## 1. 问题陈述

用户通过手机飞书使用 cc-linker 跟 Claude Code 交互时，只能跑 cc-linker 的内置命令（`/list /switch /help /new /stop` 等）和普通聊天文本，无法触发 Claude Code 自身的 slash 命令（如 `/init /review /cost /doctor /clear` 等）。

Claude Code 在交互 REPL 中由 CLI 解析这些内置命令并执行，但 cc-linker 使用 `claude -p <text>` 非交互模式（`src/proxy/session.ts:528`），slash 命令在 CLI 层不被解释。当前 `src/feishu/bot.ts:50` 的 `isCommandMessage` 把所有 `/xxx` 都判定为 cc-linker 命令，再由 `handleCommand` switch（`bot.ts:934-1016`）处理，未匹配的走 `default` 分支报错 "未知命令"。

这导致用户在手机上完全无法触发 Claude 内置命令，必须回到终端才能用 `/init /review /cost` 等。

## 2. 设计目标

- **目标**：cc-linker 命令优先，其他 `/xxx` 自动透传给当前会话的 Claude
- **非目标**（明确 YAGNI）：
  - 自定义命令文件展开（`~/.claude/commands/*.md`）—— 跟 `-p` 模式对齐
  - 破坏性命令确认卡（`/clear /compact`）—— 全自动透传
  - `/cc-help` 等显式 escape hatch —— 冲突降级
  - 配置项（`feishu_bot.cc_slash_passthrough`）—— 默认开
  - 子命令菜单（卡片按钮触发）—— 打字够简单
  - 透传白名单 —— 全开

## 3. 用户决策记录（brainstorming 输出）

| 问题 | 决策 | 理由 |
|---|---|---|
| 支持范围 | 全自动透传 + 冲突降级 | cc-linker 命令优先，其他 `/xxx` 透传给 model 上下文 |
| 自定义命令 | 只透传文本，不展开 | 实现简单，跟 `-p` 模式行为对齐 |
| 安全保护 | 不保护，透明透传 | 错误代价由 model 自己承担 |
| 无会话场景 | 行为同聊天文本 | 跟现有 `case 'no_target'` 一致，提示 `/new` |

## 4. 架构

### 4.1 改动点（共 5 处）

```
src/feishu/bot.ts
  ├─ onMessage()               # 改: 总是 resolve target
  ├─ handleCommand() default   # 改: 转发到 handleChat
  ├─ handleChat()              # 删: dead code 的 if (msg.text.startsWith('/')) 分支
  └─ helpText()                # 改: 加 1 行透传说明
CLAUDE.md                       # 改: 加 Slash Command Passthrough 子节
```

### 4.2 数据流

```
飞书消息 /xxx
  ↓ onMessage
  ↓ isCommandMessage('/xxx') = true → serialKey = cmd:openId:messageId  (保持独立锁)
  ↓ resolve target  (改为总是解析, cc-linker 命令不读 target 但 fallthrough 要用)
  ↓ enqueue → claim → handleClaimed → handleCommand
  ↓ switch (cmd) — 未命中
  ↓ fallthrough → this.handleChat(msg)
  ↓ handleChat: busy check / rendezvous probe / no_target / chat 流式
  ↓ 把 /xxx 当作文本 prompt 发给 claude -p
  ↓ Claude 看到 /xxx 在 prompt 里, 训练过的内置 (/init /review /cost) 会识别, 不识别的当作普通文本
```

### 4.3 关键不变量

- cc-linker 已知命令优先级不变：`/list /switch /help /resume /model /status /agents /stop /cancel /listdir /new /whoami`
- 自定义命令文件（`~/.claude/commands/*.md`）不展开，跟 `claude -p` 模式对齐
- 无会话时 `/xxx` 走 `case 'no_target'` 提示，跟普通 chat 文本完全一致
- 错误处理、超时、cancellation、流式卡片、permission 处理全部复用既有路径
- serialKey 仍是 `cmd:openId:messageId`（独立锁），不影响 chat 的 sessionUuid 锁

## 5. 改动点详情

### 5.1 改动 1：`onMessage()` — target 总是解析

**当前**（`bot.ts:321-324`）：

```typescript
const isCommand = isCommandMessage(text);
const target = isCommand
  ? { type: 'no_target' as const, openId: event.open_id, mappingVersion: this.userManager.getVersion() }
  : await this.resolveChatTarget(event.open_id, event.message_id);
```

**改为**：

```typescript
const isCommand = isCommandMessage(text);
// v2.5: 总是解析 target — cc-linker 命令忽略 target, 但 /xxx 透传路径走 handleChat 需要真 target
const target = await this.resolveChatTarget(event.open_id, event.message_id);
```

**影响**：
- cc-linker 已知命令（`/list`、`/switch` 等）原本不读 target，行为不变
- 多一次 user-mapping 读（negligible，~ms 级，在 SpoolQueue.enqueue 之前）
- mappingVersion 同步刷新，session 切换观察更准确

### 5.2 改动 2：`handleCommand()` — default 转发到 handleChat

**当前**（`bot.ts:1012-1014`）：

```typescript
default:
  await this.replyAndFinalize(msg, `未知命令: /${cmd}\n\n${this.helpText()}`);
  return;
```

**改为**：

```typescript
default: {
  // v2.5: cc-linker 未识别的 /xxx → 作为 prompt 文本透传给当前会话的 Claude。
  // - 模型已训练识别 /init /review /cost 等内置 slash 命令
  // - 自定义命令 ~/.claude/commands/*.md 不展开 (跟 claude -p 模式对齐)
  // - busy check / rendezvous / 流式 / 错误处理全部复用 handleChat 既有路径
  // - serialKey 仍是 cmd:openId:messageId (独立锁), 不影响 chat 的 sessionUuid 锁
  await this.handleChat(msg);
  return;
}
```

**注意点**：entry 处的 `expectedReply` 清空逻辑（`bot.ts:941-949`）会自动生效 —— 因为 `/xxx` 的 cmd 不在 `['help','status','whoami']` 白名单里，路径走"非只读"分支。

### 5.3 改动 3：删除 handleChat 中已知 dead 的 `/` 分支

**当前**（`bot.ts:1031-1051`）：

```typescript
// 这里的 if (msg.text.startsWith('/')) 分支在 v2.4.x 已成死代码 —
// 命令消息在 dispatcher (line ~848) 走 isCommandMessage → handleCommand
// 不进 handleChat。保留只是为了 safety net (万一某条消息漏过 dispatcher)。
if (msg.text.startsWith('/')) {
  const cmd = msg.text.split(/\s+/)[0]?.replace(/^\/+/, '').toLowerCase();
  ...
  await this.handleCommand(msg);
  return;
}
```

**改为**：删除该 21 行分支。改为注释更新版本：

```typescript
// v2.5: 移除 v2.4.x 的 /startsWith('/') dead code — 原意图是 safety net,
// 现在 fallthrough 路径是 default→handleChat, 这里再分发会无限递归。
// 命令消息一律在 dispatcher (line ~848) 通过 isCommandMessage 路由到 handleCommand,
// 此处只处理 /cancel (Agent View 专用) 和普通文本。
```

**为什么安全删除**：
- `onMessage` 第 321 行 `isCommandMessage` 是 true 的消息一定进 `handleCommand`，不会绕过 dispatcher 直接到 `handleChat`
- 注释自己说"已知 dead"，新代码不依赖它
- 删了反而清晰：handleChat 只关心 `/cancel` 和普通文本

### 5.4 改动 4：`helpText()` — 增加一行说明

**当前**（`bot.ts:3223-3242`）：末尾是 `/agents` 一行

**改为**：在 `/agents` 之后加一行（对齐到现有第 37 列）：

```
'  /<其他命令>                            - 透传给当前会话的 Claude (如 /init /review /cost)',
```

对齐说明：`/help` 后是 30 个空格到 `-`（位置 37）。`/<其他命令>` 中文算 4 字 × 2 cell = 8 cell，加 `/<` `>` 共 11 cell。所以 `/<其他命令>` 后需要 26 个空格到位置 37。

### 5.5 改动 5：CLAUDE.md 文档

**位置**：`CLAUDE.md` "Feishu Bot Architecture" 节追加一段：

```
### Slash Command Passthrough (v2.5)

cc-linker 命令 (`/list /switch /help /resume /model /status /agents /stop /cancel /listdir /new /whoami`) 优先处理；其他 `/xxx` 作为 prompt 文本透传给当前会话的 Claude，由 model 自行识别（model 已训练识别 /init /review /cost 等内置命令）。无活跃会话时与普通聊天文本一致：提示需要先 `/new`。自定义命令 `~/.claude/commands/*.md` 不展开（与 `claude -p` 模式对齐）。
```

## 6. 测试策略

### 6.1 单元测试（`tests/unit/feishu/`）

新增 `bot-slash-passthrough.test.ts`，参考 `bot-command.test.ts` 和 `bot-handlechat-routing.test.ts` 的模式，复用 `tests/helpers/feishu-bot.ts` 的 `createTestBot` helper。

| # | 用例 | 断言 |
|---|---|---|
| 1 | `/init` 不在 cc-linker 命令列表中 | `handleCommand` 不走 default "未知命令" 路径；调 `handleChat` |
| 2 | `/review pr diff` | `handleChat` 收到完整文本 `/review pr diff`（含前导斜杠） |
| 3 | `/clear` | 同上，原文透传 |
| 4 | `//help` | 双斜杠：cmd 解析为 `help`（cc-linker 匹配），不走 default |
| 5 | `/HELP` | 大小写归一为 `help`，cc-linker 匹配 |
| 6 | 无活跃会话 + `/init` | 走 `case 'no_target'`，提示跟 chat 一致 |
| 7 | 有会话 + `/init` | `case 'session'`，启动 busy check / rendezvous 路径 |
| 8 | `//foo` | cmd 解析为 `foo`，未命中，default→handleChat，文本为 `//foo` |
| 9 | `/cancel`（Agent View） | handleChat 内 `/cancel` 分支保留：handleCommand 入口先清 expectedReply + 提示；switch default → handleChat → handleCancelReply 静默。净效果 cancel 成功（旧行为是 "未知命令: /cancel"） |
| 10 | 串行递归防护 | 删除 dead code 后，`/xxx` 不会再二次进入 handleCommand（mock `handleCommand` 调用计数，删除 dead code 前 = 2 次，删除后 = 1 次） |
| 11 | `expectedReply` 清空 | `/xxx` 进入 handleCommand 入口清空分支。`/help /status /whoami` 不清（isReadOnly=true），其他 `/xxx` 触发清空 + 提示。需断言 entry 那条"⏱ 等待输入已自动取消(因你跑了 /init)" reply |
| 12 | `serialKey` 不变 | `/xxx` 仍用 `cmd:${openId}:${messageId}` 独立锁。SpoolQueue claim/file lock 跟 serialKey 一致。**已知行为**：两次 `/xxx` 到同一 session 不互锁，但 busy check + force-send 显式确认是兜底（见 §7 风险矩阵"已接受"项）。不做并发修。 |

**测试技巧**：
- 复用 `createTestBot` helper，依赖真实 `UserManager` / `SpoolQueue` / `RegistryManager` + mock `replyFn`
- 扩展 `createTestBot`（`tests/helpers/feishu-bot.ts`）支持可选 `sessionManager` override：当前实现 `const sessionManager = new ClaudeSessionManager()` 写死，要 mock 需改 constructor 接受 opts.sessionManager；或者给 `ClaudeSessionManager` 加测试 hook（类似 `_bgConflictHooks`）。**推荐方案**：扩展 `createTestBot` 接受 `opts.sessionManager`，零侵入现有 helper。
- 验证 `/xxx` 落到 handleChat 而不是 default 路径：用 `textReplies` 断言**不含** `"未知命令: /xxx"` 文本（含则失败）
- 验证 `/xxx` 真正进入 chat 处理（而非卡在 default）：mock `sessionManager.sendMessage` 或 `sendSDKMessage`，断言被调用且 `text === '/xxx'`（含前导斜杠）
- 边界用例（无会话、busy）通过断言 reply 文本内容确认

### 6.2 错误处理矩阵

| 场景 | 行为 |
|---|---|
| 用户发 `/xxx`，无会话 | 走 `case 'no_target'` 提示需要 `/new`（跟 chat 一致） |
| 用户发 `/xxx`，会话 busy | 走 `case 'session'` → busy check → busy 卡 |
| Claude CLI 不存在 | `sendMessage` 返 degraded → 跟 chat 错误一致 |
| Claude 处理超时 | `terminateProcessTree` → 跟 chat 一致 |
| `permission_request` 中用户发 `/xxx` | 跟 chat 文本并发行为一致；SDK canUseTool 自身有锁，sessionManager 还有 sessionLock 兜底 |
| `rendezvous` attached 状态 + `/xxx` | 走 handleChat → 进 attached 分支 → `tryRendezvousReply` 把 `/xxx` 注入 bg |
| `expectedReply` 等待中 + `/xxx` | handleCommand 入口清空 expectedReply + 提示（已有逻辑） |
| 自定义命令 `/foo`（`~/.claude/commands/foo.md` 存在） | 字面量 `/foo` 发给模型，模型看不到文件内容，等同文本命令 |
| 用户文本发 `/cancel`（预期回复等待中） | 1. handleCommand 入口清 expectedReply + 发"⏱ 等待输入已自动取消(因你跑了 /cancel)"<br>2. switch default → handleChat<br>3. handleChat `/cancel` 分支：`handleCancelReply` 看到 `wasPending=false` → **静默**<br>净效果：cancel 成功 + 用户只看到入口那一条提示，**比之前 "未知命令: /cancel" 更合理**（修复了之前 broken 行为） |
| 用户文本发 `/cancel`（无预期回复等待） | 1. 入口：`expectedReply.get` 返 undefined → 不发消息<br>2. switch default → handleChat<br>3. `/cancel` 分支静默<br>净效果：完全静默（之前是 "未知命令: /cancel"） |

### 6.3 边界场景

- 空文本 `/`：`isCommandMessage('/')` 返回 false（`length > 1` 短路），走 chat 路径，空 prompt 报错。不变。
- `/ ` 带空格：`isCommandMessage('/ ')` 返回 false（second char 是空格），走 chat 路径，文本 `/ `。不变。
- 图片消息带 `/xxx`：cc-linker 只支持文本命令，图片消息 `text` 为空，`imagePaths` 有值，`isCommandMessage('')` 是 false，走 handleChat 图片路径。
- 中文 `/初始化`：`isCommandMessage('/初始化')` true，`cmd = '初始化'`。未命中 → default → handleChat 把字面量发给 Claude。OK。

### 6.4 回归测试

删除 dead code 后，原来依赖它的测试路径消失。需 grep：

```
grep -rn "startsWith('/')" tests/
grep -rn "未知命令" tests/
grep -rn "handleCommand.*handleChat" tests/unit/feishu/
grep -rn "msg.text.startsWith" tests/
```

预期：

- `startsWith('/')`：仅在 dead code 路径或别处的字符串测试中可能存在，需逐个看
- `未知命令`：在 `bot-command.test.ts` 里基本肯定有断言（之前测试 default 分支报错路径），需要批量改
- `handleCommand.*handleChat`：确认无跨函数依赖
- `msg.text.startsWith`：dead code 引用，删除后断言要删或更新

`bot-command.test.ts` 现有断言（"未知命令: /xxx" 文本）需要更新 —— 改为断言 "无 未知命令 文本" 或 "调用了 handleChat" 或 "产生了 chat 路径调用"。

## 7. 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| 现有测试断言 "未知命令" 文本，破窗式批量改 | 🟡 中 | Step 3 单独跑 + 列 diff 走 review |
| 删除 dead code 后，隐藏在 dead branch 里的隐式行为暴露 | 🟢 低 | dead code 注释自己说"已知 dead"，且 v2.4.x 已在生产稳跑约 2 周（PR 2 ship date 2026-06-04，今日 2026-06-18） |
| `handleChat` 串行递归 | 🔴 高 | Step 2 必须同时改 handleChat dead code，不能留尾巴 |
| `/xxx` 同 session 并发（serialKey=`cmd:openId:msgId` 不锁同 session） | 🟢 低（已接受） | **决策：接受 Option A，不修**。理由：busy check（bot.ts:1153-1193 `isSessionActive`）是主要兜底；force-send 是用户显式 override，已承担风险；自动并发窗口窄（要 start marker 未写 + busy check 已读的竞态）；真出问题用户 `/resume` 即可恢复。后续若实际发生率高，再考虑 handleChat session case 改 `lockKey=sessionUuid`（超出本 spec 范围） |
| `/cancel` 文本行为变化（旧 "未知命令" → 新 静默） | 🟡 中 | spec §6.2 显式记录；属"修复了之前 broken 的命令"，不算 regression |
| `expectedReply` 清空 + 提示重复触发 | 🟢 低 | handleCommand 入口清空已经覆盖；handleChat 路径不再二次清 |
| 命名冲突（`/help /resume /model /status /agents`）让用户困惑 | 🟡 中 | helpText 末尾加透传说明；未来加 `/cc-help` escape hatch 是 YAGNI，先不做 |
| Claude 把 `/xxx` 当文本误识别成 prompt 内容（不是命令） | 🟢 低 | 用户显式发 `/xxx` 知道语义；透传就是透传 |
| `permission_request` 等待中误打 `/xxx` 导致并发 | 🟢 低 | 跟 chat 文本并发行为一致；SDK canUseTool 本身有锁，sessionManager 还有 sessionLock 兜底 |
| 性能：每次消息都 resolve target | 🟢 低 | 单次 user-mapping 读，~ms 级；远小于 Feishu 网络 RTT |
| 无活跃会话时 `/xxx` 走 no_target 提示，用户以为是命令错误 | 🟢 低 | 提示文本已包含 `/list /switch /new`，够引导 |

## 8. 验收标准

- ✅ `bun run typecheck` 0 错
- ✅ `bun test` 全绿，新测 12 条 + 现有测 0 回退
- ✅ 集成测试：手机飞书发 `/init` → 流式卡片 → Claude 处理 → 结果回飞书
- ✅ 集成测试：手机飞书发 `/help` → cc-linker 命令（不被透传）
- ✅ 集成测试：手机飞书发 `/init`（无会话） → "请先 /new" 提示
- ✅ 集成测试：手机飞书发 `/xxx`（会话 busy） → busy 卡
- ✅ 代码 review：default 分支改动有充分注释说明设计意图
- ✅ CLAUDE.md 文档同步更新

## 9. 实施步骤

1. **Step 1：单测先行**
   - 新增 `tests/unit/feishu/bot-slash-passthrough.test.ts`
   - 用例覆盖 §6.1 全部 12 个场景
   - 验证 fail（预期旧 default "未知命令" 路径断言会断）

2. **Step 2：核心改动**
   - `bot.ts:onMessage` —— 改 target 解析
   - `bot.ts:handleCommand.default` —— 改 default 分支
   - `bot.ts:handleChat` —— 删 dead `/` 分支
   - `bot.ts:helpText` —— 追加 1 行说明

3. **Step 3：现有测试更新**
   - 跑 `bun test`，找出依赖 "未知命令" 文本或 dead code 的断言
   - 逐个更新断言（预期 ≤3 个文件）

4. **Step 4：CLAUDE.md 更新**
   - 在 "Feishu Bot Architecture" 节追加 Slash Command Passthrough 子节

5. **Step 5：本地验证**
   - `bun run typecheck`
   - `bun test` 全绿
   - 真起 daemon（`bun run dev start`），手机飞书发 `/init` 看是否走通

6. **Step 6：spec + plan 收尾**
   - 写 spec 到 `docs/superpowers/specs/2026-06-18-feishu-cc-slash-passthrough-design.md`（本文件）
   - 调用 writing-plans skill 拆任务清单
   - 跑 TDD 闭环

## 10. 修订记录

| 版本 | 日期 | 关键变更 |
|---|---|---|
| v1 | 2026-06-18 | 初版，brainstorming 拍板：全自动透传 + 冲突降级，5 处代码改动，12 条单元测试 |
| v1.1 | 2026-06-18 | Spec review fixes（7 处）：<br>1) **§7 风险矩阵** —— 加 `serialKey` 同 session 不互锁（busy check 兜底）+ `/cancel` 行为变化（修复之前 broken）+ "3 周" → "约 2 周"（PR 2 ship 2026-06-04）<br>2) **§5.4 helpText** —— 对齐修正到第 37 列（中文 2 cell/字）<br>3) **§6.1 测试用例** —— 9/10/11/12 措辞更精确，加 entry reply 断言细节<br>4) **§6.1 测试技巧** —— 明确推荐扩展 `createTestBot` 接受 `opts.sessionManager`<br>5) **§6.2 错误处理矩阵** —— 新增 `/cancel`（等待中）+ `/cancel`（无等待）两行<br>6) **§6.4 grep** —— 扩展到 4 个 pattern：`startsWith('/')` + `未知命令` + `handleCommand.*handleChat` + `msg.text.startsWith` |
| v1.2 | 2026-06-19 | 用户拍板：Issue 1 serialKey 并发风险**接受 Option A 不修**。理由：busy check + force-send 显式确认已是兜底；自动并发窗口窄；force-send 是用户 override，行为一致；出问题 `/resume` 可恢复。修改：§7 风险矩阵降级 🟡 → 🟢 低（已接受），§6.1 用例 #12 措辞改为"不做并发修" |

## 11. 后续步骤

本文档为设计 spec。批准后调用 superpowers 的 `writing-plans` skill 把 §9 实施步骤拆为可执行任务清单（含 TDD 红/绿/重构节奏），落到 `docs/superpowers/plans/`。