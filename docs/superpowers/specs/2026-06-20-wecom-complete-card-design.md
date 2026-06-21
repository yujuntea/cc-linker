# cc-linker 企微侧"流式 markdown + 终态完成卡片"设计

**日期：** 2026-06-20
**版本：** v1.1（review 6 处修正）
**状态：** 待评审
**作者：** Claude Code（brainstorming + 用户拍板 + Claude review 修复）
**范围：** 企微智能机器人通道终态体验增强——流式输出结束时发一张带按钮的"完成卡片"，复用现有 4 个 case + 新增 3 个 case

### v1.1 修订（review 后 7 处修正）

- **§3.3.1 case 'continue'**：补幂等保护 — 已有 active session / pending session 时提示不覆盖（跟 §3.3.3 表格承诺对齐，避免覆盖用户未保存的状态）
- **§4.1 WecomTemplateCard 类型**：从新定义改为 `import type { WecomTemplateCard } from './card'`（`card.ts:112` 已定义），避免类型冲突
- **§4.2.1 lastSession 字段声明**：补 `lastSessionTitle` / `lastSessionUuid` / `lastCwd` 三个字段（不只是 lastUserId）
- **§4.2.3 complete() 末尾**：修正 send 调用为 `completeCardSender.send(ctx)`（旧写法 `completeCardSender(ctx)` 错） + 字段 fallback `completeCtx?.x ?? this.lastX`
- **§4.2.2.1（新增）setCompleteCardSender 调用时机**：文档化为"WecomBot 构造后立即调一次"，跟现有 `setMsgFallback` 同模式
- **§6.3 引用修正**："spec §3.4" → "§1.2 非目标"（引用错）
- **§4.3.1 删重复**：移除重复的 `setCompleteCardSender` 代码（已在 §4.2.2.1 文档化），只保留 `completeCtx` 传参

---

## 1. 问题陈述

cc-linker 企微侧当前体验：
- ✅ 流式过程中能看到 thinking + tool_use + text（PR 6.12 修过的 markdown 格式）
- ❌ **终态后用户没有任何快捷入口**，只能再打字触发 `/new` `/switch` `/listdir` 等命令
- ❌ 飞书侧"卡片实时 patch" 体验，企微无法复制（SDK 限制：`updateTemplateCard` 仅响应 `template_card_event` 5s 内调用）

**目标**：在流式输出结束后，主动 `sendMessage` 发一张"完成卡片"，提供 [继续] / [切换 session] / [选目录] 三个常用按钮 + 复用品类已有按钮（[🛑 停止] / [🔁 重试] / [🔄 刷新列表] / [🛂 硬杀]）。让用户点一下就完事，不再打字。

### 1.1 已澄清的决策

| 决策点 | 决策 |
|---|---|
| 卡片内容 | `button_interaction` 类型（≤6 按钮），保留现有 `action_menu` 模式 |
| 卡片发送时机 | 流式输出 `complete()` 成功后 100ms 内 `sendMessage` |
| 卡片发送通道 | `sendMessage(chatid, body)` 主动推送（**不**走 replyStream 续传，**不**走 updateTemplateCard） |
| 按钮 key 命名 | 业务名（`continue` / `switch` / `listdir` / `retry` / `stop` / `confirm-stop` / `list-refresh`）|
| 按钮数量上限 | 6 个（aibot SDK 硬限制）；本设计最多 7 个 → 拆主卡 + `action_menu` |
| 过期语义 | 永久有效；但点按后业务态已变化则幂等 no-op |
| 重写 card.ts | ❌ 不动，保持现状（已有 4 个 case 都 work） |
| SDK 字段命名 | 不变（继续用现有 `WecomCardBuilder` 生成的字段） |

### 1.2 非目标（YAGNI）

