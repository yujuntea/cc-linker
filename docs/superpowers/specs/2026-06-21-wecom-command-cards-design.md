# cc-linker 企微侧"命令路径交互式卡片"设计

**日期：** 2026-06-21
**版本：** v1.0
**状态：** 待评审
**作者：** Claude Code（brainstorming + 用户拍板）
**范围：** 企微智能机器人命令响应加交互式卡片（button_interaction + text_notice），让用户点按钮免去再打字

---

## 1. 问题陈述

PR 7 已 ship 流式输出完成后完成卡片，但**命令路径响应仍是纯 markdown**：

| 命令 | PR 7 现状 | 用户体验 |
|---|---|---|
| `/list` | 推 markdown 列表（10 个 active sessions） | 用户看到列表要再打字 `/switch <uuid>` |
| `/listdir` | 推 markdown 列表（cwd 子目录） | 用户看到列表要再打字 `/new <path>` |
| `/model`（无 alias）| 推 markdown 错误提示"用法" | 用户看到用法要再打字 `/model <alias>` |
| `/switch` | 推 markdown "已切换" | 切换完不知道下一步做什么 |
| `/agents` | 推 markdown bg sessions 列表 | 无法刷新 |
| `/resume` | 推 markdown "已 touch" | 无快捷切换别的 session |
| `/stop <short>` | 推 markdown "已停止" | 无快捷切换别的 session |

**目标**：让 7 个命令响应也带交互式卡片，**按钮 1:1 对齐飞书**（用户已经在飞书侧习惯这套交互）。

### 1.1 已澄清的决策

| 决策点 | 决策 |
|---|---|
| 改造范围 | **7 命令全改造**（P0: /list /listdir /model；P1: /switch /agents；P2: /resume /stop）|
| 卡片类型 | button_interaction（带按钮时）+ text_notice + action_menu（小改造 / 单按钮）|
| 卡片发送 | 复用 PR 7 `WecomCompleteCardSender` 框架（`sendMessage` 走 5s replyWelcome 窗口外，无超时风险）|
| 按钮 key 命名 | 跟飞书业务名 1:1（`resume` / `select_dir` / `select_model` / `clear_model` / `agents-refresh`）+ 复用 PR 7 已有 key |
| `switch` 双语义 | 按 `actionValue?.sessionId` 是否存在区分：有 → 立即切具体 session；无 → 列 active sessions（PR 7 行为）|
| `resume` 双语义 | 同上：有 → touch session；无 → 提示用法 |
| `/list` 按钮数 | **保持 10 条 session × 2 按钮 = 20 按钮**（跟现有 `handleCommandListCard` 一致），真机验证 SDK 接受度 |
| `/listdir` 按钮数 | 每子目录 1 按钮 + 父目录 1 按钮 = ≤ 16 按钮（飞书 `MAX_DIR_LIST_ITEMS=15`）|
| 重构 `WecomCardBuilder` | ❌ 不动（PR 7 m-9 决策不变），复用现有 builder |

### 1.2 非目标（YAGNI）

- ❌ 重构 `card.ts` 对齐 aibot SDK 真实字段（历史坑另开 PR 修）
- ❌ 实现 `news_notice` / `vote_interaction` / `multiple_interaction` 卡片类型
- ❌ 完整 AgentView（peek/reply/attach 9+ key 流程，留 PR 8+）
- ❌ 多用户并发完成卡片管理（spec §1.2 单 user 决策不变）
- ❌ 飞书侧任何变更（**零回归硬约束**）
- ❌ 改 PR 7 已 ship 的流式完成卡片逻辑（command card 是新 trigger point）

---

## 2. 现状回顾

### 2.1 飞书侧命令卡片（参考实现）

飞书侧 4 个命令用 CardKit 卡片，参考 `src/feishu/bot.ts:3860-4084`：

