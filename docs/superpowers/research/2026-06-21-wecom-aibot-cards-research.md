# WeCom aibot 交互式卡片能力调研 (PR 7.5.18)

> PR 7.5.18 research report: aibot template_card permission + industry alternatives
> 研究日期: 2026-06-21
> 目的: 为 cc-linker WeCom aibot channel 选择最佳卡片/交互方案

## 背景

cc-linker 在 WeCom (企业微信) 智能机器人 (aibot) 上尝试 17 次 PR 发送 `template_card` 消息均失败 (错误码 846605, 40016, 42014, 93006)。经查, 当前 aibot 仅授权 3 个工具:

- `get_msg_chat_list` (获取会话列表)
- `send_message` (发送消息)
- `get_message` (获取会话消息)

**`template_card` 能力未授权**, 这是 17 次 PR 失败的根因。

调研目标:
1. 找到 `template_card` 能力的正式申请路径
2. 调研在没 `template_card` 能力时, 业界用什么替代方案实现交互卡片
3. 基于 cc-linker 现状给出推荐方案

---

## Part 1: template_card 申请路径

### 1.1 官方文档入口

| 文档 | URL | 说明 |
|------|-----|------|
| 智能机器人概览 | https://developer.work.weixin.qq.com/document/path/100723 | aibot 入口、回调/回复分类 |
| 智能机器人接收消息 | https://developer.work.weixin.qq.com/document/path/100719 | 列出接收消息类型: text/image/mixed/voice/file/video/quote/stream |
| 模板卡片类型 | https://developer.work.weixin.qq.com/document/path/101032 | 模板卡片消息格式文档 (独立页) |
| 智能机器人回复消息 | https://developer.work.weixin.qq.com/document/path/101031 | 被动回复 + 模板卡片 |
| 智能机器人主动回复 | https://developer.work.weixin.qq.com/document/path/101138 | response_url 主动消息 |

### 1.2 文档原文关键发现

根据开发者中心"智能机器人"分类下文档结构:

