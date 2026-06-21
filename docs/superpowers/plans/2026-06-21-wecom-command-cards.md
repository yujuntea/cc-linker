# WeCom Command Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 企微智能机器人命令响应加交互式卡片（7 个命令全覆盖），跟飞书侧 1:1 对齐 — 用户点按钮免去再打字

**Architecture:** 4 个独立 ship-ready PR 串行实施。每 PR ship 后立即可部署可真机验收。
- **PR 7.5.1**: 公共框架 — 新建 `card-builders.ts` 6 个 builder + WecomBotConfig 加 `providerManager` 字段 + WecomUserManager 加 `setDefaultProvider`/`clearDefaultProvider` 方法 + 改 handleCommandModel 集成 ProviderManager
- **PR 7.5.2**: `/list` + `/listdir` + `/model` 改造（PR 7.5.2 C1+C3 fix: 改早期 return 块 + 强选 handleCommandListDir 返结构）+ executeCardAction 新增 3 case (select_dir / select_model / clear_model)
- **PR 7.5.3**: `/switch` + `/agents` + `/resume` + `/stop` 附加卡片 + executeCardAction 改 case 'switch' 双语义 + 新增 case 'agents-refresh'
- **PR 7.5.4**: 真机 E2E + 部署 + 截图

**Tech Stack:** Bun + TypeScript + `bun:test` + `@wecom/aibot-node-sdk` 1.0.7 + Zod

**Spec:** `docs/superpowers/specs/2026-06-21-wecom-command-cards-design.md` v1.2 (含 10 处 review 修正)

---

## 文件结构

| 文件 | 改动 | 职责 |
|---|---|---|
| `src/wecom/card-builders.ts`（新建） | PR 7.5.1 | 6 个 command card builder (list/listdir/model/agents-refresh/resume/stop) |
| `tests/unit/wecom/card-builders.test.ts`（新建） | PR 7.5.1 | 6 builder 单测 + sessionUuid 字段命名一致性 |
| `src/wecom/mapping.ts` | PR 7.5.1 | 加 setDefaultProvider + clearDefaultProvider 方法 |
| `tests/unit/wecom/mapping.test.ts` | PR 7.5.1 | 新增方法单测 |
| `src/wecom/bot.ts` | PR 7.5.1 + 7.5.2 + 7.5.3 | WecomBotConfig providerManager 字段 + handleCommand 改造 5 命令 + executeCardAction 新增 3 case |
| `tests/unit/wecom/bot.test.ts` | PR 7.5.2 + 7.5.3 | 7 命令 handleCommand 调用新 builder（mock sender）+ 3 新 case + switch 双语义 |

---

# PR 7.5.1 — 公共框架：6 builder + ProviderManager 集成

**Files:**
- Create: `src/wecom/card-builders.ts`
- Create: `tests/unit/wecom/card-builders.test.ts`
- Modify: `src/wecom/mapping.ts:54-117` (WecomUserManager 类, 在 setPending 后加新方法)
- Modify: `tests/unit/wecom/mapping.test.ts` (加新方法测试)
- Modify: `src/wecom/bot.ts:96-134` (WecomBotConfig + 构造器加 providerManager)
- Modify: `src/wecom/bot.ts:773-779` (handleCommandModel 集成 ProviderManager)

---

### Task 1.1: 写 6 个 builder 失败测试

**Files:**
- Create: `tests/unit/wecom/card-builders.test.ts`

- [ ] **Step 1: 写测试骨架 + 6 builder 测试**

```typescript
// tests/unit/wecom/card-builders.test.ts
import { describe, it, expect } from 'bun:test';
import {
  buildListCard,
  buildDirListCard,
  buildModelCard,
  buildAgentsRefreshCard,
  buildResumeCard,
  buildStopCard,
  type ListCardContext,
  type DirListCardContext,
  type ModelCardContext,
  type AgentsCardContext,
  type ResumeCardContext,
  type StopCardContext,
} from '../../../src/wecom/card-builders';
import type { WecomTemplateCard } from '../../../src/wecom/card';

describe('buildListCard', () => {
  it('builds button_interaction with 2 buttons per entry + action_menu', () => {
    const ctx: ListCardContext = {
      entries: [
        { sessionUuid: 'uuid-1', title: 'Analyze AI coding attribution', messageCount: 768, lastActive: '2026-06-21T13:24:00Z' },
        { sessionUuid: 'uuid-2', title: 'Build GLM coding plan', messageCount: 773, lastActive: '2026-06-21T12:59:00Z' },
      ],
      totalActive: 777,
    };
    const card: WecomTemplateCard = buildListCard(ctx);
    expect(card.card_type).toBe('button_interaction');
    expect(card.button_list.button.length).toBe(4);  // 2 entries × 2 buttons
    // 第 1 条 entry: switch + resume 各 1
    expect(card.button_list.button[0].action_tag).toBe('switch');
    expect((card.button_list.button[0] as any).value.sessionUuid).toBe('uuid-1');
    expect(card.button_list.button[1].action_tag).toBe('resume');
    expect((card.button_list.button[1] as any).value.sessionUuid).toBe('uuid-1');
    // 第 2 条 entry
    expect(card.button_list.button[2].action_tag).toBe('switch');
    expect((card.button_list.button[2] as any).value.sessionUuid).toBe('uuid-2');
    expect(card.button_list.button[3].action_tag).toBe('resume');
    expect((card.button_list.button[3] as any).value.sessionUuid).toBe('uuid-2');
    // 标题 + action_menu
    expect(card.main_title.title).toContain('2/777');
    expect(card.action_menu?.action_list[0].action_tag).toBe('list-refresh');
  });

  it('handles empty entries (0 buttons + 📭 desc)', () => {
    const ctx: ListCardContext = { entries: [], totalActive: 0 };
    const card = buildListCard(ctx);
    expect(card.button_list.button.length).toBe(0);
    expect(card.main_title.title).toContain('0/0');
  });
});

describe('buildDirListCard', () => {
  it('builds button_interaction with parent + dir buttons + value.sessionUuid = path', () => {
    const ctx: DirListCardContext = {
      cwd: '/tmp',
      parent: '/',
      dirs: [
        { name: 'activity-test-project', fullPath: '/tmp/activity-test-project' },
        { name: 'aibot-poc', fullPath: '/tmp/aibot-poc' },
      ],
      hasMore: false,
    };
    const card = buildDirListCard(ctx);
    expect(card.card_type).toBe('button_interaction');
    // 父目录 + 2 子目录 = 3 按钮
    expect(card.button_list.button.length).toBe(3);
    expect(card.button_list.button[0].action_tag).toBe('select_dir');
    expect((card.button_list.button[0] as any).value.sessionUuid).toBe('/');
    expect(card.button_list.button[0].action_title.text).toContain('上级');
    // 子目录
    expect((card.button_list.button[1] as any).value.sessionUuid).toBe('/tmp/activity-test-project');
    expect((card.button_list.button[2] as any).value.sessionUuid).toBe('/tmp/aibot-poc');
  });

  it('handles no parent (root dir) - no parent button', () => {
    const ctx: DirListCardContext = {
      cwd: '/',
      parent: null,
      dirs: [{ name: 'tmp', fullPath: '/tmp' }],
      hasMore: false,
    };
    const card = buildDirListCard(ctx);
    expect(card.button_list.button.length).toBe(1);  // 只有子目录按钮
    expect(card.button_list.button[0].action_tag).toBe('select_dir');
  });

  it('shows hasMore indicator when truncated', () => {
    const ctx: DirListCardContext = { cwd: '/tmp', parent: '/', dirs: [], hasMore: true };
    const card = buildDirListCard(ctx);
    expect(card.main_title.desc).toContain('还有更多');
  });
});

describe('buildModelCard', () => {
  it('builds button_interaction with provider buttons + clear button + value.sessionUuid = alias', () => {
    const ctx: ModelCardContext = {
      providers: [
        { alias: 'opus', label: 'Opus' },
        { alias: 'sonnet', label: 'Sonnet' },
        { alias: 'haiku', label: 'Haiku' },
      ],
      currentAlias: 'sonnet',
    };
    const card = buildModelCard(ctx);
    expect(card.card_type).toBe('button_interaction');
    expect(card.button_list.button.length).toBe(4);  // 3 providers + 1 clear
    // 第 1 个: opus 非当前
    expect(card.button_list.button[0].action_tag).toBe('select_model');
    expect((card.button_list.button[0] as any).value.sessionUuid).toBe('opus');
    expect(card.button_list.button[0].action_title.text).toContain('Opus');
    expect(card.button_list.button[0].action_title.text).not.toContain('当前');
    // 第 2 个: sonnet 当前
    expect(card.button_list.button[1].action_tag).toBe('select_model');
    expect((card.button_list.button[1] as any).value.sessionUuid).toBe('sonnet');
    expect(card.button_list.button[1].action_title.text).toContain('当前');
    // 清除按钮
    const clearBtn = card.button_list.button[3];
    expect(clearBtn.action_tag).toBe('clear_model');
    expect(clearBtn.action_title.text).toContain('清除');
  });
});

describe('buildAgentsRefreshCard', () => {
  it('builds text_notice with agents-refresh action_menu', () => {
    const ctx: AgentsCardContext = { bgCount: 3 };
    const card = buildAgentsRefreshCard(ctx);
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toContain('BG Sessions (3)');
    expect(card.action_menu?.action_list[0].action_tag).toBe('agents-refresh');
  });
});

describe('buildResumeCard', () => {
  it('builds text_notice with switch action_menu (no value → list semantics)', () => {
    const ctx: ResumeCardContext = { sessionUuid: 'uuid-resumed' };
    const card = buildResumeCard(ctx);
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toContain('Session 已 touch');
    expect(card.action_menu?.action_list[0].action_tag).toBe('switch');
    // 重要: switch 按钮 value 必须空 (走"列 sessions"双语义)
    expect((card.action_menu?.action_list[0] as any).value).toBeUndefined();
  });
});

describe('buildStopCard', () => {
  it('builds text_notice with switch action_menu (no value → list semantics)', () => {
    const ctx: StopCardContext = { shortId: 'abc123' };
    const card = buildStopCard(ctx);
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toContain('已停止');
    expect(card.action_menu?.action_list[0].action_tag).toBe('switch');
    expect((card.action_menu?.action_list[0] as any).value).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/card-builders.test.ts`
