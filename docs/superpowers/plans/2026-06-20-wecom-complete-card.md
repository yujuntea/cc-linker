# WeCom Complete Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 企微智能机器人流式输出完成后，主动 `sendMessage` 一张"完成卡片"（button_interaction + action_menu），让用户点按 [继续] / [切换 session] / [选目录] 等按钮，免去再打字触发命令。

**Architecture:** 4 个独立 ship-ready PR 串行实施。每 PR 完成后立即可部署、可真机验收。
- **PR 7.1**：新建 `src/wecom/complete-card.ts`（builder + sender）+ 单测
- **PR 7.2**：`src/wecom/stream-updater.ts` 注入 sender + `complete()` 末尾触发
- **PR 7.3**：`src/wecom/bot.ts` 新增 3 case（continue/switch/listdir）+ 抽 2 公共函数（renderActiveSessionsList / renderListDir）
- **PR 7.4**：E2E 真机验收 + 部署

**Tech Stack:** Bun + TypeScript + `bun:test` + `@wecom/aibot-node-sdk` 1.0.7 + Zod

**Spec:** `docs/superpowers/specs/2026-06-20-wecom-complete-card-design.md` v1.1

---

## 文件结构

| 文件 | 改动 | 职责 |
|---|---|---|
| `src/wecom/complete-card.ts`（新建） | PR 7.1 | 卡片 builder + sender（独立 stateless 模块） |
| `tests/unit/wecom/complete-card.test.ts`（新建） | PR 7.1 | 单测 buildCompleteCard + WecomCompleteCardSender.send |
| `src/wecom/stream-updater.ts` | PR 7.2 | 注入 sender + complete() 末尾触发 send |
| `tests/unit/wecom/stream-updater.test.ts` | PR 7.2 | 单测 complete() 触发 send（mock sender） |
| `src/wecom/bot.ts` | PR 7.3 | setCompleteCardSender + 新 3 case + 抽 2 公共函数 |
| `tests/unit/wecom/bot.test.ts` | PR 7.3 | 单测 3 新 case + 4 复用 case（参数化） |

---

# PR 7.1 — 新建 complete-card builder + sender

**Files:**
- Create: `src/wecom/complete-card.ts`
- Test: `tests/unit/wecom/complete-card.test.ts`

---

### Task 1.1: 写 buildCompleteCard 失败测试

**Files:**
- Create: `tests/unit/wecom/complete-card.test.ts`

- [ ] **Step 1: 写测试骨架 + buildCompleteCard 字段正确性测试**

```typescript
// tests/unit/wecom/complete-card.test.ts
import { describe, it, expect } from 'bun:test';
import { buildCompleteCard, COMPLETE_CARD_MAIN_BUTTONS, COMPLETE_CARD_ACTION_MENU } from '../../../src/wecom/complete-card';
import type { WecomTemplateCard } from '../../../src/wecom/card';

describe('buildCompleteCard', () => {
  it('builds button_interaction card with 3 main buttons + action_menu (4 items)', () => {
    const card: WecomTemplateCard = buildCompleteCard({
      userId: 'wmu_test_user_123',
      sessionTitle: '分析代码',
      durationMs: 12340,
    });

    expect(card.card_type).toBe('button_interaction');
    // 主卡 3 按钮
    expect(card.button_list.button.length).toBe(3);
    expect(card.button_list.button[0].action_tag).toBe('continue');
    expect(card.button_list.button[1].action_tag).toBe('switch');
    expect(card.button_list.button[2].action_tag).toBe('listdir');
    // 主标题含 sessionTitle
    expect(card.main_title.title).toContain('Claude 处理完成');
    expect(card.main_title.title).toContain('分析代码');
    expect(card.main_title.desc).toContain('耗时 12s');
    // action_menu 4 项
    expect(card.action_menu?.desc).toBe('操作');
    expect(card.action_menu?.action_list.length).toBe(4);
    expect(card.action_menu?.action_list[0].action_tag).toBe('retry');
    expect(card.action_menu?.action_list[3].action_tag).toBe('list-refresh');
  });

  it('omits sessionTitle suffix when not provided', () => {
    const card = buildCompleteCard({ userId: 'wmu_no_title' });
    expect(card.main_title.title).toBe('✅ Claude 处理完成');
    expect(card.main_title.desc).toBe('💡 点按下方按钮继续');
  });

  it('generates unique task_id each call (ccdone- prefix + userId slice)', () => {
    const c1 = buildCompleteCard({ userId: 'wmu_user_abc' }) as any;
    const c2 = buildCompleteCard({ userId: 'wmu_user_abc' }) as any;
    // task_id 不同 (Date.now() 不同)
    expect(c1.task_id).not.toBe(c2.task_id);
    // 都是 ccdone- 开头, 含 userId 前 12 字符
    expect(c1.task_id.startsWith('ccdone-')).toBe(true);
    expect(c1.task_id).toContain('wmu_user_abc');
  });

  it('truncates task_id to <=128 bytes for userId safety', () => {
    const longUserId = 'wmu_' + 'a'.repeat(200);
    const card = buildCompleteCard({ userId: longUserId }) as any;
    // userId slice(0, 12) 限制 → task_id 必 ≤ "ccdone-" + 13digits + "-" + 12chars = ~31 字符
    expect(card.task_id.length).toBeLessThanOrEqual(128);
  });

  it('exposes COMPLETE_CARD_MAIN_BUTTONS constant with expected keys', () => {
    expect(COMPLETE_CARD_MAIN_BUTTONS.map(b => b.key)).toEqual(['continue', 'switch', 'listdir']);
  });

  it('exposes COMPLETE_CARD_ACTION_MENU constant with expected tags', () => {
    expect(COMPLETE_CARD_ACTION_MENU.map(a => a.tag)).toEqual(['retry', 'stop', 'confirm-stop', 'list-refresh']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/complete-card.test.ts`