| 命令 | 飞书 builder | 按钮 key + value |
|---|---|---|
| `/list` | `buildListCard` (line 3860) | `tag: 'switch'` `value: { sessionId: <uuid> }` 🔄 切换<br>`tag: 'resume'` `value: { sessionId: <uuid> }` 📖 恢复 |
| `/listdir` | `buildDirListCard` (line 4028) | `tag: 'select_dir'` `value: { sessionId: <full path> }` 📁 / ⬆️ |
| `/switch` | `buildSessionOverviewCard` (line 3917) | `tag: 'resume'` `value: { sessionId: <uuid> }` 📖 恢复指引 |
| `/model` | `buildModelCard` (line 3965) | `tag: 'select_model'` `value: { sessionId: <alias> }` 🎯 选择 / `tag: 'clear_model'` 🧹 清除 |

飞书 `case` 路由（line 650-685）：
```typescript
switch (tag) {
  case 'switch': return await this.doSwitch(openId, sessionId, messageId);  // sessionId 来自 value.sessionId
  case 'resume': return await this.doResume(openId, sessionId);
  case 'select_model': return await this.doSelectModel(openId, sessionId, messageId);
  case 'clear_model': return await this.doClearModel(openId, messageId);
  case 'select_dir': return await this.doSelectDir(openId, sessionId, messageId);
}
```

**关键观察**：飞书 `/list` 卡片上 `switch` 按钮的 `value.sessionId` 始终有值（指向具体 session）；PR 7 完成卡片的 `switch` 按钮 value 为空（仅"列 sessions"）。`executeCardAction` 入口根据 `value.sessionId` 是否存在自然区分双语义，**零冲突**。

### 2.2 企微侧命令响应（改造前）

`src/wecom/bot.ts` 现有 13 个命令响应方法，全部返回 markdown string：

| 方法 | 当前位置 | 响应类型 |
|---|---|---|
| `handleCommandListCard` | bot.ts:547 | 10 sessions 列表 markdown |
| `handleCommandListDir` | bot.ts:855 | cwd 子目录列表 markdown |
| `handleCommandModel` | bot.ts:1005 | 错误用法 OR 模型列表（未实现）|
| `handleCommandSwitch` | bot.ts:670 | "已切换" markdown |
| `handleCommandAgents` | bot.ts:935 | bg sessions 列表 markdown |
| `handleCommandResume` | bot.ts:780 | "session 已 touch" markdown |
| `handleCommandStop` | bot.ts:730 | "已停止" markdown |

### 2.3 PR 7 完成卡片（复用框架）

`src/wecom/complete-card.ts`（PR 7.1 ship）已提供：
- `WecomCardBuilder.buttonInteraction(opts)` — 主卡 builder
- `WecomCompleteCardSender.send(ctx)` — `sendMessage` 主动推送
- 5 export: `CompleteCardContext` / `COMPLETE_CARD_MAIN_BUTTONS` / `COMPLETE_CARD_ACTION_MENU` / `buildCompleteCard` / `WecomCompleteCardSender`

**复用方式**：命令响应新建 `buildXxxCard(ctx)` 函数 + `WecomCompleteCardSender.send(ctx)` 推卡片，零新建框架。

### 2.4 现有 executeCardAction 框架

`src/wecom/bot.ts:1262-1345` 现有 8 case：`retry` / `stop` / `confirm-stop` / `list-refresh` / `continue` / `switch` / `listdir`。

---

## 3. 设计

### 3.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│               命令响应路径 (新)                                │
│  WecomBot.handleCommandListCard                            │
│    └─ buildListCard(ctx) → TemplateCard                     │
│    └─ WecomCompleteCardSender.send(ctx) → sdk.sendMessage    │
│         ↓                                                    │
│  用户点按钮 → SDK onCardAction                               │
│    └─ WecomBot.executeCardAction(event)                      │
│         └─ case 'switch' / 'resume' / 'select_dir' / ...   │
└─────────────────────────────────────────────────────────────┘

PR 7 完成卡 (流式路径)
  WecomBot.handleChat → Claude 流式 → updater.complete
    └─ completeCardSender.send(ctx) → sdk.sendMessage
         ↓
  用户点按钮 → executeCardAction (同 entry point)