- ❌ 实现"卡片实时 patch 流式过程"（SDK 不支持，已确认）
- ❌ 重写 `src/wecom/card.ts` 对齐 aibot SDK 真实字段（历史坑另开 PR 修）
- ❌ 实现 `text_notice` / `news_notice` / `vote_interaction` / `multiple_interaction` 卡片类型
- ❌ 多 user 并发完成卡片管理（spec §3.4 单 user 决策不变）
- ❌ 飞书侧任何变更（**零回归硬约束**）

---

## 2. 现状回顾

### 2.1 已有的卡片交互基础设施

`src/wecom/bot.ts` 已有完整框架：

- `AibotClient.onCardAction(handler)` — SDK 监听 `event.template_card_event`，转 `AibotCardActionHandler`
- `WecomBot.handleCardAction(event)` — 入口：5s 内 `replyWelcome` 占位 + `setImmediate(executeCardAction)`
- `WecomBot.executeCardAction(event)` — switch case，已实现：
  - `retry` — 提示用户重发消息（PR 6.21 P1#4）
  - `stop` — `updater.cancel('用户从卡片点击停止')`（PR 6 Task 6.5）
  - `confirm-stop` — `killSessionByUuid(sessionUuid)`（PR 6 Task 6.6）
  - `list-refresh` — `registryManager.listActive()` 推 markdown（PR 6.11）
- 测试 seam：`__test_executeCardAction(event)` 暴露给单测

### 2.2 已有的流式输出

`src/wecom/stream-updater.ts:259 complete()` 已能：
- 收到 thinking + toolUses + response
- 渲染完整结构 markdown（`renderMarkdown`，仿飞书 buildStreamingCard + buildCompleteCard）
- `replyStream(finish=true)` 关闭流
- 失败兜底 `sendMessage` markdown

**唯一缺**：complete 成功后**没有主动 sendMessage 完成卡片**——这是本 PR 的核心改动。

### 2.3 已有 SDK 接入点

`@wecom/aibot-node-sdk` 提供：
- `WSClient.sendMessage(chatid, body)` — 主动推送 markdown / template_card / 媒体（README line 240-265）
- `WSClient.updateTemplateCard(frame, templateCard, userids?)` — 响应 template_card_event 5s 内调用（README line 226-236）
- `WSClient.replyWelcome(frame, body)` — 已有 `handleCardAction` 调用

---

## 3. 设计

### 3.1 完成卡片的内容模型

#### 3.1.1 主卡（`button_interaction`）—— ≤6 按钮

流式输出完成时发送的卡，按钮布局：

```
[主标题]  Claude 处理完成
[描述]    💡 点按下方按钮继续
[按钮 1]  🔁 继续          key=continue
[按钮 2]  📂 切换 session  key=switch
[按钮 3]  📁 选目录        key=listdir
[按钮 4]  (空槽)
[按钮 5]  (空槽)
[按钮 6]  (空槽)
[右上角]  ⋮ 操作菜单 (action_menu)
```

**主卡按钮**（3 个，本 PR 新增）：
| key | text | 行为 |
|---|---|---|
| `continue` | 🔁 继续 | 等价 `/new`：调 `userManager.setPending(userId)` + `sendMessage` 提示"新会话就绪，发新消息即可" |
| `switch` | 📂 切换 session | 等价 `/list`：调用已有 `handleCommandList` 渲染列表（推 markdown） |
| `listdir` | 📁 选目录 | 等价 `/listdir`：调用已有 `handleCommandListDir` 渲染目录列表 |

> 注意：现有 `__test_handleCommand` 已有 case `list` / `listdir`，但 `handleCommand` 走 `SpoolQueue` 路径。卡片按钮不走 spool——直接调私有方法即可（见 §3.3）。

#### 3.1.2 action_menu（右上角更多）—— 复用已有 4 个 case

`WecomCardBuilder.textNotice` 已支持 `actionMenu` 参数（PR 7 m-9）。完成卡片 `action_menu.action_list`：