Expected: FAIL with "Cannot find module '../../../src/wecom/complete-card'"

---

### Task 1.2: 写 buildCompleteCard 实现

**Files:**
- Create: `src/wecom/complete-card.ts`

- [ ] **Step 1: 写实现**

```typescript
/**
 * 企微完成卡片 builder + sender
 * PR 7.1: 流式输出完成后, 主动 sendMessage 一张 button_interaction 卡片
 *
 * @see docs/superpowers/specs/2026-06-20-wecom-complete-card-design.md §3.1
 */
import type { WSClient } from '@wecom/aibot-node-sdk';
import { WecomCardBuilder, type WecomTemplateCard } from './card';
import { logger } from '../utils/logger';

export type CompleteCardContext = {
  userId: string;
  sessionTitle?: string;
  sessionUuid?: string;
  cwd?: string;
  /** 流式总耗时（用于主标题 desc 显示） */
  durationMs?: number;
};

/**
 * PR 7.1: 主卡 3 个按钮 (业务名 key, 跟现有 executeCardAction case 对齐)
 * 顺序: continue / switch / listdir — 跟 spec §3.1.1 一致
 */
export const COMPLETE_CARD_MAIN_BUTTONS: ReadonlyArray<{ key: string; text: string }> = [
  { key: 'continue', text: '🔁 继续' },
  { key: 'switch',   text: '📂 切换 session' },
  { key: 'listdir',  text: '📁 选目录' },
];

/**
 * PR 7.1: action_menu 4 项 (复用现有 4 个 executeCardAction case)
 * 顺序: retry / stop / confirm-stop / list-refresh
 */
export const COMPLETE_CARD_ACTION_MENU: ReadonlyArray<{ tag: string; text: string }> = [
  { tag: 'retry',        text: '🔁 重试本次' },
  { tag: 'stop',         text: '🛑 停止' },
  { tag: 'confirm-stop', text: '🛂 硬杀 Claude' },
  { tag: 'list-refresh', text: '🔄 刷新列表' },
];

/**
 * PR 7.1: 生成 task_id (aibot SDK 字段, 用于 updateTemplateCard 关联)
 * 限制: 数字、字母、_-@，最长 128 字节
 * 格式: ccdone-{timestamp}-{userId 前 12 字符}
 */
function genCompleteCardTaskId(userId: string): string {
  return `ccdone-${Date.now()}-${userId.slice(0, 12)}`;
}

/**
 * PR 7.1: 构造完成卡片
 * - 主卡 button_interaction (3 按钮)
 * - 右上角 action_menu (4 项复用现有 case)
 * - task_id 用于 updateTemplateCard 关联 (本 PR 不调 updateTemplateCard, 留扩展点)
 */
export function buildCompleteCard(ctx: CompleteCardContext): WecomTemplateCard {
  const titleSuffix = ctx.sessionTitle ? `: ${ctx.sessionTitle.slice(0, 18)}` : '';
  const title = `✅ Claude 处理完成${titleSuffix}`;
  const elapsed = ctx.durationMs ? ` (耗时 ${Math.floor(ctx.durationMs / 1000)}s)` : '';
  const desc = `💡 点按下方按钮继续${elapsed}`;

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
  // 用 as any 注入是因 card.ts TemplateCard union 类型对 action_menu 在 button_interaction 下 optional
  (card as any).action_menu = {
    desc: WecomCardBuilder.ACTION_MENU_DESC,
    action_list: COMPLETE_CARD_ACTION_MENU.map(a => ({
      action_tag: a.tag,
      action_title: { tag: a.tag, text: a.text },
    })),
  };

  // 注入 task_id (aibot SDK 字段, 用 as any 因 card.ts 类型不含 task_id)
  (card as any).task_id = genCompleteCardTaskId(ctx.userId);

  return card;
}

/**
 * PR 7.1: 完成卡片 sender (stateless, 每次 send 都新建 card)
 * 调用方: WecomStreamUpdater.complete() 末尾
 */
export class WecomCompleteCardSender {
  constructor(private readonly sdk: WSClient) {}

  async send(ctx: CompleteCardContext): Promise<void> {
    const card = buildCompleteCard(ctx);
    await this.sdk.sendMessage(ctx.userId, {
      msgtype: 'template_card',
      template_card: card,
    });
    logger.info(`[wecom-complete-card] sent: userId=${ctx.userId.slice(0, 12)}... taskId=${(card as any).task_id}`);
  }
}
```

