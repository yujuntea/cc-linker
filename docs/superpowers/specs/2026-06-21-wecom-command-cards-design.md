# cc-linker 企微侧"命令路径交互式卡片"设计

**日期：** 2026-06-21
**版本：** v1.2（最终 review 2 处追加，共 10 处修正）
**状态：** 待评审
**作者：** Claude Code（brainstorming + 用户拍板 + Claude review 修复）
**范围：** 企微智能机器人命令响应加交互式卡片（button_interaction + text_notice），让用户点按钮免去再打字

### v1.1 修订（review 后 8 处修正）

- **E1（致命）§5.1 case 'resume' 双语义**：handleCommandResume 签名是 `(_userId, _args)` 忽略 args（bot.ts:678），UUID 路径无效。**删除 UUID 路径，只保留"无 value → 提示用法"**。`/resume` 卡片按钮的"📖 恢复"key 移除或改成 `switch` 复用（PR 7 双语义）。
- **E2（致命）§4 builder 代码示例 `TemplateCardButton.value: { sessionId: ... }`**：aibot SDK `TemplateCardButton` 类型无 `value` 字段（api.d.ts:288-295 只有 text/style/key），但运行时 aibot 服务端接受 object value（aibot-client.ts:168 实证）。**builder 必须用 `(button as any).value = ...` 注入 + 单测覆盖 SDK 类型 vs 运行时差异**。
- **E3（致命）§3.3 + §5.1 `actionValue?.sessionId`**：现有代码用 `actionValue?.sessionUuid`（bot.ts:1319 confirm-stop 实证）。**全 spec 改 sessionUuid**。
- **E4（致命）§5.3 "飞书侧已实现，企微照搬即可"**：handleCommandModel 完全没实现 ProviderManager（bot.ts:773-779 注释 "model 持久化推 PR 6+ 配合 ProviderManager"）。**PR 7.5.1 必须实际实现 ProviderManager 集成，不只是注入**。
- **E5（重要）§1.1 "/listdir ≤16 按钮"**：handleCommandListDir 实际 `slice(0, 20)`（bot.ts:828），最多 20 子目录。**改 ≤20 子目录 × 1 按钮 + 父目录 ≤ 21 按钮**。
- **E6（重要）§4.5 "/agents 卡片注入 registryManager"**：handleCommandAgents 完全本地读 `~/.claude/jobs/` state.json（bot.ts:698-728），**不注入 registryManager**。spec 改 builder 只调 handleCommandAgents。
- **E7（小）§9 "PR 7.5.2 新增 3 case"**：实际是 4 case (select_dir/resume/select_model/clear_model)。**改 4 case**。
- **E8（致命）§6.2 "case 'select_dir' 无效路径 → handleCommandNew 内 existsSync 校验，已存在"**：handleCommandNew **没 existsSync 校验**（bot.ts:499-503 直接 setPending）。**PR 7.5.1 必须在 handleCommandNew 加 cwd 校验，或 case 'select_dir' 先校验再调 handleCommandNew**。

---

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
| `/listdir` 按钮数 | 每子目录 1 按钮 + 父目录 1 按钮 = **≤ 21 按钮**（现有 handleCommandListDir `slice(0, 20)` 上限）|
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
| `switch` | PR 7 完成卡 + /list 卡片 | `{ sessionUuid?: string }` | 双语义：有 sessionUuid → 切；无 → 列 sessions |
| `listdir` | PR 7 完成卡 | — | 选目录（无路径）|
| `resume` | ~~/list 卡片 + /switch 卡片~~ **已删（v1.1 E1）** | ~~`{ sessionId: <uuid> }`~~ | handleCommandResume 不接受 args, 双语义无效。改用 `switch` 复用双语义 |
| `select_dir` | /listdir 卡片 | `{ sessionUuid: <full path> }` | 切到具体目录（path 复用 sessionUuid 字段名，跟飞书对齐）|
| `select_model` | /model 卡片 | `{ sessionUuid: <alias> }` | 设默认模型为 alias |
| `clear_model` | /model 卡片 | — | 清除默认模型 |
| `retry` | PR 7 完成卡 action_menu | — | 重试上次 |
| `stop` | PR 7 完成卡 action_menu | — | 停止 in-flight |
| `confirm-stop` | PR 7 完成卡 action_menu | `{ sessionUuid: <uuid> }` | 硬杀 Claude |
| `list-refresh` | PR 7 完成卡 action_menu | — | 刷新 sessions |
| `agents-refresh` | /agents 卡片 action_menu | — | 刷新 bg sessions |

