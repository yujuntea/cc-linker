# setup 向导更新 — 权限模式 + 飞书命令清单

**日期：** 2026-06-17
**作者：** wuyujun
**范围：** `cc-linker setup` 向导 + `printSummary` 输出

## 背景

当前 `cc-linker setup` 一键配置向导存在两个用户痛点：

1. **没有权限模式说明**。`config.toml` 已经有 `[claude].permission_mode` 和 `[sdk].permission_mode` 两个字段（默认都是 `acceptEdits`），但 setup 流程从不告知用户，也不允许配置。新手跑完 setup 后去飞书聊天，往往在遇到 Claude 的交互确认时被卡住（飞书端没有终端确认 UI）。

2. **飞书命令清单过时**。`printSummary()` 只列出 5 个飞书命令（`/list` `/new` `/switch` `/model` `/status`），但 `bot.ts` 的 `helpText()` 实际支持 12 个唯一命令（含子命令变体共 15 行），新增的 `listDir` `stop` `agents` 等都没有出现在总结里，初学者根本不知道有这些能力。

## 目标

1. 在 setup 向导中加一个 Step，让用户**理解并主动选择** Claude Code 权限模式，结果同步写入 `[claude].permission_mode` 和 `[sdk].permission_mode`。
2. 替换 summary 中飞书命令清单为高频 6 个，引导到 `/help` 获取完整列表。
3. 在 summary 中加一句对飞书"机器人自定义菜单"（飞书开放平台 → 应用 → 机器人配置 → 自定义菜单）的轻量推荐 —— 文案引导用户去飞书后台把这 4 个高频命令绑到菜单按钮上，手机端点选比手输更方便。

## 非目标

- 不修改 `bot.ts` 的 `helpText()` 输出（已经是 12 个唯一命令、15 行条目的正确清单）。
- 不修改 `init-feishu.ts` 的命令流程（避免重复引导）。
- 不实现菜单配置的 API 调用或远程配置（只是文案提示）。
- 不收集 `allowed_tools` / `disallowed_tools` / `timeout_ms` / `claude_executable` 等其它字段。

## 设计

### 1. 新的 Step 2：权限模式选择

**位置：** `src/cli/commands/setup.ts`，插在 Step 2（装钩子）和 Step 3（飞书 Bot 配置）之间。

**交互：** 复用现有 chalk / inquirer 风格。一个 inquirer `list` 提示，6 个合法值：

```
── Step 2 ── Claude Code 权限模式 ──

ℹ  权限模式说明:
  控制 Claude Code 执行操作时的交互确认行为。
  由于飞书端无法完成终端式交互确认，默认自动接受文件编辑。

可选值:
  acceptEdits          (推荐) 自动接受文件编辑，最适合飞书侧使用
  bypassPermissions    跳过所有权限检查，慎用
  auto                 智能判断
  default              使用 Claude Code 默认（可能弹出确认）
  dontAsk              不询问
  plan                 强制进入 plan 模式

? 请选择 Claude Code 权限模式: (acceptEdits)
```

inquirer `list` 类型，`default: 'acceptEdits'`（回车 = 推荐值）。用户选择后立刻写盘，不需要二次确认。

**Step 编号重排：** 现有的 `totalSteps` 在 line 46 算成 `opts.skipFeishu ? 2 : 3`，对应 Step 1（registry）→ Step 2（hook）→ Step 3（feishu）。新增权限模式后整体重排为：

| 旧 | 新 | 名称 |
|---|---|---|
| Step 1 | Step 1 | 初始化会话注册表 |
| （无） | **Step 2** | **Claude Code 权限模式（新增）** |
| Step 2 | Step 3 | 安装 Claude Code 钩子 |
| Step 3 | Step 4 | 配置飞书 Bot |

`totalSteps` 改为 `opts.skipFeishu ? 3 : 4`。所有打印 step 标题的 console.log（line 61/75/98 附近）需要相应改写。

**关于 `--skip-hook` 的预存缺陷：** 当前代码在 `skipHook=true` 且 `skipFeishu=false` 时已经会出现 "Step 1/3" → "Step 3/3" 的跳号（line 75 在 `if (!opts.skipHook)` 块里，不参与 totalSteps 同步）。本 spec 不修这个旧 bug；新增 Step 2 后会变成 "Step 1/4" → "Step 2/4" → "Step 4/4"，跳号更明显但属于同一根因。如果未来要修，应该是 `totalSteps` 改为基于实际执行的 step 数动态计算，不在本 spec 范围。

### 2. 写入逻辑

新加一个内部辅助函数（不导出）：

```typescript
function savePermissionMode(mode: string): void {
  const existing = loadExistingConfig();
  if (!existing.claude) existing.claude = {};
  existing.claude.permission_mode = mode;
  if (!existing.sdk) existing.sdk = {};
  existing.sdk.permission_mode = mode;
  saveConfig(existing);
}
```

行为规约：
- **总是**写两个字段。无条件同步。
- **不写** `[sdk].enabled`、不读 `enabled` 状态做条件判断。
- **不破坏** `[claude]` / `[sdk]` 段下其它已有字段（如 `allowed_tools`、`claude_executable`）。
- 文件不存在时 `loadExistingConfig()` 返回 `{}`，`saveConfig` 仍会创建目录并写入。

**修改 `saveConfig` 的 section 顺序**（`src/cli/commands/init-feishu.ts` line 168）：

把 `claude` / `sdk` 加入固定顺序列表，紧跟 `feishu_bot` 之后：

```typescript
// 原:
for (const section of ['general', 'feishu_bot', 'queue', 'runtime', 'security', 'scanner', 'cli_proxy', 'hook']) {
// 改为:
for (const section of ['general', 'feishu_bot', 'claude', 'sdk', 'queue', 'runtime', 'security', 'scanner', 'cli_proxy', 'hook']) {
```

