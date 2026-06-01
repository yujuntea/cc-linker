# cc-linker 飞书侧 Claude Code Agent View 支持设计

**日期：** 2026-06-01
**状态：** 已批准
**作者：** Claude Code

## 1. 问题陈述

Claude Code 在 v2.1.139+ 引入 `claude agents` 命令,提供「Agent View」——一个全屏 TUI 仪表板,统一管理多个并行运行的后台 Claude Code 会话(后文简称 *background session*)。用户可以在一屏内看到所有 background session 的状态、当前活动、PR 进度,并能 Peek 最近输出、Reply 输入新消息、Stop 终止会话。

目前 cc-linker 在飞书侧只支持**单会话**交互(一个飞书用户 ↔ 一个 active session),无法让用户在手机端管理 background session。本设计让 cc-linker 把 Agent View 能力桥接到飞书侧,用户可以在飞书里:

1. 列出所有 background session(状态分组、目录、PR 编号、耗时)
2. Peek 任意 session 的最近输出
3. Reply 给指定 session(通过 SDK resume 注入消息)
4. Stop 正在运行的 session

不引入:派发新会话、删除会话、Worktree 管理、Filter/Pin/Rename 等 TUI-only 操作。详细范围见 §2。

## 2. 目标与非目标

### 2.1 目标(v1 必须支持)

| # | 目标 | 优先级 |
|---|------|--------|
| G1 | 飞书 `/agents` 命令列出所有 background session,按状态分组 | P0 |
| G2 | 列表显示名称、状态、耗时、cwd 摘要、PR 编号 | P0 |
| G3 | 列表卡 [Refresh] 按钮即时重拉 | P0 |
| G4 | [Peek] 抓取 `claude logs <id>` 最近 N 行,渲染 peek 卡 | P0 |
| G5 | [Reply] 在 blocked / stopped / done 状态下可发起 reply,流式输出 | P0 |
| G6 | [Reply] 在 working / attached 状态下被守卫拒绝 | P0 |
| G7 | [Stop] 调用 `claude stop <id>`,完成后自动刷新列表 | P0 |
| G8 | 同 session 的并发 reply 走 `sessionLocks` 串行化 | P0 |
| G9 | Activity Marker 写入(复用 session-activity-sync 设计) | P1 |
| G10 | Claude 版本 < 2.1.139 时降级提示 | P0 |
| G11 | 卡片 body 不超 30KB,触顶走文本 fallback | P0 |
| G12 | 单测 + 集成测试 + 手动验收 | P0 |

### 2.2 非目标(v1 不做)

| # | 不做 | 原因 |
|---|------|------|
| N1 | 派发新 background session(`claude --bg`) | 用户在终端更直接;UI 复杂度高 |
| N2 | 删除 session(`claude rm`) | 双确认交互在 IM 难做;破坏性操作 |
| N3 | Worktree 路径展示 / 清理 | 状态已经够,操作交给 CLI |
| N4 | Filter `a:<name>` / `s:<state>` / `#<PR>` | 分组已覆盖常见需求 |
| N5 | Pin / Rename | TUI-only 心智模型 |
| N6 | 「当前活动」AI 摘要(Haiku 生成的那行) | 需读 `state.json`,v1 不读 |
| N7 | 列表排序(Shift+↑↓) | 状态分组已足够 |
| N8 | PR 状态颜色 | 显示 # 即可 |
| N9 | Subagent 单独列 | Agent View 本身不把 subagent 列为独立行 |
| N10 | 跨 cc-linker 实例同步 | 单机场景 |
| N11 | 多飞书用户隔离 | 假设单用户部署 |
| N12 | 派发 `!` shell 命令 | 派发不在 v1 范围 |

### 2.3 飞书 ↔ 终端并发 reply

不在 v1 解决范围,但 spec 需诚实标注:R6 风险。详见 §9。

## 3. 背景:Claude Code Agent View

参考 https://code.claude.com/docs/en/agent-view。Agent View 的关键事实:

