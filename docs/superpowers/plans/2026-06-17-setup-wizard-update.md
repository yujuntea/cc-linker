# setup 向导更新 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `cc-linker setup` 向导中加入 Claude Code 权限模式选择步骤（同步写 `[claude]` 和 `[sdk]`），并把 summary 面板的飞书命令清单更新为高频 6 个 + `/help` 引导 + 飞书"自定义菜单"推荐。

**Architecture:** TDD 增量重构。先为 `saveConfig` 的 section 顺序加一个直接测试并修代码；再为新加的 `savePermissionMode` 写完整单元测试；最后改 wizard 流程的 step 重排和 summary 文本。Wizard 流程改动（inquirer / chalk 输出）通过手动跑 `bun run dev setup` 验证。

**Tech Stack:** Bun, TypeScript, Commander, inquirer, chalk, @iarna/toml

**Spec:** `docs/superpowers/specs/2026-06-17-setup-wizard-update-design.md`（commit `90239af`）

**Scope:** 4 个文件改动（2 source + 2 test）。无 worktree 需要。

---

## 文件结构

| 文件 | 责任 |
|------|------|
| `src/cli/commands/init-feishu.ts` | `saveConfig` 的 section 顺序列表（line 168）—— 加 `claude`、`sdk` |
| `src/cli/commands/setup.ts` | 新增 `savePermissionMode()` 导出函数；新增 Step 2 权限模式选择；step 编号重排；改 `printSummary` 命令块 |
| `tests/unit/cli/init-feishu.test.ts` | 新增 `saveConfig` section 顺序测试（用 `CC_LINKER_CONFIG_PATH` env var 覆盖路径） |
| `tests/unit/cli/setup.test.ts` | **新建。**测 `savePermissionMode` 的 4 个行为 |

---

## Task 1: 让 `saveConfig` 把 `[claude]` / `[sdk]` 写到固定位置

**Files:**
- Modify: `src/cli/commands/init-feishu.ts:168`
- Modify: `tests/unit/cli/init-feishu.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/cli/init-feishu.test.ts` 的 `describe('saveConfig', ...)` 块（line 22 附近）末尾追加：

