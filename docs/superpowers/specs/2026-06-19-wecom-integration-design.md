# cc-linker 接入企业微信（WeCom）设计

**日期：** 2026-06-19
**版本：** v1.0（基于当前 master `2f6c6b3`）
**状态：** 待评审
**作者：** Claude Code（brainstorming + 用户拍板）
**范围：** 新增企业微信智能机器人通道，作为飞书的并行平台

## 1. 问题陈述

cc-linker 当前只支持飞书 Bot，无法满足**只用企业微信 / 跨平台使用 / 团队协作**的用户场景。需要：

- 主用企微而非飞书的开发者
- 团队内部既有飞书又有企微（飞书 / 企微并存）
- 个人 / 小团队自用，希望接入更"国民"的企业微信

### 1.1 已澄清的需求边界

| 问题 | 决策 |
|---|---|
| 接入形态 | **企业微信智能机器人 (aibot)** + 长连接（WSS），非自建应用 / 非个人微信 |
| 受众 | **主要你自己 / 团队自用**（不追求规模化 ToC） |
| 架构策略 | **轻抽象 + 智能机器人**（方案 A）：抽 `PlatformMessage` + `StreamUpdater` 两个接口，飞书 + 企微并存 |
| 用户可行性 | **完全可行**（腾讯 2026-03 官方为个人开发者开了通道，详见 §2.2） |

### 1.2 非目标（YAGNI）

- ❌ 个人微信（无官方 API，第三方协议违反 ToS）
- ❌ 微信公众号 / 服务号 / 订阅号（被动回复范式不适合长对话）
- ❌ 微信小程序（不同范式）
- ❌ Slack / Discord / Telegram / WhatsApp（**留扩展点，不实现**）
- ❌ 完全 Platform Adapter 抽象（**过度设计，留给未来**）
- ❌ 重写 SpoolQueue / SessionManager / Registry（**核心零修改**）
- ❌ 飞书侧任何行为变更（**零回归硬约束**）

## 2. 背景研究

### 2.1 飞书 vs 企业微信核心差异