- **载体**:`claude agents` 命令,需要在终端 v2.1.139+ 运行
- **后端**:每个 background session 由 `claude daemon` supervisor 进程托管,会话状态存于 `~/.claude/jobs/<id>/state.json`,运行列表存于 `~/.claude/daemon/roster.json`,supervisor 日志在 `~/.claude/daemon.log`
- **数据接口**:`claude agents --json` 一次输出 JSON 数组,字段包含 `pid` / `cwd` / `kind` / `startedAt` / `sessionId` / `name` / `status`
- **管理命令**:`claude --bg <prompt>` 派发,`claude attach/stop/rm/respawn/logs/daemon status` 管理
- **会话状态机**:working / blocked (needs input) / idle / done / failed / stopped
  - **状态字符串**:JSON 字段 `status` 实际值,通过 filter 语法 `s:working` / `s:blocked` 确认。完整 6 态字符串在实现时从 `claude agents --json` 实际输出抓取
- **关键限制**:background session 与 supervisor 私有 IPC 通信,公开 API 只暴露 `attach` (TTY 抢断)和 `logs` (只读)

## 4. 架构设计

### 4.1 数据流总览

```
┌─────────────────────────────────────────────────────────────┐
│  Feishu 飞书用户              cc-linker daemon              │
│                                                              │
│  /agents  ──►  bot.handleCommand()                           │
│                       │                                      │
│                       ▼                                      │
│             AgentViewManager.handleList()                    │
│                  │        │                                 │
│        ┌─────────┘        └────────┐                        │
│        ▼                          ▼                        │
│  VersionGuard              BackgroundPoller                  │
│  (claude --version          (poll `claude agents --json`     │
│   ≥ 2.1.139?)                on demand / every N sec)       │
│        │                          │                        │
│        ▼                          ▼                        │
│  ┌──────────────────────────────────────┐                  │
│  │  Snapshot cache (last JSON result)    │                  │
│  └──────────────────────────────────────┘                  │
│        │                                                    │
│        ▼                                                    │
│  AgentListCard  ──patch──►  Feishu                           │
│                                                              │
│  [Peek]   ──►  handlePeek() ──► claude logs <id>            │
│  [Reply]  ──►  handleReply() ──► sendSDKMessage (resume)    │
│  [Stop]   ──►  handleStop() ──► claude stop <id>            │
│  [Refresh]──►  handleList()                                 │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 模块切分

新增 `src/agent-view/` 目录,与 `src/feishu/`、`src/registry/` 平级:

| 文件 | 职责 |
|------|------|
| `index.ts` | 公共类型导出 |
| `manager.ts` | `AgentViewManager` 顶层协调,被 `FeishuBot` 调用 |
| `snapshot.ts` | 解析 `claude agents --json`,定义 `AgentSession` / `AgentSessionStatus` / `AgentSessionGroup` 类型,执行版本守卫 |
| `poller.ts` | `BackgroundPoller` 周期性或按需执行 `claude agents --json`,提供 diff 事件 |
| `card.ts` | 飞书卡片构建:列表卡 / peek 卡 / 错误卡 / 空状态卡 |
| `action.ts` | 飞书 `card.action.trigger` 回调路由,处理 5 种 action |
| `reply-bridge.ts` | 把 Agent View reply 桥接到 `ClaudeSessionManager.sendSDKMessage`,集成 session lock 和 activity marker |

## 5. 各操作数据流

### 5.1 列表(`/agents`)

```
bot.handleCommand('agents', openId)
   ↓
AgentViewManager.handleList(openId)
   ↓
1. VersionGuard.check()  →  < 2.1.139? 错误卡 return
   ↓
2. Poller.fetchSnapshot() → exec `claude agents --json` 解析为 AgentSession[]
   ↓
3. groupByStatus(snapshot) → { working, needsInput, completed, ... }
   ↓
4. CardBuilder.buildListCard(groups) → 飞书列表卡 JSON
   ↓
5. client.im.v1.message.create({...}) 发送
   ↓
6. 保存 cardMessageId 到 in-memory map: openId → messageId
   ↓ (用户点 [Refresh])
7. handleList() 重跑,patch 原 cardMessageId
```

**轮询策略**:**不**做后台推送。`/agents` 首次拉一次,后续 [Refresh] 按钮拉。考虑未来加"打开期间每 30s 自动 patch",但 v1 不做。

### 5.2 Peek

```
bot.handleCardAction({ type: 'agent_view_peek', shortId, sessionId })
   ↓
AgentViewManager.handlePeek(openId, shortId, sessionId)
   ↓