```

**关键设计**：命令卡片 + 流式完成卡片**共用同一个 `executeCardAction` switch**，case 路由统一，按钮 key 全局命名空间。

### 3.2 卡片触发点设计

| 命令 | handleCommand 方法 | 改造后调用 |
|---|---|---|
| `/list` | `handleCommandListCard` | `buildListCard(ctx)` + `WecomCompleteCardSender.send(ctx)`（替换原 `sendMessage` markdown）|
| `/listdir` | `handleCommandListDir` | `buildDirListCard(ctx)` + sender.send |
| `/model`（无 alias）| `handleCommandModel` | `buildModelCard(ctx)` + sender.send |
| `/switch` | `handleCommandSwitch` | 现有 `responseText = ...` 后再 `sender.send({...})` 附加完成卡（不替换）|
| `/agents` | `handleCommandAgents` | 现有 `responseText = ...` 后再 `sender.send({...})` 加 agents-refresh action_menu |
| `/resume` | `handleCommandResume` | 现有 `responseText = ...` 后再 `sender.send({...})` 加 1 按钮 text_notice |
| `/stop` | `handleCommandStop` | 同 `/resume` |

**触发模式区分**：
- **替换模式**（`/list` `/listdir` `/model`）：把 markdown 文本塞到 card 的 markdown 元素里，整张卡代替 markdown 消息
- **附加模式**（`/switch` `/resume` `/stop`）：先推 markdown，再推一张小卡片
- **增强模式**（`/agents`）：先推 markdown 列表，再推 text_notice + agents-refresh

### 3.3 按钮 key / value 全局命名空间

| key | 来源 | value | 含义 |
|---|---|---|---|
| `continue` | PR 7 完成卡 | — | 新会话（无 sessionId）|
| `switch` | PR 7 完成卡 + /list 卡片 | `{ sessionId?: string }` | 双语义：有 sessionId → 切；无 → 列 sessions |
| `listdir` | PR 7 完成卡 | — | 选目录（无路径）|
| `resume` | /list 卡片 + /switch 卡片 | `{ sessionId: <uuid> }` | 双语义：有 → touch；无 → 提示用法 |
| `select_dir` | /listdir 卡片 | `{ sessionId: <full path> }` | 切到具体目录（path 复用 sessionId 字段名，跟飞书对齐）|
| `select_model` | /model 卡片 | `{ sessionId: <alias> }` | 设默认模型为 alias |
| `clear_model` | /model 卡片 | — | 清除默认模型 |
| `retry` | PR 7 完成卡 action_menu | — | 重试上次 |
| `stop` | PR 7 完成卡 action_menu | — | 停止 in-flight |
| `confirm-stop` | PR 7 完成卡 action_menu | `{ sessionId: <uuid> }` | 硬杀 Claude |
| `list-refresh` | PR 7 完成卡 action_menu | — | 刷新 sessions |
| `agents-refresh` | /agents 卡片 action_menu | — | 刷新 bg sessions |

> **关于 `sessionId` 字段复用**：飞书把路径、alias 都塞 `sessionId` 字段（统一命名空间）。企微侧照搬，避免 SDK 字段白名单冲突。

---

## 4. 7 个命令卡片设计

### 4.1 `/list` 卡片（button_interaction）

**触发**：`/list` 命令响应替换为卡片
**Builder**：新建 `buildListCard(ctx)` in `src/wecom/card-builders.ts`（新文件，~200 行）
**主标题**：`📋 我的会话 (10/777)`
**按钮布局**（10 条 session × 2 按钮 = 20 按钮）：
```
[session 1]
  📋 Analyze AI coding attribution accuracy (768 msgs) _2026-06-21T13:24_
  [🔄 切换 (value.sessionId=uuid1)] [📖 恢复 (value.sessionId=uuid1)]
[session 2]
  ...