```typescript
[
  { tag: 'retry',          text: '🔁 重试本次' },
  { tag: 'stop',           text: '🛑 停止' },
  { tag: 'confirm-stop',   text: '🛂 硬杀 Claude' },
  { tag: 'list-refresh',   text: '🔄 刷新列表' },
]
```

> 这是把现有 4 个 case 从"其他位置"挪到完成卡片的 action_menu（不冲突——主卡 3 个 + action_menu 4 个 = 7 个，action_menu 不受主卡 6 按钮限制）。

#### 3.1.3 task_id 生成

```typescript
function genTaskId(userId: string): string {
  // aibot SDK: 数字、字母、_-@，最长 128 字节
  // 实施时为避免同毫秒冲突加了 6 字符 Math.random() 后缀（PR 7.1 I-1 stateless 改造）
  const rand = Math.random().toString(36).slice(2, 8);
  return `ccdone-${Date.now()}-${rand}-${userId.slice(0, 12)}`;
}
```

- 全局唯一性：每次 complete 重新生成，无需去重
- 不持久化：卡片是"一次性"的，过期语义=no-op（决策 §1.1）
- 不写 mapping.json（避免污染 mapping 状态机）

### 3.2 完成卡片的发送时机

```typescript
// src/wecom/stream-updater.ts complete() 末尾
async complete(response, tokensIn, tokensOut, durationMs, numTurns,
               msgFallback?, thinking?, toolUses?) {
  // ... 现有 replyStream(finish=true) 逻辑不变 ...
  await this.sdk.replyStream(t.frame, t.streamId, this.truncate(finalMarkdown), true);
  // ↑↑↑ 现有逻辑 ↑↑↑

  // PR 7 Task 7.X 新增: 流式关闭后, 主动 sendMessage 完成卡片
  // 防御: sendMessage 失败不能影响已发流式 (兜底 markdown 已经显示给用户了)
  if (this.completeCardSender) {
    try {
      await this.completeCardSender.send({
        userId: this.lastUserId,  // 需新增字段记录
        sessionTitle: ...,
        sessionUuid: ...,
      });
    } catch (err) {
      logger.warn(`[wecom-stream] complete card send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```

**关键决策**：completeCardSender 是 WecomStreamUpdater 的**可选注入**（跟现有 `msgFallback` 同模式），不在 StreamUpdater 接口里加方法——保持接口干净，企微侧专属。

### 3.3 按钮回调的语义边界

#### 3.3.1 executeCardAction 新增 3 个 case

```typescript
case 'continue': {
  // 等价 /new: setPending + 提示用户发新消息
  // PR 7.X review fix #1: 幂等保护 — 已有 active session 时不覆盖 (跟 §3.3.3 承诺对齐)
  const current = await this.userManager.getEntry(event.externalUserId);
  if (current?.type === 'session' || current?.type === 'pending_new_session') {
    await this.client.sdk.sendMessage(event.externalUserId, {
      msgtype: 'markdown',
      markdown: { content: `⚠️ 已有 ${current.type === 'session' ? '活跃 session' : '待创建 session'}, 不创建新会话\n\n💡 如要新建, 请先 \`/cancel\` 或 \`/stop\`` },
    });
    break;
  }
  await this.userManager.setPending(event.externalUserId, {});
  await this.client.sdk.sendMessage(event.externalUserId, {
    msgtype: 'markdown',
    markdown: { content: '✨ **新会话就绪**\n\n请发送新消息开始（下一条消息将创建新的 Claude session）' },
  });
  break;
}

case 'switch': {
  // 等价 /list: 复用 handleCommandListCard 路径 (无需走 SpoolQueue)
  // 渲染活跃 session 列表 (已有逻辑 in case 'list-refresh', 抽公共函数)
  await this.renderActiveSessionsList(event.externalUserId);
  break;
}