| 维度 | 飞书 (Lark) | 企业微信 (WeCom) | 来源 |
|---|---|---|---|
| 协议接入 | WSClient 长连接 (SDK 内置) | aibot WSS (`wss://openws.work.weixin.qq.com`) | [aibot 文档](https://developer.work.weixin.qq.com/document/path/101463) |
| 凭证 | App ID + App Secret + Verification Token | bot_id + secret | [腾讯云 2026-06](https://cloud.tencent.com/developer/article/2637067) |
| 消息增量更新 | **PATCH 同一 message_id**，5 QPS/条、14 天消息龄 | ❌ update_template_card 限交互型 + 72h response_code | [企微 94888](https://developer.work.weixin.qq.com/document/path/94888) |
| 原生流式 | CardUpdater 高频 PATCH 模拟 | ✅ **stream.id**：首次创建 → 同 id patch → `finish=true` | [企微 101463](https://developer.work.weixin.qq.com/document/path/101463) |
| 主动发送限频 | 1000 次/分钟、50 次/秒 | **30 次/分钟/账号、1000 次/小时**、日上限 = 账号数 × 200 | [企微 90236](https://developer.work.weixin.qq.com/document/path/90236) |
| 按钮回调时延 | card.action.trigger 异步无约束 | template_card_event **5 秒内**必须给占位 | [企微 101463](https://developer.work.weixin.qq.com/document/path/101463) |
| 外部用户接入 | 扫码即聊 | 扫"联系我"二维码加为客户/同事 | [官方帮助](https://open.work.weixin.qq.com/help/wap/detail?docid=15422) |

### 2.2 个人开发者可行性（已验证）

| 路径 | 难度 | 时间 | 来源 |
|---|---|---|---|
| **个人组建团队**（最轻） | ⭐ | 1 分钟 | [官方帮助 15422](https://open.work.weixin.qq.com/help/wap/detail?docid=15422) |
| **完整企业注册** | ⭐⭐ | 5 分钟 + 1-3 天审核 | [2026 注册指南](https://www.cnblogs.com/bsoo/p/19782974) |
| **OpenClaw 一键授权**（2026-03 新通道） | ⭐ | 30 秒 | [腾讯 2026-03-14](https://so.html5.qq.com/page/real/search_news?docid=70000021_77669b55bdf32352) |

**核心结论**：
- ✅ 个人身份证可注册企业微信（手机端"个人组建团队"，或完整注册 300 元/年认证）
- ✅ 未认证主体能创建智能机器人并接收消息
- ✅ 企业微信 2026-03 起官方为个人 / 10 人以下团队开放
- ✅ Bun 兼容 `@wecom/aibot-node-sdk`（理论兼容，需 PoC 验证）

### 2.3 参考实现：OpenClaw = "腾讯官方版 cc-linker"

[OpenClaw](https://so.html5.qq.com/page/real/search_news?docid=70000021_77669b55bdf32352) 是腾讯 2026 推出的官方 AI Agent 平台，**架构和 cc-linker 几乎一致**：

| 维度 | OpenClaw | cc-linker |
|---|---|---|
| 桥接 | IM ↔ AI Agent | IM ↔ Claude Code CLI |
| 多平台 | 飞书 / 微信 / 企业微信 / QQ / 钉钉 / Discord / Telegram | 目前只支持飞书 |
| 通道架构 | 一实例多 channel（`openclaw.json` 配置） | `start` 命令单平台 |
| 企微接入 | 官方插件 `@wecom/wecom-openclaw-plugin` | 无 |
| 部署 | 本地或云服务器 | 本地 Bun |

**关键启示**：
1. OpenClaw 用"插件 + 通道配置"而非完全抽象层 —— **和本方案 A 一致**
2. **Wecom OpenClaw Plugin 是开源的**（[GitHub](https://github.com/WecomTeam/wecom-openclaw-plugin)），cc-linker 可参考其 WSS + stream 协议实现
3. OpenClaw 一台实例能同时跑飞书 + 企业微信 —— 验证了多通道并存可行

## 3. 架构概览

### 3.1 三层架构

```
┌──────────────────────────────────────────────────────────┐
│                   CLI 入口 (src/index.ts)                │
│   cc-linker start --platform=feishu|wecom|all           │
└────────────────┬─────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
   ┌────▼─────┐    ┌──────▼──────┐
   │ feishu/  │    │   wecom/    │  ← 新增
   │  Bot     │    │    Bot      │
   │  + Card  │    │  + Stream   │
   └────┬─────┘    └──────┬──────┘
        │                 │
        └────────┬────────┘
                 │  PlatformMessage / StreamUpdater
                 │
   ┌─────────────▼─────────────────────────┐
   │  platform/ (新增抽象层，~300 行)        │
   │   - types.ts (PlatformMessage)        │
   │   - stream-updater.ts (StreamUpdater)  │
   └─────────────┬─────────────────────────┘
                 │
   ┌─────────────▼─────────────────────────┐
   │  平台无关核心（不动）                    │
   │   - queue/SpoolQueue                   │
   │   - proxy/ClaudeSessionManager         │
   │   - registry/RegistryManager           │
   │   - feishu/mapping.ts (UserManager)    │
   │   - runtime/StateCoordinator           │
   └────────────────────────────────────────┘
```

### 3.2 关键设计原则

1. **核心不动**：SpoolQueue / SessionManager / Registry / StateCoordinator **零修改**，只把它们消费的消息类型从 `FeishuMessageEvent` 改为 `PlatformMessage`（接口替换）
2. **抽两个接口，不抽全部**：只抽"消息"和"流式更新"，其他（队列 worker 池、CAS、权限处理）保留飞书路径
3. **飞书路径零回归**：飞书的 `bot.ts` 和 `card-updater.ts` 通过适配层实现新接口，行为不变
4. **企微路径最简**：直接复用 OpenClaw 官方 SDK `@wecom/aibot-node-sdk`（MIT 协议）+ 薄包装

## 4. 组件分解

### 4.1 新增 `src/platform/` 抽象层

#### `src/platform/types.ts` (~80 行)

```typescript
export type PlatformMessage = {
  platform: 'feishu' | 'wecom';
  userId: string;              // feishu=open_id, wecom=external_userid
  chatType: 'p2p' | 'group';
  chatId: string;
  messageId: string;
  text: string;
  images?: Array<{ fileKey: string; url?: string }>;
  timestamp: number;
  raw: unknown;
};

export type PlatformReplyFn = (text: string, opts?: {
  messageId?: string;
  replyTo?: string;
}) => Promise<string | null>;

export type PlatformCardAction = {
  userId: string;
  messageId: string;
  actionTag: string;
  actionValue: string | Record<string, unknown>;
};

export type PlatformUserId = {
  platform: 'feishu' | 'wecom';
  platformUserId: string;
};
```

#### `src/platform/stream-updater.ts` (~60 行)

```typescript
export type StreamChunk = {
  kind: 'thinking' | 'text' | 'tool' | 'result' | 'error';
  content: string;
  meta?: Record<string, unknown>;
};

export interface StreamUpdater {
  start(initialText: string): Promise<string>;          // 返回 stream messageId
  update(messageId: string, chunk: StreamChunk): Promise<void>;
  finish(messageId: string, finalContent: string, opts?: {
    asCard?: boolean;
    success?: boolean;
  }): Promise<void>;
  fail(messageId: string, error: string): Promise<void>;
}
```

#### `src/platform/user-state.ts` (~80 行)
从 `feishu/mapping.ts` 抽公共部分：CAS 校验、session 解析、type 状态机转换。飞书和企微共用。

#### `src/platform/command-handler.ts` (~200 行)
从 `feishu/bot.ts` 抽出命令解析逻辑：`parseCommand` + `executeCommand`，飞书和企微共用。

### 4.2 新增 `src/wecom/` 通道

#### `src/wecom/aibot-client.ts` (~200 行)
封装 `@wecom/aibot-node-sdk@1.0.7` WSS 长连接，五个对外方法：`connect / send / updateStream / onMessage / onCardAction`

**SDK 实际 API（已 PoC 验证，2026-06-19）**：
```typescript
import { WSClient, MessageType, EventType, generateReqId } from '@wecom/aibot-node-sdk';

const wsClient = new WSClient({
  botId: '<bot_id>',
  secret: '<secret>',
  // reconnectInterval: 1000,    // 默认
  // maxReconnectAttempts: 10,   // -1 = 无限
  // heartbeatInterval: 30000,
  // requestTimeout: 10000,
  // wsUrl: 'wss://openws.work.weixin.qq.com',  // 默认
});
wsClient.connect();  // chainable
```

**Stream API**（SDK 用 `replyStream` + 同 `req_id` 持续 patch）：
```typescript
const streamId = generateReqId('stream');         // 如 'stream_1781826086256_a46e51c6'
await wsClient.replyStream(frame, streamId, 'thinking...', false);
await wsClient.replyStream(frame, streamId, '更新内容', false);    // 同 streamId = patch
await wsClient.replyStream(frame, streamId, '完成', true);          // finish=true 终止流
await wsClient.replyStreamWithCard(frame, streamId, '完成', true, { templateCard });  // 流式 + 收尾卡片
```

**主动推送**（无 callback frame）：
```typescript
await wsClient.sendMessage(chatid, { msgtype: 'markdown', markdown: { content } });
```

**按钮回调 5s 窗口**：
```typescript
await wsClient.replyWelcome(frame, { msgtype: 'template_card', template_card: { ... } });     // 5s
await wsClient.updateTemplateCard(frame, templateCard, userids?);                               // 5s
```

**事件订阅**（EventEmitter 风格）：
```typescript
wsClient.on('connected', () => ...);
wsClient.on('authenticated', () => ...);
wsClient.on('disconnected', (reason) => ...);
wsClient.on('reconnecting', (attempt) => ...);
wsClient.on('error', (err) => ...);
wsClient.on('message', (msg) => ...);
wsClient.on('message.text', (msg) => ...);       // type=Text
wsClient.on('message.image', (msg) => ...);      // type=Image
wsClient.on('message.mixed', (msg) => ...);
wsClient.on('event.enter_chat', (evt) => ...);
wsClient.on('event.template_card_event', (evt) => ...);
wsClient.on('event.feedback_event', (evt) => ...);
```

**aibot-client.ts 内部职责**：
- 单例管理 WSClient 实例
- 30s 心跳保活（SDK 默认）
- 重连退避：1s → 30s 指数（用 SDK 的 `reconnectInterval` / `maxReconnectAttempts`）
- 把 SDK EventEmitter 事件归一化为内部 callback：`onMessage(PlatformMessage)` / `onCardAction(PlatformCardAction)`
- 把 SDK 抛出的 `WSAuthFailureError`（botId/secret 错）映射到 CCError
- 把 SDK 抛出的 `WSReconnectExhaustedError`（重连耗尽）映射到 CCError

#### `src/wecom/stream-updater.ts` (~150 行)
实现 `StreamUpdater`，用 SDK `replyStream` 流式消息协议
- `start(initialText)` → `wsClient.replyStream(frame, streamId, initialText, false)` → 返回 streamId
- `update(messageId, chunk)` → `wsClient.replyStream(frame, messageId, merged, false)` → 同 streamId patch
- **节流**：2000ms（30/min 上限保护）
- **Content 上限**：20480 bytes（SDK 硬限制）；超长 buffer 截断 + finish 时丢弃
- `finish(messageId, finalContent, {asCard: true})` → `replyStreamWithCard` 流式终止 + 收尾卡片；或 `replyStream(..., true)` 纯文本收尾
- `fail(messageId, errorText)` → `replyStream(..., true)` 发 markdown 错误 + `replyTemplateCard` 附"重试/取消"按钮
- **限频 buffer**：errcode 45009/45033 → buffer 累积 → finish 时合并到 finalContent

#### `src/wecom/bot.ts` (~500 行)
`WecomBot` 主类，对标 `feishu/bot.ts` 最简版
- `onMessage(PlatformMessage)` → 写 serialKey `new:${userId}` → 入 `SpoolQueue`
- `handleChat()` → 调 `ClaudeSessionManager` → 拿 `StreamChunk[]` → 调 `StreamUpdater`
- `handleCommand()` → 委托给 `platform/command-handler`
- `onCardAction()` → 5 秒内 `replyWelcome` 发占位卡片 → 异步处理 → 处理完成后 `updateTemplateCard` 或新发
- 错误处理走 `handleError()` 共享模块

#### `src/wecom/card.ts` (~200 行)
企微模板卡片构建器（用于 `/agents` list、peek card、stop confirm）
- 5 种类型：text_notice / news_notice / button_interaction / vote_interaction / multiple_interaction
- 仅 `button_interaction` + `multiple_interaction` + `action_menu` 文本通知型可更新

#### `src/wecom/mapping.ts` (~150 行)
企微 UserMapping，与 `feishu/mapping.ts` 并存（不复用文件）
- 存储：`~/.cc-linker/user-mapping-wecom.json`
- 字段：`external_userid` / `chat_type` / `session_uuid` / `cas_token`
- CAS 用 `proper-lockfile`，与飞书一致

#### `src/wecom/index.ts` (~20 行)
模块导出：`WecomBot` / `WecomStreamUpdater` / `WecomCardBuilder`

#### `src/cli/commands/init-wecom.ts` (~100 行)
交互式配置企微：`bot_id` + `secret` 写入 `config.toml [wecom]`

### 4.3 改造模块（最小化）

| 文件 | 改动 | 行数 | PR |
|---|---|---|---|
| `src/feishu/card-updater.ts` | 加适配层实现 `StreamUpdater` | +80 | 1 |
| `src/cli/commands/start.ts` | 加 `--platform` 选项 | +50 | 3 |
| `src/utils/config.ts` | 加 `[wecom]` 节 + env override | +30 | 3 |
| `src/registry/types.ts` | `SessionEntry.platform` 字段（默认 `feishu`） | +15 | 3 |
| `src/runtime/state-coordinator.ts` | `tryAcquire({ platforms })` 单锁多平台 | +50 | 3 |
| `src/queue/spool.ts` | `SpoolMessage` + `TargetSnapshot` 加 `platform` / `userId` 字段（openId alias） | +10 | 3 |
| `src/cli/commands/setup.ts` | **全量重构**：从 4 步 hardcoded 改造为渠道多选 + ChannelConfigurator 调度（净增 ~150 行） | 重构 | 3.5 |
| `src/cli/commands/init-feishu.ts` | 提取 `runFeishuWizard()` export（setup 复用） | +30 | 3.5 |
| `src/cli/commands/channel-configurator.ts` | **新增**：统一接口 + registry | +120 | 3.5 |
| `src/index.ts` | `start` 命令注册 `init-wecom` + `init-feishu` 不变 | +20 | 3 + 3.5 |

### 4.4 文件清单汇总

```
新增：
src/platform/types.ts                       (~80 行)
src/platform/stream-updater.ts              (~60 行)
src/platform/user-state.ts                  (~80 行)
src/platform/command-handler.ts             (~200 行)
src/wecom/aibot-client.ts                   (~200 行)
src/wecom/stream-updater.ts                 (~150 行)
src/wecom/bot.ts                            (~500 行)
src/wecom/card.ts                           (~200 行)
src/wecom/mapping.ts                        (~150 行)
src/wecom/index.ts                          (~20 行)
src/cli/commands/init-wecom.ts              (~250 行) ← PR 3.5 扩展为完整 wizard
src/cli/commands/channel-configurator.ts    (~120 行) ← PR 3.5 新增

改造：
src/feishu/card-updater.ts                  (+80)   ← PR 1
src/cli/commands/start.ts                   (+50)   ← PR 3
src/utils/config.ts                         (+30)   ← PR 3
src/registry/types.ts                       (+15)   ← PR 3
src/runtime/state-coordinator.ts           (+50)   ← PR 3
src/queue/spool.ts                          (+10)   ← PR 3
src/cli/commands/setup.ts                   (重构 ~150 行净增)  ← PR 3.5
src/cli/commands/init-feishu.ts             (+30)   ← PR 3.5 提取 wizard
src/index.ts                                (+20)   ← PR 3+3.5

总计：~1990 行新增 + ~465 行改造
```

### 4.5 Setup 多渠道 + ChannelConfigurator 抽象

**目标**：把 setup 从"飞书 hardcoded"改造为"渠道多选"，init-feishu / init-wecom 都通过 `ChannelConfigurator` 接口接入，setup 动态调度。

#### 4.5.1 现状问题

当前 `setup.ts:53-188` 是 4 个 hardcoded step：
1. 初始化 registry
2. 权限模式
3. 安装 hook
4. 飞书 Bot 配置（不可跳过 / 不可加其他渠道）

`init-feishu.ts` 完整 9-step wizard 是独立命令。`init-wecom` 计划中是简化版（100 行）—— **远不及 init-feishu 的用户体验**。

#### 4.5.2 解决方案

**`ChannelConfigurator` 接口**：

```typescript
// src/cli/commands/channel-configurator.ts
export type ChannelConfigurator = {
  platform: 'feishu' | 'wecom';

  /** 检查当前是否已配置（config.toml 已有完整凭证） */
  isConfigured(): boolean;

  /** 检测 daemon 冲突（与现有 Bot 共享 WSS 时） */
  checkDaemonConflict(): Promise<'ok' | 'conflict' | 'no-config'>;

  /** 输出"创建机器人 / 创建应用"引导文字（图文步骤） */
  printCreationGuide(): void;

  /** 接收用户输入（inquirer prompt） */
  promptCredentials(existing?: Record<string, any>): Promise<{ config: any; skip?: boolean }>;

  /** 验证凭证（fetch + WSClient 试连） */
  verifyCredentials(config: any): Promise<boolean>;

  /** 自动捕获 owner_user_id（飞书 captureOpenId / 企微 enter_chat） */
  captureOwnerUserId(config: any, timeoutMs?: number): Promise<string | null>;

  /** 保存到 config.toml */
  saveConfig(config: any): void;

  /** 询问并启动 bot + 配置开机自启 */
  postInstall(config: any): Promise<{ started: boolean; autoStart: boolean }>;
};

export const configurators: Record<'feishu' | 'wecom', ChannelConfigurator> = {
  feishu: new FeishuConfigurator(),
  wecom: new WecomConfigurator(),
};
```

**`runChannelWizard()` 调度函数**：

```typescript
export async function runChannelWizard(platform: 'feishu' | 'wecom'): Promise<ChannelResult> {
  const cfg = configurators[platform];
  // 1. Daemon conflict check
  // 2. If isConfigured() → 询问 reconfigure
  // 3. printCreationGuide()（仅首次）
  // 4. promptCredentials()
  // 5. verifyCredentials()（失败重试或退出）
  // 6. captureOwnerUserId()（用户给机器人发消息）
  // 7. saveConfig()
  // 8. postInstall()（启动 bot + 开机自启）
  return result;
}
```

**新的 setup.ts 流程**：

```typescript
export async function setup(registry: RegistryManager, opts: SetupOptions = {}): Promise<void> {
  // Step 0: 渠道选择（多选 checkbox）
  const channels = opts.channels?.split(',') ?? await promptChannelSelection();
  // channels: ['feishu' | 'wecom'] 或 []

  // Step 1: 初始化 registry（无论如何）
  // Step 2: Claude 权限模式（无论如何）
  // Step 3: 安装 hook（无论如何）

  // Step 4..N: 各渠道 wizard（按选择顺序）
  const results: Record<string, ChannelResult> = {};
  for (const ch of channels) {
    results[ch] = await runChannelWizard(ch);
  }

  // Final: summary（显示所有渠道状态）
  printSummary(sessionCount, hookInstalled, results);
}
```

**新增 CLI 选项**：

```
cc-linker setup                              # 交互式渠道选择（默认勾选飞书）
cc-linker setup --channels=feishu           # 仅飞书（向后兼容）
cc-linker setup --channels=wecom            # 仅企微
cc-linker setup --channels=feishu,wecom     # 双渠道
cc-linker setup --skip-feishu --skip-hook   # 旧选项仍可用（兼容）
```

#### 4.5.3 微信"准一键"接入设计

**微信"一键扫码"真相**（已研究）：
- OpenClaw 的"一键扫码"是腾讯云控制台特有：Lighthouse → 快捷配置 → 腾讯云 OAuth → 代用户创建机器人
- cc-linker 是本地 CLI，**没有云端 OAuth 入口**，无法直接复制
- **可行的"准一键"**：CLI 引导 + 自动捕获 external_user_id（类比飞书 captureOpenId）

**init-wecom.ts 完整 wizard（7-step，与 init-feishu 镜像对齐）**：

> **架构决策（N1）**：init-wecom 的 step 数量与命名与 init-feishu 对齐（虽然 init-feishu 是 9 step 含 manual/skipCapture 分支，init-wecom 7 step 更紧凑），保证两个渠道的用户体验一致——用户切换渠道时不需要重新学习交互流程。

```
Step 1: 检测 daemon 运行 → 询问（与 feishu 同）
Step 2: 输出"创建机器人"引导（图文 + 步骤清单）
Step 3: 接收 bot_id（inquirer input）
Step 4: 接收 secret（inquirer password）
Step 5: 启动 aibot SDK WSS 长连接 + 输出"等待 SDK onReady..."
Step 6: 输出"请在企业微信给机器人发一条任意消息"
        监听 event.enter_chat → 捕获 external_user_id → 保存为 owner_external_user_id
Step 7: 保存 config.toml + 询问 start now + 询问 autoStart
```

**对自用场景完全够用**：
- 你（admin）刚创建的机器人会自动出现在你企业微信工作台
- 发一条消息触发 enter_chat 事件
- CLI 自动捕获 owner_external_user_id 完成配置

#### 4.5.4 不破坏现有 setup

- `cc-linker setup` 默认行为：勾选飞书（向后兼容）
- `init-feishu` / `init-wecom` 独立命令仍可用（不变）
- PR 3.5 改造后立即 commit，验证飞书 E2E 5 case 全部通过

#### 4.5.5 文件清单

```
新增：
src/cli/commands/channel-configurator.ts    (~120 行)
src/cli/commands/init-wecom.ts              (~250 行)  ← 从 PR 3 的 100 行扩展

改造：
src/cli/commands/setup.ts                   (~250 行)  ← 从 467 行重构到 600+ 行
src/cli/commands/init-feishu.ts             (+30 行)  ← 提取 runFeishuWizard export
src/index.ts                                (+5 行)   ← 注册 init-wecom 命令（PR 3 已加）
```

## 5. 数据流

### 5.1 入站：WSS → SpoolQueue

```
wss://openws.work.weixin.qq.com (aibot WSS, 30s heartbeat)
  ↓ aibot event: text / image / template_card_event
WecomBot.onMessage(event)
  1. 校验签名（aibot SDK 自动）
  2. event → PlatformMessage 适配
  3. serialKey = `new:${userId}` 或 `resume:${sessionUuid}`
  4. SpoolQueue.enqueue(serialKey, message)
  ↓
SpoolQueue (现有，不改)
  pending/ → processing/ → replied/
  serialKey 保证同用户串行
  ↓
dispatch worker → WecomBot.handleClaimed()
  if (isCommand(text)) → handleCommand()
  else                  → handleChat()
```

### 5.2 命令处理：复用 platform/command-handler

```
parseCommand(text)        ← 从 feishu/bot.ts 抽出
  ↓ { cmd, args }
executeCommand(cmd, args, ctx)
  - ctx.userId, ctx.platform, ctx.sessionUuid
  - 各命令独立函数（复用）
  ↓
WecomStreamUpdater.send(result)  ← 用 markdown 类型而非 stream.id（短回复）
```

### 5.3 聊天处理：Claude → 流式回复

```
handleChat(message)
  1. 读 UserMapping → sessionUuid (CAS 校验)
     - pending_new_session_claimed → 新建 ClaudeSessionManager
     - session → 复用现有 session
  2. spawn: claude -p <text> --output-format stream-json --resume <uuid>
  3. stdout → StreamParser → StreamChunk[] (thinking/text/result)
                                  ↓
WecomStreamUpdater 流式发送（节流 2000ms）：
  t=0s    start("🤔 thinking...")  → streamId
  t=2s    update(streamId, "正在分析...")
  t=4s    update(streamId, "正在分析... \n\n准备...")
  ...     节流窗口内合并 chunk，最大 ~1KB
  t=N s   finish(streamId, finalText, {asCard: false})

错误路径：
  fail(streamId, errorText)
    → markdown 错误消息 + "重试 / 取消" 模板卡片按钮

限频处理（errcode 45009/45033）：
  → 客户端 buffer + skip 下次 update
  → finish 时 buffer 合并到 finalContent
  → warn 日志 + metric
                                  ↓
  4. ClaudeSessionManager.on('result') → session_id
  5. 更新 UserMapping（CAS）
  6. 更新 Registry entry (origin: 'wecom')
  7. SpoolQueue.markDone()
```

### 5.4 按钮回调：template_card_event（5 秒时窗）

```
用户点击 "重试" 按钮
  ↓
aibot event: template_card_event { message_id, action_tag, action_value }
  ↓
WecomBot.onCardAction(event)
  1. 解析 action → { type: 'retry' | 'stop' | 'confirm-stop' | 'list-refresh', ... }
  2. 立即调 wsClient.replyWelcome(frame, thinkingCard)  ← 必须 5 秒内
  3. 异步执行实际动作（重试 Claude / 停止 session / 刷新列表）
  4. 动作完成后 wsClient.updateTemplateCard 或 sendMessage 发新结果
```

### 5.7 跨平台 session 隔离模型（Issue #3 决策）

**关键事实**（2026-06-19 已通过读源码验证）：
- `UserManager.mapping.entries[openId]`（`src/feishu/mapping.ts:39,122`）—— key 是**平台特定** userId
- `SpoolQueue serialKey = `new:${event.open_id}``（`src/feishu/bot.ts:331`）—— 同样按平台 userId 聚合
- 飞书的 `open_id` 与企微的 `external_userid` **完全不交叉**

**结论**：
- **同一真实用户**在飞书和企微各有独立 userId、各有独立 mapping entry、各有独立 sessionUuid
- 同一真实用户即使同时在飞书和企微发消息：
  - 飞书侧 → 飞书 session 跑飞书 claude 进程 → 流式回复到飞书
  - 企微侧 → 企微 session 跑企微 claude 进程 → 流式回复到企微
  - **两个 session 完全独立，不会互相阻塞**
- 飞书内部已有的 busy 判断（`pending_new_session_claimed` CAS，`mapping.ts:171-189`）只在飞书用户之间有效
- **跨平台没有"同 session 抢资源"的并发问题**

**用户感知**：
- 自用 + 团队场景：用户在某个平台活跃不会干扰另一平台的 session
- **能力缺失（不在 v1 范围）**：跨平台"继续同一会话"——如果用户在飞书跑了一个长 session，想去企微"接着聊"，目前需要重新描述上下文
  - 未来可做：用 `mobile` / `email` 等做 user identity 关联，跨平台映射 sessionUuid
  - v1 不做，spec 显式 YAGNI

**SpoolQueue 跨平台策略**（PR 3 实施）：
- `--platform=all` 时，两个 Bot 共用一个 `SpoolQueue` 实例（共享 `~/.cc-linker/spool/`）
- 但飞书消息和企微消息天然按 userId 隔离，不会冲突
- `Worker` 拉取消息时按 `serialKey` 分发，与现有逻辑一致

### 5.5 关键时序约束

| 场景 | 时延要求 | 实现 |
|---|---|---|
| aibot WSS 心跳 | ≤ 30s | SDK 自动 |
| template_card_event 主动作回复 | ≤ 5s | 立即发"处理中"占位 |
| 流式更新节流 | ≥ 2000ms | StreamUpdater 内部 |
| Claude 启动到首 chunk | 不限 | 进度卡片"🤔 thinking" |
| WSS 断线重连 | 指数退避 1s→30s | aibot-client 内部 |
| Bot 进程崩溃恢复 | 不限 | SpoolQueue reconcile |

### 5.6 飞书 vs 企微数据流关键差异

| 阶段 | 飞书 | 企微 |
|---|---|---|
| 入站 | WSClient.onMessage | aibot WSS event |
| 用户标识 | open_id | external_userid |
| 串行键 | chat_type + open_id | userId（不区分 p2p/group） |
| 流式消息标识 | message_id (PATCH) | stream.id (patch + finish=true) |
| 卡片更新 | 同步 PATCH 接口 | 异步 aibot_respond_update_msg（5s 窗口）或新发 |
| 限频约束 | 5 QPS/条 | **30/min/账号** |
| 按钮回调时延 | 异步无约束 | **5 秒内**必须给占位 |
| 群聊支持 | 是 | 是 |

## 6. 错误处理

### 6.1 错误分类矩阵

| 类别 | 检测 | 重试策略 | 用户感知 | 日志 |
|---|---|---|---|---|
| **A. 网络层** | WSS 断开 / 心跳超时 | 指数退避 1s→30s | "连接断开，正在重连..." | warn → error |
| **B. aibot 限频** | errcode 45009/45033 | client buffer + skip | 无（流式合并） | warn + counter |
| **C. Claude 进程** | spawn 失败 / mid-stream crash | 5 分钟内 ≤2 次自动重试 | "Claude 崩溃，请重试" | error + dump |
| **D. SpoolQueue** | processing 卡死 / 磁盘满 | reconcile 重启恢复 | 无（透明恢复） | error |
| **E. 平台无关** | Registry lock / CAS 冲突 | CCError 自带重试 | error card + 修复建议 | error + code |

### 6.2 A. 网络层（企微专属）

**A0. SDK 抛错（PoC 实测已识别）**
- `WSAuthFailureError`：botId/secret 错导致认证连续失败耗尽 maxAuthFailureAttempts → **不可恢复**
  - 处理：映射到 CCError E_CONFIG → fail-fast 进程自杀 + 用户必须修正 config 后重启
  - 日志：error（一次性，附完整 stack）
- `WSReconnectExhaustedError`：WSS 重连次数耗尽 maxReconnectAttempts → 网络持续不可达
  - 处理：触发 A3 进程自杀逻辑
  - 日志：error

**A1. WSS 断线**
- 退避：1s, 2s, 4s, 8s, 16s, 30s (max)
- 重连成功：清零退避；SpoolQueue reconcile 拉回 processing
- 重连失败 >5min：发 error metric
- 重连失败持续 >10min：bot.ts 进程自杀，launchd 重启
- 日志：warn (首次) → error (持续 5min)

**A2. 心跳超时**
- 30s 内未收到 pong → 单次重试 → 二次失败触发 A1

**A3. 进程自杀触发条件**
- `WSReconnectExhaustedError` 抛出
- A1 持续 >10min
- `WSAuthFailureError` 抛出（认证失败）
- launchd / systemd 重启 → `startupReconcile` 恢复 SpoolQueue

### 6.3 B. aibot 限频（协议级硬约束）

**B1. 流式更新触发 30/min 上限**
- StreamUpdater 内部 token bucket：30 tokens / 60s
- token 不足：update throw → catch 后 buffer chunk
- 下个节流窗口 (2000ms)：buffer 合并到下次 update
- finish 时：buffer 非空则拼接到 finalContent
- 日志：debug (轻度) → warn (buffer >3)

**B2. 主动发消息触发 1000/小时 上限**
- Bot 实例小时级计数
- 超过 800/小时：降级为"仅响应用户主动消息，不主动推送"
- 超过 1000/小时：完全停止主动推送 + error metric

### 6.4 C. Claude 进程

**C1. spawn 失败** — 立即 fail(messageId, "Claude CLI 启动失败") + "重试 / 帮助" 卡片。不重试。

**C2. mid-stream crash** — 参考现有 session._buildStreamingResult 模式
- finish(streamId, lastBuffer + "[回复被中断]", {success: false})
- 5 分钟内用户重试：自动 --resume 同一 session
- 失败 >2 次：停止自动重试，改"重试 / 新会话" 按钮
- 日志：error + 保存 stream partial + session_id

**C3. Permission Prompt 悬挂** — 复用 feishu/bot.ts PermissionHandler (5 分钟超时)
- 企微同步：发"是否允许 {tool_name}？ [是 / 否]" 模板卡片
- 按钮回调通过 template_card_event (5 秒窗口)

### 6.5 D. SpoolQueue（透明恢复）

**D1. processing 卡死** — startupReconcile() 扫描 processing/
- mtime > 30 分钟：移回 pending/ 重新处理
- 日志：warn + counter

**D2. 磁盘满 / Registry lock 失败**
- ENOSPC：error + 进程自杀（launchd 重启触发日志轮转）
- ELOCKED：重试 3 次 (100ms) → 仍失败则 CCError E013

### 6.6 E. 平台无关（CCError）

**E1. CAS 冲突** — 不重试，重新读 mapping 后重新决策
**E2. Registry 写失败** — 自动 rollback (从 backup 恢复) + error card

### 6.7 降级策略总表

| 场景 | 降级行为 |
|---|---|
| WSS 长时间断线 | 进程自杀 → launchd 重启 → reconcile 恢复 |
| aibot 限频持续触发 | buffer 合并，最终结果完整 |
| 限频达小时上限 | 禁用主动推送，仅响应用户消息 |
| Claude 反复崩溃 | 降级为短文本回复 (--max-turns 1) |
| SpoolQueue 损坏 | 从 backup 恢复 + warn 用户 |
| Registry 写失败 | rollback + error card |
| CAS 冲突 | 静默重读 mapping |

## 7. 测试策略

### 7.1 测试金字塔

```
       ┌──────────────────┐
       │   E2E 端到端测试  │  真实企微 + Claude CLI（人工 + 自动）
       └────────┬─────────┘
       ┌────────▼─────────┐
       │   集成测试        │  Mock aibot SDK / SpoolQueue (~30 case)
       └────────┬─────────┘
       ┌────────▼─────────┐
       │   单元测试        │  每个模块独立 (~80 case)
       └──────────────────┘
```

### 7.2 Bun + SDK 兼容性 PoC（前置，必做）✅ 已于 2026-06-19 验证

**PoC 结论**（已实测，PoC 代码在 `/tmp/aibot-poc/`）：

| 验证项 | 结果 | 备注 |
|---|---|---|
| `@wecom/aibot-node-sdk@1.0.7` 在 Bun v1.3.14 加载 | ✅ 通过 | named + default imports 都正确 |
| `new WSClient({ botId, secret })` 实例化 | ✅ 通过 | constructor 选项齐 |
| EventEmitter 事件订阅 | ✅ 通过 | `on('message.text')` 等正常工作 |
| `node:crypto` / `node:events` / `ws` | ✅ 通过 | 全部可用 |
| `bun build --compile` 打包 standalone binary | ✅ 通过 | 61MB binary，所有 SDK 行为正常 |

**PoC-3 关键 API 实测**（用于 §4.2 SDK 调用）：
```typescript
// 真实 SDK API（不是 spec 自创的）
wsClient.replyStream(frame, streamId, content, finish?, msgItem?, feedback?);
wsClient.replyStreamWithCard(frame, streamId, content, finish?, { msgItem?, templateCard?, ... });
wsClient.replyWelcome(frame, body);              // 5s 窗口
wsClient.updateTemplateCard(frame, templateCard, userids?);  // 5s 窗口
wsClient.sendMessage(chatid, body);              // 主动推送（无 callback frame）

// 事件
wsClient.on('message.text', handler);
wsClient.on('message.image', handler);
wsClient.on('event.template_card_event', handler);
wsClient.on('event.enter_chat', handler);

// 内容上限
// content max 20480 bytes（SDK 硬限制）

// 错误类
WSAuthFailureError       // botId/secret 错 → CCError
WSReconnectExhaustedError // 重连耗尽 → CCError
```

**备选方案不再需要**：PoC 完全通过，无需走 Bun 原生 WebSocket 自实现协议层。

**PoC 后续保留**：作为 PR 2 的 smoke test fixture，`bun test tests/poc/` 跑回归。

### 7.3 单元测试 (~80 case)

| 模块 | 测试点 |
|---|---|
| `platform/types.ts` | Feishu/aibot event → PlatformMessage 适配；userId 序列化 |
| `platform/stream-updater.ts` | 接口签名正确（编译期） |
| `wecom/aibot-client.ts` | WSS 连接/重连/心跳；errcode 映射 |
| `wecom/stream-updater.ts` | 节流合并；限频 buffer；stream.id 生命周期 |
| `wecom/bot.ts` | onMessage 归一化；handleCommand 路由；串行键 |
| `wecom/card.ts` | 5 种卡片 builder；按钮事件序列化 |
| `wecom/mapping.ts` | 读写 user-mapping-wecom.json；CAS 冲突 |
| CLI 改动 | `--platform` 解析；`init-wecom` 交互 |

### 7.4 集成测试 (~30 case)

用 Mock aibot Server 模拟企微服务端：

| 场景 | 描述 |
|---|---|
| 1 | 单聊文本 → Claude 流式 5 chunk 节流合并 |
| 2 | 群聊 @机器人 → 同上流程 |
| 3 | 图片消息 → 下载 → buildPromptWithImages |
| 4 | 限频持续触发 → buffer 合并到 finish |
| 5-7 | /list /switch /bridge new 命令 |
| 8 | 按钮回调"重试" → 5s 占位 + 异步处理 |
| 9 | Claude mid-stream crash → 部分结果 + 重试按钮 |
| 10 | WSS 断开 → 重连 → reconcile 恢复 |

### 7.5 端到端测试（E2E）

真实企微环境，必跑：

- E1: 手机企微发文本 → 流式回复正确
- E2: 手机企微发图片 → 识别回复
- E3-E5: /list /agents /stop 真实交互
- E6: WSS 主动 kill → launchd 重启 → reconcile
- E7: 100 条连续消息无漏/无乱序
- E8: 限频实测 60s 内 40 条

### 7.6 飞书零回归（强制）

- PR 1 抽象层后：飞书原有所有单测 + 集成测试 100% 通过
- 飞书路径 demo 5 个场景手工全过
- E2E 并行：飞书 + 企微同实例跑 1 小时无异常

### 7.7 性能基线

| 指标 | 飞书当前 | 企微目标 |
|---|---|---|
| 消息入站 → 首 chunk | < 3s | < 5s |
| 流式更新间隔 | 1500ms | **2000ms** |
| WSS 重连时间 | < 5s | < 5s |
| 内存占用 | ~80MB | ~100MB |
| SpoolQueue 积压告警 | 100 | 100 |
| 限频告警阈值 | n/a | 30/min/账号 |

## 8. 实施计划（3 个 PR）

### PR 1：抽象层（platform/）

**目标**：抽出 PlatformMessage / StreamUpdater 接口，飞书适配层接入，**不引入企微**

**范围**：
- 新增 `src/platform/types.ts`, `src/platform/stream-updater.ts`
- 新增 `src/platform/user-state.ts`, `src/platform/command-handler.ts`（从 feishu 抽公共部分）
- 改造 `src/feishu/card-updater.ts` 实现 `StreamUpdater`

**验收**：
- 所有 platform/ 单测通过
- 飞书 card-updater 适配层正确
- 飞书原有 4210 行代码零行为变更
- 飞书所有单测 + 集成测试 100% 通过
- 飞书路径 demo 5 场景手工全过

**风险**：抽取公共代码时漏掉边缘情况 → 飞书 E2E 必跑 + 单测覆盖率 ≥ 90%

### PR 2：企微全模块（wecom/）

**目标**：实现完整 wecom/ 通道，端到端可用

**前置**：PR 1 已合并 + Bun PoC 通过

**范围**：
- 新增 `src/wecom/` 全模块（aibot-client, stream-updater, bot, card, mapping, index）
- 新增 `src/wecom/` 单测 + 集成测试 + mock aibot server

**验收**：
- 所有 wecom/ 单测 + 集成测试通过
- PoC 三个脚本全部成功
- 限频 buffer 行为通过 mock 测试
- stream.id 流式协议正确（E2E 5 case 全过）
- 真实企微环境 E2E 8 case 全过
- 飞书回归：飞书 E2E 5 case 全过

**风险**：aibot SDK 行为细节 → 集成测试覆盖所有 SDK 错误码

### PR 3：CLI 整合（基础）

**目标**：把企微通道接入 CLI 命令 + config schema

**前置**：PR 2 已合并

**范围**：
- 改造 `src/cli/commands/start.ts` 加 `--platform`
- 改造 `src/utils/config.ts` 加 `[wecom]` 节
- 改造 `src/registry/types.ts` 加 `platform` 字段（v4→v5 migration）
- 改造 `src/runtime/state-coordinator.ts` 单锁多 `platforms`
- 改造 `src/queue/spool.ts` 加 `platform` + `userId` 字段
- 新增 `src/cli/commands/init-wecom.ts`（**简化版**：仅 bot_id + secret 写入 config，验证 + capture 由 PR 3.5 补充）
- 改造 `src/index.ts` 注册 `init-wecom`

**验收**：
- `--platform=feishu|wecom|all` 三种模式均工作
- `init-wecom` 简化版能写 config
- `config.toml [wecom]` + env override 正确
- StateCoordinator 双平台锁不冲突
- 双平台并存 (`--platform=all`) 跑 1 小时无异常

### PR 3.5：Setup 多渠道改造（新增，本节提交时确认）

**目标**：把 `setup` 从"飞书 hardcoded"改造为"渠道多选"，统一体验

**前置**：PR 3 已合并

**范围**（详见 §4.5）：
- **新增** `src/cli/commands/channel-configurator.ts`（统一接口 + registry）
- **改造** `src/cli/commands/setup.ts`：移除 hardcoded 飞书 step，加渠道选择 + 动态 wizard 调度 + 统一 summary
- **改造** `src/cli/commands/init-feishu.ts`：提取 `runFeishuWizard()` export（setup 复用）
- **扩展** `src/cli/commands/init-wecom.ts`：从 PR 3 简化版扩展为完整 7-step wizard（加 verify / captureOwnerUserId / 启动 / 自启）
- 改造 `src/index.ts` 注册 `init-wecom`（PR 3 已加）

**验收**：
- `cc-linker setup` 默认勾选飞书，向后兼容
- `cc-linker setup --channels=feishu,wecom` 跳过交互式选择
- `cc-linker setup --channels=wecom` 独立配企微
- `init-wecom` 7-step wizard 跑通：bot_id + secret → SDK 连 → enter_chat 捕获 → 写 config → 启动 → 自启
- 飞书路径 E2E 5 case 全部回归（setup 重构不破坏）
- 双渠道 `init-feishu` + `init-wecom` 独立命令仍可用

**与 PR 3 的拆分理由**：
- PR 3 关注"命令行能跑起来"（基础）
- PR 3.5 关注"setup 向导用户体验"（进阶）
- 拆分后 PR 3 review 更轻量，PR 3.5 单独 review setup 改造不与 start --platform 混合

## 9. 风险与未决问题

### 9.1 已知风险

| 风险 | 影响 | 缓解 | 状态 |
|---|---|---|---|
| `@wecom/aibot-node-sdk` Bun 不兼容 | ~~PR 2 阻塞~~ | ~~PoC 前置验证~~ | ✅ **PoC 已通过**（2026-06-19，见 §7.2） |
| `bun build --compile` 不能打包 SDK | ~~PR 2 阻塞~~ | ~~改 Bun 原生 WebSocket~~ | ✅ **PoC 已通过**（61MB standalone binary 行为正常） |
| aibot 限频 30/min 影响长对话 UX | 流式体验下降 | buffer 合并 + finish 完整；节流提到 2000ms | ⚠️ 协议级硬约束 |
| 按钮回调 5s 时窗导致"卡住"错觉 | 用户感知差 | 立即占位卡片（`replyWelcome`）+ 异步处理 | ⚠️ 协议级硬约束 |
| 抽公共代码时破坏飞书边缘行为 | 飞书回归 | PR 1 强制 E2E + 单测覆盖 ≥90% | 🔄 PR 1 风险 |
| SDK 抛 `WSAuthFailureError` 误显示 | 配置错时 user 看不懂 | 映射到 CCError + 一次性 error 日志 | 🔄 已识别，PR 2 处理 |
| 跨平台 userId 隔离导致"无法跨平台继续会话" | 用户体验缺陷 | **v1 显式 YAGNI**，未来用 mobile/email 做 identity 关联 | 🔄 已知约束，v1 不解决 |
| 用户接入需扫"联系我"二维码 | 自用 0 摩擦，团队 1 次性 | README 写清流程 | 🟢 可控 |
| **PR 3.5 setup 重构破坏飞书 E2E** | setup.ts 是用户首次安装接触的核心，重写引入新 wizard 调度可能引入回归 | Task 3.5.7 强制飞书 5 case E2E 回归；Step 0 默认勾选飞书（向后兼容）；ChannelConfigurator 抽象 feishu/wecom 行为对齐 init-feishu | 🔄 PR 3.5 风险 |
| **FeishuConfigurator 与 runFeishuWizard 重复逻辑 / owner_id 丢失** | Task 3.5.2 promptCredentials 必须委托 runFeishuWizard 完整流程（含 captureOpenId），不能分步执行否则 saveConfig 阶段会覆盖 owner_open_id | Task 3.5.2 Step 2 实现细节明确；Task 3.5.7 飞书 E2E 跑通验证 owner_id 正确写入 | 🔄 PR 3.5 风险 |

### 9.2 未决问题（生产观测）

1. aibot WSS 重连稳定性（生产 1 周观测）
2. stream.id 流式 patch 的实际节流行为（30/min 是否包括 stream patch 还是仅 send）
3. 未认证主体是否能创建智能机器人（需用户实测；spec 已推荐"个人组建团队"作为兜底路径）
4. 限频触发的精确阈值（30/min 是 SDK 文档值，实际可能浮动）

### 9.3 不在 v1 范围（未来可能）

- 个人微信接入（无官方 API，不考虑）
- 公众号 / 小程序接入（范式不同，不考虑）
- 完全 Platform Adapter 抽象（待 3 个平台以上时再做）
- 飞书侧行为优化（独立需求，不在本次范围）
- 跨平台"继续同一会话"（user identity 关联）
- 复杂监控 / metric 导出（按 Issue #4 决策暂不做）

## 10. 验收标准（v1 完成判定）

### 10.1 功能验收

**基础（PR 1-3 验收）：**
- [ ] cc-linker start --platform=wecom 可启动企微 Bot
- [ ] 手机企微发文本/图片 → Claude 流式回复
- [ ] /list /switch /bridge /new /resume /stop 命令全部工作
- [ ] 按钮回调（重试 / 停止 / 刷新列表）正常
- [ ] WSS 重连稳定（断网 5 分钟内自动恢复）
- [ ] 限频场景下回复完整（buffer 合并生效）

**Setup 多渠道（PR 3.5 验收）：**
- [ ] `cc-linker setup` 默认勾选飞书，向后兼容（飞书用户无感）
- [ ] `cc-linker setup --channels=feishu,wecom` 双渠道配置跑通
- [ ] `cc-linker setup --channels=wecom` 独立配企微跑通
- [ ] `init-wecom` 7-step wizard 跑通：bot_id + secret → SDK 连 → enter_chat 捕获 owner_external_user_id → 写 config → 启动 → 自启
- [ ] `init-feishu` 9-step wizard 仍可用（独立命令不被破坏）
- [ ] `ChannelConfigurator` 接口：feishu / wecom 各实现一套，setup 调度统一
- [ ] 飞书路径 setup 5 case E2E 全部回归（setup 重构零破坏）

### 10.2 飞书零回归（硬约束）

- [ ] 飞书所有现有功能不受影响
- [ ] 飞书 E2E 5 case 全过
- [ ] --platform=all 时飞书 + 企微共存无冲突

### 10.3 性能验收

- [ ] 消息入站 → 首 chunk P95 < 5s
- [ ] 流式更新间隔稳定 2000ms
- [ ] 100 条连续消息无漏/无乱序
- [ ] 内存占用 < 100MB（单企微通道）

### 10.4 文档验收

- [ ] README 更新（企微通道使用说明）
- [ ] docs/superpowers/specs/2026-06-19-wecom-integration-design.md（本文件）
- [ ] config.toml [wecom] 节注释完整

## 11. 参考资料

### 11.1 企业微信官方文档

- [智能机器人 aibot 文档 (101463)](https://developer.work.weixin.qq.com/document/path/101463)
- [模板卡片更新 (94888)](https://developer.work.weixin.qq.com/document/path/94888)
- [应用消息接口 (90236)](https://developer.work.weixin.qq.com/document/path/90236)
- [代开发自建应用 (97165)](https://developer.work.weixin.qq.com/document/path/97165)
- [官方帮助：注册企业微信 (15422)](https://open.work.weixin.qq.com/help/wap/detail?docid=15422)

### 11.2 OpenClaw 相关

- [腾讯 2026-03-14 一键扫码接入公告](https://so.html5.qq.com/page/real/search_news?docid=70000021_77669b55bdf32352)
- [搜狐 2026-03-26 面向个人及团队开放](https://www.sohu.com/a/1001459400_120972183)
- [WecomTeam/aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk)
- [WecomTeam/wecom-openclaw-plugin](https://github.com/WecomTeam/wecom-openclaw-plugin)
- [腾讯云开发者社区：OpenClaw 接入企微 3 步教程 (2026-06-19)](https://cloud.tencent.com/developer/article/2637067)

### 11.3 同类项目（参考架构）

- [cc-connect](https://github.com/cccZone/cc-connect/blob/main/docs/wecom.md)
- [clawrelay-wecom-server](https://github.com/wxkingstar/clawrelay-wecom-server)
- [pi-wecombot](https://github.com/huang-x-h/pi-wecombot)

### 11.4 飞书侧（参考基线）

- [飞书 Card PATCH 文档](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)
- 当前 `src/feishu/bot.ts` (4210 行) 和 `src/feishu/card-updater.ts` (650 行)