```
**action_menu**（右上角）：[🔄 刷新] (`list-refresh`)

**字段定义**：
```typescript
type ListCardContext = {
  entries: Array<{ uuid: string; title: string; messageCount: number; lastActive: string }>;
  totalActive: number;
};

export function buildListCard(ctx: ListCardContext): WecomTemplateCard {
  const buttons: TemplateCardButton[] = [];
  for (const e of ctx.entries) {
    buttons.push({ text: '🔄 切换', key: 'switch', value: { sessionId: e.uuid } });
    buttons.push({ text: '📖 恢复', key: 'resume', value: { sessionId: e.uuid } });
  }
  return WecomCardBuilder.buttonInteraction({
    title: `📋 我的会话 (${ctx.entries.length}/${ctx.totalActive})`,
    description: '💡 点按下方按钮切换或恢复 session',
    buttons,
  }) + action_menu([{ tag: 'list-refresh', text: '🔄 刷新' }]);
}
```

> ⚠️ **20 按钮风险**：企微 aibot SDK button_interaction.button_list 字段类型无明确上限（README 无说明），PR 7.5 真机验证。降级方案：超 6 按钮自动改 text_notice + 折叠。

### 4.2 `/listdir` 卡片（button_interaction）

**触发**：`/listdir` 命令响应替换为卡片
**Builder**：新建 `buildDirListCard(ctx)`
**主标题**：`📂 目录浏览: <cwd>`
**按钮布局**（每子目录 1 按钮 + 父目录 = ≤ 16 按钮）：
```
⬆️ 上级目录: /Users/wuyujun (父目录 button: value.sessionId=<parent path>)
[📁 activity-test-project]
[📁 aibot-poc]
...
```
**action_menu**：[🔄 刷新] (`listdir-refresh`) — 复用 PR 7 模式

**字段定义**：
```typescript
type DirListCardContext = {
  cwd: string;
  parent: string | null;
  dirs: Array<{ name: string; fullPath: string }>;
  hasMore: boolean;
};

export function buildDirListCard(ctx: DirListCardContext): WecomTemplateCard {
  const buttons: TemplateCardButton[] = [];
  if (ctx.parent) {
    buttons.push({ text: `⬆️ 上级目录`, key: 'select_dir', value: { sessionId: ctx.parent } });
  }
  for (const d of ctx.dirs) {
    buttons.push({ text: `📁 ${d.name}`, key: 'select_dir', value: { sessionId: d.fullPath } });
  }
  return WecomCardBuilder.buttonInteraction({
    title: `📂 ${ctx.cwd}`,
    description: ctx.hasMore ? '💡 还有更多子目录未显示' : `💡 共 ${ctx.dirs.length} 个子目录`,
    buttons,
  });
}
```

### 4.3 `/model` 卡片（button_interaction）

**触发**：`/model` 命令（无 alias）响应替换为卡片
**Builder**：新建 `buildModelCard(ctx)`
**前提**：需要注入 `ProviderManager`（飞书 `bot.ts:3148` `providerManager.list()`）。**PR 7.5 同时注入 ProviderManager**。
**主标题**：`🤖 模型选择`
**按钮布局**：每个 provider 一个按钮
```
[🎯 Opus (当前)]   value.sessionId="opus"   style=primary
[🎯 Sonnet]        value.sessionId="sonnet"  style=default
[🎯 Haiku]         value.sessionId="haiku"   style=default
[🧹 清除默认]
```
**action_menu**：无

**字段定义**：
```typescript
type ModelCardContext = {
  providers: Array<{ alias: string; label: string }>;
  currentAlias?: string;
};

