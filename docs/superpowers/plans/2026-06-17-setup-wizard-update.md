# setup 向导更新 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `cc-linker setup` 向导中加入 Claude Code 权限模式选择步骤（同步写 `[claude]` 和 `[sdk]`），并把 summary 面板的飞书命令清单更新为高频 6 个 + `/help` 引导 + 飞书"自定义菜单"推荐。

**Architecture:** TDD 增量重构。先重构 `loadExistingConfig` / `saveConfig` 让它们接受可选 `configPath` 参数（绕开 bun:test 模块缓存导致的跨文件污染 —— 代码库已警告 `mock.module` 是 "irrevocable across files"）；再调整 `saveConfig` section 顺序把 `[claude]`/`[sdk]` 写进固定位置；为新加的 `savePermissionMode` 写完整单元测试；最后改 wizard 流程的 step 重排和 summary 文本。Wizard 流程改动（inquirer / chalk 输出）通过手动跑 `bun run dev setup` 验证。

**Tech Stack:** Bun, TypeScript, Commander, inquirer, chalk, @iarna/toml

**Spec:** `docs/superpowers/specs/2026-06-17-setup-wizard-update-design.md`（commit `90239af`）

**Scope:** 4 个文件改动（2 source + 2 test）。无 worktree 需要。

**已知背景：**
- `paths.ts` line 15：`export const CONFIG_PATH = process.env.CC_LINKER_CONFIG_PATH ?? ...` —— env var 只在模块首次加载时被读取，bun:test 会缓存模块。
- 代码库已在 `tests/unit/feishu/bot-runsdk.test.ts:6-7` 明确警告 `mock.module` 跨文件不可撤销。本计划**不用 mock.module**，改用可选 `configPath` 参数。
- inquirer `list` 提示不接受 `q` 键。验证 wizard 流程中途退出用 `Ctrl+C`。
- `--skip-feishu --skip-hook` 组合下会出现跳号（"Step 1/3 → Step 2/3 → summary"），是 spec 已记录的预存缺陷，本计划不修。

---

## 文件结构

| 文件 | 责任 |
|------|------|
| `src/cli/commands/init-feishu.ts` | `loadExistingConfig` / `saveConfig` 改为接受可选 `configPath` 参数；`saveConfig` section 顺序列表加 `claude`、`sdk` |
| `src/cli/commands/setup.ts` | 新增 `savePermissionMode(mode, configPath?)` 导出函数；新增 Step 2 权限模式选择；step 编号重排；改 `printSummary` 命令块 |
| `tests/unit/cli/init-feishu.test.ts` | 加 `loadExistingConfig` / `saveConfig` 接受可选路径的测试；加 `saveConfig` section 顺序测试 |
| `tests/unit/cli/setup.test.ts` | **新建。**测 `savePermissionMode` 的 4 个行为（用可选 `configPath` 参数） |

---

## Task 1: 让 `loadExistingConfig` 和 `saveConfig` 接受可选 `configPath` 参数

**Files:**
- Modify: `src/cli/commands/init-feishu.ts:142-149`（`loadExistingConfig`）
- Modify: `src/cli/commands/init-feishu.ts:161-192`（`saveConfig`）

- [ ] **Step 1: 改 `loadExistingConfig` 签名**

`src/cli/commands/init-feishu.ts` line 142-149 替换为：

```typescript
export function loadExistingConfig(configPath?: string): Record<string, any> {
  const path = configPath ?? CONFIG_PATH;
  if (!existsSync(path)) return {};
  try {
    return parse(readFileSync(path, 'utf8')) as Record<string, any>;
  } catch {
    return {};
  }
}
```

- [ ] **Step 2: 改 `saveConfig` 签名**

`src/cli/commands/init-feishu.ts` line 161-192 替换为：

```typescript
export function saveConfig(config: Record<string, any>, configPath?: string): void {
  const path = configPath ?? CONFIG_PATH;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const lines: string[] = [];

  // Write known sections in order
  for (const section of ['general', 'feishu_bot', 'queue', 'runtime', 'security', 'scanner', 'cli_proxy', 'hook']) {
    const values = config[section];
    if (!values || typeof values !== 'object') continue;
    lines.push(`[${section}]`);
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue;
      lines.push(`${k} = ${formatTomlValue(v)}`);
    }
    lines.push('');

    // Mark written
    if (config[section]) delete config[section];
  }

  // Write any remaining sections
  for (const [section, values] of Object.entries(config)) {
    if (typeof values !== 'object' || values === null) continue;
    lines.push(`[${section}]`);
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null) continue;
      lines.push(`${k} = ${formatTomlValue(v)}`);
    }
    lines.push('');
  }

  writeFileSync(path, lines.join('\n'), { mode: 0o600 });
}
```