Expected: FAIL with "Cannot find module '../../../src/wecom/card-builders'"

---

### Task 1.2: 实现 6 个 builder

**Files:**
- Create: `src/wecom/card-builders.ts`

- [ ] **Step 1: 写实现**

```typescript
/**
 * 企微命令响应交互式卡片 builder
 * PR 7.5: 7 个命令响应改造, 跟飞书侧 buildListCard / buildDirListCard / buildModelCard 1:1 对齐
 *
 * @see docs/superpowers/specs/2026-06-21-wecom-command-cards-design.md §4
 */
import type { TemplateCardButton } from '@wecom/aibot-node-sdk';
import { WecomCardBuilder, type WecomTemplateCard } from './card';

// ============ Context 类型 ============

export type ListCardContext = {
  entries: Array<{ sessionUuid: string; title: string; messageCount: number; lastActive: string }>;
  totalActive: number;
};

export type DirListCardContext = {
  cwd: string;
  parent: string | null;
  dirs: Array<{ name: string; fullPath: string }>;
  hasMore: boolean;
};

export type ModelCardContext = {
  // PR 7.5 C2 fix: ProviderConfig 字段是 'name' 不是 'label' (utils/providers.ts:9-14)
  providers: Array<{ alias: string; name: string }>;
  currentAlias?: string;
};

export type AgentsCardContext = { bgCount: number };
export type ResumeCardContext = { sessionUuid: string };
export type StopCardContext = { shortId: string };

// ============ Builder 实现 ============

/**
 * PR 7.5 E2 + C4 fix: aibot SDK TemplateCardButton 类型无 value 字段,
 *   但 WecomCardBuilder.buttonInteraction Zod schema (card.ts:21-25) 强制
 *   {tag, text, type} 字段名. value 字段 SDK 类型无声明, 但运行时
 *   aibot 服务端接受 object value (aibot-client.ts:168 实证).
 *   修法: 构造符合 Zod schema 的对象 + (btn as any).value = ... 注入.
 */
function makeButton(text: string, tag: string, value?: { sessionUuid: string }): any {
  const btn: any = { text, tag };
  if (value) btn.value = value;
  return btn;
}

export function buildListCard(ctx: ListCardContext): WecomTemplateCard {
  // PR 7.5 C3 fix: empty entries 时 WecomCardBuilder.buttonInteraction Zod schema
  //   要求 buttons.min(1) (card.ts:42), 0 按钮会抛错. 改用 textNotice 路径.
  if (ctx.entries.length === 0) {
    return WecomCardBuilder.textNotice({
      title: `📋 我的会话 (0/${ctx.totalActive})`,
      content: '📭 当前无 active session',
      actionMenu: [{ tag: 'list-refresh', text: '🔄 刷新' }],
    });
  }
  const buttons: any[] = [];
  for (const e of ctx.entries) {
    buttons.push(makeButton('🔄 切换', 'switch', { sessionUuid: e.sessionUuid }));
    buttons.push(makeButton('📖 恢复', 'resume', { sessionUuid: e.sessionUuid }));
  }
  const card = WecomCardBuilder.buttonInteraction({
    title: `📋 我的会话 (${ctx.entries.length}/${ctx.totalActive})`,
    description: '💡 点按下方按钮切换或恢复 session',
    buttons,
  });
  // action_menu (PR 7.5 4.1 必有 action_menu, 走 WecomCardBuilder API)
  (card as any).action_menu = {
    desc: WecomCardBuilder.ACTION_MENU_DESC,
    action_list: [{ action_tag: 'list-refresh', action_title: { tag: 'list-refresh', text: '🔄 刷新' } }],
  };
  return card;
}

export function buildDirListCard(ctx: DirListCardContext): WecomTemplateCard {
  const buttons: any[] = [];
  if (ctx.parent) {
    buttons.push(makeButton('⬆️ 上级目录', 'select_dir', { sessionUuid: ctx.parent }));
  }
  for (const d of ctx.dirs) {
    buttons.push(makeButton(`📁 ${d.name}`, 'select_dir', { sessionUuid: d.fullPath }));
  }
  return WecomCardBuilder.buttonInteraction({
    title: `📂 ${ctx.cwd}`,
    description: ctx.hasMore ? '💡 还有更多子目录未显示' : `💡 共 ${ctx.dirs.length} 个子目录`,
    buttons,
  });
}

export function buildModelCard(ctx: ModelCardContext): WecomTemplateCard {
  const buttons: any[] = ctx.providers.map(p => {
    const isCurrent = p.alias === ctx.currentAlias;
    // PR 7.5 C4 fix: WecomCardBuilder.buttonInteraction Zod schema (card.ts:21-25)
    //   强制 {tag, text, type} 字段名, 不是 {key, text, style}.
    //   value 字段 SDK 类型无声明, (btn as any).value = ... 注入 (PR 7.5 E2)
    return {
      tag: 'select_model',
      text: isCurrent ? `🎯 ${p.name} (当前)` : `🎯 ${p.name}`,
      type: isCurrent ? 'default' : 'primary',
      value: { sessionUuid: p.alias },
    };
  });
  buttons.push({
    tag: 'clear_model',
    text: '🧹 清除默认',
    type: 'danger',
  });
  return WecomCardBuilder.buttonInteraction({
    title: '🤖 模型选择',
    description: '💡 点按下方按钮设默认模型',
    buttons,
  });
}

export function buildAgentsRefreshCard(ctx: AgentsCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: `📊 BG Sessions (${ctx.bgCount})`,
    content: '💡 点右上角刷新列表',
    actionMenu: [{ tag: 'agents-refresh', text: '🔄 刷新' }],
  });
}

export function buildResumeCard(ctx: ResumeCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: '✅ Session 已 touch',
    content: `uuid: ${ctx.sessionUuid.slice(0, 8)}...`,
    // PR 7.5 E1: handleCommandResume 不接受 args, 改用 switch 不带 value (列 sessions)
    actionMenu: [{ tag: 'switch', text: '📂 切换别的 session' }],
  });
}

export function buildStopCard(ctx: StopCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: `✅ 已停止: ${ctx.shortId}`,
    content: '💡 点右上角切换 session',
    actionMenu: [{ tag: 'switch', text: '📂 切换 session' }],
  });
}
```