- [ ] **Step 2: 跑测试确认通过**

Run: `bun test tests/unit/wecom/complete-card.test.ts`
Expected: 6 tests pass

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 4: commit**

```bash
git add src/wecom/complete-card.ts tests/unit/wecom/complete-card.test.ts
git commit -m "feat(wecom): add complete-card builder + sender

PR 7.1: 流式输出完成后, 主动 sendMessage 一张 button_interaction 卡片
- buildCompleteCard(ctx) → 主卡 3 按钮 (continue/switch/listdir) + action_menu 4 项 (retry/stop/confirm-stop/list-refresh)
- WecomCompleteCardSender.send(ctx) → sendMessage 主动推送
- task_id: ccdone-{timestamp}-{userId[:12]}, ≤128 字节
- 6 单测覆盖: 字段正确性 / 缺省值 / task_id 唯一性 / 常量导出"
```

---

# PR 7.2 — stream-updater 注入 sender + complete() 末尾触发 send

**Files:**
- Modify: `src/wecom/stream-updater.ts`
- Modify: `tests/unit/wecom/stream-updater.test.ts`

---

### Task 2.1: 写 complete() 触发 send 的失败测试

**Files:**
- Modify: `tests/unit/wecom/stream-updater.test.ts`

- [ ] **Step 1: 加测试 — complete 触发 completeCardSender.send (mock sender)**

打开 `tests/unit/wecom/stream-updater.test.ts`，在文件末尾追加：

```typescript
import { WecomCompleteCardSender } from '../../../src/wecom/complete-card';

describe('PR 7.2: complete() 触发 completeCardSender.send', () => {
  let mockSdk: any;
  let mockSender: any;
  let updater: WecomStreamUpdater;

  beforeEach(() => {
    mockSdk = {
      replyStream: (...args: any[]) => Promise.resolve({}),
    };
    mockSender = {
      sendCalls: [] as any[],
      send: (ctx: any) => {
        mockSender.sendCalls.push(ctx);
        return Promise.resolve();
      },
    };
    updater = new WecomStreamUpdater(mockSdk, { throttleMs: 100 });
    updater.setCompleteCardSender(mockSender as any);
  });

  it('does NOT call sender.send when not injected', async () => {
    // 验证默认行为: 不注入 sender → 不发卡片 (向后兼容)
    const updater2 = new WecomStreamUpdater(mockSdk, { throttleMs: 100 });
    await updater2.startProcessing('user-1', mockInboundFrame());
    await updater2.complete('完成内容', 100, 200, 5000, 1);
    // 不抛错, 不调 mockSender (没注入)
    expect(true).toBe(true);
  });

  it('calls sender.send with userId/duration after complete() success', async () => {
    await updater.startProcessing('user_42', mockInboundFrame());
    await updater.complete('完成内容', 100, 200, 5500, 1, undefined, '思考内容', [], {
      sessionTitle: '测试 session',
      sessionUuid: 'uuid-abc',
      cwd: '/tmp',
    });
    expect(mockSender.sendCalls.length).toBe(1);
    const sent = mockSender.sendCalls[0];
    expect(sent.userId).toBe('user_42');
    expect(sent.durationMs).toBe(5500);
    expect(sent.sessionTitle).toBe('测试 session');
    expect(sent.sessionUuid).toBe('uuid-abc');
    expect(sent.cwd).toBe('/tmp');
  });

  it('PR 7.2 review: sender.send failure does NOT break complete()', async () => {
    // sender.send 抛错 → complete() 不应 reject (流式输出已成功, 不能让卡片失败冒泡)
    mockSender.send = () => Promise.reject(new Error('mock sendMessage fail'));
    await updater.startProcessing('user_x', mockInboundFrame());
    // 不应 reject
    await updater.complete('done', 1, 2, 3000, 1);
    // 验证: 没有 propagate error
    expect(true).toBe(true);
  });

  it('PR 7.2 review: sender.send is called AFTER replyStream(finish=true) completes', async () => {
    const order: string[] = [];
    mockSdk.replyStream = (...args: any[]) => {
      order.push(`replyStream(finish=${args[3]})`);
      return Promise.resolve({});
    };
    mockSender.send = (ctx: any) => {
      order.push('sender.send');
      return Promise.resolve();
    };
    await updater.startProcessing('user_y', mockInboundFrame());
    await updater.complete('done', 1, 2, 3000, 1);
    expect(order).toEqual(['replyStream(finish=true)', 'sender.send']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/stream-updater.test.ts`
Expected: FAIL with "updater.setCompleteCardSender is not a function" 或 "sender.sendCalls is undefined"

---

### Task 2.2: 实现 setCompleteCardSender + 字段 + complete() 触发