export function buildModelCard(ctx: ModelCardContext): WecomTemplateCard {
  const buttons: TemplateCardButton[] = ctx.providers.map(p => ({
    text: p.alias === ctx.currentAlias ? `🎯 ${p.label} (当前)` : `🎯 ${p.label}`,
    key: 'select_model',
    value: { sessionId: p.alias },
    style: p.alias === ctx.currentAlias ? 'default' : 'primary',
  }));
  buttons.push({ text: '🧹 清除默认', key: 'clear_model', style: 'danger' });
  return WecomCardBuilder.buttonInteraction({
    title: '🤖 模型选择',
    description: '💡 点按下方按钮设默认模型',
    buttons,
  });
}
```

### 4.4 `/switch` 完成卡（button_interaction，复用 PR 7）

**触发**：`/switch <uuid>` 命令响应 markdown 之后再追加完成卡
**Builder**：复用 PR 7 `buildCompleteCard(ctx)`
**主标题**：`✅ 已切换: <sessionTitle>`
**按钮布局**：PR 7 完成卡 3 主按钮 + 4 action_menu（`continue` / `switch` / `listdir` / `retry` / `stop` / `confirm-stop` / `list-refresh`）

**字段定义**：直接复用 `CompleteCardContext`，传 `sessionTitle` + `sessionUuid` + `cwd`。

### 4.5 `/agents` 附加卡（text_notice + action_menu）

**触发**：`/agents` 命令响应 markdown 列表之后再追加小卡片
**Builder**：新建 `buildAgentsRefreshCard(ctx)`
**主标题**：`📊 BG Sessions (N)`
**action_menu**：[🔄 刷新] (`agents-refresh`)

**字段定义**：
```typescript
type AgentsCardContext = {
  bgCount: number;
};

export function buildAgentsRefreshCard(ctx: AgentsCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: `📊 BG Sessions (${ctx.bgCount})`,
    content: '💡 点右上角刷新列表',
    actionMenu: [{ tag: 'agents-refresh', text: '🔄 刷新' }],
  });
}
```

### 4.6 `/resume` 附加卡（text_notice + 1 按钮）

**触发**：`/resume <uuid>` 命令响应 markdown 之后再追加小卡片
**Builder**：新建 `buildResumeCard(ctx)`
**主标题**：`✅ Session 已 touch`
**按钮布局**：[📂 切换别的 session] (`switch`，**不带** value → 双语义走"列 sessions")
**action_menu**：无

**字段定义**：
```typescript
type ResumeCardContext = { uuid: string };

export function buildResumeCard(ctx: ResumeCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: `✅ Session 已 touch`,
    content: `uuid: ${ctx.uuid.slice(0, 8)}...`,
    actionMenu: [{ tag: 'switch', text: '📂 切换别的 session' }],
  });
}
```

> ⚠️ **textNotice + 0 action_menu 42045 风险**（PR 7.11 教训）：确保至少 1 个 action_menu 项。

### 4.7 `/stop <short>` 附加卡（text_notice + 1 按钮）

**触发**：`/stop <short>` 命令响应 markdown 之后再追加小卡片
**Builder**：新建 `buildStopCard(ctx)`
**主标题**：`✅ 已停止: <short>`
**按钮布局**：[📂 切换 session] (`switch` 不带 value)

**字段定义**：同 `/resume` 模式，`shortId` 替换 `uuid`。

---

## 5. executeCardAction 改动

### 5.1 新增 5 case

```typescript
case 'resume': {
  // 双语义: 有 value.sessionId → touch session; 无 → 提示用法
  const uuid = event.actionValue?.sessionId;
  if (uuid) {
    await this.handleCommandResume(event.externalUserId, [uuid]);
  } else {
    await this.client.sdk.sendMessage(event.externalUserId, {
      msgtype: 'markdown',
      markdown: { content: '💡 用法: 在 /list 卡片上点 [📖 恢复] 按钮, 或 `/resume <short>`' },
    });
  }
  break;
}

case 'select_dir': {
  const path = event.actionValue?.sessionId;  // 路径复用 sessionId 字段
  if (path) {
    await this.handleCommandNew(event.externalUserId, [path]);
  }
  break;
}

case 'select_model': {
  const alias = event.actionValue?.sessionId;
  if (alias) {
    await this.handleCommandModel(event.externalUserId, [alias]);
  }
  break;
}

case 'clear_model': {
  // 飞书 doClearModel 行为: 清除 user-mapping 中的 defaultModel
  await this.handleCommandModel(event.externalUserId, ['--clear']);
  break;
}