- [ ] **Step 2: 跑测试确认通过**

Run: `bun test tests/unit/wecom/card-builders.test.ts`
Expected: **9 tests pass** (PR 7.5 M1 fix: buildListCard 2 + buildDirListCard 3 + buildModelCard 1 + buildAgentsRefreshCard 1 + buildResumeCard 1 + buildStopCard 1 = 9)

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 4: commit**

```bash
git add src/wecom/card-builders.ts tests/unit/wecom/card-builders.test.ts
git commit -m "feat(wecom): add 6 command-card builders (list/listdir/model/agents/resume/stop)

PR 7.5.1: 企微命令路径交互式卡片公共框架
- buildListCard: 2 按钮/session (switch/resume 带 value.sessionUuid) + action_menu 刷新
- buildDirListCard: 父目录 + 每子目录 1 按钮 (select_dir value.sessionUuid=path)
- buildModelCard: 每 provider 1 按钮 (select_model) + 1 清除按钮 (clear_model)
- buildAgentsRefreshCard: text_notice + agents-refresh action_menu
- buildResumeCard: text_notice + switch action_menu (no value → list semantics, PR 7.5 E1)
- buildStopCard: text_notice + switch action_menu (no value)

8 单测覆盖: 字段正确性 + sessionUuid 命名一致性 + value 注入 (PR 7.5 E2)
- value 字段 SDK 类型无声明但运行时工作 (aibot-client.ts:168 实证)"
```

---

### Task 1.3: WecomUserManager 加 setDefaultProvider / clearDefaultProvider

**Files:**
- Modify: `src/wecom/mapping.ts:54-117` (WecomUserManager 类)
- Modify: `tests/unit/wecom/mapping.test.ts`

- [ ] **Step 1: 写失败测试**

打开 `tests/unit/wecom/mapping.test.ts`，在末尾追加：

```typescript
describe('PR 7.5.1: defaultProvider methods', () => {
  it('setDefaultProvider writes entry.defaultProvider', async () => {
    const { WecomUserManager } = await import('../../../src/wecom/mapping');
    const fs = await import('fs/promises');
    const path = await import('path');
    const tmpFile = path.join('/tmp', `test-mapping-pr751-${Date.now()}.json`);
    const mgr = new WecomUserManager(tmpFile);
    await mgr.setPending('user-test-1', { cwd: '/tmp' });
    await mgr.setDefaultProvider('user-test-1', 'opus');
    const entry = await mgr.getEntry('user-test-1');
    expect(entry?.defaultProvider).toBe('opus');
    await fs.unlink(tmpFile);
  });

  it('clearDefaultProvider removes defaultProvider field', async () => {
    const { WecomUserManager } = await import('../../../src/wecom/mapping');
    const fs = await import('fs/promises');
    const path = await import('path');
    const tmpFile = path.join('/tmp', `test-mapping-pr751-clr-${Date.now()}.json`);
    const mgr = new WecomUserManager(tmpFile);
    await mgr.setPending('user-test-1', { cwd: '/tmp' });
    await mgr.setDefaultProvider('user-test-1', 'sonnet');
    await mgr.clearDefaultProvider('user-test-1');
    const entry = await mgr.getEntry('user-test-1');
    expect(entry?.defaultProvider).toBeUndefined();
    await fs.unlink(tmpFile);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/mapping.test.ts -t "PR 7.5.1"`
Expected: FAIL with "mgr.setDefaultProvider is not a function"

- [ ] **Step 3: 实现 2 个新方法**

打开 `src/wecom/mapping.ts`，在 `async setPending(...)` 方法 (line 54-69) **之后** 加：

```typescript
  /**
   * PR 7.5.1: 写 entry.defaultProvider (user-level 配置, 跨 session 保留)
   * 平台无关 PlatformMappingEntry.defaultProvider 字段已存在 (platform/mapping-types.ts:33)
   *   飞书侧 doSelectModel 走类似路径. 企微侧 PR 7.5.1 新增.
   */
  async setDefaultProvider(externalUserId: string, alias: string): Promise<void> {
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[externalUserId];
      if (!current) {
        // 防御: 用户无 entry, 先创建 pending 占位
        mapping.entries[externalUserId] = {
          type: 'pending_new_session',
          sessionUuid: null,
          createdAt: new Date().toISOString(),
          casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          defaultProvider: alias,
        };
      } else {
        mapping.entries[externalUserId] = {
          ...current,
          defaultProvider: alias,
        };
      }
      mapping.version++;
      this.saveMapping(mapping);
    });
  }

  /**
   * PR 7.5.1: 清除 entry.defaultProvider (跟飞书 doClearModel 行为对齐)
   */
  async clearDefaultProvider(externalUserId: string): Promise<void> {
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[externalUserId];
      if (!current) return;
      const { defaultProvider, ...rest } = current;
      mapping.entries[externalUserId] = rest;
      mapping.version++;
      this.saveMapping(mapping);
    });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/mapping.test.ts`
Expected: 全部 pass (2 新增 + 旧测试)

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 6: commit**

```bash
git add src/wecom/mapping.ts tests/unit/wecom/mapping.test.ts
git commit -m "feat(wecom): WecomUserManager setDefaultProvider + clearDefaultProvider

PR 7.5.1: 给 WecomUserManager 加 2 个方法支持 /model 命令持久化 defaultProvider
- PlatformMappingEntry.defaultProvider 字段已存在 (platform/mapping-types.ts:33)
  飞书侧 doSelectModel 走类似路径. 企微侧 PR 7.5.1 新增.
- setDefaultProvider: 写 entry.defaultProvider = alias, 跨 session 保留
- clearDefaultProvider: 从 entry 删除 defaultProvider 字段 (跟飞书 doClearModel 对齐)
- 防御: 无 entry 时先创建 pending_new_session 占位再设 defaultProvider

2 单测覆盖: set/clear 双向 + 无 entry 兜底"
```

---

### Task 1.4: WecomBotConfig + 构造器加 providerManager + handleCommandModel 集成

**Files:**
- Modify: `src/wecom/bot.ts:96-134` (WecomBotConfig + 构造器)
- Modify: `src/wecom/bot.ts:773-779` (handleCommandModel 实际集成)

- [ ] **Step 1: 写失败测试**

打开 `tests/unit/wecom/bot.test.ts`，找已有 WecomBot 测试段，添加：

```typescript
describe('PR 7.5.1: handleCommandModel 集成 ProviderManager', () => {
  it('alias = "opus" → 调用 setDefaultProvider 写 entry', async () => {
    // 构造 bot + mock providerManager + userManager
    // 调 handleCommandModel(userId, ['opus'])
    // 验证 mock setDefaultProvider 被调 1 次 + alias='opus'
  });

  it('alias = "--clear" → 调用 clearDefaultProvider', async () => {
    // 构造 bot + mock providerManager + userManager
    // 调 handleCommandModel(userId, ['--clear'])
    // 验证 mock clearDefaultProvider 被调 1 次
  });
});
```