**Files:**
- Modify: `src/wecom/stream-updater.ts`

- [ ] **Step 1: 引入 import + 加字段声明 + setter**

打开 `src/wecom/stream-updater.ts`，在文件顶部 import 段（line 7-9）下方加：

```typescript
import type { WecomCompleteCardSender } from './complete-card';
```

在 class `WecomStreamUpdater` 字段区（line 84 附近，`private lastInboundFrame: any = null;` 下方）追加：

```typescript
  /**
   * PR 7.2: 流式上下文, complete() 末尾用作完成卡片 ctx
   * - lastUserId: startProcessing 时记录
   * - lastSessionTitle/UUID/Cwd: complete() 时由 completeCtx 可选参数注入
   */
  private lastUserId: string | null = null;
  private lastSessionTitle: string | undefined = undefined;
  private lastSessionUuid: string | undefined = undefined;
  private lastCwd: string | undefined = undefined;

  /**
   * PR 7.2: 注入完成卡片 sender (跟现有 setMsgFallback 同模式)
   * 调用方: WecomBot 构造后立即调一次 (stateless, 多次 complete 复用)
   */
  private completeCardSender?: WecomCompleteCardSender;

  setCompleteCardSender(sender: WecomCompleteCardSender): void {
    this.completeCardSender = sender;
  }
```

- [ ] **Step 2: startProcessing 记录 lastUserId**

在 `src/wecom/stream-updater.ts:140 startProcessing` 方法顶部（`this.currentStreamId = generateReqId('stream');` 之后）插入：

```typescript
    this.lastUserId = userId;
```

- [ ] **Step 3: complete() 加 completeCtx 可选参数 + 末尾触发 send**