1. execFile('claude', ['logs', shortId]) 拿最近文本
   ↓
2. CardBuilder.buildPeekCard({ name, status, cwd, pid, startedAt, lastActivity, recentOutput })
   ↓
3. client.im.v1.message.create 发送新 peek 卡(不 patch 列表卡)
```

`claude logs <id>` 输出截断:取末尾 N 行(N = `peek_lines`,默认 30),超过 2KB 用 `truncateBytes` 截断(复用 `card-updater.ts` 工具)。

### 5.3 Reply(关键路径,两步式文本消息模式)

**为什么不直接用飞书卡片表单弹窗**:飞书卡片是否原生支持 `tag: 'input'` 等模态组件在不同客户端表现不一致,且 cc-linker 现有交互走的是"用户直接发文本"模式(例如 `/switch <id>` 后接下一条消息),两步式更稳。

**数据流**:

```
Step A — 用户在 list / peek 卡上点 [Reply] 按钮
   ↓
按钮 value: { type: 'agent_view_reply_request', shortId, sessionId, cwd }
   ↓
bot.handleCardAction(...)
   ↓
AgentViewManager.handleReplyRequest(openId, shortId, sessionId, cwd)
   ↓
1. 状态守卫: 查 AgentViewManager 缓存或重新 `claude agents --json` → 检查 status
   ├─ working | attached → 错误卡 return(贴回复)
   ├─ failed            → 错误卡 return
   └─ blocked | stopped | done → 继续
   ↓
2. 标记 openId 为「等待 reply 输入」,带 5 分钟超时
   ↓
3. 把原 list / peek 卡 patch 为「✍️ 等待输入回复 · <name>」状态
   ↓
4. 在聊天里发一条文本消息:
   "↩️ 回复会话: <name>
    请直接发送文字消息作为回复(5 分钟内有效)
    发送『/cancel』可取消等待"
   ↓
5. 设置 in-memory map: openId → { shortId, sessionId, cwd, expectedReply: true, startedAt }

Step B — 用户发普通文本消息(im.message.receive_v1)
   ↓
bot.handleChat() 收到普通消息
   ↓
1. 检查 in-memory map 该 openId 是否处于 expectedReply 状态
   ├─ 否 → 走现有 handleChat 流程(普通 chat reply)
   └─ 是 → 进入 handleReply 流程 ↓
   ↓
2. 文本以 "/cancel" 开头 → 清除等待标记,patch 原卡为 "已取消",return
   ↓
3. AgentViewManager.handleReply(openId, shortId, sessionId, cwd, text)
   ↓
4. 清除等待标记(避免双重 reply)
   ↓
5. 创建新 CardUpdater(独立于 Agent View 卡片),startProcessing(openId) → 拿新 cardMessageId
   ↓
6. sendSDKMessage(
     sessionId,           // resume
     text,
     cwd,
     onProgress,          // 喂 CardUpdater.updateStream
     onPermissionRequest, // 喂 PermissionHandler → 走现有权限卡
     false,               // isNew = false
     sessionId,           // lockKey
     undefined            // settingsPath
   )
   ↓
7. 流式结果:CardUpdater 自动 processing → streaming → complete/error
   ↓
8. 完成后 releaseSessionLock(sessionId)
```

**关键设计**:
- **每个 reply 是新飞书消息**,不 patch peek/列表卡。原因:peek 卡内容已多,patch 后难看;IM 习惯每动作产生新消息;用户能在消息流里直接看到 reply 完整过程
- **状态守卫依据**:`claude agents --json` 返回的 `status` 字段,实际值 `working` / `blocked` / `idle` / `done` / `failed` / `stopped`(前两个由官方 filter 语法 `s:working` / `s:blocked` 证实,其余 4 态字符串实现时从 `claude agents --json` 实际输出抓取)
- **不操作 supervisor 私有协议**:Anthropic 未公开,代价太高
- **不阻塞**:reply 触发后立刻让出,流式回调异步
- **等待超时**:5 分钟无输入,自动清除等待标记、patch 原卡为 "⏱ 等待超时"
- **"等待输入"期间不影响用户发无关消息**:Step B 入口先检查 expectedReply 标记,无标记走普通 chat 处理

**为什么不直接用 `card.action.trigger` 弹窗**:飞书卡片 input 组件在不同客户端(PC/手机/不同飞书版本)表现不一致,且本仓库无先例。两步式走"普通消息"通道,跟现有 cc-linker UX 一致(用户本来就习惯在飞书里打字),移动端体验更好。

### 5.4 Stop

```
bot.handleCardAction({ type: 'agent_view_stop', shortId, sessionId })
   ↓