case 'listdir': {
  // 等价 /listdir: 复用 handleCommandListDir 私有方法
  await this.renderListDir(event.externalUserId);
  break;
}
```

#### 3.3.2 复用现有 4 个 case

- `retry` / `stop` / `confirm-stop` / `list-refresh` 现有逻辑不变，只把按钮入口从"其他位置"挪到完成卡片 action_menu
- 防御：executeCardAction 的 default 已 warn，不影响

#### 3.3.3 幂等 no-op 语义

| 按钮 | 幂等条件 | no-op 行为 |
|---|---|---|
| `continue` | 已有 active session | 警告"已有会话，不创建新 session" |
| `switch` | 无 active session | 提示"暂无 session 可切换" |
| `listdir` | cwd 不存在 | 提示"工作目录不存在" |
| `retry` | 原 messageId 不在 spool | sendMessage 提示"历史消息已存档"（PR 6.21 已有） |
| `stop` | 无 in-flight 流 | no-op（updater.cancel 内部已 guard） |
| `confirm-stop` | sessionUuid 不在 registry | 提示"未找到 session"（PR 6 Task 6.6 已有） |
| `list-refresh` | registry 未注入 | warn log（PR 6 Task 6.7 已有） |

---

## 4. 组件改动

### 4.1 新增 `src/wecom/complete-card.ts` (~120 行)

```typescript
/**
 * 企微完成卡片 builder + sender
 * PR 7 Task 7.X: 流式输出完成后, 主动 sendMessage 一张 button_interaction 卡片
 *
 * @see docs/superpowers/specs/2026-06-20-wecom-complete-card-design.md §3.1
 */
import type { WSClient } from '@wecom/aibot-node-sdk';
import { WecomCardBuilder } from './card';
import { logger } from '../utils/logger';

export type CompleteCardContext = {
  userId: string;
  sessionTitle?: string;
  sessionUuid?: string;
  cwd?: string;
  /** 流式总耗时（用于主标题 desc 显示） */
  durationMs?: number;
};

// PR 7.X review fix #2: 不要重新定义 WecomTemplateCard (card.ts:112 已定义),
//   直接 import 复用, 避免类型冲突 / drift
import type { WecomTemplateCard } from './card';

export const COMPLETE_CARD_MAIN_BUTTONS: Array<{ key: string; text: string }> = [
  { key: 'continue', text: '🔁 继续' },
  { key: 'switch',   text: '📂 切换 session' },
  { key: 'listdir',  text: '📁 选目录' },
];

export const COMPLETE_CARD_ACTION_MENU: Array<{ tag: string; text: string }> = [
  { tag: 'retry',        text: '🔁 重试本次' },
  { tag: 'stop',         text: '🛑 停止' },
  { tag: 'confirm-stop', text: '🛂 硬杀 Claude' },
  { tag: 'list-refresh', text: '🔄 刷新列表' },
];

export function buildCompleteCard(ctx: CompleteCardContext): WecomTemplateCard {
  const title = `✅ Claude 处理完成${ctx.sessionTitle ? `: ${ctx.sessionTitle.slice(0, 18)}` : ''}`;
  const desc = `💡 点按下方按钮继续${ctx.durationMs ? ` (耗时 ${Math.floor(ctx.durationMs / 1000)}s)` : ''}`;
  const card = WecomCardBuilder.buttonInteraction({
    title,
    description: desc,
    buttons: COMPLETE_CARD_MAIN_BUTTONS.map(b => ({
      tag: b.key,
      text: b.text,
      type: 'default' as const,
    })),
  });
  // 注入 action_menu (PR 7 m-9 ACTION_MENU_DESC 默认 '操作')
  (card as any).action_menu = {
    desc: WecomCardBuilder.ACTION_MENU_DESC,
    action_list: COMPLETE_CARD_ACTION_MENU.map(a => ({
      action_tag: a.tag,
      action_title: { tag: a.tag, text: a.text },
    })),
  };
  // task_id (aibot SDK 字段, 用于 updateTemplateCard 关联)
  (card as any).task_id = genCompleteCardTaskId(ctx.userId);
  return card;
}

export class WecomCompleteCardSender {
  constructor(private sdk: WSClient) {}