实际测试代码要构造 WecomBot（用现有 `new WecomBot({...})` 模式），mock `providerManager` 注入 + `userManager` 方法覆盖。参考 PR 7.3 集成测试段（bot.test.ts:3422-3485）mock 模式。

> **实施注意**：具体测试代码必须参照现有 bot.test.ts:75-87 mockClient 模式 + PR 7.3 makeBotWithMocks 模式（PR 7 spec 已 ship）。实施时必须先读这些测试段并对齐风格，不能凭想象写。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -t "PR 7.5.1"`
Expected: FAIL (handleCommandModel 还没调 setDefaultProvider)

- [ ] **Step 3: WecomBotConfig 加 providerManager 字段**

打开 `src/wecom/bot.ts`，在 WecomBotConfig interface (line 96-134) **registryManager 后**加：

```typescript
  /**
   * PR 7.5.1: ProviderManager 注入 - /model 命令持久化 defaultProvider 用
   * 飞书侧 feishu/bot.ts:34 import ProviderManager from '../utils/providers'
   * 企微侧 PR 7.5.1 镜像实现. 必须实际集成, 不是只注入.
   */
  providerManager?: ProviderManager;
```

在文件顶部 import 段加：

```typescript
import { ProviderManager } from '../utils/providers';
```

- [ ] **Step 4: 构造器注入 providerManager**

在构造器 (line 169-192) **registryManager 注入后**加：

```typescript
    this.providerManager = config.providerManager;
```

并在 class 字段区 (line 153) 加：

```typescript
  /**
   * PR 7.5.1: ProviderManager 注入 - /model 集成用
   * 未注入时 /model 命令仍走 PR 5 stub (返回 '已设置 model: <name>' 占位 markdown)
   */
  private providerManager?: ProviderManager;
```

- [ ] **Step 5: 改 handleCommandModel 集成**

打开 `src/wecom/bot.ts:773-779` 现有方法，**完整替换**：

```typescript
  /**
   * PR 7.5.1 + C1 fix: handleCommandModel 实际集成 ProviderManager
   * 旧版 (PR 5 stub): 只 log + 返回 markdown 占位 "已设置 model: <name>"
   * 新版:
   * - alias = '--clear' → 调 userManager.clearDefaultProvider(userId) + 返回"已清除"
   * - alias = '<name>'  → ProviderManager.resolve(alias) 验证 → userManager.setDefaultProvider → 返回"已设置"
   *   - PR 7.5 C1 fix: ProviderManager.resolve 返回 null (不抛错), 必须显式 null 检查返回错误
   * - 无 alias → handleCommand case 'model' 入口拦截, 走 buildModelCard 路径 (PR 7.5.2)
   */
  private async handleCommandModel(userId: string, args: string[]): Promise<string> {
    if (args.length === 0 || !args[0]) {
      // PR 7.5.2: handleCommand case 'model' 入口拦截, 这里只兜底
      return '❌ 用法: /model <model-alias> (例如: /model sonnet)';
    }
    const alias = args[0];
    if (alias === '--clear') {
      await this.userManager.clearDefaultProvider(userId);
      return '✅ 已清除默认模型';
    }
    // PR 7.5 C1 fix: resolve 返回 null (utils/providers.ts:38-49), 不抛错
    if (this.providerManager && !this.providerManager.resolve(alias)) {
      return `❌ 未知 model alias: ${alias}`;
    }
    await this.userManager.setDefaultProvider(userId, alias);
    return `✅ 默认模型已设置为 ${alias}`;
  }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bot.test.ts -t "PR 7.5.1"`
Expected: 全部新测试 pass

- [ ] **Step 7: 跑全套 typecheck + 全套测试**

Run: `bun run typecheck && bun test`
Expected: 0 errors + 1289+10+4+2+2 = 1307+ tests pass

- [ ] **Step 8: commit**

```bash
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): WecomBotConfig + handleCommandModel 集成 ProviderManager

PR 7.5.1: 改造 handleCommandModel 实际写 user-mapping entry.defaultProvider
- WecomBotConfig 新增 providerManager?: ProviderManager 字段
- 构造器注入 this.providerManager = config.providerManager
- handleCommandModel 改造:
  - alias = '--clear' → userManager.clearDefaultProvider + 返回'已清除'
  - alias = '<name>'  → userManager.setDefaultProvider + 返回'已设置'
- PR 7.5 C1 fix: alias 验证 ProviderManager.resolve(alias) 返回 null (utils/providers.ts:38-49)
  时显式返回错误 '❌ 未知 model alias: <alias>', 不依赖 catch
- 无 alias → 兜底'用法' markdown (PR 7.5.2 handleCommand 入口拦截, 走 buildModelCard)

2 单测覆盖: set + clear 双向 + alias 验证 null 路径, mock providerManager + userManager"
```

---

# PR 7.5.2 — /list + /listdir 改造 + executeCardAction 3 新 case

**Files:**
- Modify: `src/wecom/bot.ts:402-461` (handleCommand case 'list' / 'listdir' 改造)
- Modify: `src/wecom/bot.ts:547-588` (handleCommandListCard 拆分 — Task 2.0)
- Modify: `src/wecom/bot.ts:803-851` (handleCommandListDir 拆分 — Task 2.0)
- Modify: `src/wecom/bot.ts:698-728` (handleCommandAgents 拆分 — Task 2.0)
- Modify: `src/wecom/bot.ts:1262-1345` (executeCardAction switch 加 3 case)

---

### Task 2.0: 改造 handleCommandListCard / handleCommandListDir / handleCommandAgents 返回结构 (I6 + M7 fix)

**Files:**
- Modify: `src/wecom/bot.ts:547-588` (handleCommandListCard) — 拆分 _Internal 返回结构
- Modify: `src/wecom/bot.ts:803-851` (handleCommandListDir) — 拆分 _Internal 返回结构
- Modify: `src/wecom/bot.ts:698-728` (handleCommandAgents) — 拆分 _Internal 返回结构

- [ ] **Step 1: handleCommandListCard 拆分 (PR 7.5.2 M7 fix)**

```typescript
// M7 fix: bot.ts:409-412 已有 'list' 命令提前拦截走 handleCommandListCard,
//   改 handleCommandListCard (不是 case 'list' switch)
// 改造签名: 返回 ListCardData 结构 (handleCommand case 'list' 拆 .markdown, 卡片路径用 .entries)

type ListCardData = {
  markdown: string;  // 现有 markdown 渲染 (handleClaimed 外层 sendMessage 仍要)
  entries: Array<{ sessionUuid: string; title: string; messageCount: number; lastActive: string }>;
  totalActive: number;
};

// handleCommandListCard 现有签名: private handleCommandListCard(msg: SpoolMessage): Promise<void>
// 改造为: 返回 ListCardData (调用方 handleCommand case 'list' 处理返回的 string 是从 .markdown 拿)

private async handleCommandListCard(msg: SpoolMessage): Promise<ListCardData> {
  const internal = await this._handleCommandListCardInternal(msg);
  return { ...internal, markdown: this._renderListMarkdown(internal) };
}

private async _handleCommandListCardInternal(msg: SpoolMessage): Promise<Omit<ListCardData, 'markdown'>> {
  if (!this.registryManager) {
    return { entries: [], totalActive: 0 };
  }
  const allActive = this.registryManager.sessions;
  const activeEntries = Object.entries(allActive)
    .filter(([_, s]) => s.status === 'active')
    .sort(([_, a], [__, b]) => (b.last_active ?? '').localeCompare(a.last_active ?? ''))
    .slice(0, 10)
    .map(([sessionUuid, s]) => ({
      sessionUuid,
      title: s.title ?? '(无标题)',
      messageCount: s.message_count ?? 0,
      lastActive: s.last_active ?? '',
    }));
  const totalActive = Object.values(allActive).filter(s => s.status === 'active').length;
  return { entries: activeEntries, totalActive };
}