AgentViewManager.handleStop(openId, shortId, sessionId)
   ↓
1. execFile('claude', ['stop', shortId])
   ├─ 失败 → 错误卡 return
   └─ 成功 ↓
2. sleep(1000)  // 等 supervisor 收尾
   ↓
3. handleList(openId) 重拉并 patch 原列表卡
```

`Ctrl+X` 第一次按下即 stop,第二次 2 秒内按下才 delete。v1 **不**暴露 delete。

## 6. UI 设计

### 6.1 列表卡(主入口)

```
┌──────────────────────────────────────────────┐
│ 🤖 Agent View · 3 sessions                   │   <- header (blue)
├──────────────────────────────────────────────┤
│ **Working (1)**                              │
│                                              │
│ ✽ `flaky-test-fix`  ·  2m                   │
│   Edit tests/checkout.test.ts               │
│   📁 ~/projects/my-app  ·  PR #1234         │
│   [Peek] [Reply] [Stop]                      │
│                                              │
│ **Needs input (1)**                          │
│                                              │
│ ✻ `power-up design`  ·  1m                  │
│   needs input: double jump or wall climb?    │
│   (status: blocked)                          │
│   📁 ~/projects/my-game                     │
│   [Peek] [Reply]                             │
│                                              │
│ **Completed (1)**                            │
│                                              │
│ ∙ `title screen`  ·  9m                     │
│   result: menu, options, credits done        │
│   📁 ~/projects/my-game  ·  PR #1235         │
│   [Peek]                                     │
├──────────────────────────────────────────────┤
│ Last refreshed 12:34:56  ·  [🔄 Refresh]    │
└──────────────────────────────────────────────┘
```

**状态图标映射**(参考 Agent View TUI):

| TUI | 飞书 emoji | 含义 |
|-----|-----------|------|
| `✻` / 动画 `✽` | `✽` | Working |
| `✻` (yellow) | `❓` | Needs input |
| `∙` (dim) | `⏸️` | Idle |
| `∙` (green) | `✅` | Completed |
| `∙` (red) | `❌` | Failed |
| `∙` (grey) | `⏹️` | Stopped |

**每行字段**:
- 名称(`name` 字段)
- 状态(根据 `status` 字段映射)
- 耗时(从 `startedAt` 计算,人可读格式)
- 活动描述:v1 不显示(见 N6)
- 目录(`cwd`,截断到 `~/projects/my-app`)
- PR 编号(若有,普通文本)

**按钮可见性**:
- `[Peek]`:所有状态都显示
- `[Reply]`:blocked / stopped / done 时显示(working / failed / attached 不显示)
- `[Stop]`:working / blocked / idle 时显示(done / failed / stopped 不显示)

**空状态卡**:`🤖 Agent View / 暂无后台会话 / 请先在终端运行: claude --bg "<prompt>"` —— 教学提示,带一个 [Refresh] 按钮。

**溢出**:>10 个会话时折行 `… N more`,提示用户用 CLI filter。完整列表不渲染避免超 30KB。

### 6.2 Peek 卡

```
┌──────────────────────────────────────────────┐
│ 🔍 Peek · `flaky-test-fix`                   │   <- header
├──────────────────────────────────────────────┤
│ Status: Working                              │
│ CWD: ~/projects/my-app                       │
│ PID: 12345  ·  Started 12:30:00              │
│ Last activity: 2m ago                        │
├──────────────────────────────────────────────┤
│ **Recent output (last 30 lines)**            │
│ ```                                          │
│ $ npm test                                   │
│ PASS tests/checkout.test.ts                  │
│ FAIL tests/cart.test.ts                      │
│   Expected: 3                                │
│   Received: 4                                │
│ ```                                          │
├──────────────────────────────────────────────┤
│ [Reply] [Stop] [← Back to list] [Refresh]   │
└──────────────────────────────────────────────┘
```

### 6.3 错误卡

| 错误 | 标题 | 内容 |
|------|------|------|
| 版本过低 | `❌ Claude 版本过低` | `需要 v2.1.139+,当前 vX.Y.Z / 请运行 claude update` |
| Claude 不在 PATH | `❌ Claude CLI 未安装` | `请先安装 Claude Code CLI` |
| supervisor 异常 | `❌ Claude supervisor 异常` | `<stderr 前 200 字符>` |
| 解析失败 | `⚠️ 无法解析 Claude 输出` | `<前 100 字符>` |
| 会话已消失 | `⚠️ 会话已不存在` | `已自动刷新列表` + 触发 handleList |

错误卡统一无操作按钮,header 用 `template: 'red'`,标题前缀 `❌` 或 `⚠️`。

### 6.4 Action value schema

**对齐 cc-linker 现有 `card.action.trigger` 处理模式**:`tag` 是动作判别字符串,`value` 是 value object(可空)。`bot.handleCardAction()` 现有 `switch (tag)` 分派。

```typescript
// 按钮实际构造
{ tag: 'agent_view_refresh',          value: {} }
{ tag: 'agent_view_peek',              value: { shortId, sessionId, cwd } }
{ tag: 'agent_view_reply_request',     value: { shortId, sessionId, cwd } }
{ tag: 'agent_view_stop',              value: { shortId, sessionId } }
{ tag: 'agent_view_back_to_list',      value: {} }