  async send(ctx: CompleteCardContext): Promise<void> {
    const card = buildCompleteCard(ctx);
    await this.sdk.sendMessage(ctx.userId, {
      msgtype: 'template_card',
      template_card: card,
    });
    logger.info(`[wecom-complete-card] sent: userId=${ctx.userId.slice(0, 12)}... taskId=${(card as any).task_id}`);
  }
}

function genCompleteCardTaskId(userId: string): string {
  return `ccdone-${Date.now()}-${userId.slice(0, 12)}`;
}
```

### 4.2 改动 `src/wecom/stream-updater.ts`

#### 4.2.1 新增 `lastUserId` 字段 + `setCompleteCardSender` 方法

```typescript
// PR 7.X review fix #3: lastUserId / lastSessionTitle / lastSessionUuid / lastCwd
//   4 个字段配套声明, 不是只有 lastUserId — complete() 末尾要用全
private lastUserId: string | null = null;
private lastSessionTitle: string | undefined = undefined;
private lastSessionUuid: string | undefined = undefined;
private lastCwd: string | undefined = undefined;
private completeCardSender?: WecomCompleteCardSender;

setCompleteCardSender(sender: WecomCompleteCardSender): void {
  this.completeCardSender = sender;
}
```

#### 4.2.2 `startProcessing` 记录 userId

```typescript
async startProcessing(userId: string, inboundFrame?: any): Promise<string> {
  this.currentStreamId = generateReqId('stream');
  this.lastUserId = userId;  // PR 7 Task 7.X 新增
  // lastSessionTitle / lastSessionUuid / lastCwd 在 complete() 阶段由 completeCtx 参数注入
  //   (而不是 startProcessing 阶段, 因为那时还不知道 session 是否创建成功)
  // ... 现有逻辑不变 ...
}
```

#### 4.2.2.1 setCompleteCardSender 调用时机

**PR 7.X review fix #5**: 跟现有 `setMsgFallback` 同模式，在 WecomBot 构造后立即调一次（不每次 handleChat 调一次）。

```typescript
// src/wecom/bot.ts 构造 / connect 入口:
this.updater.setMsgFallback(this.sendMarkdownFallback.bind(this));  // 已有
this.updater.setCompleteCardSender(new WecomCompleteCardSender(this.client.sdk));  // PR 7.X 新增
```

**生命周期**：sender 是 stateless（每次 send 都新建 card），不持有 per-stream 状态。setter 一次即可，complete 多次调用复用。

#### 4.2.3 `complete` 末尾触发完成卡片

在 `clearTerminalState()` 之前插入：

```typescript
// PR 7 Task 7.X: 流式关闭后, 主动 sendMessage 完成卡片
if (this.completeCardSender && this.lastUserId) {
  try {
    // PR 7.X review fix #4: 修正调用 — completeCardSender 是对象, 调 .send(ctx)
    //   不是把对象当函数调 (旧 spec §3.2 写法是 this.completeCardSender({...}), 错)
    await this.completeCardSender.send({
      userId: this.lastUserId,
      sessionTitle: completeCtx?.sessionTitle ?? this.lastSessionTitle,
      sessionUuid: completeCtx?.sessionUuid ?? this.lastSessionUuid,
      cwd: completeCtx?.cwd ?? this.lastCwd,
      durationMs: _durationMs,
    });
  } catch (cardErr) {
    logger.warn(`[wecom-stream] complete card send failed: ${cardErr instanceof Error ? cardErr.message : String(cardErr)}`);
  }
}
```

新增可选参数（让 caller 传 sessionTitle / sessionUuid / cwd）：

```typescript
async complete(
  response: string,
  _tokensIn: number,
  _tokensOut: number,
  _durationMs: number,
  _numTurns: number,
  msgFallback?: (text: string) => Promise<void>,
  thinking?: string,
  toolUses?: StreamUpdateToolUse[],
  completeCtx?: { sessionTitle?: string; sessionUuid?: string; cwd?: string },  // PR 7 新增
): Promise<void>
```

> StreamUpdater 接口**不加方法**——`completeCtx` 通过可选参数 + setter 注入。

### 4.3 改动 `src/wecom/bot.ts`

#### 4.3.1 `handleChat` 调 updater.complete 时传 completeCtx

> PR 7.X review fix #7: sender set 已在 §4.2.2.1 文档化（构造后立即调一次），
> 本节只关注 handleChat 调 complete() 时传 completeCtx。

```typescript
// handleChat 调用 updater.complete 时传 completeCtx:
await this.updater.complete(
  resultText,
  tokensIn, tokensOut, durationMs, numTurns,
  undefined,  // msgFallback (已有 this.msgFallback 类字段)
  state.thinking,
  state.toolUses,
  {
    sessionTitle: result.sessionTitle ?? this.lastSessionTitle,
    sessionUuid: result.sessionId,
    cwd: cwd,
  },
);
```

#### 4.3.2 `executeCardAction` 新增 3 个 case

见 §3.3.1 代码。

#### 4.3.3 抽公共函数 `renderActiveSessionsList`

`case 'list-refresh` 现有逻辑（bot.ts:1251-1285）+ 新增 `case 'switch` 共用：

```typescript
private async renderActiveSessionsList(userId: string): Promise<void> {
  // 抽 case 'list-refresh' 的渲染逻辑 (activeEntries 列表 + markdown 渲染)
  // 共享给 case 'switch' (完成卡片按钮) 和 case 'list-refresh' (action_menu)
}
```

#### 4.3.4 抽公共函数 `renderListDir`

`handleCommandListDir` 现有逻辑（bot.ts:458-...）抽出来共享给 `case 'listdir'` 按钮。

---

## 5. 错误处理

### 5.1 完成卡片发送失败

| 错误 | 处理 |
|---|---|
| `sendMessage` 网络超时 | log warn，不影响流式输出（用户已看到 finalMarkdown） |
| `sendMessage` errcode 非 0 | log warn，下游兜底靠现有 `replyStream finish=true` 流的 finalMarkdown |
| `task_id` 超长（>128 字节） | `genCompleteCardTaskId` 内置截断 |
| 卡片 schema 校验失败 | Zod schema 已在 `WecomCardBuilder.buttonInteraction` 内部 catch |

### 5.2 按钮回调失败

| 错误 | 处理 |
|---|---|
| `setImmediate` 5s 后才调 executeCardAction | 已有 `replyWelcome` 兜底占位（`⏳ 处理中...`）|
| `case 'continue'` setPending 失败 | sendMessage 提示"创建会话失败: ${err}" |
| `case 'switch'` registryManager 未注入 | warn log（已有逻辑） |
| `case 'listdir'` cwd 不存在 | sendMessage 提示"工作目录不存在: ${cwd}" |
| 未知 actionTag | `default: logger.warn`（已有） |

### 5.3 并发安全

| 场景 | 处理 |
|---|---|
| 流式输出未结束用户点完成卡片按钮 | 按钮回调 `setImmediate` + executeCardAction 不依赖 updater state（除 `stop` / `confirm-stop`）|
| 流式结束后用户又发新消息 | 新消息走 SpoolQueue → 旧完成卡片变孤儿 → 点按钮幂等 no-op |
| 同一用户多 session | switch 按钮 + list-refresh 都能列出全部 active session |

---

## 6. 测试策略

### 6.1 单测覆盖

| 文件 | 新增 case |
|---|---|
| `tests/unit/wecom/complete-card.test.ts`（新文件，~80 行） | `buildCompleteCard` 字段正确性 + `task_id` 唯一性 + `action_menu` 注入 |
| `tests/unit/wecom/complete-card.test.ts` | `WecomCompleteCardSender.send` mock SDK + 校验 `msgtype: 'template_card'` |
| `tests/unit/wecom/stream-updater.test.ts` | complete 触发 completeCardSender.send（mock） |
| `tests/unit/wecom/bot.test.ts` | `__test_executeCardAction` 新增 3 个 case：`continue` / `switch` / `listdir` |
| `tests/unit/wecom/bot.test.ts` | 验证 action_menu 4 个 case 在新入口下仍 work（参数化） |

### 6.2 手动 E2E

| 场景 | 期望 |
|---|---|
| 用户发"读 /etc/hostname"，等流式结束 | 流式关闭后，单独一条消息：完成卡片（[继续][切换][选目录] + 操作菜单）|
| 点 [继续] 按钮 | 收到 `✨ 新会话就绪` markdown，再发消息能创建新 session |
| 点 [切换 session] 按钮 | 收到活跃 session 列表 markdown |
| 点 [选目录] 按钮 | 收到 `/listdir` 输出 |
| 点操作菜单 [🛑 停止]（无 in-flight 流） | no-op + 提示"无正在处理的会话" |
| 点操作菜单 [🔄 刷新列表] | 收到刷新的活跃 session 列表 markdown |
| 流式输出后，用户发新消息 | 新消息正常处理（旧完成卡片变孤儿，点击仍幂等 no-op）|

### 6.3 不测的场景（YAGNI）

- ❌ 多 user 并发完成卡片管理（见 §1.2 非目标，"WecomStreamUpdater 单 user 设计"）
- ❌ updateTemplateCard 主动 patch（不在本 PR 范围）
- ❌ 卡片样式 pixel-perfect 验证（视觉验收）

---

## 7. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 完成卡片字段名错（main_title vs mainTitle） | 中 | sendMessage 静默失败 | Zod schema 已在 WecomCardBuilder 校验；新增单测覆盖 |
| 按钮 key 跟现有 case 冲突 | 低 | executeCardAction 走错分支 | key 列表 `COMPLETE_CARD_MAIN_BUTTONS` 常量化，单测覆盖所有 key 唯一 |
| 流式输出未结束用户点完成卡片按钮 | 中 | 按钮回调卡死 | executeCardAction 全部 async + setImmediate，无依赖 updater state |
| 任务编号（task_id）超过 128 字节 | 极低 | updateTemplateCard 失败 | `genCompleteCardTaskId` 内置 `userId.slice(0, 12)` |
| 飞书侧回归 | 极低 | 飞书用户体验崩 | 改动只在 `src/wecom/*`，不动 `src/feishu/*`、不动 `src/platform/*` 接口 |

---

## 8. 实施 PR 分解（subagent-driven-development 拆分建议）

| PR | 范围 | 文件 |
|---|---|---|
| PR 7.1 | 新增 `src/wecom/complete-card.ts` + 单测 | 新增 1 + 测试 1 |
| PR 7.2 | 改 `stream-updater.ts` 注入 completeCardSender + 调 send | 改 1 + 测试 1 |
| PR 7.3 | 改 `bot.ts` 新增 3 case + 抽 2 个公共函数 | 改 1 + 测试 1 |
| PR 7.4 | E2E 验证 + 截图 + 真机验收 | — |

每个 PR 独立 ship-ready，单测 + typecheck + 部署 + 真机测试全过。

---

## 9. 参考文档

- `@wecom/aibot-node-sdk/README.md` — line 226-265（`updateTemplateCard` / `sendMessage` 签名 + 限制）
- `node_modules/@wecom/aibot-node-sdk/dist/types/api.d.ts` — `TemplateCard` / `TemplateCardType.ButtonInteraction` 类型
- `docs/superpowers/specs/2026-06-19-wecom-integration-design.md` — §4.2 stream-updater + card builder 设计
- `src/wecom/bot.ts:1180-1289` — 现有 handleCardAction + executeCardAction 框架
- `src/wecom/stream-updater.ts:259-309` — 现有 complete() 方法
- `src/wecom/card.ts:119-174` — 现有 WecomCardBuilder.textNotice/buttonInteraction