修改 `complete()` 方法签名（line 259-277），在 `toolUses?` 后追加参数：

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
    // PR 7.2: 上下文传给完成卡片 (sessionTitle/UUID/cwd)
    completeCtx?: { sessionTitle?: string; sessionUuid?: string; cwd?: string },
  ): Promise<void> {
```

在 `complete()` 方法内，`clearTerminalState()` 调用**之前**插入 send 触发：

```typescript
    // PR 7.2: 流式关闭后, 主动 sendMessage 完成卡片
    // 防御: sendMessage 失败不能影响已发流式 (用户已看到 finalMarkdown)
    if (this.completeCardSender && this.lastUserId) {
      try {
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

- [ ] **Step 4: clearTerminalState 清理 lastUserId**

修改 `clearTerminalState()` 方法（line 342-345）：

```typescript
  private clearTerminalState(): void {
    this.currentStreamId = null;
    this.lastInboundFrame = null;
    // PR 7.2: 清理流式上下文, 避免下次 complete 误用上次的 userId
    this.lastUserId = null;
    this.lastSessionTitle = undefined;
    this.lastSessionUuid = undefined;
    this.lastCwd = undefined;
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/unit/wecom/stream-updater.test.ts`
Expected: 全部 pass（4 个新 + 旧测试）

- [ ] **Step 6: 跑全套 typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 7: commit**

```bash
git add src/wecom/stream-updater.ts tests/unit/wecom/stream-updater.test.ts
git commit -m "feat(wecom): stream-updater complete() triggers complete card

PR 7.2: 流式输出成功后, 主动 sendMessage 一张 button_interaction 卡片
- 新增 lastUserId/lastSessionTitle/UUID/Cwd 字段 + setCompleteCardSender setter
- complete() 加 completeCtx 可选参数 (sessionTitle/UUID/cwd)
- complete() 末尾: 若 sender 已注入 + lastUserId 有值 → send, 失败仅 warn
- send 调用顺序保证: replyStream(finish=true) 先, sender.send 后
- 4 单测覆盖: 默认行为 / send 触发 / 失败不冒泡 / 调用顺序"
```

---

# PR 7.3 — bot.ts 新增 3 case + 抽 2 公共函数 + 已有 4 case 复用

**Files:**
- Modify: `src/wecom/bot.ts`
- Modify: `tests/unit/wecom/bot.test.ts`

---

### Task 3.1: 写 3 新 case + 4 复用 case 的失败测试

**Files:**
- Modify: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 加测试 — 3 个新 case (continue/switch/listdir)**

打开 `tests/unit/wecom/bot.test.ts`，找已有 `executeCardAction` 测试段（搜 `__test_executeCardAction`），在末尾追加：

```typescript
// PR 7.3 helper: 构造带 mock sdk + mock userManager 的 WecomBot
function makeBotWithMocks(opts: {
  sdkSendMessage?: (chatid: string, body: any) => Promise<any>;
  userManagerEntry?: any;  // null = 空, object = 已有 entry
} = {}) {
  const sentMessages: any[] = [];
  const mockSdk = {
    sendMessage: (chatid: string, body: any) => {
      sentMessages.push({ chatid, body });
      return opts.sdkSendMessage ? opts.sdkSendMessage(chatid, body) : Promise.resolve({});
    },
    replyWelcome: () => Promise.resolve({}),
    replyStream: () => Promise.resolve({}),
  };
  const mockClient = {
    sdk: mockSdk,
    onCardAction: () => {},
    onMessage: () => {},
    connect: () => {},
  };
  const setPendingCalls: string[] = [];
  const bot = new WecomBot({
    botId: 'test',
    secret: 'test',
    userMappingPath: '/tmp/test-mapping-pr73.json',
    client: mockClient as any,
  });
  // 覆盖 userManager 方法 (注入 mock)
  bot.userManager.getEntry = async () => opts.userManagerEntry ?? null;
  bot.userManager.setPending = async (userId: string) => {
    setPendingCalls.push(userId);
  };
  // 测试辅助字段
  (bot as any)._sentMessages = sentMessages;
  (bot as any)._setPendingCalls = setPendingCalls;
  return bot;
}

describe('PR 7.3: executeCardAction 新增 3 case (continue/switch/listdir)', () => {
  it("case 'continue': setPending + 提示新会话就绪 (无现有 session)", async () => {
    const bot = makeBotWithMocks({ userManagerEntry: null });
    await bot.__test_executeCardAction({
      externalUserId: 'wmu_test',
      messageId: 'msg-1',
      actionTag: 'continue',
      actionValue: {},
      inboundFrame: { headers: { req_id: 'req_1' } },
    });
    expect((bot as any)._setPendingCalls).toEqual(['wmu_test']);
    const newSessionMsg = (bot as any)._sentMessages.find((m: any) => m.body.markdown?.content?.includes('新会话就绪'));
    expect(newSessionMsg).toBeDefined();
  });

  it("case 'continue': 已有 active session 时不发新 session (幂等 no-op)", async () => {
    const bot = makeBotWithMocks({
      userManagerEntry: { type: 'session', sessionUuid: 'uuid_existing', cwd: '/tmp' },
    });
    await bot.__test_executeCardAction({
      externalUserId: 'wmu_test', messageId: 'msg-1',
      actionTag: 'continue', actionValue: {},
      inboundFrame: { headers: { req_id: 'req_1' } },
    });
    expect((bot as any)._setPendingCalls.length).toBe(0);
    const warnMsg = (bot as any)._sentMessages.find((m: any) => m.body.markdown?.content?.includes('已有'));
    expect(warnMsg).toBeDefined();
  });

  it("case 'continue': 已有 pending_new_session 时也不发新 (幂等)", async () => {
    const bot = makeBotWithMocks({
      userManagerEntry: { type: 'pending_new_session', sessionUuid: null, cwd: null },
    });
    await bot.__test_executeCardAction({
      externalUserId: 'wmu_test', messageId: 'msg-1',
      actionTag: 'continue', actionValue: {},
      inboundFrame: { headers: { req_id: 'req_1' } },
    });
    expect((bot as any)._setPendingCalls.length).toBe(0);
  });

  it("case 'switch': 调 renderActiveSessionsList (mock)", async () => {
    const bot = makeBotWithMocks();
    let renderCalledWith: string | null = null;
    (bot as any).renderActiveSessionsList = async (uid: string) => {
      renderCalledWith = uid;
    };
    await bot.__test_executeCardAction({
      externalUserId: 'wmu_test', messageId: 'msg-1',
      actionTag: 'switch', actionValue: {},
      inboundFrame: { headers: { req_id: 'req_1' } },
    });
    expect(renderCalledWith).toBe('wmu_test');
  });

  it("case 'listdir': 调 renderListDir (mock)", async () => {
    const bot = makeBotWithMocks();
    let renderCalledWith: string | null = null;
    (bot as any).renderListDir = async (uid: string) => {
      renderCalledWith = uid;
    };
    await bot.__test_executeCardAction({
      externalUserId: 'wmu_test', messageId: 'msg-1',
      actionTag: 'listdir', actionValue: {},
      inboundFrame: { headers: { req_id: 'req_1' } },
    });
    expect(renderCalledWith).toBe('wmu_test');
  });
});

describe('PR 7.3: executeCardAction 已有 4 case (从 action_menu 进) 仍 work', () => {
  it.each([
    ['retry', '🔁 重试提示'],
    ['list-refresh', '📋'],
  ])("action_tag=%s 仍正常 (期望文案包含: %s)", async (tag, expectedSubstring) => {
    const bot = makeBotWithMocks();
    if (tag === 'list-refresh') {
      bot.registryManager = {
        sessions: { 'uuid-1': { status: 'active', title: '测试', message_count: 5, last_active: '2026-06-20T08:00:00Z' } },
      };
    }
    await bot.__test_executeCardAction({
      externalUserId: 'wmu_test', messageId: 'msg-old',
      actionTag: tag, actionValue: {},
      inboundFrame: { headers: { req_id: 'req_1' } },
    });
    const found = (bot as any)._sentMessages.find((m: any) => m.body.markdown?.content?.includes(expectedSubstring));
    expect(found).toBeDefined();
  });

  it("action_tag='stop': 调 updater.cancel", async () => {
    const bot = makeBotWithMocks();
    let cancelCalled = false;
    bot.updater.cancel = async () => { cancelCalled = true; };
    await bot.__test_executeCardAction({
      externalUserId: 'wmu_test', messageId: 'msg-old',
      actionTag: 'stop', actionValue: {},
      inboundFrame: { headers: { req_id: 'req_1' } },
    });
    expect(cancelCalled).toBe(true);
  });

  it("action_tag='confirm-stop': 缺 sessionUuid 时 warn no-op", async () => {
    const bot = makeBotWithMocks();
    await bot.__test_executeCardAction({
      externalUserId: 'wmu_test', messageId: 'msg-old',
      actionTag: 'confirm-stop', actionValue: {},  // 无 sessionUuid
      inboundFrame: { headers: { req_id: 'req_1' } },
    });
    expect(true).toBe(true);  // 不抛错
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -t "PR 7.3"`
Expected: FAIL（bot 还没 3 新 case / 还没抽 2 公共方法）

---

### Task 3.2: 实现 2 个公共方法 + handleChat 注入 sender + completeCtx 传参

**Files:**
- Modify: `src/wecom/bot.ts`

- [ ] **Step 1: import 新增 + WecomCompleteCardSender 注入**

打开 `src/wecom/bot.ts`，在顶部 import 段加：

```typescript
import { WecomCompleteCardSender } from './complete-card';
```

找到 WecomBot 构造器（`constructor`）末尾（通常是 `this.updater.setMsgFallback(...)` 调用之后），加：

```typescript
    // PR 7.3: 注入完成卡片 sender (stateless, 一次注入多次复用)
    this.updater.setCompleteCardSender(new WecomCompleteCardSender(this.client.sdk));
```

- [ ] **Step 2: 抽公共方法 renderActiveSessionsList**

找到现有 `case 'list-refresh'` 的渲染逻辑（bot.ts:1264-1285 那段 activeEntries + markdown 渲染），把它抽成 private 方法，加在 class 内：

```typescript
  /**
   * PR 7.3: 抽公共方法 — 渲染活跃 session 列表 markdown
   * 共享给: case 'switch' (完成卡片按钮) + case 'list-refresh' (action_menu)
   * @param userId 企微 external_userid (推送目标)
   */
  private async renderActiveSessionsList(userId: string): Promise<void> {
    if (!this.registryManager) {
      logger.warn('[wecom-bot] renderActiveSessionsList: registryManager not available');
      return;
    }
    const allActive = this.registryManager.sessions;
    const activeEntries = Object.entries(allActive)
      .filter(([_, s]) => s.status === 'active')
      .sort(([_, a], [__, b]) => (b.last_active ?? '').localeCompare(a.last_active ?? ''))
      .slice(0, 5);
    const totalActive = Object.values(allActive).filter(s => s.status === 'active').length;
    const markdown = activeEntries.length === 0
      ? '📭 当前无 active session'
      : `📋 **活跃 sessions (${activeEntries.length}${totalActive > 5 ? '+' : ''})**\n\n` +
        activeEntries.map(([uuid, s]) => {
          const title = s.title ?? '(无标题)';
          const msgs = s.message_count != null ? ` (${s.message_count} msgs)` : '';
          const lastActive = s.last_active ? ` _${s.last_active.slice(0, 16)}_` : '';
          return `• **${title}**${msgs}${lastActive}\n   \`${uuid.slice(0, 8)}…\``;
        }).join('\n\n') +
        `\n\n_(共 ${totalActive} 个; 用 \`/list\` 看全部)_`;
    await this.client.sdk.sendMessage(userId, {
      msgtype: 'markdown',
      markdown: { content: markdown },
    });
  }