> "开发者也可直接回复**模板卡片消息**" — 引用自 [接收消息 100719](https://developer.work.weixin.qq.com/document/path/100719) 概述

智能机器人接收侧支持的消息类型 (官方列举):
- `text` — 文本
- `image` — 图片 (仅单聊)
- `mixed` — 图文混排
- `voice` — 语音 (仅单聊)
- `file` — 文件 (仅单聊, ≤100MB)
- `video` — 视频 (仅单聊, ≤100MB)
- `quote` — 引用
- `stream` — 流式消息刷新

**文档明确把"模板卡片"作为可"直接回复"的选项**, 因此 aibot 在协议层支持 `template_card`。问题在于实际授权范围。

### 1.3 申请路径

WeCom aibot 的能力授权走 **企业管理员后台**, 不是开发者自助:

**步骤:**

1. **企业管理员登录企业微信管理后台**
   - URL: https://work.weixin.qq.com/wework_admin/

2. **进入应用管理 → 智能机器人 → 选择目标机器人**
   - 路径: 应用管理 → 智能机器人 → [机器人名]

3. **找到"能力/接口权限"配置**
   - 在机器人配置页底部, 通常是"接口权限"或"能力授权"区域

4. **勾选需要的能力**:
   - `template_card` (模板卡片)
   - `markdown` / `markdown_v2`
   - `image` (图片)
   - `file` (文件)
   - `voice` (语音)
   - `video` (视频)

5. **保存并等待生效**
   - 通常 5-10 分钟内生效
   - 部分能力可能需要企业认证 (非个人微信)

**注**: 对于个人/未认证企业, 部分能力 (如 template_card) 可能灰度或受限。这是用户 aibot 仅 3 个工具的可能原因。

### 1.4 错误码解析

| 错误码 | 含义 | 触发场景 |
|--------|------|---------|
| `40016` | invalid button size / 参数无效 | 卡片结构非法、缺必填字段 |
| `846605` | aibot 未授权该能力 | 用了未勾选的能力 |
| `42014` | 应用未启用 / 能力未授权 | 同上, 但定位更明确 |
| `93006` | 消息类型不被支持 | msgtype 当前 aibot 不接受 |

**根因诊断**: 用户报告 17 个 PR 各种错误码混合出现, 但**全是"能力未授权"语义**:
- `846605` / `42014` → 后台未勾选
- `40016` → 即使勾选了, msgtype 字符串没在白名单 (例如发到 stream-only 通道)
- `93006` → 协议层 fallback 错误

### 1.5 业界 cc-connect 项目验证

参考相似项目 [cccZone/cc-connect](https://github.com/cccZone/cc-connect/blob/main/docs/wecom.md) 的 wecom.md 文档:

> "WebSocket aibot (recommended): No public URL, no encryption, no IP whitelist needed — **but no image/voice/Markdown**."

cc-connect 选择了 **Webhook 回调模式 (而非 aibot WebSocket)** 因为 aibot 能力受限。该项目明确区分:
- **aibot (API 模式长连接)**: 受限于 aibot 能力, 仅文本流
- **aibot (Webhook 回调)**: 需要公网 IP, 但支持 image/voice/markdown
- **自建应用 (corpId + agentId)**: 全功能, 包括 template_card

---

## Part 2: 业界替代方案

### 2.1 方案 A: Markdown + URL 链接 (markdown msgtype)

**形式**: 用 `markdown` 类型消息, 在文本里嵌入可点击 URL。

**优点**:
- markdown 几乎所有 aibot 都默认支持
- 不需要 template_card 权限
- 链接天然可点击, 用户能跳转
- 飞书、钉钉、企微三端格式接近

**缺点**:
- **没有按钮交互** — 用户不能点击"确认/取消"
- 复杂场景下只能依赖用户手动回文本
- 卡片视觉差: 没有图片 banner、没有分隔线

**适用场景**: 单向通知、状态汇报、简单跳转。

### 2.2 方案 B: 多次消息模拟按钮流 (sequential text)

**形式**: aibot 连发多条文本, 用户回复数字/字母对应选项。

```
Bot: 请选择操作:
Bot: 1. 查看详情
Bot: 2. 重试
Bot: 3. 取消
User: 1
```

**优点**:
- 100% 兼容所有 aibot
- 实现简单 (no extra capability)
- 用户学习成本低 (数字选项)

**缺点**:
- UX 差 — 不是卡片, 用户得读多条消息
- 多轮上下文靠 `serialKey` 维持 (cc-linker 已有此机制)
- 容易被噪声消息淹没

**适用场景**: 命令选择、低频关键操作。

### 2.3 方案 C: 图文混排 (mixed msgtype)

**形式**: 用 `mixed` (图文混排) 类型, 一条消息带标题 + 描述 + 跳转链接 + 图片。

**优点**:
- 视觉比纯文本好
- 支持图片 + 链接组合
- aibot 默认就支持 mixed 接收/回复

**缺点**:
- **仍无按钮**
- 图片需先上传获取 media_id, 流程复杂
- cc-linker 当前 aibot 通道用 WebSocket 长连接, 接收 mixed 但 **回复能力受限**

**适用场景**: 报告展示、图文通知。

### 2.4 方案 D: stream 流式消息 + 多轮

**形式**: 用 aibot 的 `stream` (流式消息刷新) 类型, 模拟卡片更新效果。

**优点**:
- aibot 原生支持
- 可模拟"卡片从 processing → complete" 状态流转
- cc-linker 现有 CardUpdater 思路可直接借鉴

**缺点**:
- 仅限"刷新同一消息", 没有交互按钮
- 用户体感仍是文本
- 一次性写入, 不支持按钮回调

**适用场景**: 长任务进度展示 (如 cc-linker Agent view 现有用法)。

### 2.5 方案 E: 切换到自建应用 (corpId + agentId) 模式

**形式**: 不用 aibot, 而是用企业微信自建应用 + 客服消息接口。

**优点**:
- **全功能**: 包括 template_card
- 已有 400+ 错误码文档支撑
- 频率上限更高

**缺点**:
- 用户必须先添加自建应用为"好友" (vs aibot 直接搜索)
- 配置复杂: 需要 corpId + agentId + agentSecret + 应用可见范围
- 用户视角: 从"对话 AI" 变成"对话应用", 心智变化

**适用场景**: 想要完整卡片能力的**长期方案**。

### 2.6 方案 F: 飞书 / 钉钉作为替代通道

**形式**: 既然企微 aibot 限制多, **让用户改用飞书/钉钉** cc-linker bot。

**优点**:
- 飞书 IM 支持 **interactive card** 原生交互按钮 (Callback / Open URL / Invoke)
- 钉钉支持 **ActionCard 消息卡片**
- cc-linker 已经有 Feishu 通道, 复用代码

**缺点**:
- 用户迁移成本
- 飞书/钉钉不在所有企业都能用
- 失去"用企微聊天" 卖点

**适用场景**: To-B 部署时客户已有飞书/钉钉习惯。

---

## Part 3: 三大平台卡片能力对比

| 能力 | 企微 aibot (当前) | 企微 自建应用 | 飞书 bot | 钉钉 bot |
|------|------------------|--------------|----------|----------|
| **template_card** | 受限/未授权 | 全功能 | 对应: interactive card | 对应: ActionCard |
| **markdown** | 受限 | 全功能 | 富文本 | markdown |
| **图文混排** | 支持 | 支持 | 支持 | 支持 |
| **图片** | 支持 | 支持 | 支持 | 支持 |
| **按钮回调** | 无 | 有 (callback) | 有 (callback 完整) | 有 (callback 完整) |
| **卡片更新** | 无 | 有 (response_code) | 有 (card.update) | 有 |
| **流式刷新** | 有 (stream) | 有 | 有 (interactive 状态) | 无原生 |
| **配置门槛** | 低 | 中 | 中 | 中 |
| **用户添加成本** | 低 (搜名字) | 高 (加好友) | 低 | 低 |

---

## Part 4: 推荐方案

基于 cc-linker 现状 + 17 PR 失败教训 + 业界调研:

### 主推 (Tier 1): **方案 B 多次消息模拟按钮流** + **stream 流式刷新**

**理由**:
1. **零额外授权** — 不依赖 template_card 能力
2. **现有架构已支持** — cc-linker 已有 `serialKey` (per-session serial processing) 机制
3. **覆盖 80% 场景** — Agent view 的 /list /peek /reply /stop 都能用文本流模拟
4. **可视化增强** — 用 aibot 的 `stream` (流式消息刷新) 模拟"卡片从生成中 → 完成"

**具体实施**:

```typescript
// 伪代码
async function renderAgentListCard(agents: AgentSession[]): Promise<void> {
  // 1. 发第一条 "🎲 正在加载..." (stream start)
  const streamId = await bot.sendStream(userOpenId, "🎲 正在加载...");
  // 2. 解析每个 agent, 增量更新 stream
  for (const agent of agents) {
    await bot.updateStream(streamId, renderAgentBlock(agent));
    await sleep(100);  // 让用户看到逐条出现
  }
  // 3. 发交互提示 (多次文本消息)
  await bot.sendText(userOpenId, "📋 回复数字选择 agent:\n1️⃣ session-1\n2️⃣ session-2\n...");
  // 4. 进入等待输入状态
  state.setPendingReply(userOpenId, { type: 'agent_select', list });
}
```

### 备选 (Tier 2): **方案 A markdown + URL** 用于不需要按钮的通知

**适用**: "/agents 状态汇报" "/status 命令输出" 等**单向 + 跳转**场景。

### 长期 (Tier 3): **申请 template_card 权限 + 方案 E 自建应用双轨**

**步骤**:
1. **短期 (1 周内)**: 联系企业微信管理员, 在 aibot 后台勾选 template_card / markdown / image 能力。**等用户授权后, 17 个 PR 的代码不需要改**, 立刻能跑通。
2. **中期 (1-3 月)**: 提交企微客服接口申请, 切换到**自建应用**通道, 拿全功能 (含 template_card 完整 6 种 card_type)。
3. **长期 (3-6 月)**: 评估**飞书**作为 To-B 部署主通道, 因飞书 interactive card 能力最完整且 cc-linker 已有代码基础。

---

## 后续行动

### 立即 (本周)

1. **核实用户企微后台**:
   - 进入 https://work.weixin.qq.com/wework_admin/ → 应用管理 → 智能机器人 → 选择 aibot
   - 截图当前已授权能力 (对照 3 个工具的限制)
   - 找企业管理员尝试勾选 `template_card`、`markdown`、`image`、`file` 能力

2. **如果管理员不能/不愿授权**, 按 Tier 1 方案 B 实施:
   - 在 `src/wecom/channel.ts` 增加 `renderMultiMessageCard()` 函数
   - 把现有 Feishu CardUpdater 的卡片逻辑 (按钮 + 状态) 翻译成"多次文本流"
   - Agent view 全部用文本流改造, 移除对 template_card 的依赖

3. **错误码统一诊断**:
   - 在 `send_message` 调用后, 把 846605 / 40016 / 42014 / 93006 映射为用户友好提示
   - 提示"您的 aibot 尚未授权此能力, 请联系管理员开启"

### 中期 (1-3 月)

1. **架构层面**:
   - 抽象 `CardRenderer` 接口, 让 Feishu / WeCom / Slack 等 channel 各实现
   - WeCom 实现 = MultiMessageRenderer (Tier 1)
   - Feishu 实现 = 现有 CardUpdater

2. **A/B 测试**: 同等场景下, 比较 Feishu 卡片 vs WeCom 多消息的 UX, 用数据决定 To-B 主推

### 参考资料

- WeCom 智能机器人文档: https://developer.work.weixin.qq.com/document/path/100723
- 智能机器人接收消息: https://developer.work.weixin.qq.com/document/path/100719
- 模板卡片类型: https://developer.work.weixin.qq.com/document/path/101032
- OpenClaw 接入企业微信智能机器人: https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657
- cc-connect wecom 文档: https://github.com/cccZone/cc-connect/blob/main/docs/wecom.md
- 飞书机器人消息类型: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
- 钉钉机器人消息类型: https://open.dingtalk.com/document/orgapp/robot-message-types-and-data-format
