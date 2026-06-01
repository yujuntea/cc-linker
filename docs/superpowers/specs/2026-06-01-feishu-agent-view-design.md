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

## 3. 背景:Claude Code Agent View

参考 https://code.claude.com/docs/en/agent-view。Agent View 的关键事实:

- **载体**:`claude agents` 命令,需要在终端 v2.1.139+ 运行
- **后端**:每个 background session 由 `claude daemon` supervisor 进程托管,会话状态存于 `~/.claude/jobs/<id>/state.json`,运行列表存于 `~/.claude/daemon/roster.json`,supervisor 日志在 `~/.claude/daemon.log`
- **数据接口**:`claude agents --json` 一次输出 JSON 数组,字段包含 `pid` / `cwd` / `kind` / `startedAt` / `sessionId` / `name` / `status`
- **管理命令**:`claude --bg <prompt>` 派发,`claude attach/stop/rm/respawn/logs/daemon status` 管理
- **会话状态机**:working / blocked (needs input) / idle / done / failed / stopped
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

### 5.3 Reply(关键路径)

```
Step A — 触发输入弹窗(在 list / peek 卡上)
   ↓
[Reply] 按钮 value: { type: 'agent_view_reply_prompt', shortId, sessionId, cwd }
   ↓
Feishu 客户端弹输入框,用户输入后 callback:
   ↓
bot.handleCardAction({ type: 'agent_view_reply_submit', shortId, sessionId, cwd, text })

Step B — 处理 reply
   ↓
AgentViewManager.handleReply(openId, shortId, sessionId, cwd, text)
   ↓
1. 状态守卫: lookupSession(shortId) → 检查 status
   ├─ working | attached → 错误卡 return
   ├─ failed → 错误卡 return
   └─ blocked | stopped | done → 继续
   ↓
2. acquireSessionLock(sessionId)  // 复用 ClaudeSessionManager
   ↓
3. 创建新 CardUpdater(独立于 Agent View 卡片),startProcessing(openId) → 拿新 cardMessageId
   ↓
4. sendSDKMessage(
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
5. 流式结果:CardUpdater 自动 processing → streaming → complete/error
   ↓
6. 完成后 releaseSessionLock(sessionId)
```

**关键设计**:
- **每个 reply 是新飞书消息**,不 patch peek/列表卡。原因:peek 卡内容已多,patch 后难看;IM 习惯每动作产生新消息;用户能在消息流里直接看到 reply 完整过程
- **状态守卫依据**:`claude agents --json` 返回的 `status` 字段(具体字符串在实现时确认)
- **不操作 supervisor 私有协议**:Anthropic 未公开,代价太高
- **不阻塞**:reply 触发后立刻让出,流式回调异步

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

```typescript
type AgentViewAction =
  | { type: 'agent_view_refresh' }
  | { type: 'agent_view_peek';     shortId: string; sessionId: string; cwd: string }
  | { type: 'agent_view_reply_prompt';  shortId: string; sessionId: string; cwd: string }
  | { type: 'agent_view_reply_submit';  shortId: string; sessionId: string; cwd: string; text: string }
  | { type: 'agent_view_stop';     shortId: string; sessionId: string }
  | { type: 'agent_view_back_to_list' }
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
| reply 文本为空 | feishu input 校验 | 客户端弹错,不发送 |
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

## 10. 测试策略

### 10.1 单元测试(`bun test`)

- `snapshot.ts`:解析各种 JSON 形态(working / blocked / mixed / empty / invalid)
- `snapshot.ts`:版本守卫(2.1.138 / 2.1.139 / 2.1.200 / 字符串异常)
- `card.ts`:列表卡 / peek 卡 / 错误卡 JSON 结构 + 字节上限
- `action.ts`:action value 解析与路由

### 10.2 集成测试(`bun test`)

- mock `execFile` 返回固定 JSON,验证 `AgentViewManager` 各方法的调用链
- mock `sendSDKMessage` 注入可控流,验证 reply 卡状态切换

### 10.3 测试 fixture

`tests/fixtures/agents-json/`:
- `working.json`:1 个 working 会话
- `blocked.json`:1 个 needs input 会话
- `mixed.json`:3 状态各 1
- `empty.json`:空数组
- `invalid.json`:格式错乱
- `attached.json`:有 attached 状态会话(若字段支持)

### 10.4 手动验收(DoD 必做)

- 启 cc-linker
- 终端 `claude --bg "<长任务>"` 派发
- 飞书 `/agents` 看到列表
- 点 [Peek] 看输出
- 让 Claude 进入 needs input,飞书 [Reply] 注入回答
- 验证 Activity Marker 写到 `~/.cc-linker/activity/<uuid>.log`
- 终端 `cat` 那个 log 确认

## 11. 验收标准(Definition of Done)

- [ ] `/agents` 在飞书可用,版本 < 2.1.139 时显示降级提示
- [ ] 列表卡正确分组 working / needs input / completed,空组不显示
- [ ] 列表卡显示名称、状态、耗时、cwd 摘要、PR 编号
- [ ] [Refresh] 按钮即时重拉,防抖 `refresh_min_interval_ms`
- [ ] [Peek] 抓取最近 `peek_lines` 行,渲染 peek 卡
- [ ] [Reply] 在 blocked / stopped / done 状态可发起,流式输出
- [ ] [Reply] 在 working / attached 状态被守卫拒绝,显示明确提示
- [ ] [Stop] 真正停掉 session,完成后自动刷新列表
- [ ] 同一 session 的并发 reply 走 `sessionLocks` 串行化
- [ ] Activity Marker 写入,格式与 session-activity-sync design 一致
- [ ] 卡片 body 永远不超 30KB,触顶走文本 fallback
- [ ] `agent_view.enabled = false` 时 `/agents` 返回 "已禁用"
- [ ] `bun run typecheck` 通过
- [ ] `bun test` 全绿,新单测覆盖核心路径
- [ ] README.md / README_en.md 新增 "Agent View" 章节
- [ ] CLAUDE.md Important Files 表加 `src/agent-view/`
- [ ] 手动验收 1 个端到端场景通过

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