private _renderListMarkdown(data: Omit<ListCardData, 'markdown'>): string {
  // 提取原 handleCommandListCard markdown 渲染 (bot.ts:547-588)
  // ...
}
```

**关键调用方更新**: `handleCommand case 'list':` (bot.ts:414-419 提前拦截) — 当前直接 `await this.handleCommandListCard(msg)`, 改造后必须 `const data = await this.handleCommandListCard(msg); responseText = data.markdown;`, 卡片路径从 `data.entries / data.totalActive` 喂 `buildListCard`.

- [ ] **Step 2: handleCommandListDir 拆分 (PR 7.5.2 C3 + I6 fix)**

**关键修正**: v1.1 计划保持 `handleCommandListDir` 返回 string + 让 case 'listdir' 反向解析 string — 这是 dead code 路径。v1.2 强选 (a) 方案 — handleCommandListDir **改返 DirListData 结构**, 同步改 PR 7.3 ship 的 `renderListDir` 拆 `.markdown`.

```typescript
// PR 7.5.2 C3 fix: handleCommandListDir 改返 DirListData 结构 (string → DirListData)
type DirListData = {
  markdown: string;  // 现有 markdown 渲染 (handleClaimed 外层 sendMessage / renderListDir 用)
  cwd: string;
  parent: string | null;
  dirs: Array<{ name: string; fullPath: string }>;
  hasMore: boolean;
};

private async handleCommandListDir(userId: string): Promise<DirListData> {
  // 注意: 返回类型变了, PR 7.3 renderListDir + 现有 case 'listdir' 调用方需同步改
  const internal = await this._handleCommandListDirInternal(userId);
  return { ...internal, markdown: this._renderDirListMarkdown(internal) };
}

private async _handleCommandListDirInternal(userId: string): Promise<Omit<DirListData, 'markdown'>> {
  // 提取原 handleCommandListDir 的 readdirSync + existsSync 逻辑 (bot.ts:803-851)
  // 返回结构: { cwd, parent, dirs, hasMore }
  // ...
}

private _renderDirListMarkdown(data: Omit<DirListData, 'markdown'>): string {
  // 提取原 markdown 渲染
  // ...
}
```

**同步改 PR 7.3 ship 的 renderListDir** (bot.ts:847-853) — 拆 `.markdown`:

```typescript
  private async renderListDir(userId: string): Promise<void> {
    // PR 7.5.2 C3 fix: handleCommandListDir 改返结构后, 这里取 .markdown
    const data = await this.handleCommandListDir(userId);
    await this.client.sdk.sendMessage(userId, {
      msgtype: 'markdown',
      markdown: { content: data.markdown },
    });
  }
```

> **C3 实施影响 3 处同步改**:
> 1. `handleCommandListDir` 签名: `Promise<string>` → `Promise<DirListData>`
> 2. `renderListDir` (bot.ts:847-853) 拆 `.markdown`
> 3. handleCommand case 'listdir' (Task 2.2 Step 2) 拆 `.markdown` + 用结构喂 builder
> 三处必须在同一 PR (PR 7.5.2) 一起改, 避免编译失败.
```

- [ ] **Step 3: handleCommandAgents 拆分 (PR 7.5.2 I4 fix)**

```typescript
type AgentsData = {
  markdown: string;
  bgCount: number;
};

private async handleCommandAgents(userId: string, args: string[]): Promise<AgentsData> {
  const internal = await this._handleCommandAgentsInternal(userId);
  return { ...internal, markdown: this._renderAgentsMarkdown(internal) };
}

private async _handleCommandAgentsInternal(userId: string): Promise<Omit<AgentsData, 'markdown'>> {
  // 提取原 handleCommandAgents 的 readdirSync + state.json 解析逻辑 (bot.ts:698-728)
  // 返回 { bgCount: number } (内部统计数量)
}

private _renderAgentsMarkdown(data: Omit<AgentsData, 'markdown'>): string {
  // 提取原 markdown 渲染
}
```

**关键调用方更新**: `handleCommand case 'agents':` — 当前 `responseText = await this.handleCommandAgents(...)`, 改造后 `const data = await this.handleCommandAgents(...); responseText = data.markdown;`, 卡片路径从 `data.bgCount` 喂 `buildAgentsRefreshCard`.

- [ ] **Step 4: 跑测试确认 0 regression**

Run: `bun test tests/unit/wecom/bot.test.ts`
Expected: 1289 旧测试全部 pass (PR 7 已 ship 不会 break)

- [ ] **Step 5: commit**

```bash
git add src/wecom/bot.ts
git commit -m "refactor(wecom): handleCommandListCard/ListDir/Agents 拆返回结构

PR 7.5.2 I6 + M7 fix: 3 个 handleCommand 方法拆 _Internal 返回结构
+ _renderXxxMarkdown 渲染字符串. 准备 PR 7.5.2 command card 化:
- handleCommandListCard 改返 ListCardData {markdown, entries, totalActive}
  (M7 fix: 改 handleCommandListCard 不是 case 'list' switch,
   因为 bot.ts:409-412 提前拦截)
- handleCommandListDir 拆 _handleCommandListDirInternal + _renderDirListMarkdown
- handleCommandAgents 拆 _handleCommandAgentsInternal + _renderAgentsMarkdown
  (I4 fix: bgCount 从字符串解析 hack 改成结构返回)
- 保持调用方 0 regression (handleCommand case 仍可用 .markdown 字符串)

后续 PR 7.5.2 Task 2.2 用这些结构直接喂 buildListCard/buildDirListCard/buildAgentsRefreshCard"
```

---

### Task 2.1: 写失败测试

**Files:**
- Modify: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 加测试**

```typescript
describe('PR 7.5.2: /list + /listdir 改造', () => {
  it("/list → sender.send 收到 card with button_list.button.length = 20", async () => {
    // 构造 WecomBot + mock 10 sessions (registryManager.sessions 填 10 条)
    // 触发 /list 命令响应
    // 验证 sender.send 被调 1 次 + template_card.button_list.button.length = 20
  });

  it("/listdir /tmp → sender.send 收到 card with dir buttons", async () => {
    // 构造 WecomBot + cwd=/tmp + mock 子目录
    // 触发 /listdir 命令响应
    // 验证 sender.send 被调 1 次 + 按钮 key=select_dir + value.sessionUuid=path
  });

  it('case select_dir: 路径存在 → 调 handleCommandNew(userId, [path])', async () => {
    // 触发 template_card_event event.actionTag='select_dir' + actionValue.sessionUuid='/tmp'
    // 验证 handleCommandNew 被调 1 次 + args = ['/tmp']
  });

  it('case select_dir: 路径不存在 → sendMessage 提示错误 (不调 handleCommandNew)', async () => {
    // 触发 event.actionTag='select_dir' + actionValue.sessionUuid='/nonexistent'
    // 验证 sendMessage 被调 + 内容含'路径不存在'
    // 验证 handleCommandNew NOT called
  });

  it('case select_model: 调 handleCommandModel + setDefaultProvider', async () => {
    // 触发 event.actionTag='select_model' + actionValue.sessionUuid='opus'
    // 验证 handleCommandModel(userId, ['opus']) 被调
  });

  it('case clear_model: 调 handleCommandModel + clearDefaultProvider', async () => {
    // 触发 event.actionTag='clear_model'
    // 验证 handleCommandModel(userId, ['--clear']) 被调
  });
});
```