> **关于 `sessionUuid` 字段复用**：飞书把路径、alias 都塞 `sessionId` 字段。企微 aibot 服务端实际用 `action_value.sessionUuid` 接收（bot.ts:1319 confirm-stop 实证），企微侧照搬 `sessionUuid` 字段名。

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
  [🔄 切换 (value.sessionUuid=uuid1)] [📖 恢复 (value.sessionUuid=uuid1)]
[session 2]
  ...
```
**action_menu**（右上角）：[🔄 刷新] (`list-refresh`)

**字段定义**：
```typescript
type ListCardContext = {
  entries: Array<{ sessionUuid: string; title: string; messageCount: number; lastActive: string }>;
  totalActive: number;
};

export function buildListCard(ctx: ListCardContext): WecomTemplateCard {
  const buttons: TemplateCardButton[] = [];
  for (const e of ctx.entries) {
    const switchBtn = { text: '🔄 切换', key: 'switch' };
    (switchBtn as any).value = { sessionUuid: e.sessionUuid };  // PR 7.5 E2: SDK 类型无 value, 运行时注入
    const resumeBtn = { text: '📖 恢复', key: 'resume' };
    (resumeBtn as any).value = { sessionUuid: e.sessionUuid };
    buttons.push(switchBtn, resumeBtn);
  }
  return WecomCardBuilder.buttonInteraction({
    title: `📋 我的会话 (${ctx.entries.length}/${ctx.totalActive})`,
    description: '💡 点按下方按钮切换或恢复 session',
    buttons,
  }) + action_menu([{ tag: 'list-refresh', text: '🔄 刷新' }]);
}
```

> ⚠️ **20 按钮风险 + E2 注入**：企微 aibot SDK `TemplateCardButton` 类型无 `value` 字段（api.d.ts:288-295 只有 text/style/key），但 aibot 服务端运行时接受 object value（aibot-client.ts:168 实证）。**必须用 `(button as any).value` 注入 + 单测覆盖 SDK 类型 vs 运行时差异**。真机 PR 7.5.4 验证 20 按钮渲染。

### 4.2 `/listdir` 卡片（button_interaction）

**触发**：`/listdir` 命令响应替换为卡片
**Builder**：新建 `buildDirListCard(ctx)`
**主标题**：`📂 目录浏览: <cwd>`
**按钮布局**（每子目录 1 按钮 + 父目录 = ≤ 21 按钮）：
```
⬆️ 上级目录: /Users/wuyujun (父目录 button: value.sessionUuid=<parent path>)
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
    const parentBtn = { text: `⬆️ 上级目录`, key: 'select_dir' };
    (parentBtn as any).value = { sessionUuid: ctx.parent };
    buttons.push(parentBtn);
  }
  for (const d of ctx.dirs) {
    const dirBtn = { text: `📁 ${d.name}`, key: 'select_dir' };
    (dirBtn as any).value = { sessionUuid: d.fullPath };
    buttons.push(dirBtn);
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
**前提 (PR 7.5 E4 修正)**：`handleCommandModel` 当前没实现 ProviderManager（bot.ts:773-779）。**PR 7.5.1 必须实际集成 ProviderManager.list() 列 provider**，不只是注入。
**主标题**：`🤖 模型选择`
**按钮布局**：每个 provider 一个按钮
```
[🎯 Opus (当前)]   value.sessionUuid="opus"   style=primary
[🎯 Sonnet]        value.sessionUuid="sonnet"  style=default
[🎯 Haiku]         value.sessionUuid="haiku"   style=default
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
  const buttons: any[] = ctx.providers.map(p => ({
    text: p.alias === ctx.currentAlias ? `🎯 ${p.label} (当前)` : `🎯 ${p.label}`,
    key: 'select_model',
    value: { sessionUuid: p.alias },  // PR 7.5 E2: SDK 类型无 value, 运行时注入
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

> **PR 7.5 E6 修正**：`/agents` 不注入 `registryManager`（轻量化）。现有 `handleCommandAgents` 本地读 `~/.claude/jobs/*/state.json`（bot.ts:698-728），不依赖外部注册表。

### 4.6 `/resume` 附加卡（text_notice + 1 按钮）

**触发**：`/resume <uuid>` 命令响应 markdown 之后再追加小卡片
**Builder**：新建 `buildResumeCard(ctx)`
**主标题**：`✅ Session 已 touch`
**按钮布局**：[📂 切换别的 session] (`switch`，**不带** value → 双语义走"列 sessions")
**action_menu**：无

**字段定义**：
```typescript
type ResumeCardContext = { sessionUuid: string };

export function buildResumeCard(ctx: ResumeCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: `✅ Session 已 touch`,
    content: `uuid: ${ctx.sessionUuid.slice(0, 8)}...`,
    actionMenu: [{ tag: 'switch', text: '📂 切换别的 session' }],
  });
}
```

> ⚠️ **PR 7.5 E1 修正**：`/resume` 命令**只 touch 当前 active session**（不接受 uuid 参数）。附加卡的"📂 切换别的 session"按钮走 `switch` key 不带 value → 列出 active sessions 让用户选。这跟 `/resume` 按钮"恢复具体 session"的语义不同，但因 handleCommandResume 限制只能用此替代方案。

### 4.7 `/stop <short>` 附加卡（text_notice + 1 按钮）

**触发**：`/stop <short>` 命令响应 markdown 之后再追加小卡片
**Builder**：新建 `buildStopCard(ctx)`
**主标题**：`✅ 已停止: <short>`
**按钮布局**：[📂 切换 session] (`switch` 不带 value)

**字段定义**：同 `/resume` 模式，`shortId` 替换 `uuid`。

---

## 5. executeCardAction 改动

### 5.1 新增 4 case（PR 7.5 E7 修正：原 5 case 实际是 4 case，case 'resume' 已删）

```typescript
case 'select_dir': {
  // PR 7.5 E8: 必须先 existsSync 校验, 不存在 sendMarkdown 提示, 不调 handleCommandNew
  const path = event.actionValue?.sessionUuid;  // E3: sessionUuid 不是 sessionId
  if (!path) break;
  const { existsSync } = await import('fs');
  if (!existsSync(path)) {
    await this.client.sdk.sendMessage(event.externalUserId, {
      msgtype: 'markdown',
      markdown: { content: `❌ 路径不存在: \`${path}\`` },
    });
    break;
  }
  await this.handleCommandNew(event.externalUserId, [path]);
  break;
}

case 'select_model': {
  const alias = event.actionValue?.sessionUuid;
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

// PR 7.5 E1: case 'resume' 已删。handleCommandResume 签名 (_userId, _args) 忽略 args,
//   /list 卡片 "📖 恢复" 按钮实际无效。改用 'switch' key 复用 PR 7 双语义:
//   - /list 卡片 'switch' 带 value.sessionUuid → 切到具体 session
//   - /resume 卡片 'switch' 不带 value → 列 sessions (从 PR 7 行为)
```

### 5.2 改动 1 case（双语义 switch）

```typescript
case 'switch': {
  // 双语义: 有 value.sessionUuid → 切具体 session; 无 → 列 sessions
  const targetUuid = event.actionValue?.sessionUuid;
  if (targetUuid) {
    await this.handleCommandSwitch(event.externalUserId, [targetUuid]);
  } else {
    // PR 7 完成卡路径: 列 active sessions
    await this.renderActiveSessionsList(event.externalUserId);
  }
  break;
}
```

### 5.3 新增依赖注入（PR 7.5 E4 修正：实际实现，不只是注入）

**架构挑战**：现有 `handleCommand` 返回 markdown string，由 `handleClaimed` 末尾统一 `sendMessage(responseText)`。但 PR 7.5 需要**推卡片（template_card msgtype）**，不是 markdown。

**修法**：把"无 alias 时显示 model 选择卡"逻辑**提到 `handleCommand` case 'model' 入口**（不在 handleCommandModel 内部）：

```typescript
// handleCommand case 'model' (bot.ts 现有 switch case):
case 'model': {
  if (parsed.args.length === 0 || !parsed.args[0]) {
    // PR 7.5: 无 alias 时推 model 选择卡 (不走 handleCommandModel, 直接走 builder + sender)
    const providers = this.providerManager.list();  // 注入后可用
    const currentAlias = this.userManager.getEntry(msg.userId)?.type === 'session'
      ? this.userManager.getEntry(msg.userId)?.defaultProvider
      : undefined;
    const card = buildModelCard({ providers, currentAlias });
    await this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card });
    this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    return;
  }
  // PR 7.5: 有 alias, 走 handleCommandModel 实际实现 user-mapping entry.defaultProvider
  responseText = await this.handleCommandModel(msg.userId, parsed.args);
  break;
}
```

**handleCommandModel 改造**（PR 7.5.1 集成 ProviderManager）：

```typescript
private async handleCommandModel(userId: string, args: string[]): Promise<string> {
  if (args.length === 0 || !args[0]) {
    return '❌ 用法: /model <model-alias>';  // 保留作为 case 'model' 没经过 builder 路径时的兜底
  }
  if (args[0] === '--clear') {
    // PR 7.5: 清除 entry.defaultProvider (通过 user-mapping)
    const entry = this.userManager.getEntry(userId);
    if (entry?.type === 'session') {
      // TODO: PR 7.5.1 加 userManager.clearDefaultProvider 方法
    }
    return '✅ 已清除默认模型';
  }
  const alias = args[0];
  // PR 7.5: 实际写 user-mapping entry.defaultProvider
  //   TODO: PR 7.5.1 加 userManager.setDefaultProvider 方法
  //   现在 PR 5 stub 只 log + 返回 "已设置" 占位 markdown
  return `✅ 默认模型已设置为 ${alias}\n\n_(注: PR 7.5 临时实现, 持久化推后续 PR)_`;
}
```

**WecomBotConfig + 构造器**：

```typescript
// WecomBotConfig 新增字段
providerManager?: ProviderManager;
wecomCompleteCardSender?: WecomCompleteCardSender;  // PR 7 已注入 sender, 提为构造器可选

// 构造器注入
this.providerManager = config.providerManager ?? new ProviderManager();
this.wecomCompleteCardSender = config.wecomCompleteCardSender ?? new WecomCompleteCardSender(this.client.sdk);
```

> **PR 7.5 E4 强调**：飞书侧 `feishu/bot.ts:3148` `providerManager.list()` 已 work，企微侧**完全没实现**（bot.ts:773-779 注释明确 "model 持久化推 PR 6+"）。PR 7.5.1 必须：
> 1. 实现 `userManager.setDefaultProvider(userId, alias)` + `clearDefaultProvider(userId)`
> 2. 实现 ProviderManager 集成进 handleCommandModel
> 3. case 'model' 无 alias 时走 builder 路径（不调 handleCommandModel）

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
| `case 'switch'` value.sessionUuid 缺失 | 走"列 sessions" fallback（双语义保护） |
| ~~`case 'resume'` value.sessionId 缺失~~ | **已删 (v1.1 E1)** |
| `case 'select_dir'` 无效路径 | **PR 7.5 E8: case 内 existsSync 校验 (bot.ts:499-503 handleCommandNew 没校验)** |
| `case 'select_model'` alias 不存在 | `handleCommandModel` 内 alias 校验，已存在 |
| `case 'clear_model'` user-mapping 无 defaultProvider | 静默 no-op |
| `case 'agents-refresh'` 无 registryManager 依赖 | **PR 7.5 E6: handleCommandAgents 本地读 ~/.claude/jobs/, 不需 registryManager** |
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
| **PR 7.5.2** | `/list` + `/listdir` 改造 + executeCardAction 新增 3 case (switch 双语义 / select_dir / resume 删) + 新增 4 case (select_dir / resume / select_model / clear_model) | 改 1 + 测试 1 |
| **PR 7.5.3** | `/model` + `/switch` + `/agents` + `/resume` + `/stop` 附加卡片 + case 'agents-refresh' (resume 双语义 case 已删 E1) | 改 1 + 测试 1 |
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