case 'agents-refresh': {
  // 重新跑 /agents 命令响应逻辑
  await this.handleCommandAgents(event.externalUserId, []);
  break;
}
```

### 5.2 改动 2 case（双语义）

```typescript
case 'switch': {
  // 双语义: 有 value.sessionId → 切具体 session; 无 → 列 sessions
  const targetUuid = event.actionValue?.sessionId;
  if (targetUuid) {
    await this.handleCommandSwitch(event.externalUserId, [targetUuid]);
  } else {
    // PR 7 完成卡路径: 列 active sessions
    await this.renderActiveSessionsList(event.externalUserId);
  }
  break;
}

// case 'resume' 双语义见 5.1
```

### 5.3 新增依赖注入

PR 7.5 必须注入 **ProviderManager**（`/model` 用），否则 `handleCommandModel` 没法列 provider：

```typescript
// WecomBotConfig 新增字段
providerManager?: ProviderManager;

// 构造器注入
this.providerManager = config.providerManager;
```

> 飞书 `feishu/bot.ts:3148` 用法参考。ProviderManager 已有标准实现（飞书侧用），企微侧**新注入**。

---

## 6. 错误处理

### 6.1 卡片发送失败

| 错误 | 处理 |
|---|---|
| `sendMessage` 网络超时 | `sender.send` 包了 try/catch → warn log，不影响命令响应（已发 markdown）|
| `sendMessage` errcode 非 0 | 跟 PR 7 完成卡一样，warn log，下游兜底靠 markdown 响应 |
| 卡片 schema 校验失败 | Zod schema 已在 WecomCardBuilder 内部 catch |

### 6.2 按钮回调失败

| 错误 | 处理 |
|---|---|
| `setImmediate` 5s 后才调 executeCardAction | 现有 `replyWelcome` 兜底占位（`⏳ 处理中...`） |
| `case 'switch'` value.sessionId 缺失 | 走"列 sessions" fallback（双语义保护） |
| `case 'resume'` value.sessionId 缺失 | 走"提示用法" fallback |
| `case 'select_dir'` 无效路径 | `handleCommandNew` 内 `existsSync` 校验，已存在 |
| `case 'select_model'` alias 不存在 | `handleCommandModel` 内 alias 校验，已存在 |
| `case 'clear_model'` user-mapping 无 defaultModel | 静默 no-op |
| `case 'agents-refresh'` registryManager 未注入 | warn log（已有逻辑） |
| 未知 actionTag | `default: logger.warn`（已有） |

### 6.3 并发安全

| 场景 | 处理 |
|---|---|
| 命令响应 markdown 后用户立刻点按钮 | 命令卡片和流式卡片用同一个 executeCardAction，无并发问题 |
| 多个用户同时点同一张卡片 | executeCardAction 入口 validateOwner 已覆盖（PR 6 修复） |
| 用户点按钮触发命令响应后又点 PR 7 完成卡按钮 | 两次 executeCardAction 入口都走 switch case，串行无冲突 |

### 6.4 SDK 限制风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| `/list` 20 按钮超 SDK 上限 | 中 | 真机验证；超 6 按钮降级 text_notice + 折叠 |
| `/listdir` 16 按钮超 SDK 上限 | 低 | 飞书侧能用，企微 SDK 应一致 |
| `textNotice` + 0 action_menu 42045 | 已修 | 确保所有 text_notice 至少 1 个 action_menu |

---

## 7. 测试策略

### 7.1 单测覆盖

| 文件 | 新增 case |
|---|---|
| `tests/unit/wecom/card-builders.test.ts`（新） | buildListCard / buildDirListCard / buildModelCard / buildAgentsRefreshCard / buildResumeCard / buildStopCard 字段正确性 |
| `tests/unit/wecom/bot.test.ts` | 7 命令 handleCommand 调用新 builder（mock sender）；5 新 case + 2 双语义 case |
| 集成测试 | 复用 PR 7 集成测试模式，加 1 个"handleCommandListCard → sender.send 收到正确按钮 key" |

### 7.2 手动 E2E（必做）

| 场景 | 期望 |
|---|---|
| 发 `/list` | 卡片 10 条 session × 2 按钮 + action_menu 刷新 |
| 点 `/list` 卡片 [🔄 切换] 按钮 | 用户收到"已切换 session" markdown（来自 `handleCommandSwitch`）|
| 发 `/listdir /tmp` | 卡片 10 个子目录 + 父目录按钮 |
| 点 `/listdir` 卡片 [📁 <name>] | 用户收到"已新建 pending session (cwd=<name>)"|
| 发 `/model`（无 alias） | 卡片列 provider + 🎯 按钮 + 🧹 清除 |
| 点 [🎯 Opus] | 用户收到"默认模型已设置为 opus"|
| 发 `/switch <uuid>` | markdown 响应后追加 PR 7 完成卡（3 主 + 4 项）|
| 发 `/resume <uuid>` | markdown 响应后追加 text_notice + 1 按钮（[📂 切换别的]）|
| 点 PR 7 完成卡 [📂 切换 session] | 现有 PR 7 行为不变（列 sessions）|
| 发 `/stop <short>` | markdown 响应后追加 text_notice + 1 按钮 |

### 7.3 不测的场景（YAGNI）

- ❌ 多用户并发卡片（spec §1.2 单 user）
- ❌ 卡片样式 pixel-perfect 验收（视觉验证）
- ❌ SDK 内部按钮 key 白名单边界（除非真机失败）

---

## 8. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `/list` 20 按钮超 SDK 上限 | 中 | 卡片不显示 | 真机验证 + 降级方案（超 6 改 text_notice 折叠） |
| `case 'switch'` 双语义混淆 | 低 | 用户点错按钮 | value.sessionId 缺失 fallback 明确 |
| ProviderManager 注入失败 | 低 | `/model` 报"用法" | 飞书侧已实现，企微照搬即可 |
| `case 'select_dir'` path 含特殊字符 | 低 | sendMessage 失败 | path 用 base64 编码？暂不（飞书没做） |
| `textNotice + 0 action_menu` 42045 风险 | 中 | 卡片不显示 | 所有 textNotice 必须至少 1 个 action_menu |

---

## 9. PR 拆分（4 个 ship-ready PR）

| PR | 范围 | 文件 |
|---|---|---|
| **PR 7.5.1** | 公共框架: 新建 `card-builders.ts` + 5 builder + ProviderManager 注入 + WecomBotConfig 加字段 | 新增 1 + 改 1 + 测试 1 |
| **PR 7.5.2** | `/list` + `/listdir` 改造 + executeCardAction 新增 2 case (switch 双语义 / resume 双语义) + 新增 3 case (select_dir / resume / select_model / clear_model) | 改 1 + 测试 1 |
| **PR 7.5.3** | `/model` + `/switch` + `/agents` + `/resume` + `/stop` 附加卡片 + case 'agents-refresh' + 'resume' (双语义 'resume' case 已在 PR 7.5.2) | 改 1 + 测试 1 |
| **PR 7.5.4** | 真机 E2E + 部署 + 截图 | — |

每个 PR 独立 ship-ready，单测 + typecheck + 部署 + 真机测试全过。

---

## 10. 参考文档

- 飞书 4 个 builder: `src/feishu/bot.ts:3860-4084`
- 飞书 case 'switch' 实现: `src/feishu/bot.ts:664-665`
- 飞书 case 'select_model' / 'clear_model' / 'select_dir': `src/feishu/bot.ts:671-682`
- PR 7 spec (风格基准): `docs/superpowers/specs/2026-06-20-wecom-complete-card-design.md` v1.1
- PR 7 complete-card.ts (复用框架): `src/wecom/complete-card.ts`
- 企微 executeCardAction 现有 case: `src/wecom/bot.ts:1262-1345`
- 飞书 ProviderManager (注入参考): `src/feishu/bot.ts:3148`