// 在 bot.handleCardAction 内的分派(伪代码)
switch (tag) {
  case 'agent_view_refresh':          await agentView.handleList(openId, messageId); break;
  case 'agent_view_peek':              await agentView.handlePeek(openId, value.shortId, value.sessionId, value.cwd); break;
  case 'agent_view_reply_request':     await agentView.handleReplyRequest(openId, value.shortId, value.sessionId, value.cwd); break;
  case 'agent_view_stop':              await agentView.handleStop(openId, value.shortId, value.sessionId); break;
  case 'agent_view_back_to_list':      await agentView.handleList(openId, messageId); break;
}

// 类型定义(便于 action.ts 引用)
type AgentViewValue =
  | { tag: 'agent_view_refresh' }
  | { tag: 'agent_view_peek';          shortId: string; sessionId: string; cwd: string }
  | { tag: 'agent_view_reply_request'; shortId: string; sessionId: string; cwd: string }
  | { tag: 'agent_view_stop';          shortId: string; sessionId: string }
  | { tag: 'agent_view_back_to_list' }
```

## 7. 配置

`config.toml` 新增节:

```toml
[agent_view]
# 是否启用 Agent View 功能(v1 默认 true)
enabled = true
# 两次 refresh 之间的最小间隔(ms),用于防抖
refresh_min_interval_ms = 2000
# Peek 抓取最近多少行
peek_lines = 30
# Reply 锁等待超时(ms)
reply_lock_timeout_ms = 30000
# 给用户提示用,不强制
min_claude_version = "2.1.139"
```

`config.ts` 注册这些 key,带默认值,env 变量 `CC_LINKER_AGENT_VIEW_*` override。

## 8. 错误处理

| 错误 | 检测点 | 飞书呈现 |
|------|--------|----------|
| `claude` 不在 PATH | `execFile` ENOENT | 错误卡 "Claude CLI 未安装" |
| 版本 < 2.1.139 | 解析 `--version` | 错误卡 "需要 v2.1.139+,当前 vX" |
| supervisor 未跑 | `agents --json` 返回 `[]` | 教学卡 "请先 `claude --bg <prompt>`" |
| supervisor 异常 | `agents --json` 非 0 exit | 错误卡 "Claude supervisor 异常" |
| 解析失败 | JSON.parse 抛错 | 错误卡 "无法解析输出" |
| `claude logs <id>` 失败 | execFile 非 0 | 在原列表卡 patch "会话已不存在" + refresh |
| `claude stop <id>` 失败 | execFile 非 0 | 在原列表卡 patch "Stop 失败:<err>" |
| `sendSDKMessage` "session in use" | error 文本匹配 | reply 卡 "会话已被占用" |
| `sendSDKMessage` 其他错误 | catch 通用 | reply 卡显示错误(走 CardUpdater.error) |
| reply 等待超时(5 分钟无输入) | setTimeout 触发 | patch 原卡 "⏱ 等待超时",清除 expectedReply 标记 |
| reply 期间用户发 `/cancel` | 普通消息文本匹配 | patch 原卡 "已取消",清除标记,不发 reply |
| reply 期间用户发无关消息 | 普通消息 | 不影响:无 expectedReply 标记的消息走普通 chat 流程 |
| reply 期间用户发第二条 reply 文本 | 普通消息 | 不影响:expectedReply 标记已被 Step B 入口清掉,走普通 chat |
| 卡片 body 超 30KB | build 完测字节 | fallback 到纯文本消息(`shouldFallbackToText`) |
| 列表/peek 关闭/超时 | CardUpdater.dispose | 现有行为 |

实现:`agent-view/card.ts` 暴露 `buildErrorCard(reason)`,统一标题、配色、footer。**不**复用 `feishu/card-updater.ts` 的错误卡构造,因其绑定到 `CardUpdater` 实例。

## 9. 关键风险与开放问题

### R1 — SDK resume 对 supervisor-managed session 行为未知(高)

**风险**:`query({ resume: sessionId, prompt })` 对一个 supervisor 托管的 blocked session 表现未知。可能:成功注入 / 起并行进程 / 报错。

**缓解**:
- v1 状态守卫限定 reply 只在 blocked / stopped / done
- 失败时 graceful 报错,不动 supervisor
- 真实环境手测验证(DoD 包含此项)
- 如需更深集成,v2 探索 supervisor 协议(Anthropic 不承诺 API 稳定性)

### R2 — Claude 版本边界(中)

**风险**:Agent View 在 research preview,接口可能变。`claude agents --json` 字段名、状态字符串可能调整。

**缓解**:
- snapshot.ts 解析失败不抛错,只显示错误卡
- 类型定义集中在一个文件,改起来范围可控
- 走 `claude --version` 守卫,提示用户升级

### R3 — 卡片大小(低)

**风险**:cwd 全路径 + 大量会话可能撑爆 30KB。

**缓解**:
- 列表上限 10 个会话 + 折行
- 估算每会话 250B,10 个 ~3KB,加上 header/footer ~3.5KB,远低于 30KB
- `shouldFallbackToText` 兜底

### R4 — 多飞书用户竞争(中)

**风险**:多个飞书用户可能 reply 同一 session。

**缓解**:
- 现有 `ClaudeSessionManager.sessionLocks` 串行化(已实现)
- 列表对所有用户显示相同内容(N11 暂不做隔离)

### R5 — 旧版 CLAUDE Code 兼容性(中)

**风险**:用户从老版本升级到 v0.3.4 后,`agent view` 命令可用但 `claude` CLI 未必 ≥ 2.1.139。

**缓解**:`/agents` 入口处先做 version 守卫,降级提示清晰。

### R6 — 飞书 ↔ 终端(或两个飞书客户端)并发 reply(中)

**风险**:同一 background session 同时被:
- (a) 飞书 reply + 终端 `claude attach`(用户分心)
- (b) 两个飞书用户同时 reply(单机部署不常见但可能)

官方文档只说 supervisor "starts a fresh process from where it left off",**未明说**两个客户端并发输入时如何仲裁。可能:两个 client 都被注入成功(状态分叉)、第二个被丢弃、supervisor 报错。

**缓解(v1)**:
- `ClaudeSessionManager.sessionLocks` 已经按 sessionId 串行化 sendSDKMessage,飞书侧两个 reply 会排队
- 飞书 reply 进行中,Activity Marker 写入 `~/.cc-linker/activity/<uuid>.log`(`start` / `heartbeat` / `end`),与现有 session-activity-sync 设计兼容,让终端 `claude` 用户能看到"飞书正在用这个 session"
- 终端用户主动 `claude attach` 跟飞书 reply 并发时,行为取决于 supervisor —— spec 诚实标注,**v1 不解决**

**v2 候选方案**:
- 读 supervisor 的 `daemon.log` 探测其他客户端活动
- 实现自定义 supervisor-side watcher
- 这部分工作量较大,且 Anthropic 不保证协议稳定

## 10. 测试策略

### 10.1 单元测试(`bun test`)

- `snapshot.ts`:解析各种 JSON 形态(working / blocked / mixed / empty / invalid)
- `snapshot.ts`:版本守卫(2.1.138 / 2.1.139 / 2.1.200 / 字符串异常)
- `card.ts`:列表卡 / peek 卡 / 错误卡 / 等待中状态卡 / 超时卡 / 取消卡 JSON 结构 + 字节上限
- `action.ts`:action value 解析与路由(5 种 tag)
- `reply-bridge.ts`:expectedReply 状态机
  - 标记写入 / 读取 / 清除
  - 5 分钟超时触发清除
  - `/cancel` 触发清除
  - 普通消息在 expectedReply 状态下走 handleReply 流程
  - 普通消息在无 expectedReply 状态下走普通 chat 流程

### 10.2 集成测试(`bun test`)

- mock `execFile` 返回固定 JSON,验证 `AgentViewManager` 各方法的调用链
- mock `sendSDKMessage` 注入可控流,验证 reply 卡状态切换

### 10.3 测试 fixture

`tests/fixtures/agents-json/`:
- `working.json`:1 个 working 会话
- `blocked.json`:1 个 blocked 会话(原 "needs input")
- `mixed.json`:3 状态各 1
- `empty.json`:空数组
- `invalid.json`:格式错乱
- `attached.json`:有 attached 状态会话(若字段支持)

### 10.4 手动验收(DoD 必做)

- 启 cc-linker
- 终端 `claude --bg "<长任务>"` 派发
- 飞书 `/agents` 看到列表
- 点 [Peek] 看输出
- 让 Claude 进入 blocked 状态(原 "needs input"),飞书 [Reply] 按钮 → 文本消息 → 注入回答
- 验证 Activity Marker 写到 `~/.cc-linker/activity/<uuid>.log`
- 终端 `cat` 那个 log 确认

## 11. 验收标准(Definition of Done)

- [ ] `/agents` 在飞书可用,版本 < 2.1.139 时显示降级提示
- [ ] 列表卡正确分组 working / blocked / completed,空组不显示
- [ ] 列表卡显示名称、状态、耗时、cwd 摘要、PR 编号
- [ ] [Refresh] 按钮即时重拉,防抖 `refresh_min_interval_ms`
- [ ] [Peek] 抓取最近 `peek_lines` 行,渲染 peek 卡
- [ ] [Reply] 两步式:点按钮 → 列表卡 patch 为等待状态 → 用户发文本消息 → 注入回答
- [ ] [Reply] 在 working / attached / failed 状态被守卫拒绝,显示明确提示
- [ ] [Reply] 等待 5 分钟超时,自动清除 expectedReply 标记并 patch 原卡
- [ ] [Reply] 等待期间用户发 `/cancel` 取消
- [ ] [Reply] 等待期间用户发无关消息不被打断(走普通 chat)
- [ ] [Stop] 真正停掉 session,完成后自动刷新列表
- [ ] 同一 session 的并发 reply 走 `sessionLocks` 串行化
- [ ] Activity Marker 写入,格式与 session-activity-sync design 一致
- [ ] 卡片 body 永远不超 30KB,触顶走文本 fallback
- [ ] `agent_view.enabled = false` 时 `/agents` 返回 "已禁用"
- [ ] `bun run typecheck` 通过
- [ ] `bun test` 全绿,新单测覆盖核心路径(包括 expectedReply 状态机)
- [ ] README.md / README_en.md 新增 "Agent View" 章节
- [ ] CLAUDE.md Important Files 表加 `src/agent-view/`
- [ ] 手动验收 1 个端到端场景通过(派发→blocked→飞书 reply)

## 12. 文档更新

- `docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md`(本文档)
- `README.md` / `README_en.md` 新增 "Agent View" 章节,展示命令、卡片示例图、配置说明
- `CLAUDE.md` "Important Files" 表加 `src/agent-view/`
- `docs/agent-view.md`(可选,放完整用户手册)

## 13. 参考

- Claude Code Agent View 文档:https://code.claude.com/docs/en/agent-view
- Claude Agent SDK:https://docs.anthropic.com/en/api/agent-sdk/overview
- `docs/session-activity-sync-design.md`(复用 Activity Marker 设计)
- `docs/superpowers/specs/2026-05-24-feishu-permission-interaction-design.md`(sendSDKMessage 现有用法)