> **实施注意**：参照现有 bot.test.ts mock 模式（PR 7.3 makeBotWithMocks）。具体 mock userManager.setDefaultProvider / clearDefaultProvider / handleCommandNew / handleCommandModel 的 spy 实现。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -t "PR 7.5.2"`
Expected: FAIL (case 'select_dir' 等还未实现)

---

### Task 2.2: 改造 handleCommand case 'list' / 'listdir' + 新增 3 case

**Files:**
- Modify: `src/wecom/bot.ts`

- [ ] **Step 1: 改造 handleCommand case 'list' (PR 7.5.2 C1 fix)**

**关键**: `case 'list':` (bot.ts:420-423) 是 **unreachable code** — 上面 `if (parsed.cmd === 'list')` (bot.ts:409-412) 早期 return 已拦截。**改早期 return 块，不是 unreachable case**:

打开 `src/wecom/bot.ts`，找到现有早期 return 块 (lines 409-412)，**替换为**：

```typescript
    if (parsed.cmd === 'list') {
      // PR 7.5.2 C1 fix: 推 buildListCard 卡片代替 markdown 列表 (PR 6.11 改造路径)
      //   Task 2.0 拆分后 handleCommandListCard 改返 ListCardData 结构
      const data = await this.handleCommandListCard(msg);
      // 空 entries 已经在 Task 2.0 内部改 textNotice 路径, 这里无脑推卡
      const card = buildListCard(data);
      await this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card });
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;  // 保持早期 return, 跳外层 sendMessage 路径 (PR 6.11 既有行为)
    }
```

**附带改动**: 删 unreachable `case 'list':` (lines 420-423), 避免 subagent 跟着 plan 改错位置。

> **C1 修法依据**: bot.ts:409-412 早期 return 是真正改造点; line 420-423 case 'list' 是 PR 6.9 引入的 unreachable 占位 (注释明确说 "PR 6.9: unreachable — 上面 if (parsed.cmd === 'list') 已拦截走 handleCommandListCard"). PR 7.5.2 必须删掉这个 unreachable 块, 防止后续误改.
```

> **实施注意**：变量 `s.title` / `s.message_count` / `s.last_active` 字段名以现有 `registryManager.sessions` 类型为准，实施时验证。

- [ ] **Step 2: 改造 handleCommand case 'listdir'**

找到现有 `case 'listdir':` (line 454 附近)，**替换为**：

```typescript
        case 'listdir': {
          // PR 7.5.2 C3 fix: handleCommandListDir 已改返 DirListData 结构 (Task 2.0 Step 2)
          const data = await this.handleCommandListDir(msg.userId);
          if (data.markdown.startsWith('❌')) {
            // 错误路径: 推 markdown 错误提示 (保持 PR 6.13 行为, 不发卡片)
            await this.client.sdk.sendMessage(resolveReceiveId(msg), {
              msgtype: 'markdown',
              markdown: { content: data.markdown },
            });
          } else {
            // 正常路径: 推 buildDirListCard 卡片 (从结构直接喂 builder, 不反向解析 markdown)
            const card = buildDirListCard({
              cwd: data.cwd,
              parent: data.parent,
              dirs: data.dirs,
              hasMore: data.hasMore,
            });
            await this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card });
          }
          this.spoolQueue.markDone(msg.messageId, msg.serialKey);
          break;
        }
```

- [ ] **Step 3: 改造 handleCommand case 'model' (无 alias 走 builder)**

找到现有 `case 'model':` (line 447 附近)，**替换为**：

```typescript
        case 'model': {
          if (!this.providerManager) {
            // PR 7.5.2: providerManager 未注入, 走兜底 markdown 提示用法
            responseText = '❌ 用法: /model <model-alias> (providerManager 未注入)';
            break;
          }
          if (parsed.args.length === 0 || !parsed.args[0]) {
            // PR 7.5.2 F2 修正: 无 alias 走 builder 路径, 不调 handleCommandModel
            const currentEntry = this.userManager.getEntry(msg.userId);
            const currentAlias = currentEntry?.type === 'session'
              ? (currentEntry as any).defaultProvider
              : undefined;
            const providers = this.providerManager.list().map(p => ({ alias: p.alias, label: p.label }));
            const card = buildModelCard({ providers, currentAlias });
            await this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card });
            this.spoolQueue.markDone(msg.messageId, msg.serialKey);
            return;  // 不走外层 sendMessage (return 出 handleClaimed)
          }
          // 有 alias, 走 handleCommandModel (PR 7.5.1 实现, 实际写 user-mapping)
          responseText = await this.handleCommandModel(msg.userId, parsed.args);
          break;
        }
```

> ⚠️ `return` 出 handleCommand 走 handleClaimed 末尾 markDone 路径；`break` 走外层 sendMessage 路径。**两种退出方式不能混用**：用 `return` 时 markDone 必须在这里调，用 `break` 时 markDone 走外层。实施时仔细核对。

- [ ] **Step 4: 新增 3 case**

打开 `src/wecom/bot.ts:1262` executeCardAction switch，找到现有 `case 'listdir':` (line 1291)，**在其上方**加：

```typescript
      case 'select_dir': {
        // PR 7.5 E8: handleCommandNew 没 existsSync 校验, case 内自己校验
        const path = event.actionValue?.sessionUuid;
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
        // PR 7.5.1: 实际写 user-mapping entry.defaultProvider
        const alias = event.actionValue?.sessionUuid;
        if (alias) {
          await this.handleCommandModel(event.externalUserId, [alias]);
        }
        break;
      }

      case 'clear_model': {
        // PR 7.5.1: 清除 user-mapping defaultProvider
        await this.handleCommandModel(event.externalUserId, ['--clear']);
        break;
      }
```

并在 import 段加：

```typescript
import { buildListCard, buildDirListCard, buildModelCard } from './card-builders';
import { WecomCompleteCardSender } from './complete-card';
```

并在 class 字段区 (line 153 附近) 加：

```typescript
  /**
   * PR 7.5: 注入 WecomCompleteCardSender (PR 7 已 ship, 提为 WecomBotConfig 可选字段)
   * handleCommand case 'list' / 'listdir' / 'model' 走卡片路径用
   */
  private wecomCompleteCardSender?: WecomCompleteCardSender;
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bot.test.ts -t "PR 7.5.2"`
Expected: 6 新测试 pass

- [ ] **Step 6: 跑全套测试**

Run: `bun test`
Expected: 1289 + 8 (PR 7.5.1) + 6 (PR 7.5.2) = 1303+ tests pass

- [ ] **Step 7: typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 8: commit**

```bash
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): /list + /listdir + /model 卡片化 + 3 new case

PR 7.5.2: 改造 3 命令响应 + 新增 executeCardAction 3 case
- handleCommand case 'list' 替换模式: 推 buildListCard (10 sessions × 2 buttons = 20)
- handleCommand case 'listdir' 替换模式: 推 buildDirListCard (父+子目录)
- handleCommand case 'model' F2 修正: 无 alias 走 builder 路径 (不调 handleCommandModel),
  实际从 handleCommandListDir 拆 _handleCommandListDirInternal 返回 DirListResult
  + _renderDirListMarkdown 渲染 markdown 字符串
- executeCardAction 新增 3 case:
  - case 'select_dir' (E8 校验 + 调 handleCommandNew)
  - case 'select_model' (调 handleCommandModel 写 defaultProvider)
  - case 'clear_model' (调 handleCommandModel ['--clear'])

6 单测覆盖: /list / /listdir / /model 卡片路径 + 3 case 双语义"
```

---

# PR 7.5.3 — /model + /switch + /agents + /resume + /stop 附加卡

**Files:**
- Modify: `src/wecom/bot.ts:402-461` (handleCommand case 'switch' / 'agents' / 'resume' / 'stop')
- Modify: `src/wecom/bot.ts:1262-1345` (executeCardAction 新增 case 'agents-refresh' + 改 case 'switch' 双语义)

---

### Task 3.1: 写失败测试

**Files:**
- Modify: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 加测试**