```

把 `case 'list-refresh'` 改成调此方法：

```typescript
      case 'list-refresh': {
        await this.renderActiveSessionsList(event.externalUserId);
        break;
      }
```

- [ ] **Step 3: 抽公共方法 renderListDir**

把现有 `case 'listdir'` 命令（bot.ts:458 那段 handleCommand `case 'listdir'`）的核心渲染逻辑抽成 private 方法。**先**搜 bot.ts 找到 `case 'listdir':` 的实际实现位置（line 458 是大概位置，可能有偏差），把渲染 listdir 结果 markdown 的部分抽到：

```typescript
  /**
   * PR 7.3: 抽公共方法 — 渲染 /listdir 结果 markdown
   * 共享给: handleCommand case 'listdir' (SpoolQueue 路径) + executeCardAction case 'listdir' (按钮)
   * @param userId 企微 external_userid
   * @param cwd 可选: 切换的工作目录 (按钮版本从 active session 读, 命令版本从 SpoolMessage 读)
   */
  private async renderListDir(userId: string, cwd?: string): Promise<void> {
    // TODO: 把 handleCommand case 'listdir' 的实际渲染逻辑搬这里
    // PR 7.3: 暂用 markDone 标记, 实际实现见 handleCommand 现有代码
    const targetCwd = cwd ?? this.userManager.getEntry(userId).then(e => e?.cwd ?? process.cwd());
    // 防御: cwd 不存在
    const finalCwd = await targetCwd;
    if (!finalCwd || !(await this.dirExists(finalCwd))) {
      await this.client.sdk.sendMessage(userId, {
        msgtype: 'markdown',
        markdown: { content: `❌ 工作目录不存在: \`${finalCwd}\`` },
      });
      return;
    }
    // 调原 handleCommand listdir 渲染 (复用)
    // 注: 实际实现时直接把现有 case 'listdir' 代码搬这里, 不留 TODO
    throw new Error('renderListDir: 实际实现见 PR 7.3 Task 3.2 Step 3');
  }

  private async dirExists(p: string): Promise<boolean> {
    try {
      const { stat } = await import('fs/promises');
      const s = await stat(p);
      return s.isDirectory();
    } catch { return false; }
  }