这样 `claude` / `sdk` 紧跟 `feishu_bot`，与 `src/utils/config.ts` DEFAULTS 中这两个 section 的相对位置一致，避免落到底部"剩余 sections"块。注：`saveConfig` 的固定列表与 DEFAULTS 的完整顺序并不完全一致（例如 DEFAULTS 把 `scanner` 放在 `general` 之后，但 `saveConfig` 把它放在 `security` 之后）—— 这是历史遗留，不在本次 spec 范围。

### 3. Summary 面板更新

`setup.ts` 的 `printSummary()`（line 382-416）替换 `if (feishu.configured)` 块：

```typescript
if (feishu.configured) {
  console.log(chalk.cyan('  飞书端可用命令:'));
  console.log(chalk.white('    /list                — 列出会话'));
  console.log(chalk.white('    /listDir             — 浏览目录'));
  console.log(chalk.white('    /new [路径] -- 提示  — 创建新会话'));
  console.log(chalk.white('    /model               — 查看/管理模型'));
  console.log(chalk.white('    /stop                — 停止当前会话处理'));
  console.log(chalk.white('    /agents              — 查看 Agent 列表'));
  console.log('');
  console.log(chalk.gray('  完整命令列表：在飞书给 Bot 发 /help'));
  console.log(chalk.gray('  💡 提示：可在飞书开放平台 → 机器人 → 自定义菜单，'));
  console.log(chalk.gray('     把 /list、/new、/agents、/help 绑到菜单上，手机端点选更方便'));
  console.log('');
}
```

要点：
- 6 个高频命令（按用户决定清单）
- 引导到 `/help` 获取完整列表
- 一句对飞书"自定义菜单"的轻量文案推荐
- 保持 `chalk.cyan` / `chalk.white` / `chalk.gray` 现有配色

### 4. 不动的部分

- `bot.ts` 的 `handleCommand` switch / `helpText` —— 已经是 12 个唯一命令、15 行条目的正确清单，summary 引导到 `/help` 就够了。
- `init-feishu.ts` 主体命令流程 —— 已有 `printPermissionGuide()` 处理飞书侧权限，避免双份引导。
- `config.ts` 的 `DEFAULTS` —— 默认值已经合理（`acceptEdits`），向导只是暴露。

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/cli/commands/setup.ts` | 新增 Step 2 流程；新增 `savePermissionMode()`；修改 `totalSteps` 计算；step 编号重排（2/3→3/4，3/3→4/4）；修改 `printSummary` 命令块 |
| `src/cli/commands/init-feishu.ts` | `saveConfig` 的 section 顺序列表加入 `claude`、`sdk` |
| `tests/unit/cli/setup.test.ts` | **新建。**测试 `savePermissionMode` 行为：双字段同步、不破坏其它字段、不存在 config.toml 时能新建 |
| `tests/unit/cli/init-feishu.test.ts` | 新增 `saveConfig` 输出顺序测试（确保 `claude`/`sdk` 紧跟 `feishu_bot`）—— 现有 `saveConfig` round-trip 测试就在这个文件里，新增 case 与之共用 fixture |

## 测试策略

**单元测试：**
- `savePermissionMode('bypassPermissions')` 后 `config.toml` 含 `[claude] permission_mode = "bypassPermissions"` 和 `[sdk] permission_mode = "bypassPermissions"`，且 `[sdk].enabled` / `allowed_tools` / `claude_executable` 等已有字段不被覆盖
- `saveConfig` 顺序：含 `[claude]` 和 `[sdk]` 时，输出顺序是 `[general] → [feishu_bot] → [claude] → [sdk] → [queue] → ...`
- 不存在的 `~/.cc-linker/config.toml` 时能新建文件并写入

**手动验证：**
- `bun run dev setup` 走默认 → `cat ~/.cc-linker/config.toml` 应含 `[claude].permission_mode = "acceptEdits"` 和 `[sdk].permission_mode = "acceptEdits"`
- `bun run dev setup` 选 `bypassPermissions` → config.toml 两段都同步更新
- `bun run dev init-feishu` 仍正常工作，没引入新行为
- `cc-linker start --daemon` 起来后，飞书端发 `/help` 仍返回 12 个唯一命令的完整列表（验证没破坏 bot.ts）

## 风险与权衡

**风险 1：re-run setup 时会再问一次权限模式。**
- 评估：这是 wanted 行为 —— 用户改主意了能直接改。如果觉得烦，可以后续加 `--skip-permission` flag，但当前不在范围内。

**风险 2：`[sdk].permission_mode` 实际消费方是 ClaudeSessionManager。**
- 评估：grep 确认唯一消费方是 `src/proxy/session.ts:749`（SDK 模式启动的 chat 会话读取这个字段作为 Claude SDK 的 permission 透传）。`src/agent-view/` 整个目录没有任何 `sdk.permission_mode` 引用。默认值已经是 `acceptEdits`，强写一遍对绝大多数用户无副作用。但要注意：如果用户有自定义的 `claude.permission_mode` 但 `sdk.permission_mode` 不同（典型场景：CLI 走 `bypassPermissions`、SDK 走 `default`），setup 跑完后两边会被强制对齐。这是规约（用户决定"同步"），不算 bug，但建议在 summary 末尾加一行提示"两个 permission_mode 已同步为同一值"，让用户能立刻察觉。

**风险 3：summary 文案与 helpText 文案偶有漂移。**
- 评估：summary 是终端一次性输出，helpText 是运行时命令。两者都有 6 个高频命令就够；用户发 `/help` 总能拿到最新最全的（12 个唯一命令）。无需做单一来源。
