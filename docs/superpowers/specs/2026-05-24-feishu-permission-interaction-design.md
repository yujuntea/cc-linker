# cc-linker 终端交互式权限确认设计

**日期：** 2026-05-24  
**状态：** 已批准  
**作者：** Claude Code  

## 1. 问题陈述

当前 cc-linker 通过 `Bun.spawn(['claude', '-p', ...])` 启动 Claude CLI 进程，将飞书消息代理到 Claude Code。当 Claude 需要权限确认（如执行 Bash 命令、文件写入）时：

- CLI `-p` (非交互) 模式不支持交互式权限确认
- 官方文档明确说明：`-p` 模式下权限阻塞会导致 session abort
- 当前 `stdin: 'ignore'` 设置使进程完全无法接收用户输入
- 用户只能在飞书中看到 Claude 的自然语言提示"请在终端手动授权"，无法在手机端完成操作

**根本原因：** 当前架构依赖 CLI 的 stdout/stderr 管道，但 `-p` 模式不提供权限交互能力。

## 2. 解决方案

迁移到 Anthropic TypeScript Agent SDK (`@anthropic-ai/claude-agent-sdk`)，利用其 `canUseTool` 回调机制实现飞书卡片上的交互式权限确认。

### 2.1 为什么选择 Agent SDK

| 方案 | 可行性 | 原因 |
|------|--------|------|
| CLI spawn + stdin 管道 | 不可行 | `-p` 模式不支持交互权限确认，权限阻塞会 abort session |
| 解析 stderr 权限提示 | 不可行 | stderr 只是通知，不会等待用户回复 |
| Agent SDK `canUseTool` | 可行 | 官方支持的交互权限机制，暂停执行等待用户决策 |

### 2.2 架构概览

```
飞书用户 → FeishuBot.handleChat() → ClaudeSessionManager.sendSDKMessage()
                                           │
                              ┌────────────┼────────────┐
                              │            │            │
                       StreamAdapter  PermissionHandler  CardUpdater
                       (SDK→Chunk)   (canUseTool回调)   (复用)
                              │            │            │
                              └──────┬─────┘            │
                                     │                  │
                              飞书卡片更新 ←─────────────┘
                              (processing → streaming
                               → permission_prompt → complete/error)
                                     │
                              用户点击"允许"/"拒绝"按钮
                                     │
                              PermissionHandler.resolve()
                              → { behavior: "allow" | "deny" }
```

## 3. 核心模块设计

### 3.1 ClaudeSessionManager 重构

**文件：** `src/proxy/session.ts`

**变更：** 新增 `sendSDKMessage()` 方法，复用现有的 `acquireSessionLock`/`acquireSlot` 并发控制，返回结果和 `PermissionHandler` 实例供调用方管理权限交互。

**核心逻辑：**
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

async sendSDKMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  onProgress: (chunk: StreamChunk) => void,
  onPermissionRequest: (prompt: PermissionPrompt) => void,
  isNew?: boolean,
  lockKey?: string,
  settingsPath?: string,
): Promise<{ result: SendMessageResult; handler: PermissionHandler }> {
  const resolvedLockKey = lockKey ?? sessionId ?? '__new__';
  await this.acquireSessionLock(resolvedLockKey);
  await this.acquireSlot();

  const handler = new PermissionHandler({
    allowedTools: config.get('claude.allowed_tools', []),
    disallowedTools: config.get('claude.disallowed_tools', []),
    timeoutMs: config.get('sdk.timeout_ms', 600_000),
  });
  handler.onPermissionRequest = onPermissionRequest;

  try {
    for await (const message of query({
      prompt: text,
      options: {
        permissionMode: config.get('sdk.permission_mode', 'acceptEdits'),
        canUseTool: handler.canUseTool.bind(handler),
        cwd: expandPath(cwd),
        allowedTools: config.get('claude.allowed_tools', []),
        disallowedTools: config.get('claude.disallowed_tools', []),
        pathToClaudeCodeExecutable: config.get('sdk.claude_executable', 'claude'),
        ...(sessionId && !isNew ? { resume: sessionId } : {}),
        ...(settingsPath ? { settings: settingsPath } : {}),
      },
    })) {
      if (message.type === 'stream_event') {
        streamAdapter.adaptSDKMessage(message, onProgress);
      } else if (message.type === 'result') {
        return { result: buildResult(message), handler };
      }
    }
  } finally {
    this.releaseSlot();
    this.releaseSessionLock(resolvedLockKey);
  }
}
```

**会话恢复：** SDK 支持 `resume` 选项，行为与 CLI 的 `--resume` 一致
```typescript
options: {
  ...(sessionId && !isNew ? { resume: sessionId } : {}),
}
```

**并发控制：** `sendSDKMessage` 复用现有的 `acquireSessionLock` + `acquireSlot` 机制，与 `sendMessage` / `sendStreamingMessage` 保持一致，确保同一 session 串行执行且全局并发不超过 `max_concurrent_sessions`。

### 3.2 PermissionHandler（新模块）

**文件：** `src/proxy/permission-handler.ts`

**职责：**
- 实现 `canUseTool` 回调
- 区分普通工具权限和 `AskUserQuestion`（澄清问题）
- 管理待处理的权限请求与用户决策的映射

**接口设计：**
```typescript
interface PermissionPrompt {
  type: 'tool' | 'question';
  toolName: string;           // 'Bash' | 'Write' | 'Edit' | 'AskUserQuestion' | ...
  input: Record<string, unknown>;
  displayText: string;        // 用于飞书卡片展示的可读文本
  index: number;              // 唯一标识符
}

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export class PermissionHandler {
  private pendingPrompts: Map<number, PermissionPrompt> = new Map();
  private resolveFns: Map<number, (result: PermissionResult) => void> = new Map();
  private nextIndex = 0;
  private onPermissionRequest: (prompt: PermissionPrompt) => void;

  canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
  ): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') {
      return this.handleClarifyingQuestion(input);
    }
    return this.handleToolPermission(toolName, input, options);
  }

  // 由飞书按钮点击事件调用
  resolveUserDecision(index: number, approved: boolean): void {
    const resolve = this.resolveFns.get(index);
    if (resolve) {
      if (approved) {
        resolve({ behavior: 'allow', updatedInput: this.pendingPrompts.get(index)!.input });
      } else {
        resolve({ behavior: 'deny', message: '用户在飞书中拒绝了此操作' });
      }
      this.cleanup(index);
    }
  }
}
```

**超时处理：**
- 设置超时（如 10 分钟），超时后自动拒绝
- 通过 `options.signal` 实现取消

### 3.3 StreamAdapter（新模块）

**文件：** `src/proxy/stream-adapter.ts`

**职责：** 将 SDK 消息流适配到现有 `StreamChunk` 格式，复用 `CardUpdater`

**SDK 消息类型映射：**
```typescript
// SDK StreamEvent → StreamChunk
'content_block_delta' + 'text_delta'    → { type: 'text', content }
'content_block_delta' + 'thinking_delta' → { type: 'thinking', content }
'result'                                → { type: 'result', result, session_id, ... }
```

### 3.4 CardUpdater 扩展

**文件：** `src/feishu/card-updater.ts`

**新增方法：**
```typescript
async updatePermissionPrompt(
  toolName: string,
  action: string,
  promptIndex: number,
): Promise<void>

async updatePermissionResult(approved: boolean): Promise<void>
```

**飞书卡片结构（权限请求）：**
```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": " 需要权限确认" },
    "template": "orange"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**Bash 命令：**\n```\nrm -rf /tmp/foo\n```"
    },
    {
      "tag": "action",
      "actions": [
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "✅ 允许" },
          "type": "primary",
          "value": { "type": "permission_approve", "index": 0 }
        },
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "❌ 拒绝" },
          "type": "default",
          "value": { "type": "permission_deny", "index": 0 }
        }
      ]
    }
  ]
}
```

### 3.5 飞书按钮事件处理

**文件：** `src/feishu/bot.ts`

**新增：** 卡片按钮点击事件处理（飞书 Interactive Card Callback）

Bot 中维护 `activePermissionHandlers: Map<string, PermissionHandler>`，以 `openId` 为 key 存储当前活跃的权限 handler。当用户点击权限卡片按钮时，从该 Map 中取出 handler 并解析决策：

```typescript
private activePermissionHandlers = new Map<string, PermissionHandler>();

private async handlePermissionCardAction(
  openId: string,
  approved: boolean,
  index: number,
  cardMessageId?: string,
): Promise<string | null> {
  const handler = this.activePermissionHandlers.get(openId);
  if (!handler) {
    return '权限确认已过期，请重试';
  }
  handler.resolveUserDecision(index, approved);
  // 更新权限卡片状态（通过 CardUpdater patch）
  return approved ? '✅ 已允许，Claude 将继续执行' : '❌ 已拒绝，Claude 将尝试其他方式';
}
```

**注意：** 飞书卡片按钮点击通过 Webhook 回调传递，需要在 bot 启动时注册交互回调 URL。`sendSDKMessage` 返回的 `PermissionHandler` 实例由调用方（Bot）存入该 Map，消息处理完成后清理。

## 4. 集成点

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/proxy/session.ts` | 重写 | 新增 `sendSDKMessage()`，复用 lock/slot 机制，返回 `PermissionHandler` |
| `src/proxy/permission-handler.ts` | 新增 | 实现 `canUseTool` 回调 |
| `src/proxy/stream-adapter.ts` | 新增 | SDK 消息流 → StreamChunk 适配 |
| `src/feishu/card-updater.ts` | 扩展 | 新增权限卡片方法 |
| `src/feishu/bot.ts` | 扩展 | 新增卡片按钮事件处理 |
| `package.json` | 新增依赖 | `@anthropic-ai/claude-agent-sdk` |
| `src/utils/config.ts` | 扩展 | 新增 SDK 相关配置项 |