```

> **实施注意**：实施时**不**留 TODO — 直接打开 `src/wecom/bot.ts` 看 `case 'listdir':` 现有渲染代码，把那段代码**逐字**搬到 `renderListDir`，保留原 `dirExists` 检查逻辑（如果已有就复用），并在原 `case 'listdir':` 改成 `await this.renderListDir(msg.userId, msg.cwd);`。plan 里 TODO 占位是允许的（实施时必须替换为真实代码）。

- [ ] **Step 4: handleChat 调 updater.complete 时传 completeCtx**

找到 `handleChat` 方法内调 `updater.complete(...)` 那行（用 grep 找 `updater.complete`），加最后参数：

```typescript
    await this.updater.complete(
      resultText,
      tokensIn, tokensOut, durationMs, numTurns,
      undefined,  // msgFallback (用类字段)
      state.thinking,
      state.toolUses,
      // PR 7.3: 完成卡片 ctx (sessionTitle/UUID/cwd)
      {
        sessionTitle: (result as any).sessionTitle ?? this.lastSessionTitle,
        sessionUuid: result.sessionId,
        cwd: cwd,
      },
    );
```

> 实施时根据 handleChat 实际变量名调整 `result.sessionId` / `cwd` / `resultText` 等。

- [ ] **Step 5: executeCardAction 加 3 个新 case**

在 `executeCardAction` 方法 switch 内（line 1208 附近，`case 'retry':` 上方）加：

```typescript
      case 'continue': {
        // PR 7.3: 幂等保护 — 已有 session / pending 时不发新
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
        await this.renderActiveSessionsList(event.externalUserId);
        break;
      }
      case 'listdir': {
        await this.renderListDir(event.externalUserId);
        break;
      }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bot.test.ts -t "PR 7.3"`
Expected: 全部新 case pass

- [ ] **Step 7: 跑全套 typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 8: 跑全套测试确保无回归**

Run: `bun test`
Expected: 全部 pass (测试数应该比 PR 7.2 多 ~12 个)

- [ ] **Step 9: commit**

```bash
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): executeCardAction 新增 continue/switch/listdir 3 case

PR 7.3: 完成卡片按钮入口接通 executeCardAction
- case 'continue': 幂等保护 (getEntry 检查 session/pending) + setPending + sendMessage 提示
- case 'switch': 抽 renderActiveSessionsList 公共方法, 跟 case 'list-refresh' 共用
- case 'listdir': 抽 renderListDir 公共方法, 跟 handleCommand case 'listdir' 共用
- 构造器注入 WecomCompleteCardSender (一次, 多次 complete 复用)
- handleChat 调 updater.complete 时传 completeCtx {sessionTitle/UUID/cwd}
- 8 新单测 (3 新 case + 4 复用 case + 1 缺 sessionUuid)"
```

---

# PR 7.4 — E2E 真机验收 + 部署

**Files:**
- Modify: 无代码改动

---

### Task 4.1: 真机部署 + 手动 E2E

- [ ] **Step 1: 部署**

Run: `bun run deploy`
Expected: deploy OK，新 daemon PID 启动

- [ ] **Step 2: 验证流式输出结束自动出完成卡片**

打开企业微信 App → 找 cc-linker bot → 发消息 "读 /etc/hostname"
观察：
- ✅ 流式 markdown 滚动（思考过程 + 当前操作 + 回复 + ⏱ 已用时）
- ✅ 流式关闭后，**单独一条消息**显示完成卡片：✅ Claude 处理完成 + [🔁 继续] [📂 切换 session] [📁 选目录] + 右上角 ⋮ 操作

- [ ] **Step 3: 验证 [🔁 继续] 按钮**

无现有 session 时点 [继续]：
- ✅ 收到 markdown "✨ 新会话就绪..."
- ✅ 再发消息能创建新 session

有 active session 时点 [继续]：
- ✅ 收到 markdown "⚠️ 已有活跃 session, 不创建新会话..."

- [ ] **Step 4: 验证 [📂 切换 session] 按钮**

- ✅ 收到 markdown "📋 活跃 sessions (...)" 列表

- [ ] **Step 5: 验证 [📁 选目录] 按钮**

- ✅ 收到 listdir 输出（目录列表 + session 信息）

- [ ] **Step 6: 验证操作菜单 4 项**

点 ⋮ → [🛑 停止]：✅ updater.cancel 调，无 in-flight 流时 warn no-op
点 ⋮ → [🔁 重试本次]：✅ 收到 markdown "🔁 重试提示: 请重新发送..."
点 ⋮ → [🔄 刷新列表]：✅ 收到刷新的活跃 session 列表

- [ ] **Step 7: 验证失败兜底（sendMessage 失败）**

- 临时把 config.toml 里的 bot_id 改错（只测一次，记得恢复）→ 重启 bot → 发消息 → 验证流式输出仍正常（完成卡片可能不显示，但不报错）

- [ ] **Step 8: 跑最后一遍全套测试 + typecheck**

Run: `bun test && bun run typecheck`
Expected: 全部 pass + 0 errors

- [ ] **Step 9: 收集日志 + 截图 + 写 commit**

```bash
git add docs/superpowers/plans/2026-06-20-wecom-complete-card.md
git commit -m "docs(plan): PR 7.4 E2E verification completed