注意：`delete config[section]` 移到 `if` 内（line 168 之前是循环外删除，行为相同，但这里重组为循环内更直观）。

- [ ] **Step 3: 跑 typecheck，确认没类型错误**

跑：`bun run typecheck`
预期：PASS（默认参数 + 可选参数都是合法的 TS 语法）

- [ ] **Step 4: 跑全部 init-feishu 测试，确认没破坏（现有测试都走默认路径）**

跑：`bun test tests/unit/cli/init-feishu.test.ts`
预期：全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init-feishu.ts
git commit -m "refactor(init-feishu): make loadExistingConfig/saveConfig accept optional configPath"
```

---

## Task 2: 修 `saveConfig` section 顺序 + 加测试

**Files:**
- Modify: `src/cli/commands/init-feishu.ts:167`（section 列表）
- Modify: `tests/unit/cli/init-feishu.test.ts`

- [ ] **Step 1: 改 section 顺序列表**

`src/cli/commands/init-feishu.ts` 中 `saveConfig` 函数里的固定列表（Task 1 Step 2 改过的版本，line 167 附近）：

```typescript
// 原:
for (const section of ['general', 'feishu_bot', 'queue', 'runtime', 'security', 'scanner', 'cli_proxy', 'hook']) {
// 改为:
for (const section of ['general', 'feishu_bot', 'claude', 'sdk', 'queue', 'runtime', 'security', 'scanner', 'cli_proxy', 'hook']) {
```

- [ ] **Step 2: 在 `tests/unit/cli/init-feishu.test.ts` 追加测试**

在 `describe('init-feishu helpers', ...)` 块内、紧跟 `describe('saveConfig', ...)` 之后（line 64 之后，line 65 的 `describe('loadExistingConfig', ...)` 之前）追加：

```typescript
  describe('saveConfig with explicit configPath', () => {
    it('places [claude] and [sdk] right after [feishu_bot] in output order', () => {
      const { saveConfig } = require('../../src/cli/commands/init-feishu');
      saveConfig(
        {
          general: { log_level: 'info' },
          feishu_bot: { app_id: 'x' },
          claude: { permission_mode: 'acceptEdits' },
          sdk: { permission_mode: 'acceptEdits' },
          queue: { max_pending: 100 },
        },
        configPath, // ← 测试 beforeEach 提供的 tmpDir/configPath
      );
      const raw = readFileSync(configPath, 'utf8');
      const idxFeishu = raw.indexOf('[feishu_bot]');
      const idxClaude = raw.indexOf('[claude]');
      const idxSdk = raw.indexOf('[sdk]');
      const idxQueue = raw.indexOf('[queue]');
      expect(idxFeishu).toBeGreaterThan(-1);
      expect(idxClaude).toBeGreaterThan(idxFeishu);
      expect(idxSdk).toBeGreaterThan(idxClaude);
      expect(idxQueue).toBeGreaterThan(idxSdk);
    });

    it('preserves [sdk].enabled when not modified', () => {
      writeFileSync(configPath, `[claude]
permission_mode = "default"
allowed_tools = ["Read"]

[sdk]
enabled = false
claude_executable = "/custom/path/claude"
`);
      const { saveConfig } = require('../../src/cli/commands/init-feishu');
      saveConfig(
        {
          claude: { permission_mode: 'bypassPermissions', allowed_tools: ['Read'] },
          sdk: { permission_mode: 'bypassPermissions', enabled: false, claude_executable: '/custom/path/claude' },
        },
        configPath,
      );
      const raw = readFileSync(configPath, 'utf8');
      // [sdk] enabled preserved
      expect(raw).toMatch(/\[sdk\][\s\S]*enabled\s*=\s*false/);
      // [sdk] claude_executable preserved
      expect(raw).toContain('claude_executable');
      // [claude] allowed_tools preserved
      expect(raw).toMatch(/\[claude\][\s\S]*allowed_tools/);
    });
  });
```

- [ ] **Step 3: 跑新测试**

跑：`bun test tests/unit/cli/init-feishu.test.ts -t "saveConfig with explicit configPath"`
预期：2 个 PASS

- [ ] **Step 4: 跑全部 init-feishu 测试**

跑：`bun test tests/unit/cli/init-feishu.test.ts`
预期：全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init-feishu.ts tests/unit/cli/init-feishu.test.ts
git commit -m "fix(init-feishu): place [claude]/[sdk] right after [feishu_bot] in saveConfig"
```

---

## Task 3: 新建 `tests/unit/cli/setup.test.ts` 骨架 + `savePermissionMode` 占位

**Files:**
- Create: `tests/unit/cli/setup.test.ts`
- Modify: `src/cli/commands/setup.ts` —— 新增 `savePermissionMode` 导出函数（占位实现）

- [ ] **Step 1: 在 `setup.ts` 加占位导出**

`src/cli/commands/setup.ts` 中 import 块（line 15）之后追加：

```typescript
export function savePermissionMode(mode: string, _configPath?: string): void {
  // placeholder — implemented in Task 4
  void mode;
}
```

注意：参数用 `_configPath` 加下划线表示有意未使用，避免 TS noUnusedParameters 警告。

- [ ] **Step 2: 建测试文件骨架**

创建 `tests/unit/cli/setup.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('setup savePermissionMode', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccl-setup-test-'));
    configPath = join(tmpDir, 'config.toml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('with empty config (file does not exist)', () => {
    it('creates config.toml with [claude] and [sdk] sections', async () => {
      const { savePermissionMode } = await import('../../src/cli/commands/setup');
      savePermissionMode('acceptEdits', configPath);
      expect(existsSync(configPath)).toBe(true);
      const raw = readFileSync(configPath, 'utf8');
      expect(raw).toContain('[claude]');
      expect(raw).toContain('[sdk]');
      expect(raw).toMatch(/permission_mode\s*=\s*"acceptEdits"/);
    });
  });
});
```

- [ ] **Step 3: 跑测试，确认占位实现下失败**

跑：`bun test tests/unit/cli/setup.test.ts`
预期：FAIL（`savePermissionMode` 是 no-op，文件不会被创建，existsSync 断言失败）

- [ ] **Step 4: Commit 测试文件 + 占位实现**

```bash
git add tests/unit/cli/setup.test.ts src/cli/commands/setup.ts
git commit -m "test(setup): scaffold savePermissionMode test + placeholder impl"
```

---

## Task 4: 实现 `savePermissionMode` 真实逻辑

**Files:**
- Modify: `src/cli/commands/setup.ts`

- [ ] **Step 1: 替换占位实现为真实逻辑**

`src/cli/commands/setup.ts` 中 `savePermissionMode` 替换为：

```typescript
export function savePermissionMode(mode: string, configPath?: string): void {
  const existing = loadExistingConfig(configPath);
  if (!existing.claude) existing.claude = {};
  existing.claude.permission_mode = mode;
  if (!existing.sdk) existing.sdk = {};
  existing.sdk.permission_mode = mode;
  saveConfig(existing, configPath);
}
```

- [ ] **Step 2: 跑 Task 3 写的测试**

跑：`bun test tests/unit/cli/setup.test.ts -t "with empty config"`
预期：PASS

- [ ] **Step 3: 在测试文件追加 3 个新 describe**

把 `tests/unit/cli/setup.test.ts` 中 `describe('with empty config ...', ...)` 之后追加 3 个新 describe：

```typescript
  describe('with existing [claude] and [sdk] sections', () => {
    beforeEach(() => {
      writeFileSync(configPath, `[claude]
permission_mode = "default"
allowed_tools = ["Read"]

[sdk]
enabled = false
claude_executable = "/custom/path/claude"
`);
    });

    it('updates both permission_mode fields, preserves everything else', async () => {
      const { savePermissionMode } = await import('../../src/cli/commands/setup');
      savePermissionMode('bypassPermissions', configPath);
      const raw = readFileSync(configPath, 'utf8');
      // [claude].permission_mode updated
      expect(raw).toMatch(/\[claude\][\s\S]*permission_mode\s*=\s*"bypassPermissions"/);
      // [claude].allowed_tools preserved
      expect(raw).toContain('allowed_tools');
      // [sdk].permission_mode updated
      expect(raw).toMatch(/\[sdk\][\s\S]*permission_mode\s*=\s*"bypassPermissions"/);
      // [sdk].enabled preserved (false)
      expect(raw).toMatch(/\[sdk\][\s\S]*enabled\s*=\s*false/);
      // [sdk].claude_executable preserved
      expect(raw).toContain('claude_executable');
    });

    it('does not modify [sdk].enabled', async () => {
      const { savePermissionMode } = await import('../../src/cli/commands/setup');
      savePermissionMode('acceptEdits', configPath);
      const raw = readFileSync(configPath, 'utf8');
      // Only one "enabled" in [sdk] section, still `false`
      const sdkBlock = raw.match(/\[sdk\][\s\S]*?(?=\n\[|$)/)?.[0] ?? '';
      expect(sdkBlock).toMatch(/enabled\s*=\s*false/);
      expect(sdkBlock).not.toMatch(/enabled\s*=\s*true/);
    });
  });

  describe('with existing config.toml that lacks [claude]/[sdk]', () => {
    beforeEach(() => {
      writeFileSync(configPath, `[feishu_bot]
app_id = "x"
`);
    });

    it('adds [claude] and [sdk] without touching [feishu_bot]', async () => {
      const { savePermissionMode } = await import('../../src/cli/commands/setup');
      savePermissionMode('plan', configPath);
      const raw = readFileSync(configPath, 'utf8');
      expect(raw).toContain('[feishu_bot]');
      expect(raw).toContain('app_id = "x"');
      expect(raw).toContain('[claude]');
      expect(raw).toContain('[sdk]');
      expect(raw).toMatch(/permission_mode\s*=\s*"plan"/);
    });
  });
```

- [ ] **Step 4: 跑全部 setup 测试**

跑：`bun test tests/unit/cli/setup.test.ts`
预期：3 个 describe 全部 PASS（共 4 个 it：empty / updates / does-not-modify / adds-without-touching）

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/setup.ts tests/unit/cli/setup.test.ts
git commit -m "feat(setup): implement savePermissionMode (sync [claude]+[sdk], preserve others)"
```

---

## Task 5: 在 setup 向导加 Step 2 权限模式选择 + 重排 step 编号

**Files:**
- Modify: `src/cli/commands/setup.ts:46`（`totalSteps`）
- Modify: `src/cli/commands/setup.ts:75`（hook 步骤的 step 编号 2→3）
- Modify: `src/cli/commands/setup.ts:98`（feishu 步骤的 step 编号 3→4）
- Modify: `src/cli/commands/setup.ts` —— 在 hook 块之前插入新 Step 2

- [ ] **Step 1: 改 `totalSteps` 计算**

`src/cli/commands/setup.ts` line 46：

```typescript
// 原:
const totalSteps = opts.skipFeishu ? 2 : 3;
// 改为:
const totalSteps = opts.skipFeishu ? 3 : 4;
```

- [ ] **Step 2: 重排现有 step 编号**

`src/cli/commands/setup.ts` 中两处 step 标题：

- line 75 附近（hook 块）：`Step 2/${totalSteps}` → `Step 3/${totalSteps}`
- line 98 附近（feishu 块）：`Step 3/${totalSteps}` → `Step 4/${totalSteps}`

line 61 附近（registry 块）的 `Step 1/${totalSteps}` 保持不变。

- [ ] **Step 3: 在 hook 块之前插入新的 Step 2 流程**

在 `src/cli/commands/setup.ts` 中、`if (!opts.skipHook) {`（line 73 附近）之前插入：

```typescript
  // ===== Step 2: Claude Code 权限模式 =====
  console.log(chalk.cyan(`── Step 2/${totalSteps} ── Claude Code 权限模式`));
  console.log('');
  console.log(chalk.gray('  ℹ  权限模式说明:'));
  console.log(chalk.gray('    控制 Claude Code 执行操作时的交互确认行为。'));
  console.log(chalk.gray('    由于飞书端无法完成终端式交互确认，默认自动接受文件编辑。'));
  console.log('');
  console.log(chalk.gray('  可选值:'));
  console.log(chalk.gray('    acceptEdits          (推荐) 自动接受文件编辑，最适合飞书侧使用'));
  console.log(chalk.gray('    bypassPermissions    跳过所有权限检查，慎用'));
  console.log(chalk.gray('    auto                 智能判断'));
  console.log(chalk.gray('    default              使用 Claude Code 默认（可能弹出确认）'));
  console.log(chalk.gray('    dontAsk              不询问'));
  console.log(chalk.gray('    plan                 强制进入 plan 模式'));
  console.log('');

  const { permissionMode } = await inquirer.prompt([{
    type: 'list',
    name: 'permissionMode',
    message: '请选择 Claude Code 权限模式:',
    default: 'acceptEdits',
    choices: [
      { name: 'acceptEdits          (推荐) 自动接受文件编辑，最适合飞书侧使用', value: 'acceptEdits' },
      { name: 'bypassPermissions    跳过所有权限检查，慎用', value: 'bypassPermissions' },
      { name: 'auto                 智能判断', value: 'auto' },
      { name: 'default              使用 Claude Code 默认（可能弹出确认）', value: 'default' },
      { name: 'dontAsk              不询问', value: 'dontAsk' },
      { name: 'plan                 强制进入 plan 模式', value: 'plan' },
    ],
  }]);

  savePermissionMode(permissionMode);
  console.log(chalk.green(`  ✅ 权限模式已设置为: ${permissionMode}（已同步到 [claude] 和 [sdk]）`));
  console.log('');
```

- [ ] **Step 4: 跑 typecheck**

跑：`bun run typecheck`
预期：PASS

- [ ] **Step 5: 跑全部 setup + init-feishu 测试**

跑：`bun test tests/unit/cli/setup.test.ts tests/unit/cli/init-feishu.test.ts`
预期：全部 PASS

- [ ] **Step 6: 手动跑 `setup --skip-feishu`，确认 step 编号和 prompt 正确**

跑：`bun run dev setup --skip-feishu`
预期看到（按顺序）：
1. "── Step 1/3 ── 初始化会话注册表"
2. "── Step 2/3 ── Claude Code 权限模式"
3. 6 个选项的 list prompt
4. 选完回显 "✅ 权限模式已设置为: acceptEdits（已同步到 [claude] 和 [sdk]）"
5. "── Step 3/3 ── 安装 Claude Code 钩子"
6. summary（不显示飞书命令块，因为 feishu.configured = false）

中途想退出看效果：按 `Ctrl+C`（inquirer `list` 不接受 `q` 键；`Esc` 也不退出当前 prompt）。退出不会改写 config.toml，因为 prompt 没选完。

- [ ] **Step 7: 验证 `configPath` 的写入**

跑：`cat ~/.cc-linker/config.toml | grep -A1 -E "^\[(claude|sdk)\]"`
预期：含 `[claude]` + `permission_mode = "acceptEdits"` 紧接其后；`[sdk]` + `permission_mode = "acceptEdits"` 紧接其后

如不想污染真实 config，跑前备份：`cp ~/.cc-linker/config.toml /tmp/cfg.bak`；跑后恢复：`cp /tmp/cfg.bak ~/.cc-linker/config.toml`

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/setup.ts
git commit -m "feat(setup): add Step 2 permission_mode prompt + renumber steps (1→1, 2→3, 3→4)"
```

---

## Task 6: 更新 `printSummary` 的飞书命令清单和菜单推荐

**Files:**
- Modify: `src/cli/commands/setup.ts:407-414`（`printSummary` 里的 `if (feishu.configured)` 块）

- [ ] **Step 1: 替换 summary 块**

`src/cli/commands/setup.ts` 中 `printSummary` 函数里 `if (feishu.configured)` 块（line 407-414）整体替换为：

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

- [ ] **Step 2: 跑 typecheck**

跑：`bun run typecheck`
预期：PASS

- [ ] **Step 3: 手动跑 setup 看 summary 输出（用 `--skip-feishu` 路径不会显示飞书命令块，需用真实路径）**

跑：`bun run dev setup --skip-feishu` 不会显示飞书命令块。验证 summary 改动需要走飞书路径：但在测试环境无法实际发 Feishu 消息捕获 `owner_open_id`。

**验证替代方案：**
- 在 `printSummary` 调用前临时打 console.log 看输出。`setup.ts` 的 `printSummary` 在 line 141 调用。
- 或：直接读代码确认替换的 8 个 console.log 与原 5 个不同（grep 对照即可）。

跑：`grep -A20 "if (feishu.configured)" src/cli/commands/setup.ts | head -25`
预期：看到新的 6 个命令 + `/help` 引导 + 菜单提示

- [ ] **Step 4: 跑全部测试**

跑：`bun test`
预期：全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/setup.ts
git commit -m "feat(setup): refresh summary command list + add custom menu hint"
```

---

## Task 7: 端到端验证

**Files:** 无（纯验证）

- [ ] **Step 1: 跑全量单元测试**

跑：`bun test`
预期：全部 PASS

- [ ] **Step 2: 跑 typecheck**

跑：`bun run typecheck`
预期：PASS

- [ ] **Step 3: 验证 `init-feishu` 子命令没破坏**

跑：`bun run dev init-feishu`
预期：完整的飞书配置向导正常进入。中途按 `Ctrl+C` 退出（不要回车到 Step 1 之前的 daemon 询问部分）。不实际改写 `~/.cc-linker/config.toml`。

- [ ] **Step 4: 验证 `setup --skip-feishu` 路径**

跑：`bun run dev setup --skip-feishu`（走完完整流程或 Ctrl+C 中途退出）
预期看到：
- "── Step 1/3 ── 初始化会话注册表"
- "── Step 2/3 ── Claude Code 权限模式"
- 6 个选项的 list prompt
- 选完 "✅ 权限模式已设置为: X（已同步到 [claude] 和 [sdk]）"
- "── Step 3/3 ── 安装 Claude Code 钩子"
- summary 不含 "飞书端可用命令" 块

- [ ] **Step 5: 验证 `setup --skip-hook` 路径（仍会进入飞书 Step 4，但中途可退出）**

跑：`bun run dev setup --skip-hook`
预期看到：
- "── Step 1/4 ── 初始化会话注册表"
- "── Step 2/4 ── Claude Code 权限模式"
- 选完后跳到 "── Step 4/4 ── 配置飞书 Bot"（注意：跳号是 spec 已记录的预存缺陷，本任务系列不修）
- 飞书路径里按 Ctrl+C 退出

- [ ] **Step 6: 确认 `bot.ts` 的 `helpText` 没被改动**

跑：`git log --oneline src/feishu/bot.ts | head -3`
预期：最近的 commit 不在本任务系列中（`setup` 任务只改 `setup.ts` + `init-feishu.ts` + 两个测试文件）

- [ ] **Step 7: 跑 `setup --skip-feishu` 真实写入后的 `config.toml` 校验**

跑：
```bash
cp ~/.cc-linker/config.toml /tmp/cfg.bak  # 备份
bun run dev setup --skip-feishu  # 跑完整流程（回车走默认 acceptEdits）
grep -A2 -E "^\[(claude|sdk)\]" ~/.cc-linker/config.toml
cp /tmp/cfg.bak ~/.cc-linker/config.toml  # 恢复
```
预期：grep 输出含
```
[claude]
permission_mode = "acceptEdits"

[sdk]
permission_mode = "acceptEdits"
```
且 `[claude]` 紧跟 `[feishu_bot]`（如果有），`[sdk]` 紧跟 `[claude]`。

---

## Self-Review

### Spec 覆盖

| Spec 段落 | 哪个 Task 实现 |
|----------|----------------|
| 1. Step 2 权限模式选择 + step 重排 | Task 5 |
| 2. 写入逻辑 `savePermissionMode` | Task 3（scaffold） + Task 4（实现） |
| 2. `saveConfig` section 顺序调整 | Task 2 |
| 2. `loadExistingConfig` / `saveConfig` 接受可选路径 | Task 1（额外重构，spec 未明确要求但实现所需） |
| 3. Summary 面板更新 | Task 6 |
| 改动文件清单 | Task 1, 2, 3, 4, 5, 6 |
| 测试策略 | Task 2, 4 |
| 手动验证 | Task 5, 7 |
| 风险 1（re-run） | 不需专门任务 —— wanted 行为 |
| 风险 2（[sdk] 消费方） | spec 自包含交代 |
| 风险 3（summary 与 helpText 文案漂移） | spec 自包含交代 |

### Placeholder 扫描

- ✓ 无 "TBD"、"TODO"、"implement later"
- ✓ 所有代码块都是可执行内容
- ✓ 没有 "类似 Task N" 引用

### 类型一致性

- `loadExistingConfig(configPath?: string): Record<string, any>` —— Task 1 改签名，Task 2 测试用 `configPath` 参数，Task 4 `savePermissionMode` 调用时也传 `configPath` ✓
- `saveConfig(config, configPath?)` —— Task 1 改签名，Task 2/4 全部用 `configPath` 参数 ✓
- `savePermissionMode(mode: string, configPath?: string): void` —— Task 3 占位 + Task 4 真实实现，签名一致 ✓
- Task 5 调用 `savePermissionMode(permissionMode)` 不传 configPath，走默认路径（写 `~/.cc-linker/config.toml`）✓

### 已知陷阱（已纳入 plan）

- ✓ bun:test 模块缓存 → 用可选 `configPath` 参数解决（不用 `mock.module`）
- ✓ inquirer `list` 不接受 `q` → 验证步骤用 `Ctrl+C`
- ✓ 飞书 e2e 路径需要真实 bot → 验证只走 `--skip-feishu` / `--skip-hook` 路径
- ✓ `--skip-feishu --skip-hook` 跳号 → spec 已记录，不修