```typescript
describe('PR 7.5.3: /switch + /resume + /stop + /agents 附加卡 + case agents-refresh + switch 双语义', () => {
  it('/switch <uuid> → responseText + sender.send 收到 PR 7 完成卡', async () => {
    // 触发 /switch <uuid>
    // 验证 responseText = "已切换 session: <uuid>" (走 handleCommandSwitch)
    // 验证 sender.send 被调 1 次 + 卡片主标题含 "已切换"
  });

  it('/resume <uuid> → responseText + sender.send 收到 buildResumeCard', async () => {
    // 触发 /resume <uuid>
    // 验证 responseText 来自 handleCommandResume
    // 验证 sender.send 被调 + buildResumeCard 主标题含 "Session 已 touch"
  });

  it('/stop <short> → responseText + sender.send 收到 buildStopCard', async () => {
    // 触发 /stop <short>
    // 验证 responseText 来自 handleCommandStop
    // 验证 sender.send 被调 + buildStopCard 主标题含 "已停止"
  });

  it('/agents → responseText + sender.send 收到 buildAgentsRefreshCard', async () => {
    // 触发 /agents
    // 验证 responseText 来自 handleCommandAgents
    // 验证 sender.send 被调 + buildAgentsRefreshCard 主标题含 "BG Sessions"
  });

  it("case 'agents-refresh' → 调 handleCommandAgents 重新执行", async () => {
    // 触发 template_card_event event.actionTag='agents-refresh'
    // 验证 handleCommandAgents(userId, []) 被调 1 次
  });

  it("case 'switch' 双语义: 有 value.sessionUuid → handleCommandSwitch([uuid])", async () => {
    // 触发 event.actionTag='switch' + actionValue.sessionUuid='uuid-1'
    // 验证 handleCommandSwitch(userId, ['uuid-1']) 被调 1 次
    // 验证 renderActiveSessionsList NOT called (PR 7 路径)
  });

  it("case 'switch' 双语义: 无 value → renderActiveSessionsList (PR 7 完成卡路径)", async () => {
    // 触发 event.actionTag='switch' + actionValue 无 sessionUuid
    // 验证 handleCommandSwitch NOT called
    // 验证 renderActiveSessionsList 被调 1 次
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -t "PR 7.5.3"`
Expected: FAIL

---

### Task 3.2: 改造 handleCommand 4 命令 + 新增/改 executeCardAction case

**Files:**
- Modify: `src/wecom/bot.ts`

- [ ] **Step 1: import 新 builder**

打开 `src/wecom/bot.ts` import 段，加：

```typescript
import { buildListCard, buildDirListCard, buildModelCard, buildAgentsRefreshCard, buildResumeCard, buildStopCard } from './card-builders';
```

- [ ] **Step 2: 改造 handleCommand case 'switch'**

找到现有 `case 'switch':` (line 432 附近)，**替换为**：

```typescript
        case 'switch':
          responseText = await this.handleCommandSwitch(msg.userId, parsed.args);
          // PR 7.5.3 + I3 fix: 附加 PR 7 完成卡 (从 registryManager.sessions[uuid]?.title 拿真实 title,
          //   fallback 用 uuid.slice(0, 18). 不用 uuid 直接当 title 否则主标题'已切换: abc123...' 丑陋)
          if (responseText.startsWith('✅') && parsed.args.length > 0) {
            const targetUuid = parsed.args[0];
            const sessionEntry = this.registryManager?.sessions?.[targetUuid];
            const sessionTitle = sessionEntry?.title ?? targetUuid.slice(0, 18);
            const card = buildCompleteCard({
              userId: msg.userId,
              sessionTitle,
              sessionUuid: targetUuid,
              cwd: this.userManager.getEntry(msg.userId)?.cwd,
            });
            // 异步发卡片, 不阻塞 responseText 推回
            this.wecomCompleteCardSender?.send({ userId: msg.userId, template_card: card })
              .catch(err => logger.warn(`[wecom-bot] complete card after switch failed: ${err}`));
          }
          break;
```

> **PR 7.5.3 review fix**: sessionTitle 实际需要从 registry 拿 (`this.registryManager?.sessions[uuid]?.title`), 实施时按 registry 数据填充真实 title。

- [ ] **Step 3: 改造 handleCommand case 'resume'**

找到现有 `case 'resume':` (line 435 附近)，**替换为**：

```typescript
        case 'resume':
          responseText = await this.handleCommandResume(msg.userId, parsed.args);
          // PR 7.5.3: 附加 buildResumeCard
          {
            const entry = this.userManager.getEntry(msg.userId);
            const card = buildResumeCard({ sessionUuid: entry?.sessionUuid ?? '' });
            this.wecomCompleteCardSender?.send({ userId: msg.userId, template_card: card })
              .catch(err => logger.warn(`[wecom-bot] complete card after resume failed: ${err}`));
          }
          break;
```

- [ ] **Step 4: 改造 handleCommand case 'stop'**

找到现有 `case 'stop':` (line 438 附近)，**替换为**：

```typescript
        case 'stop':
          responseText = await this.handleCommandStop(msg.userId, parsed.args);
          // PR 7.5.3: 附加 buildStopCard
          if (parsed.args.length > 0) {
            const card = buildStopCard({ shortId: parsed.args[0] });
            this.wecomCompleteCardSender?.send({ userId: msg.userId, template_card: card })
              .catch(err => logger.warn(`[wecom-bot] complete card after stop failed: ${err}`));
          }
          break;
```

- [ ] **Step 5: 改造 handleCommand case 'agents'**

找到现有 `case 'agents':` (line 435 附近)，**替换为**：

```typescript
        case 'agents':
          // PR 7.5.3 + I4 fix: handleCommandAgents 改造返回 {markdown, bgCount} 结构,
          //   避免字符串解析 hack. _handleCommandAgentsInternal 抽 readdirSync,
          //   _renderAgentsMarkdown 拼 markdown.
          const agentsResult = await this.handleCommandAgents(msg.userId, parsed.args);
          responseText = agentsResult.markdown;
          {
            const card = buildAgentsRefreshCard({ bgCount: agentsResult.bgCount });
            this.wecomCompleteCardSender?.send({ userId: msg.userId, template_card: card })
              .catch(err => logger.warn(`[wecom-bot] complete card after agents failed: ${err}`));
          }
          break;
```

> **PR 7.5.3 review fix**: bgCount 解析简化用行数过滤, 实施时可优化 (从 handleCommandAgents 返回结构而非字符串解析)。

- [ ] **Step 6: executeCardAction 新增 case 'agents-refresh' + 改 case 'switch'**

打开 `src/wecom/bot.ts:1291` 附近，在 `case 'switch':` **原代码**（PR 7.3 已 ship）替换为：

```typescript
      case 'switch': {
        // PR 7.5.3 双语义: 有 value.sessionUuid → 切具体 session; 无 → 列 sessions (PR 7 行为)
        const targetUuid = event.actionValue?.sessionUuid;
        if (targetUuid) {
          await this.handleCommandSwitch(event.externalUserId, [targetUuid]);
        } else {
          await this.renderActiveSessionsList(event.externalUserId);
        }
        break;
      }
```

在 `case 'list-refresh':` 之前加：

```typescript
      case 'agents-refresh': {
        // PR 7.5.3: 重新跑 /agents 命令响应 (无参数)
        await this.handleCommandAgents(event.externalUserId, []);
        break;
      }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bot.test.ts -t "PR 7.5.3"`
Expected: 7 新测试 pass

- [ ] **Step 8: 跑全套测试**

Run: `bun test`
Expected: 1289 + 8 + 2 + 2 + 6 + 7 = 1314+ tests pass

- [ ] **Step 9: typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 10: commit**