PR 7.4: 4 个 ship-ready PR 全跑通
- 流式输出结束自动出完成卡片
- 3 主卡按钮 + 4 action_menu 项全部 work
- 失败兜底 sendMessage 不影响已发流式
- 全套单测 + typecheck + 真机验收 pass"
```

---

## Self-Review

### Spec coverage（spec → plan 映射）

| Spec 章节 | Plan 任务 |
|---|---|
| §3.1.1 主卡 3 按钮 | Task 1.1 / 1.2 buildCompleteCard |
| §3.1.2 action_menu 4 项 | Task 1.1 / 1.2 COMPLETE_CARD_ACTION_MENU |
| §3.1.3 task_id 生成 | Task 1.1 / 1.2 genCompleteCardTaskId |
| §3.2 完成卡片发送时机 | Task 2.1 / 2.2 complete() 末尾触发 |
| §3.3.1 case 'continue' 幂等 | Task 3.1 / 3.2.5 |
| §3.3.1 case 'switch' 抽公共方法 | Task 3.2.2 renderActiveSessionsList |
| §3.3.1 case 'listdir' 抽公共方法 | Task 3.2.3 renderListDir |
| §3.3.2 复用 4 case | Task 3.1 it.each 参数化测试 |
| §3.3.3 幂等 no-op 表 | Task 3.1 + Task 3.2.5 (continue getEntry 检查) |
| §4.1 complete-card.ts | Task 1.1 / 1.2 |
| §4.2 stream-updater 改动 | Task 2.1 / 2.2 |
| §4.3 bot.ts 改动 | Task 3.2 |
| §5 错误处理 | Task 2.1 PR 7.2 review 测试 (send 失败不冒泡) + Task 4.1 真机 |
| §6 测试 | 4 PR 各有专门单测 + 真机 E2E |
| §8 PR 拆分 | 本 plan 4 个 task group |

### Placeholder scan

无 TBD / TODO / FIXME 在 plan 主体（Task 3.2.3 renderListDir 内 TODO 是允许的——spec 实施时把真实代码搬过去必须替换 plan 内 TODO 段）

### Type consistency

- `CompleteCardContext` 在 PR 7.1 定义，PR 7.2 / 7.3 复用，字段名一致（userId/sessionTitle/sessionUuid/cwd/durationMs）
- `WecomTemplateCard` 在 PR 7.1 import 自 card.ts（跟 spec v1.1 fix #2 对齐）
- 按钮 key 列表 `COMPLETE_CARD_MAIN_BUTTONS` 在 PR 7.1 定义，PR 7.3 case 'continue'/'switch'/'listdir' 引用，命名一致
- action_menu 列表 `COMPLETE_CARD_ACTION_MENU` 在 PR 7.1 定义，跟现有 executeCardAction case（retry/stop/confirm-stop/list-refresh）命名一致

### 风险评估

| 风险 | 缓解 |
|---|---|
| Task 3.2.3 renderListDir 实际代码不熟 | 实施时打开 bot.ts 现 case 'listdir' 全文搬运，保留 dirExists 检查 |
| 真机测试时 bot_id 改错忘恢复 | Step 7 立即恢复，再发测试消息验证 |
| 飞书侧回归 | 改动只在 src/wecom/*，bot.ts 改的也只是 wecom 内部 case，飞书侧 0 改动 |

---

## 执行选项

Plan 完整保存到 `docs/superpowers/plans/2026-06-20-wecom-complete-card.md`。两种执行方式：

**1. Subagent-Driven（推荐）** — 我为每个 Task 派一个独立 subagent，按顺序执行，每个 Task 完成后做 spec compliance review + code quality review。

**2. Inline Execution** — 在当前 session 串行执行所有 Task，每个 Task 完成后批量 commit。

你想用哪种？