```typescript
it('places [claude] and [sdk] right after [feishu_bot] in output order', async () => {
  const fs = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const customDir = fs.mkdtempSync(join(tmpdir(), 'ccl-saveorder-'));
  const customPath = join(customDir, 'config.toml');

  // Inject a custom config path via env var before importing
  const prev = process.env.CC_LINKER_CONFIG_PATH;
  process.env.CC_LINKER_CONFIG_PATH = customPath;

  try {
    // Dynamic import to pick up env var
    const { saveConfig } = await import('../../src/cli/commands/init-feishu');
    saveConfig({
      general: { log_level: 'info' },
      feishu_bot: { app_id: 'x' },
      claude: { permission_mode: 'acceptEdits' },
      sdk: { permission_mode: 'acceptEdits' },
      queue: { max_pending: 100 },
    });
    const raw = fs.readFileSync(customPath, 'utf8');
    const idxFeishu = raw.indexOf('[feishu_bot]');
    const idxClaude = raw.indexOf('[claude]');
    const idxSdk = raw.indexOf('[sdk]');
    const idxQueue = raw.indexOf('[queue]');
    expect(idxFeishu).toBeGreaterThan(-1);
    expect(idxClaude).toBeGreaterThan(idxFeishu);
    expect(idxSdk).toBeGreaterThan(idxClaude);
    expect(idxQueue).toBeGreaterThan(idxSdk);
  } finally {
    if (prev === undefined) delete process.env.CC_LINKER_CONFIG_PATH;
    else process.env.CC_LINKER_CONFIG_PATH = prev;
    fs.rmSync(customDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试，确认它失败**

跑：`bun test tests/unit/cli/init-feishu.test.ts -t "places \[claude\] and \[sdk\] right after"`
预期：FAIL，错误信息指出 `[claude]` / `[sdk]` 出现在 `[queue]` 之后（即被写到"剩余 sections"块底部）。

- [ ] **Step 3: 改 `saveConfig` 的 section 顺序列表**

`src/cli/commands/init-feishu.ts` line 168：

```typescript
// 原:
for (const section of ['general', 'feishu_bot', 'queue', 'runtime', 'security', 'scanner', 'cli_proxy', 'hook']) {
// 改为:
for (const section of ['general', 'feishu_bot', 'claude', 'sdk', 'queue', 'runtime', 'security', 'scanner', 'cli_proxy', 'hook']) {
```

- [ ] **Step 4: 重跑测试，确认它通过**

跑：`bun test tests/unit/cli/init-feishu.test.ts -t "places \[claude\] and \[sdk\] right after"`
预期：PASS

- [ ] **Step 5: 跑全部 init-feishu 测试，确认没破坏其它用例**

跑：`bun test tests/unit/cli/init-feishu.test.ts`
预期：全部 PASS（包括原有的 8 个 `describe` 块）

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/init-feishu.ts tests/unit/cli/init-feishu.test.ts
git commit -m "fix(init-feishu): place [claude]/[sdk] right after [feishu_bot] in saveConfig output"
```

---

## Task 2: 新建 `tests/unit/cli/setup.test.ts` 并加 `savePermissionMode` 的失败测试

**Files:**
- Create: `tests/unit/cli/setup.test.ts`

- [ ] **Step 1: 建测试文件骨架**

创建 `tests/unit/cli/setup.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('setup savePermissionMode', () => {
  let tmpDir: string;
  let prevConfigPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccl-setup-test-'));
    prevConfigPath = process.env.CC_LINKER_CONFIG_PATH;
    process.env.CC_LINKER_CONFIG_PATH = join(tmpDir, 'config.toml');
  });

  afterEach(() => {
    if (prevConfigPath === undefined) delete process.env.CC_LINKER_CONFIG_PATH;
    else process.env.CC_LINKER_CONFIG_PATH = prevConfigPath;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('with empty config', () => {
    it('writes [claude].permission_mode and [sdk].permission_mode', async () => {
      const { savePermissionMode } = await import('../../src/cli/commands/setup');
      savePermissionMode('acceptEdits');
      const raw = readFileSync(join(tmpDir, 'config.toml'), 'utf8');
      expect(raw).toContain('[claude]');
      expect(raw).toContain('[sdk]');
      expect(raw).toMatch(/permission_mode\s*=\s*"acceptEdits"/);
    });
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

跑：`bun test tests/unit/cli/setup.test.ts`
预期：FAIL —— 错误信息指出 `savePermissionMode` is not exported from `setup`（module 不导出该函数）。

- [ ] **Step 3: 临时在 `setup.ts` 加占位实现，先让模块加载通过**

`src/cli/commands/setup.ts` 顶部 import 之后（line 16 之后）追加：

```typescript
export function savePermissionMode(mode: string): void {
  // placeholder — will be implemented in Task 3
  void mode;
}
```

- [ ] **Step 4: 重跑测试，确认空实现下失败模式正确（output 不含 permission_mode）**

跑：`bun test tests/unit/cli/setup.test.ts`
预期：FAIL —— error contains "permission_mode"（即 output 里没有这个字符串，断言失败）

- [ ] **Step 5: Commit 测试文件 + 占位实现**

```bash
git add tests/unit/cli/setup.test.ts src/cli/commands/setup.ts
git commit -m "test(setup): scaffold savePermissionMode test + placeholder impl"
```

---

## Task 3: 实现 `savePermissionMode` 真实逻辑

**Files:**
- Modify: `src/cli/commands/setup.ts`

- [ ] **Step 1: 替换占位实现为真实逻辑**

`src/cli/commands/setup.ts` 中 `savePermissionMode` 替换为：

```typescript
export function savePermissionMode(mode: string): void {
  const existing = loadExistingConfig();
  if (!existing.claude) existing.claude = {};
  existing.claude.permission_mode = mode;
  if (!existing.sdk) existing.sdk = {};
  existing.sdk.permission_mode = mode;
  saveConfig(existing);
}
```

- [ ] **Step 2: 跑 Task 2 写的测试，确认通过**

跑：`bun test tests/unit/cli/setup.test.ts -t "with empty config"`
预期：PASS

- [ ] **Step 3: 在测试文件追加更多用例**

在 `tests/unit/cli/setup.test.ts` 的 `describe('setup savePermissionMode', ...)` 块内、紧跟 `describe('with empty config', ...)` 之后，新增第二个 describe 块：

```typescript
  describe('with existing [claude] and [sdk] sections', () => {
    beforeEach(() => {
      writeFileSync(join(tmpDir, 'config.toml'), `[claude]
permission_mode = "default"
allowed_tools = ["Read"]

[sdk]
enabled = false
claude_executable = "/custom/path/claude"
`);
    });

    it('preserves allowed_tools and does not change sdk.enabled', async () => {
      const { savePermissionMode } = await import('../../src/cli/commands/setup');
      savePermissionMode('bypassPermissions');
      const raw = readFileSync(join(tmpDir, 'config.toml'), 'utf8');
      // [claude].allowed_tools preserved
      expect(raw).toContain('allowed_tools');
      // [claude].permission_mode updated
      expect(raw).toMatch(/\[claude\][\s\S]*permission_mode\s*=\s*"bypassPermissions"/);
      // [sdk].enabled preserved (still false)
      expect(raw).toMatch(/\[sdk\][\s\S]*enabled\s*=\s*false/);
      // [sdk].claude_executable preserved
      expect(raw).toContain('claude_executable');
      // [sdk].permission_mode updated
      expect(raw).toMatch(/\[sdk\][\s\S]*permission_mode\s*=\s*"bypassPermissions"/);
    });

    it('does not touch [sdk].enabled', async () => {
      const { savePermissionMode } = await import('../../src/cli/commands/setup');
      savePermissionMode('acceptEdits');
      const raw = readFileSync(join(tmpDir, 'config.toml'), 'utf8');
      // Should be exactly one occurrence of "enabled" and it should be `false`
      const enabledMatches = raw.match(/enabled\s*=\s*(true|false)/g) ?? [];
      expect(enabledMatches).toEqual(['enabled = false']);
    });
  });

  describe('when config.toml does not exist', () => {
    it('creates the file with the new sections', async () => {
      const { savePermissionMode } = await import('../../src/cli/commands/setup');
      const target = join(tmpDir, 'config.toml');
      expect(existsSync(target)).toBe(false);
      savePermissionMode('plan');
      expect(existsSync(target)).toBe(true);
      const raw = readFileSync(target, 'utf8');
      expect(raw).toContain('[claude]');
      expect(raw).toContain('[sdk]');
      expect(raw).toContain('"plan"');
    });
  });
```

- [ ] **Step 4: 跑全部新测试，确认都通过**

跑：`bun test tests/unit/cli/setup.test.ts`
预期：全部 PASS（4 个用例：empty config、preserves fields、no enabled touch、creates new file）

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/setup.ts tests/unit/cli/setup.test.ts
git commit -m "feat(setup): implement savePermissionMode (sync [claude]+[sdk])"
```

---

## Task 4: 在 setup 向导加 Step 2 权限模式选择 + 重排 step 编号

**Files:**
- Modify: `src/cli/commands/setup.ts` —— 修改 `totalSteps`、重排 step 编号、加新 step 2 流程

- [ ] **Step 1: 改 `totalSteps` 计算**

`src/cli/commands/setup.ts` line 46：

```typescript
// 原:
const totalSteps = opts.skipFeishu ? 2 : 3;
// 改为:
const totalSteps = opts.skipFeishu ? 3 : 4;
```

- [ ] **Step 2: 重排现有 step 编号**

`src/cli/commands/setup.ts` 中三处 step 标题 console.log：

- line 61 附近（registry）：`Step 1/${totalSteps}` → **保持不变**（仍为 Step 1）
- line 75 附近（hook）：`Step 2/${totalSteps}` → `Step 3/${totalSteps}`
- line 98 附近（feishu）：`Step 3/${totalSteps}` → `Step 4/${totalSteps}`

- [ ] **Step 3: 在 registry 之后、hook 之前插入新的 Step 2 流程**

在 `src/cli/commands/setup.ts` 中、`if (!opts.skipHook)` 块（hook 安装）之前，插入以下内容（参考现有 `printPermissionGuide()` 和 `runFeishuWizard()` 里的 inquirer + chalk 风格）：

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

- [ ] **Step 4: 跑 typecheck，确认没类型错误**

跑：`bun run typecheck`
预期：PASS

- [ ] **Step 5: 跑全部 setup 相关测试**

跑：`bun test tests/unit/cli/setup.test.ts tests/unit/cli/init-feishu.test.ts`
预期：全部 PASS

- [ ] **Step 6: 手动跑 setup，确认 step 编号和 prompt 正确**

跑：`bun run dev setup`（在交互中：跳过 feishu 路径，回车走默认 `acceptEdits`，最后 q 退出 inquirer 不进入飞书）
预期看到：
- "── Step 1/4 ── 初始化会话注册表"
- "── Step 2/4 ── Claude Code 权限模式"
- 6 个选项的 list prompt
- 选完回显 "✅ 权限模式已设置为: acceptEdits（已同步到 [claude] 和 [sdk]）"
- "── Step 3/4 ── 安装 Claude Code 钩子"
- 之后如果跳过 feishu 直接进 summary

- [ ] **Step 7: 验证 `~/.cc-linker/config.toml` 写入了正确值**

跑：`cat ~/.cc-linker/config.toml | grep -A2 "permission_mode"`
预期：含 `[claude]` + `permission_mode = "acceptEdits"` + `[sdk]` + `permission_mode = "acceptEdits"`

（如果不想污染真实 config，可以提前备份： `cp ~/.cc-linker/config.toml /tmp/cfg.bak`；跑完恢复： `cp /tmp/cfg.bak ~/.cc-linker/config.toml`）

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/setup.ts
git commit -m "feat(setup): add Step 2 permission_mode prompt + renumber steps (1→1, 2→3, 3→4)"
```

---

## Task 5: 更新 `printSummary` 的飞书命令清单和菜单推荐

**Files:**
- Modify: `src/cli/commands/setup.ts` —— 替换 `printSummary` 里 `if (feishu.configured)` 块

- [ ] **Step 1: 替换 summary 的飞书命令块**

`src/cli/commands/setup.ts` 中 `printSummary` 函数（line 382 附近）里 `if (feishu.configured)` 块（line 407-414 附近）整体替换为：

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

- [ ] **Step 3: 手动跑 setup 看 summary 输**

跑：`bun run dev setup`（走 feishu 路径或跳到 summary 都能看到）
预期看到 summary 末尾：
- 6 个高频命令（`/list`、`/listDir`、`/new`、`/model`、`/stop`、`/agents`）
- "完整命令列表：在飞书给 Bot 发 /help"
- "💡 提示：可在飞书开放平台 → 机器人 → 自定义菜单，把 /list、/new、/agents、/help 绑到菜单上，手机端点选更方便"

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/setup.ts
git commit -m "feat(setup): refresh summary command list + add custom menu hint"
```

---

## Task 6: 端到端验证 + 跑全量测试

**Files:** 无（纯验证）

- [ ] **Step 1: 跑全量单元测试**

跑：`bun test`
预期：全部 PASS（特别注意 init-feishu + setup 两个文件）

- [ ] **Step 2: 跑 typecheck**

跑：`bun run typecheck`
预期：PASS

- [ ] **Step 3: 验证 `init-feishu` 子命令没破坏**

跑：`bun run dev init-feishu`（之前测过的入口），确认行为不变
预期：完整的飞书配置向导正常进入（中途 Ctrl+C 退出即可，不实际改 config）

- [ ] **Step 4: 验证 `setup --skip-feishu` 路径下 step 编号正常**

跑：`bun run dev setup --skip-feishu`
预期看到：
- "── Step 1/3 ── 初始化会话注册表"
- "── Step 2/3 ── Claude Code 权限模式"
- "── Step 3/3 ── 安装 Claude Code 钩子"
- summary 里没有 "飞书端可用命令" 块（因为 feishu.configured = false）

- [ ] **Step 5: 验证完整 setup 流程（含 feishu）step 编号正常**

跑：`bun run dev setup`（走完整路径，捕获 owner_open_id 即可）
预期看到：
- "── Step 1/4 ── 初始化会话注册表"
- "── Step 2/4 ── Claude Code 权限模式"
- "── Step 3/4 ── 安装 Claude Code 钩子"
- "── Step 4/4 ── 配置飞书 Bot"
- summary 含新的 6 个命令 + 菜单提示

- [ ] **Step 6: 确认 `bot.ts` 的 `helpText` 没被改动**

跑：`git log --oneline src/feishu/bot.ts | head -3`
预期：本任务系列没改 bot.ts（只改 setup.ts + init-feishu.ts + 两个测试文件）

- [ ] **Step 7: 如有 lint 工具，跑一次**

跑：项目根目录的 lint 命令（如果有 `bun run lint` 之类）
预期：PASS

---

## Self-Review

### Spec 覆盖

| Spec 段落 | 哪个 Task 实现 |
|----------|----------------|
| 1. Step 2 权限模式选择 + step 重排 | Task 4 |
| 2. 写入逻辑 `savePermissionMode` | Task 2（测试 scaffold） + Task 3（实现） |
| 2. `saveConfig` section 顺序调整 | Task 1 |
| 3. Summary 面板更新 | Task 5 |
| 改动文件清单（setup.ts / init-feishu.ts / 两个测试文件） | Task 1, 2, 3, 4, 5 |
| 测试策略（4 个 savePermissionMode 行为 + 顺序测试 + 不存在文件） | Task 1, 3 |
| 手动验证（setup 默认 / setup bypassPermissions / init-feishu / /help 仍 12 命令） | Task 6 |
| 风险 1（re-run） | 不需要专门任务 —— 这是 wanted 行为 |
| 风险 2（[sdk] 消费方是 proxy/session.ts:749，不是 Agent View） | spec 自包含交代，不影响代码 |
| 风险 3（summary 与 helpText 文案漂移） | spec 自包含交代，不影响代码 |

### Placeholder 扫描

- ✓ 无 "TBD"、"TODO"、"implement later"
- ✓ 所有代码块都是实际可执行内容
- ✓ 没有 "类似 Task N" 的引用（每步都自包含）

### 类型一致性

- `savePermissionMode(mode: string): void` 在 Task 2 定义为占位，Task 3 实现为相同签名，Task 4 调用点为 `savePermissionMode(permissionMode)`（`permissionMode` 是 inquirer 返回的 string，与签名一致）✓
- `loadExistingConfig()` 和 `saveConfig()` 来自 `init-feishu.ts`，所有 Task 引用一致 ✓
- 测试中的 `process.env.CC_LINKER_CONFIG_PATH` 路径覆盖方案在 Task 1 / 2 / 3 一致 ✓