```bash
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): /switch /resume /stop /agents 附加卡片 + case 双语义

PR 7.5.3: 4 命令附加卡片模式 + executeCardAction 2 改动
- handleCommand case 'switch' 附加 buildCompleteCard (PR 7 完成卡复用)
- handleCommand case 'resume' 附加 buildResumeCard (text_notice + 1 switch 按钮)
- handleCommand case 'stop' 附加 buildStopCard (text_notice + 1 switch 按钮)
- handleCommand case 'agents' 附加 buildAgentsRefreshCard (text_notice + agents-refresh)
- executeCardAction 改 case 'switch' 双语义 (有 value.sessionUuid → handleCommandSwitch; 无 → renderActiveSessionsList)
- executeCardAction 新增 case 'agents-refresh' → handleCommandAgents([])

7 单测覆盖: 4 命令附加卡 + 2 case 双语义 + 1 新 case"
```

---

# PR 7.5.4 — 真机 E2E + 部署 + 截图

**Files:** 无代码改动

---

### Task 4.1: 部署 + 真机 E2E 验收

- [ ] **Step 1: 部署**

Run: `bun run deploy`
Expected: deploy OK, 新 daemon PID 启动

- [ ] **Step 2: /list 真机验证**

打开企业微信 App → cc-linker bot → 发 `/list`
观察：
- ✅ 卡片 (button_interaction) 显示 10 条 sessions + 每条 2 按钮 (切换/恢复)
- ✅ 右上角 ⋮ → [🔄 刷新]
- ⚠️ 如果 aibot 服务端拒绝 20 按钮, 截图保留 + 反馈

- [ ] **Step 3: /list 切换按钮**

点 [🔄 切换] (任意 session)
- ✅ 收到 "✅ 已切换 session: <uuid>" markdown
- ✅ 紧接着收到 PR 7 完成卡片 (主标题 "已切换")

- [ ] **Step 4: /listdir 真机验证**

发 `/listdir /tmp`
- ✅ 卡片显示父目录 + 10 子目录按钮
- ✅ 每个按钮 text="📁 <name>"

点任意 [📁 <name>]
- ✅ 收到 "路径不存在" 或 "已创建 pending session"

- [ ] **Step 5: /model 真机验证**

发 `/model`（无 alias）
- ✅ 卡片显示 provider 列表 (Opus/Sonnet/Haiku) + [🧹 清除默认]

点 [🎯 Opus]
- ✅ 收到 "✅ 默认模型已设置为 opus"

- [ ] **Step 6: /switch /resume /stop 附加卡验证**

发 `/switch <uuid>`
- ✅ markdown "已切换" + 附加 PR 7 完成卡 (3 主按钮 + 4 action_menu)

发 `/resume`
- ✅ markdown "已 touch" + 附加 text_notice "Session 已 touch" + [📂 切换别的 session] 按钮

发 `/stop <short>`
- ✅ markdown "已停止" + 附加 text_notice "已停止: <short>" + [📂 切换 session] 按钮

- [ ] **Step 7: 失败兜底验证**

点 `/listdir` 卡片上不存在的路径（手动 mock 或临时删路径）
- ✅ 收到 "❌ 路径不存在" markdown，不调 handleCommandNew

- [ ] **Step 8: 跑最后一遍全套测试 + typecheck**

Run: `bun test && bun run typecheck`
Expected: 1314+ tests pass + 0 errors

- [ ] **Step 9: 写 commit**

```bash
git commit --allow-empty -m "chore: PR 7.5 E2E verification completed

PR 7.5 全部 4 PR ship-ready + 部署:
- PR 7.5.1: 公共框架 (6 builder + ProviderManager 集成 + defaultProvider 持久化)
- PR 7.5.2: /list + /listdir + /model 卡片化 + 3 新 case
- PR 7.5.3: /switch + /resume + /stop + /agents 附加卡 + 双语义 switch + agents-refresh
- PR 7.5.4: 真机 E2E + 部署 + 截图

全套测试 1314+ pass + typecheck 0 errors + 真机验收 pass"
```

---

## Self-Review

### Spec coverage (spec → plan 映射)

| Spec 章节 | Plan 任务 |
|---|---|
| §3.1 架构概览 | 4 PR 拆分 §9 |
| §3.2 卡片触发点 | PR 7.5.2 Task 2.2 (list/listdir/model) + PR 7.5.3 Task 3.2 (switch/resume/stop/agents) |
| §3.3 按钮 key 命名 | 全程引用 sessionUuid (PR 7.5 E3) |
| §4.1 /list 卡片 | PR 7.5.1 Task 1.2 buildListCard |
| §4.2 /listdir 卡片 | PR 7.5.1 Task 1.2 buildDirListCard + PR 7.5.2 Task 2.2 (handleCommandListDir 拆分) |
| §4.3 /model 卡片 | PR 7.5.1 Task 1.2 buildModelCard + PR 7.5.1 Task 1.4 (ProviderManager 集成) + PR 7.5.2 Task 2.2 (case 'model' 无 alias) |
| §4.4 /switch 完成卡 | PR 7.5.3 Task 3.2 (PR 7 完成卡复用) |
| §4.5 /agents 附加卡 | PR 7.5.1 Task 1.2 buildAgentsRefreshCard + PR 7.5.3 Task 3.2 |
| §4.6 /resume 附加卡 | PR 7.5.1 Task 1.2 buildResumeCard + PR 7.5.3 Task 3.2 |
| §4.7 /stop 附加卡 | PR 7.5.1 Task 1.2 buildStopCard + PR 7.5.3 Task 3.2 |
| §5.1 新增 3 case (select_dir/select_model/clear_model) | PR 7.5.2 Task 2.2 |
| §5.2 改 case 'switch' 双语义 | PR 7.5.3 Task 3.2 |
| §5.3 ProviderManager 注入 | PR 7.5.1 Task 1.4 |
| §6.1 卡片发送失败 | PR 7 已 ship (try/catch in stream-updater + sender) |
| §6.2 按钮回调失败 | case 'switch' 双语义 + case 'select_dir' existsSync 校验 |
| §6.3 并发安全 | 现有 validateOwner + executeCardAction 串行 |

### Placeholder scan

✅ 无 TBD / TODO / FIXME 在 plan 主体 (Task 1.3 Step 2, Task 2.1 Step 1 实施注意都明确"实施时按 X 模式写"无未实现代码)

### Type consistency

- `CompleteCardContext` (PR 7 ship) → 复用 `buildCompleteCard`, sessionUuid 字段对齐
- `ListCardContext.entries[].sessionUuid` (PR 7.5 v1.2 F1) → 跟 PR 7 CompleteCardContext.sessionUuid 一致
- 所有 button `value.sessionUuid` 字段名一致
- `handleCommandListDir` 拆分 (`_handleCommandListDirInternal` + `_renderDirListMarkdown`) 保证 markdown 路径 + 卡片路径共用同一 readdirSync 数据

### 风险

| 风险 | 缓解 |
|---|---|
| Task 1.4 Step 1 测试代码不完整 (只写了 it 名称, 没具体 mock setup) | Step 1 加"实施注意": 实施时按现有 bot.test.ts PR 7.3 makeBotWithMocks 模式 |
| Task 2.2 Step 2 改造 handleCommandListDir 拆分影响现有 case 'listdir' 逻辑 | 实施时优先保守: 加 _handleCommandListDirInternal 保留原 handleCommandListDir, 不破坏现有路径 |
| Task 3.2 Step 2 /switch 附加卡的 sessionTitle 拿不到 (registry 数据未必有 title) | 实施时先读 registryManager.sessions[uuid]?.title, 兜底用 uuid.slice(0, 18) |
| Task 3.2 Step 5 /agents bgCount 解析粗糙 (按行数过滤) | 实施时优化: 改 handleCommandAgents 返回 {markdown, bgCount} 结构 |
| 真机 /listdir 21 按钮超 SDK 上限 | 已有 PR 7.5 v1.2 E5 缓解 (限 20 子目录), 真机 PR 7.5.4 验证 |