## 5. 配置

**config.toml 新增项：**
```toml
[proxy]
# 执行引擎选择
engine = "sdk"  # "cli" (旧) | "sdk" (新)

[sdk]
# SDK 特定配置
permission_mode = "acceptEdits"  # default | acceptEdits | plan | auto | dontAsk | bypassPermissions
timeout_ms = 600000  # 权限确认超时（10分钟）
claude_executable = "claude"  # SDK 使用的 Claude 可执行文件路径（编译后二进制场景必需）
```

**环境变量：**
```bash
CC_LINKER_PROXY_ENGINE=sdk
CC_LINKER_SDK_PERMISSION_MODE=acceptEdits
CC_LINKER_SDK_TIMEOUT_MS=600000
```

## 6. 迁移策略

### Phase 1：双引擎并行
- 保留旧的 CLI spawn 方法（`sendMessage` / `sendStreamingMessage`）
- 新增 `sendSDKMessage`，通过 `sdk.enabled` 开关切换
- `sdk.enabled` 同时覆盖流式和非流式路径（优先于 `stream.enabled` 的旧逻辑）
- 验证 SDK 方法的基本功能

### Phase 2：SDK 为主
- 默认使用 SDK 引擎
- CLI 引擎作为 fallback（可配置）
- 收集用户反馈

### Phase 3：清理
- 移除 CLI spawn 代码
- 统一使用 SDK
- 清理废弃配置

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| SDK API 变化 | 中 | 锁定 SDK 版本，写集成测试 |
| 会话恢复兼容性 | 低 | SDK 支持 resume，行为与 CLI 一致 |
| 权限回调超时 | 中 | 设置超时（10分钟），超时后自动拒绝 |
| 飞书卡片交互延迟 | 低 | 卡片更新有节流机制 |
| 认证方式变化 | 低 | SDK 使用相同的环境变量 |
| 飞书回调 URL 配置 | 中 | 需要配置交互式卡片回调 URL |
| **编译后二进制找不到 SDK 嵌入的 Claude** | **高** | **使用 `pathToClaudeCodeExecutable: "claude"` 依赖系统安装** |

## 7.1 关键技术风险：编译后二进制

**问题：** cc-linker 使用 `bun run build` 编译成独立二进制（`dist/cc-linker`）。
SDK 嵌入的平台特定 Claude 二进制在 `bun build --compile` 后无法通过 `require.resolve` 找到（Bun 的 `$bunfs` 虚拟文件系统限制）。

**解决方案：** 使用 `pathToClaudeCodeExecutable` 选项指向系统安装的 `claude`：

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: text,
  options: {
    pathToClaudeCodeExecutable: config.get('sdk.claude_executable', 'claude'),
    // ... 其他配置
  }
})) { ... }
```

**前提条件：** 用户系统必须已安装 `claude` 命令行工具（`npm install -g @anthropic-ai/claude-code`）。
这与 cc-linker 现有要求一致（CLI spawn 模式也需要系统安装 claude）。

**替代方案（不推荐）：** 使用 `extractFromBunfs()` 提取嵌入的二进制到临时目录。
需要 SDK v0.3.144+，且需要修改构建流程，复杂度较高。

## 7.2 Bun 运行时兼容性

SDK 明确支持 Bun 运行时：
- 自动检测运行时，无需额外配置
- 可选参数 `executable: 'bun'`（通常不需要）
- 唯一的限制是编译后二进制场景（见 7.1）

## 7.3 计费变化

从 2026年6月15日起，Agent SDK 和 `claude -p` 使用独立的 Agent SDK 积分池，
与交互式使用量分开。这不影响技术可行性，但需要在运营层面关注。

## 8. 测试策略

- **单元测试：** `PermissionHandler` 的 `canUseTool` 回调逻辑
- **集成测试：** SDK `query()` → `StreamAdapter` → `CardUpdater` 全链路
- **E2E 测试：** 飞书消息 → 权限确认 → Claude 继续执行

## 9. 参考资料

- [Claude Agent SDK 文档](https://code.claude.com/docs/en/agent-sdk/overview)
- [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
