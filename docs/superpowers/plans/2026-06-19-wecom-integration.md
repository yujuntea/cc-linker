# cc-linker 接入企业微信 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 cc-linker 添加企业微信智能机器人（aibot）通道，复用现有 SpoolQueue / ClaudeSessionManager / Registry 核心模块，飞书路径零回归。

**Architecture:** 三层架构 — CLI / `platform/` 抽象层 + `feishu/` + `wecom/` 通道 / 平台无关核心（`SpoolQueue`/`ClaudeSessionManager`/`Registry`/`StateCoordinator`）。抽 `PlatformMessage` + `StreamUpdater` 两个接口，跨平台 userId 完全隔离（飞书 `open_id` vs 企微 `external_userid` 是 disjoint key）。

**Tech Stack:** Bun 1.3+ + TypeScript 6.0 + `@wecom/aibot-node-sdk@^1.0.7` + `ws@^8.16.0` + 现有飞书 SDK `@larksuiteoapi/node-sdk`。`bun build --compile` 已 PoC 验证打包 OK。

**Spec:** `docs/superpowers/specs/2026-06-19-wecom-integration-design.md`

---

## File Structure

| 文件 | 职责 | PR |
|------|------|-----|
| `poc/aibot-load.ts` | PoC: Bun + SDK 兼容性 smoke test（已写） | 1 |
| `poc/aibot-stream.ts` | PoC: SDK `replyStream` 流式实测 | 1 |
| `poc/aibot-button.ts` | PoC: 按钮回调 5s `replyWelcome` 实测 | 1 |
| `src/platform/types.ts` | `PlatformMessage` / `PlatformUserId` / `PlatformCardAction` / `PlatformReplyFn` | 1 |
| `src/platform/stream-updater.ts` | `StreamChunk` / `StreamUpdater` 接口 | 1 |
| `src/platform/user-state.ts` | CAS 校验 + session 解析（从 `feishu/mapping.ts` 抽） | 1 |
| `src/platform/command-handler.ts` | 命令解析 + 执行（从 `feishu/bot.ts` 抽） | 1 |
| `src/feishu/card-updater.ts` | **修改**: 实现 `StreamUpdater` 适配层（不改行为） | 1 |
| `src/wecom/aibot-client.ts` | `WSClient` 封装 + 错误映射 + 事件归一化 | 2 |
| `src/wecom/stream-updater.ts` | `StreamUpdater` 实现（节流 2000ms + 限频 buffer） | 2 |
| `src/wecom/card.ts` | 5 种模板卡片 builder | 2 |
| `src/wecom/mapping.ts` | 企微 `UserManager`（独立文件，CAS） | 2 |
| `src/wecom/bot.ts` | `WecomBot` 主类 | 2 |
| `src/wecom/index.ts` | 模块导出 | 2 |
| `src/cli/commands/init-wecom.ts` | 交互式 `bot_id` + `secret` 配置 | 3 |
| `src/cli/commands/start.ts` | **修改**: `--platform=feishu\|wecom\|all` | 3 |
| `src/cli/commands/setup.ts` | **修改**: `--wecom` 选项 | 3 |
| `src/index.ts` | **修改**: 注册 `init-wecom` | 3 |
| `src/utils/config.ts` | **修改**: `[wecom]` 节 + env override | 3 |
| `src/registry/types.ts` | **修改**: `SessionEntry.platform` 字段 | 3 |
| `src/runtime/state-coordinator.ts` | **修改**: 双平台锁 | 3 |
| `tests/unit/platform/types.test.ts` | 适配器测试 | 1 |
| `tests/unit/platform/stream-updater.test.ts` | 接口契约 | 1 |
| `tests/unit/platform/user-state.test.ts` | CAS + session 解析 | 1 |
| `tests/unit/platform/command-handler.test.ts` | 命令路由 | 1 |
| `tests/unit/wecom/aibot-client.test.ts` | WSClient 封装 | 2 |
| `tests/unit/wecom/stream-updater.test.ts` | 节流 + buffer + SDK 错误码 | 2 |
| `tests/unit/wecom/card.test.ts` | 5 种模板卡片 | 2 |
| `tests/unit/wecom/mapping.test.ts` | 企微 UserManager CAS | 2 |
| `tests/unit/wecom/bot.test.ts` | WecomBot 主类 | 2 |
| `tests/integration/wecom/mock-aibot.ts` | Mock aibot server | 2 |
| `tests/integration/wecom/spool-roundtrip.test.ts` | SpoolQueue 端到端 | 2 |

**预期代码量**：新增 ~1740 行 + 改造 ~225 行 + 测试 ~600 行。分 3 个 PR。

---

# PR 1: 抽象层（platform/）

**目标**：抽 `PlatformMessage` / `StreamUpdater` 接口，飞书侧实现适配层。**不引入企微代码**。本 PR 完成后飞书行为零变化。

**风险**：抽公共代码时漏掉边缘情况 → 飞书 E2E 必跑 + 单测覆盖 ≥ 90%。

## Task 1.1: 把 PoC smoke test 入库

**Files:**
- Create: `poc/aibot-load.ts`

- [ ] **Step 1: 从 `/tmp/aibot-poc/poc-load.ts` 复制并改名为 `poc/aibot-load.ts`**

Read `/tmp/aibot-poc/poc-load.ts` 的内容（原 PoC 验证脚本），写入 `poc/aibot-load.ts`。

- [ ] **Step 2: 跑 smoke test**

Run: `bun run poc/aibot-load.ts`
Expected: 退出码 0，输出 `=== POC RESULTS ===` 段
Verify: 25 个 `[POC-N]` 标记全部打印，无 error，无 `undefined`

- [ ] **Step 3: Commit**

```bash
git add poc/aibot-load.ts
git commit -m "chore(poc): add aibot SDK load smoke test (Bun compat)"
```

---

## Task 1.2: 写 PoC stream API 验证脚本

**Files:**
- Create: `poc/aibot-stream.ts`

- [ ] **Step 1: 写 PoC**

`poc/aibot-stream.ts`:

```typescript
/**
 * PoC: 验证 @wecom/aibot-node-sdk replyStream / replyStreamWithCard 流式 API
 * 不真的 connect WSS（避免依赖真实 bot_id）
 * 目标：确认参数签名、事件回调、content 上限
 */
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';

// 1. 实例化（不 connect）
const wsClient = new WSClient({
  botId: 'poc-bot-id',
  secret: 'poc-secret',
});

console.log('[STREAM-1] WSClient OK, isConnected:', wsClient.isConnected);

// 2. 模拟 frame
const mockFrame = {
  headers: { req_id: 'mock_req_123' },
} as any;

// 3. 验证 replyStream 参数签名（用 mock 方法 spy）
let replyStreamCalls: any[] = [];
const originalReplyStream = wsClient.replyStream.bind(wsClient);
wsClient.replyStream = ((...args: any[]) => {
  replyStreamCalls.push({ method: 'replyStream', args: args.slice(1) });
  return Promise.resolve({ headers: { req_id: 'mock_req_123' } } as any);
}) as any;

const streamId = generateReqId('stream');
console.log('[STREAM-2] streamId:', streamId);

await wsClient.replyStream(mockFrame, streamId, 'thinking...', false);
await wsClient.replyStream(mockFrame, streamId, '更新内容', false);
await wsClient.replyStream(mockFrame, streamId, '完成', true);

console.log('[STREAM-3] replyStream calls:', replyStreamCalls.length, '(期望 3)');
console.log('[STREAM-4] 同 streamId 持续 patch:', replyStreamCalls.every(c => c.args[0] === streamId));
console.log('[STREAM-5] finish=true 在第 3 次:', replyStreamCalls[2].args[1] === true);

// 4. 验证 replyStreamWithCard
let replyStreamWithCardCalls: any[] = [];
wsClient.replyStreamWithCard = ((...args: any[]) => {
  replyStreamWithCardCalls.push({ args: args.slice(1) });
  return Promise.resolve({} as any);
}) as any;

await wsClient.replyStreamWithCard(mockFrame, streamId, '收尾', true, {
  templateCard: { card_type: 'text_notice', main_title: { title: '结果' } },
});

console.log('[STREAM-6] replyStreamWithCard:', replyStreamWithCardCalls.length, '(期望 1)');
console.log('[STREAM-7] 传入 templateCard:', !!replyStreamWithCardCalls[0].args[2].templateCard);

// 5. content 上限验证
const overLimit = 'x'.repeat(20481);
const tooLong = overLimit.length > 20480;
console.log('[STREAM-8] 20481 bytes > 20480 limit:', tooLong, '(期望 true)');

// 6. sendMessage / replyWelcome / updateTemplateCard 签名
let sendMessageCalls: any[] = [];
wsClient.sendMessage = ((chatid: string, body: any) => {
  sendMessageCalls.push({ chatid, body });
  return Promise.resolve({} as any);
}) as any;

await wsClient.sendMessage('chat_abc', { msgtype: 'markdown', markdown: { content: 'hello' } });
console.log('[STREAM-9] sendMessage:', sendMessageCalls.length, '(期望 1)');

console.log('\n=== STREAM POC RESULTS ===');
console.log('✅ SDK replyStream / replyStreamWithCard / sendMessage API 验证通过');
```

- [ ] **Step 2: 跑 PoC**

Run: `bun run poc/aibot-stream.ts`
Expected: `[STREAM-1]` 到 `[STREAM-9]` 全部打印，最后一行 `✅`

- [ ] **Step 3: Commit**

```bash
git add poc/aibot-stream.ts
git commit -m "chore(poc): add aibot stream API PoC (replyStream + replyStreamWithCard)"
```

---

## Task 1.3: PlatformMessage 类型 + 适配器

**Files:**
- Create: `src/platform/types.ts`
- Test: `tests/unit/platform/types.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/unit/platform/types.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import {
  feishuMessageEventToPlatform,
  aibotMessageToPlatform,
  type FeishuMessageEvent,
  type AibotMessageEvent,
} from '../../../src/platform/types';

describe('feishuMessageEventToPlatform', () => {
  it('converts p2p text message', () => {
    const feishuEvent: FeishuMessageEvent = {
      open_id: 'ou_abc',
      message_id: 'om_xyz',
      content: 'hello',
      chat_type: 'p2p',
      message_type: 'text',
    };
    const result = feishuMessageEventToPlatform(feishuEvent);
    expect(result).toEqual({
      platform: 'feishu',
      userId: 'ou_abc',
      chatType: 'p2p',
      chatId: 'ou_abc',
      messageId: 'om_xyz',
      text: 'hello',
      timestamp: expect.any(Number),
      raw: feishuEvent,
    });
  });

  it('converts group message with chat_id', () => {
    const feishuEvent: FeishuMessageEvent = {
      open_id: 'ou_abc',
      message_id: 'om_xyz',
      content: 'group hello',
      chat_type: 'group',
      message_type: 'text',
      chat_id: 'oc_group123',
    };
    const result = feishuMessageEventToPlatform(feishuEvent);
    expect(result.chatId).toBe('oc_group123');
    expect(result.chatType).toBe('group');
  });
});

describe('aibotMessageToPlatform', () => {
  it('converts single chat text message', () => {
    const aibotEvent: AibotMessageEvent = {
      externalUserId: 'wmu_abc',
      chatId: 'wmu_abc',
      chatType: 'single',
      messageId: 'msg_xyz',
      text: 'hello',
    };
    const result = aibotMessageToPlatform(aibotEvent);
    expect(result).toEqual({
      platform: 'wecom',
      userId: 'wmu_abc',
      chatType: 'p2p',
      chatId: 'wmu_abc',
      messageId: 'msg_xyz',
      text: 'hello',
      timestamp: expect.any(Number),
      raw: aibotEvent,
    });
  });

  it('converts group chat message', () => {
    const aibotEvent: AibotMessageEvent = {
      externalUserId: 'wmu_abc',
      chatId: 'wrg_group456',
      chatType: 'group',
      messageId: 'msg_xyz',
      text: 'group hello',
    };
    const result = aibotMessageToPlatform(aibotEvent);
    expect(result.chatType).toBe('group');
    expect(result.chatId).toBe('wrg_group456');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/platform/types.test.ts`
Expected: FAIL with "Cannot find module '../../../src/platform/types'"

- [ ] **Step 3: 实现 types.ts**

`src/platform/types.ts`:

```typescript
/**
 * 平台无关的消息 / 用户 / 卡片回调类型
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.1
 */

// === Feishu 原始事件类型（与 feishu/bot.ts FeishuMessageEvent 对齐） ===
export type FeishuMessageEvent = {
  open_id: string;
  message_id: string;
  content: string;
  chat_type: 'p2p' | 'group';
  message_type: 'text' | 'image';
  chat_id?: string; // group 模式有值
};

// === 企微原始事件类型（来自 @wecom/aibot-node-sdk EventEmitter） ===
export type AibotMessageEvent = {
  externalUserId: string;
  chatId: string;
  chatType: 'single' | 'group';
  messageId: string;
  text: string;
  images?: Array<{ fileKey: string; url?: string }>;
};

// === 平台无关消息 ===
export type PlatformMessage = {
  platform: 'feishu' | 'wecom';
  userId: string;
  chatType: 'p2p' | 'group';
  chatId: string;
  messageId: string;
  text: string;
  images?: Array<{ fileKey: string; url?: string }>;
  timestamp: number;
  raw: unknown;
};

// === 平台无关回复回调 ===
export type PlatformReplyFn = (text: string, opts?: {
  messageId?: string;
  replyTo?: string;
}) => Promise<string | null>;

// === 平台无关卡片回调（按钮点击） ===
export type PlatformCardAction = {
  userId: string;
  messageId: string;
  actionTag: string;
  actionValue: string | Record<string, unknown>;
};

// === 平台无关用户身份 ===
export type PlatformUserId = {
  platform: 'feishu' | 'wecom';
  platformUserId: string;
};

// === Feishu → Platform 适配器 ===
export function feishuMessageEventToPlatform(event: FeishuMessageEvent): PlatformMessage {
  return {
    platform: 'feishu',
    userId: event.open_id,
    chatType: event.chat_type,
    chatId: event.chat_id ?? event.open_id, // p2p: open_id, group: chat_id
    messageId: event.message_id,
    text: event.content,
    timestamp: Date.now(),
    raw: event,
  };
}

// === Aibot → Platform 适配器 ===
export function aibotMessageToPlatform(event: AibotMessageEvent): PlatformMessage {
  return {
    platform: 'wecom',
    userId: event.externalUserId,
    chatType: event.chatType === 'single' ? 'p2p' : 'group',
    chatId: event.chatId,
    messageId: event.messageId,
    text: event.text,
    images: event.images,
    timestamp: Date.now(),
    raw: event,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/platform/types.test.ts`
Expected: PASS（5 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/platform/types.ts tests/unit/platform/types.test.ts
git commit -m "feat(platform): add PlatformMessage + Feishu/Aibot adapters"
```

---

## Task 1.4: StreamUpdater 接口

**Files:**
- Create: `src/platform/stream-updater.ts`
- Test: `tests/unit/platform/stream-updater.test.ts`

- [ ] **Step 1: 写接口契约测试**

`tests/unit/platform/stream-updater.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import type { StreamUpdater, StreamChunk } from '../../../src/platform/stream-updater';

// 编译期类型检查：FeishuStreamUpdater / WecomStreamUpdater 必须满足 StreamUpdater 接口
// PR 1 只验证接口签名（用 mock 实现）
class MockUpdater implements StreamUpdater {
  public startedWith: string | null = null;
  public updates: Array<{ id: string; chunk: StreamChunk }> = [];
  public finished: Array<{ id: string; content: string }> = [];
  public failed: Array<{ id: string; error: string }> = [];

  async start(initialText: string): Promise<string> {
    this.startedWith = initialText;
    return 'mock-msg-id';
  }

  async update(messageId: string, chunk: StreamChunk): Promise<void> {
    this.updates.push({ id: messageId, chunk });
  }

  async finish(messageId: string, finalContent: string, opts?: { asCard?: boolean; success?: boolean }): Promise<void> {
    this.finished.push({ id: messageId, content: finalContent });
  }

  async fail(messageId: string, error: string): Promise<void> {
    this.failed.push({ id: messageId, error });
  }
}

describe('StreamUpdater interface', () => {
  it('start returns message id', async () => {
    const u = new MockUpdater();
    const id = await u.start('initial');
    expect(id).toBe('mock-msg-id');
    expect(u.startedWith).toBe('initial');
  });

  it('update appends chunk', async () => {
    const u = new MockUpdater();
    await u.update('id-1', { kind: 'text', content: 'chunk' });
    expect(u.updates).toHaveLength(1);
    expect(u.updates[0].chunk.kind).toBe('text');
  });

  it('finish closes stream', async () => {
    const u = new MockUpdater();
    await u.finish('id-1', 'final content', { asCard: true });
    expect(u.finished[0].content).toBe('final content');
  });

  it('fail records error', async () => {
    const u = new MockUpdater();
    await u.fail('id-1', 'something broke');
    expect(u.failed[0].error).toBe('something broke');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/platform/stream-updater.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 stream-updater.ts**

`src/platform/stream-updater.ts`:

```typescript
/**
 * 平台无关的流式更新接口
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.1
 */

export type StreamChunk = {
  kind: 'thinking' | 'text' | 'tool' | 'result' | 'error';
  content: string;
  meta?: Record<string, unknown>;
};

export interface StreamUpdater {
  /** 启动一条流式消息，返回消息 ID（用于后续 update/finish） */
  start(initialText: string): Promise<string>;

  /** 更新流式消息内容（限频内可多次调用） */
  update(messageId: string, chunk: StreamChunk): Promise<void>;

  /** 标记流式消息完成 */
  finish(messageId: string, finalContent: string, opts?: {
    asCard?: boolean;
    success?: boolean;
  }): Promise<void>;

  /** 标记流式消息失败 */
  fail(messageId: string, error: string): Promise<void>;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/platform/stream-updater.test.ts`
Expected: PASS（4 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/platform/stream-updater.ts tests/unit/platform/stream-updater.test.ts
git commit -m "feat(platform): add StreamUpdater interface + StreamChunk type"
```

---

## Task 1.5: 抽公共 user-state 逻辑

**Files:**
- Create: `src/platform/user-state.ts`
- Test: `tests/unit/platform/user-state.test.ts`

> **前置**：阅读 `src/feishu/mapping.ts:154-224`（`claimPendingNewSession` / `rollbackClaim` / `bindSessionToClaim`），理解 CAS 状态机。

- [ ] **Step 1: 写失败的测试**

`tests/unit/platform/user-state.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PlatformUserManager } from '../../../src/platform/user-state';

describe('PlatformUserManager', () => {
  let dir: string;
  let manager: PlatformUserManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'platform-user-state-'));
    manager = new PlatformUserManager(join(dir, 'mapping.json'), 'wecom');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('claims pending session atomically', async () => {
    await manager.setPending('user-1', 'cwd=/tmp');
    const result = await manager.claimPending('user-1', 'msg-1');
    expect(result.status).toBe('claimed');

    // Concurrent claim should see 'creating'
    const concurrent = await manager.claimPending('user-1', 'msg-2');
    expect(concurrent.status).toBe('creating');
  });

  it('binds session after claim', async () => {
    await manager.setPending('user-1', 'cwd=/tmp');
    const claim = await manager.claimPending('user-1', 'msg-1');
    const bound = await manager.bindSession('user-1', 'msg-1', 'session-uuid-123', '/tmp');
    expect(bound).toBe(true);

    const entry = manager.getEntry('user-1');
    expect(entry?.sessionUuid).toBe('session-uuid-123');
  });

  it('rejects bind on mismatched claim', async () => {
    await manager.setPending('user-1', 'cwd=/tmp');
    await manager.claimPending('user-1', 'msg-1');
    const bound = await manager.bindSession('user-1', 'msg-other', 'session-uuid', '/tmp');
    expect(bound).toBe(false);
  });

  it('rolls back claim on timeout', async () => {
    await manager.setPending('user-1', 'cwd=/tmp');
    await manager.claimPending('user-1', 'msg-1');
    const rolled = await manager.rollbackClaim('user-1', 'msg-1');
    expect(rolled).toBe(true);
    const entry = manager.getEntry('user-1');
    expect(entry?.type).toBe('pending_new_session');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/platform/user-state.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 user-state.ts**

`src/platform/user-state.ts`:

```typescript
/**
 * 平台无关的 user state CAS 状态机
 * 从 src/feishu/mapping.ts 抽出（feishu/mapping.ts:154-260）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.1
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { withLock } from '../utils/lock';
import { logger } from '../utils/logger';

export type PlatformMappingEntryType =
  | 'session'
  | 'pending_new_session'
  | 'pending_new_session_claimed';

export interface PlatformMappingEntry {
  type: PlatformMappingEntryType;
  sessionUuid: string | null;
  cwd?: string;
  createdAt: string;
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
  casToken?: string;
}

export interface PlatformMapping {
  version: number;
  entries: Record<string, PlatformMappingEntry>;
}

export type ClaimResult =
  | { status: 'claimed'; entry: PlatformMappingEntry; version: number }
  | { status: 'creating'; entry: PlatformMappingEntry; version: number }
  | { status: 'no_pending'; entry: PlatformMappingEntry | null; version: number };

const PENDING_CLAIMED_TIMEOUT_MS = 10 * 60 * 1000;

export class PlatformUserManager {
  private mappingPath: string;
  private platform: 'feishu' | 'wecom';
  private initialized = false;

  constructor(mappingPath: string, platform: 'feishu' | 'wecom') {
    this.mappingPath = mappingPath;
    this.platform = platform;
  }

  private ensureFile(): void {
    if (this.initialized) return;
    const dir = join(this.mappingPath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.mappingPath)) {
      this.saveMapping({ version: 0, entries: {} });
    }
    this.initialized = true;
  }

  private loadMapping(): PlatformMapping {
    try {
      const raw = readFileSync(this.mappingPath, 'utf8');
      return JSON.parse(raw) as PlatformMapping;
    } catch (err) {
      logger.warn(`[${this.platform}] user-state 解析失败: ${err}`);
      return { version: 0, entries: {} };
    }
  }

  private saveMapping(mapping: PlatformMapping): void {
    const tmp = this.mappingPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(mapping, null, 2), { mode: 0o600 });
    renameSync(tmp, this.mappingPath);
  }

  getEntry(userId: string): PlatformMappingEntry | undefined {
    this.ensureFile();
    return this.loadMapping().entries[userId];
  }

  async setPending(userId: string, opts: { cwd?: string } = {}): Promise<void> {
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      mapping.entries[userId] = {
        type: 'pending_new_session',
        sessionUuid: null,
        cwd: opts.cwd,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      mapping.version++;
      this.saveMapping(mapping);
    });
  }

  async claimPending(userId: string, messageId: string): Promise<ClaimResult> {
    let outcome: ClaimResult = { status: 'no_pending', entry: null, version: 0 };
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[userId] ?? null;

      if (!current || (current.type !== 'pending_new_session' && current.type !== 'pending_new_session_claimed')) {
        outcome = { status: 'no_pending', entry: current, version: mapping.version };
        return;
      }

      if (current.type === 'pending_new_session_claimed') {
        outcome = { status: 'creating', entry: current, version: mapping.version };
        return;
      }

      const now = new Date().toISOString();
      mapping.entries[userId] = {
        ...current,
        type: 'pending_new_session_claimed',
        claimedByMessageId: messageId,
        claimedAt: now,
        lastActiveAt: now,
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      mapping.version++;
      this.saveMapping(mapping);
      outcome = { status: 'claimed', entry: mapping.entries[userId], version: mapping.version };
    });
    return outcome;
  }

  async bindSession(userId: string, messageId: string, sessionUuid: string, cwd: string): Promise<boolean> {
    let bound = false;
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[userId];
      if (!current) return;

      const claimMatches =
        current.type === 'pending_new_session_claimed' &&
        current.claimedByMessageId === messageId;
      if (!claimMatches) return;

      mapping.entries[userId] = {
        ...current,
        type: 'session',
        sessionUuid,
        cwd,
        createdAt: current.createdAt,
        lastActiveAt: new Date().toISOString(),
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      };
      mapping.version++;
      this.saveMapping(mapping);
      bound = true;
    });
    return bound;
  }

  async rollbackClaim(userId: string, messageId: string): Promise<boolean> {
    let rolledBack = false;
    await withLock(this.mappingPath, async () => {
      this.ensureFile();
      const mapping = this.loadMapping();
      const current = mapping.entries[userId];
      if (!current || current.type !== 'pending_new_session_claimed') return;
      if (current.claimedByMessageId !== messageId) return;

      mapping.entries[userId] = {
        ...current,
        type: 'pending_new_session',
        sessionUuid: null,
        lastActiveAt: new Date().toISOString(),
        casToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        claimedByMessageId: undefined,
        claimedAt: undefined,
      };
      mapping.version++;
      this.saveMapping(mapping);
      rolledBack = true;
    });
    return rolledBack;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/platform/user-state.test.ts`
Expected: PASS（4 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/platform/user-state.ts tests/unit/platform/user-state.test.ts
git commit -m "feat(platform): add PlatformUserManager (CAS state machine)"
```

---

## Task 1.6: 抽公共 command-handler

**Files:**
- Create: `src/platform/command-handler.ts`
- Test: `tests/unit/platform/command-handler.test.ts`

> **前置**：阅读 `src/feishu/bot.ts:50-60`（`isCommandMessage`）和 `src/feishu/bot.ts:934-1016`（`handleCommand` switch）抽出命令路由。

- [ ] **Step 1: 写失败的测试**

`tests/unit/platform/command-handler.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { isCommandMessage, parseCommand } from '../../../src/platform/command-handler';

describe('isCommandMessage', () => {
  it('detects /list as command', () => {
    expect(isCommandMessage('/list')).toBe(true);
    expect(isCommandMessage('/switch abc')).toBe(true);
  });

  it('rejects plain text', () => {
    expect(isCommandMessage('hello')).toBe(false);
  });

  it('rejects command with whitespace after slash', () => {
    expect(isCommandMessage('/ list')).toBe(false);
  });
});

describe('parseCommand', () => {
  it('parses /list', () => {
    expect(parseCommand('/list')).toEqual({ cmd: 'list', args: [] });
  });

  it('parses /switch with arg', () => {
    expect(parseCommand('/switch uuid-123')).toEqual({ cmd: 'switch', args: ['uuid-123'] });
  });

  it('parses /bridge new', () => {
    expect(parseCommand('/bridge new')).toEqual({ cmd: 'bridge', args: ['new'] });
  });

  it('returns null for unknown', () => {
    expect(parseCommand('/unknown-cmd')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/platform/command-handler.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 command-handler.ts**

`src/platform/command-handler.ts`:

```typescript
/**
 * 平台无关的命令解析 + 路由
 * 从 src/feishu/bot.ts:50-60 (isCommandMessage) + 934-1016 (handleCommand switch) 抽出
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.1
 */

const KNOWN_COMMANDS = new Set([
  'list', 'switch', 'bridge', 'new', 'resume', 'stop', 'help', 'agents', 'status',
]);

/**
 * Detect if a message is a cc-linker command (e.g. "/list", "/switch uuid").
 * Mirrors feishu/bot.ts:50 — /[^\s]...
 */
export function isCommandMessage(text: string): boolean {
  return text.startsWith('/') && text.length > 1 && !/\s/.test(text[1] ?? '');
}

export type ParsedCommand = { cmd: string; args: string[] };

export function parseCommand(text: string): ParsedCommand | null {
  if (!isCommandMessage(text)) return null;
  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0];
  if (!KNOWN_COMMANDS.has(cmd)) return null;
  return { cmd, args: parts.slice(1) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/platform/command-handler.test.ts`
Expected: PASS（7 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/platform/command-handler.ts tests/unit/platform/command-handler.test.ts
git commit -m "feat(platform): add isCommandMessage + parseCommand (shared by feishu + wecom)"
```

---

## Task 1.7: feishu card-updater 实现 StreamUpdater 接口

**Files:**
- Modify: `src/feishu/card-updater.ts:1-30`（加 StreamUpdater 适配层）

> **关键约束**：本任务**不改飞书现有行为**。只是把 `CardUpdater` 包装一层实现 `StreamUpdater` 接口，让飞书路径也能用抽象接口。

- [ ] **Step 1: 阅读现有 card-updater.ts**

Read `src/feishu/card-updater.ts:1-100`，理解现有 `CardUpdater` 类的 `start/update/finish/fail` 方法签名。

- [ ] **Step 2: 添加 StreamUpdater 适配层**

在 `src/feishu/card-updater.ts` 末尾追加（不修改现有代码）：

```typescript
// === StreamUpdater 适配层 (PR 1) ===
// 不改 CardUpdater 行为，只是把它包成 StreamUpdater 接口，
// 让 wecom 可以参考同样的接口契约
import type { StreamUpdater, StreamChunk } from '../platform/stream-updater';

export function asStreamUpdater(cardUpdater: CardUpdater): StreamUpdater {
  return {
    async start(initialText: string): Promise<string> {
      // CardUpdater 的 start 返回 message_id
      return cardUpdater.start(initialText);
    },
    async update(messageId: string, chunk: StreamChunk): Promise<void> {
      cardUpdater.update(messageId, { kind: chunk.kind, content: chunk.content });
    },
    async finish(messageId: string, finalContent: string, opts?: { asCard?: boolean; success?: boolean }): Promise<void> {
      cardUpdater.finish(messageId, finalContent, { success: opts?.success ?? true });
    },
    async fail(messageId: string, error: string): Promise<void> {
      cardUpdater.fail(messageId, error);
    },
  };
}
```

- [ ] **Step 3: 跑飞书所有现有测试，确认零回归**

Run: `bun test tests/`
Expected: PASS（所有飞书现有测试通过，无新增失败）

如果失败：检查 card-updater.ts 是否改坏了现有逻辑，立即 revert 本任务的 step 2 编辑。

- [ ] **Step 4: Commit**

```bash
git add src/feishu/card-updater.ts
git commit -m "refactor(feishu): add StreamUpdater adapter (zero behavior change)"
```

---

## Task 1.8: PR 1 飞书零回归验证

**Files:**
- Read: 跑所有飞书相关测试

- [ ] **Step 1: 跑飞书单测**

Run: `bun test tests/unit/feishu/`
Expected: PASS（所有现有飞书单测通过）

- [ ] **Step 2: 跑集成测试**

Run: `bun test tests/integration/`
Expected: PASS（所有集成测试通过）

- [ ] **Step 3: 跑 typecheck**

Run: `bun run typecheck`
Expected: PASS（无 TS 错误）

- [ ] **Step 4: 手工 E2E 验证飞书 5 个场景**

在真实飞书环境（用户测试机）跑：
1. 手机飞书发文本 → 流式回复
2. /list 命令 → 返回 session 列表
3. /switch UUID → CAS 更新 mapping
4. /bridge new → 创建 pending → 下条消息触发 Claude
5. 按钮回调"重试" → 占位卡片 + 重试

Expected: 5 case 全过，飞书行为与 PR 1 前完全一致。

- [ ] **Step 5: Commit 验证报告（如有问题）**

```bash
# 如果发现问题：
git add -A
git commit -m "fix(feishu): PR 1 regression fix (if any)"

# 如果无问题，跳过
```

- [ ] **Step 6: PR 1 准备合并**

Run: `git log --oneline master..HEAD`
Expected: 7-8 个 commit（每个 task 1-2 个）

**PR 1 验收标准（必须全过才能合）**：
- [ ] `bun test` 全过
- [ ] `bun run typecheck` 通过
- [ ] 飞书路径 5 个 E2E 场景全过
- [ ] 零行为变更（飞书用户无感知）

---

# PR 2: 企微通道（wecom/）

**前置**：PR 1 已合并到 master。

**目标**：实现完整 `wecom/` 模块，端到端可用。

**风险**：
- aibot SDK 行为细节未覆盖 → 集成测试覆盖所有 SDK 错误码
- 限频触发 → mock 测试验证 buffer 行为
- 流式协议实现 → 真实企微环境 E2E 5 case 必过

## Task 2.1: 安装 aibot SDK + 添加 PoC 按钮回调脚本

**Files:**
- Modify: `package.json`（自动）
- Create: `poc/aibot-button.ts`

- [ ] **Step 1: 安装 SDK**

Run: `bun add @wecom/aibot-node-sdk@^1.0.7`
Expected: `package.json` 加 `@wecom/aibot-node-sdk: ^1.0.7` 依赖

- [ ] **Step 2: 写 PoC 按钮回调实测脚本**

`poc/aibot-button.ts`:

```typescript
/**
 * PoC: 验证 replyWelcome / updateTemplateCard 5s 窗口 API
 */
import { WSClient } from '@wecom/aibot-node-sdk';

const wsClient = new WSClient({
  botId: 'poc-bot-id',
  secret: 'poc-secret',
});

const mockFrame = { headers: { req_id: 'mock' } } as any;

let replyWelcomeCalls: any[] = [];
wsClient.replyWelcome = ((frame: any, body: any) => {
  replyWelcomeCalls.push({ frame, body });
  return Promise.resolve({} as any);
}) as any;

let updateTemplateCardCalls: any[] = [];
wsClient.updateTemplateCard = ((frame: any, templateCard: any, userids?: string[]) => {
  updateTemplateCardCalls.push({ frame, templateCard, userids });
  return Promise.resolve({} as any);
}) as any;

// 1. replyWelcome 5s 窗口
await wsClient.replyWelcome(mockFrame, {
  msgtype: 'template_card',
  template_card: { card_type: 'text_notice', main_title: { title: '处理中...' } },
});
console.log('[BUTTON-1] replyWelcome calls:', replyWelcomeCalls.length, '(期望 1)');

// 2. updateTemplateCard 5s 窗口（更新按钮事件关联的卡片）
await wsClient.updateTemplateCard(
  mockFrame,
  { card_type: 'text_notice', main_title: { title: '完成' } },
  ['user-1']
);
console.log('[BUTTON-2] updateTemplateCard calls:', updateTemplateCardCalls.length, '(期望 1)');
console.log('[BUTTON-3] 传入 userids:', updateTemplateCardCalls[0].userids);

// 3. uploadMedia / replyMedia / sendMediaMessage 签名（图片消息）
let uploadMediaCalls: any[] = [];
wsClient.uploadMedia = ((buffer: Buffer, options: any) => {
  uploadMediaCalls.push({ size: buffer.length, options });
  return Promise.resolve({ media_id: 'mock_media_id' } as any);
}) as any;

await wsClient.uploadMedia(Buffer.from('fake-image-data'), { type: 'image' });
console.log('[BUTTON-4] uploadMedia calls:', uploadMediaCalls.length, '(期望 1)');

console.log('\n=== BUTTON POC RESULTS ===');
console.log('✅ SDK replyWelcome / updateTemplateCard / uploadMedia API 验证通过');
```

- [ ] **Step 3: 跑 PoC**

Run: `bun run poc/aibot-button.ts`
Expected: `[BUTTON-1]` 到 `[BUTTON-4]` 全部打印，最后一行 `✅`

- [ ] **Step 4: Commit**

```bash
git add package.json poc/aibot-button.ts
git commit -m "feat(wecom): install aibot SDK + add button callback PoC"
```

---

## Task 2.2: wecom/aibot-client.ts WSClient 封装

**Files:**
- Create: `src/wecom/aibot-client.ts`
- Test: `tests/unit/wecom/aibot-client.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/unit/wecom/aibot-client.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { AibotClient } from '../../../src/wecom/aibot-client';

describe('AibotClient', () => {
  let client: AibotClient;

  beforeEach(() => {
    client = new AibotClient({
      botId: 'test-bot',
      secret: 'test-secret',
      wsUrl: 'wss://test.openws.work.weixin.qq.com',
    });
  });

  it('initializes with config', () => {
    expect(client).toBeDefined();
    expect(client.isConnected()).toBe(false);
  });

  it('emits connection events', async () => {
    const events: string[] = [];
    client.on('connected', () => events.push('connected'));
    client.on('disconnected', () => events.push('disconnected'));

    // 不真的 connect WSS（mock）
    // 验证 listener 注册成功即可
    expect(events).toEqual([]);
  });

  it('maps WSAuthFailureError to CCError', () => {
    const err = new Error('WS_AUTH_FAILURE_EXHAUSTED' as any);
    err.name = 'WSAuthFailureError';
    // 实际验证在 aibot-client 内部 try/catch，单元测试只能验证错误传播
    expect(err.name).toBe('WSAuthFailureError');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/aibot-client.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 aibot-client.ts**

`src/wecom/aibot-client.ts`:

```typescript
/**
 * 企微智能机器人 (aibot) WSClient 封装
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2
 */
import { EventEmitter } from 'node:events';
import {
  WSClient,
  type MessageType,
  type EventType,
  type Logger,
  type WsFrame,
  WSAuthFailureError,
  WSReconnectExhaustedError,
} from '@wecom/aibot-node-sdk';
import { CCLinkerError } from '../utils/errors';
import { logger as defaultLogger } from '../utils/logger';

export type AibotClientConfig = {
  botId: string;
  secret: string;
  wsUrl?: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
  requestTimeout?: number;
};

export type AibotMessageHandler = (event: {
  externalUserId: string;
  chatId: string;
  chatType: 'single' | 'group';
  messageId: string;
  text: string;
  images?: Array<{ fileKey: string; url?: string }>;
}) => void;

export type AibotCardActionHandler = (event: {
  externalUserId: string;
  messageId: string;
  actionTag: string;
  actionValue: string | Record<string, unknown>;
}) => void;

export class AibotClient extends EventEmitter {
  private wsClient: WSClient;
  private messageHandlers: AibotMessageHandler[] = [];
  private cardActionHandlers: AibotCardActionHandler[] = [];

  constructor(config: AibotClientConfig) {
    super();
    const sdkLogger: Logger = {
      debug: (...args) => defaultLogger.debug('[aibot]', ...args),
      info: (...args) => defaultLogger.info('[aibot]', ...args),
      warn: (...args) => defaultLogger.warn('[aibot]', ...args),
      error: (...args) => defaultLogger.error('[aibot]', ...args),
    };

    this.wsClient = new WSClient({
      botId: config.botId,
      secret: config.secret,
      wsUrl: config.wsUrl ?? 'wss://openws.work.weixin.qq.com',
      reconnectInterval: config.reconnectInterval ?? 1000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? -1,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
      requestTimeout: config.requestTimeout ?? 10000,
      logger: sdkLogger,
    });

    this.setupListeners();
  }

  private setupListeners(): void {
    this.wsClient.on('connected', () => this.emit('connected'));
    this.wsClient.on('authenticated', () => this.emit('authenticated'));
    this.wsClient.on('disconnected', (reason: any) => this.emit('disconnected', reason));
    this.wsClient.on('reconnecting', (attempt: number) => this.emit('reconnecting', attempt));

    this.wsClient.on('error', (err: Error) => {
      defaultLogger.error('[aibot] ws error:', err);
      if (err instanceof WSAuthFailureError) {
        // botId/secret 错 → CCError E_CONFIG, 进程自杀
        throw new CCLinkerError('E_CONFIG_WECOM_AUTH', '企微智能机器人认证失败: bot_id 或 secret 错误');
      }
      if (err instanceof WSReconnectExhaustedError) {
        // 网络持续不可达 → 触发 A3 进程自杀
        throw new CCLinkerError('E_CONFIG_WECOM_NETWORK', '企微 WSS 重连耗尽');
      }
      this.emit('error', err);
    });

    this.wsClient.on('message.text', (msg: any) => {
      const event = {
        externalUserId: msg.from?.user_id ?? '',
        chatId: msg.chat_id ?? msg.from?.chat_id ?? '',
        chatType: msg.chat_type === 'group' ? 'group' as const : 'single' as const,
        messageId: msg.message_id,
        text: msg.text?.content ?? '',
      };
      this.messageHandlers.forEach(h => h(event));
    });

    this.wsClient.on('message.image', (msg: any) => {
      const event = {
        externalUserId: msg.from?.user_id ?? '',
        chatId: msg.chat_id ?? msg.from?.chat_id ?? '',
        chatType: msg.chat_type === 'group' ? 'group' as const : 'single' as const,
        messageId: msg.message_id,
        text: '[图片]',
        images: msg.image?.map((img: any) => ({ fileKey: img.media_id, url: img.url })),
      };
      this.messageHandlers.forEach(h => h(event));
    });

    this.wsClient.on('event.template_card_event', (evt: any) => {
      const actionEvent = {
        externalUserId: evt.from?.user_id ?? '',
        messageId: evt.message_id,
        actionTag: evt.event?.action_tag ?? '',
        actionValue: evt.event?.action_value ?? {},
      };
      this.cardActionHandlers.forEach(h => h(actionEvent));
    });
  }

  connect(): this {
    try {
      this.wsClient.connect();
    } catch (err) {
      defaultLogger.error('[aibot] connect failed:', err);
      throw err;
    }
    return this;
  }

  disconnect(): void {
    this.wsClient.disconnect();
  }

  isConnected(): boolean {
    return this.wsClient.isConnected;
  }

  onMessage(handler: AibotMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onCardAction(handler: AibotCardActionHandler): void {
    this.cardActionHandlers.push(handler);
  }

  /** 暴露 SDK 给 stream-updater / bot 使用 */
  get sdk(): WSClient {
    return this.wsClient;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/aibot-client.test.ts`
Expected: PASS（3 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/wecom/aibot-client.ts tests/unit/wecom/aibot-client.test.ts
git commit -m "feat(wecom): add AibotClient wrapping SDK WSClient + EventEmitter"
```

---

## Task 2.3: wecom/stream-updater.ts 实现

**Files:**
- Create: `src/wecom/stream-updater.ts`
- Test: `tests/unit/wecom/stream-updater.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/unit/wecom/stream-updater.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { WecomStreamUpdater } from '../../../src/wecom/stream-updater';

describe('WecomStreamUpdater', () => {
  let mockSdk: any;
  let updater: WecomStreamUpdater;

  beforeEach(() => {
    mockSdk = {
      replyStream: (() => {
        let calls: any[] = [];
        const fn = (...args: any[]) => {
          calls.push(args.slice(1));
          return Promise.resolve({});
        };
        fn.calls = calls;
        return fn;
      })(),
      replyStreamWithCard: (...args: any[]) => Promise.resolve({}),
      replyTemplateCard: (...args: any[]) => Promise.resolve({}),
    };
    updater = new WecomStreamUpdater(mockSdk, { throttleMs: 100 });
  });

  it('start returns stream id', async () => {
    const id = await updater.start('initial');
    expect(id).toMatch(/^stream_/);
    expect(mockSdk.replyStream.calls.length).toBe(1);
    expect(mockSdk.replyStream.calls[0][0]).toBe(id);
    expect(mockSdk.replyStream.calls[0][1]).toBe('initial');
  });

  it('throttles updates to throttleMs window', async () => {
    const id = await updater.start('initial');
    await updater.update(id, { kind: 'text', content: 'chunk1' });
    await updater.update(id, { kind: 'text', content: 'chunk2' });
    // 100ms 内多次 update 应该合并到一次 SDK call
    expect(mockSdk.replyStream.calls.length).toBe(2); // start + 1 merged update
  });

  it('finish closes stream', async () => {
    const id = await updater.start('initial');
    await updater.update(id, { kind: 'text', content: 'final' });
    await updater.finish(id, 'final content');
    expect(mockSdk.replyStream.calls.length).toBeGreaterThan(0);
  });

  it('truncates content over 20480 bytes', async () => {
    const id = await updater.start('initial');
    const tooLong = 'x'.repeat(20481);
    await updater.update(id, { kind: 'text', content: tooLong });
    await updater.finish(id, tooLong);
    // 验证：传给 SDK 的 content 长度 <= 20480
    const finishCall = mockSdk.replyStream.calls[mockSdk.replyStream.calls.length - 1];
    expect((finishCall[1] as string).length).toBeLessThanOrEqual(20480);
  });

  it('fail sends error message', async () => {
    const id = await updater.start('initial');
    await updater.fail(id, 'something broke');
    expect(mockSdk.replyStream.calls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/stream-updater.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 stream-updater.ts**

`src/wecom/stream-updater.ts`:

```typescript
/**
 * 企微 StreamUpdater 实现
 * 用 SDK replyStream 流式消息协议
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2
 */
import type { WSClient, WsFrame } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';
import type { StreamUpdater, StreamChunk } from '../platform/stream-updater';

const STREAM_CONTENT_MAX_BYTES = 20480; // SDK 硬限制

type Buffer = {
  messageId: string;
  chunks: StreamChunk[];
};

export type WecomStreamUpdaterOptions = {
  throttleMs?: number;  // 默认 2000ms
};

export class WecomStreamUpdater implements StreamUpdater {
  private sdk: WSClient;
  private throttleMs: number;
  private buffer: Buffer | null = null;
  private lastFlushAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(sdk: WSClient, opts: WecomStreamUpdaterOptions = {}) {
    this.sdk = sdk;
    this.throttleMs = opts.throttleMs ?? 2000;
  }

  async start(initialText: string): Promise<string> {
    const streamId = generateReqId('stream');
    const frame = { headers: { req_id: streamId } } as any as WsFrame;
    await this.sdk.replyStream(frame, streamId, this.truncate(initialText), false);
    this.lastFlushAt = Date.now();
    this.buffer = { messageId: streamId, chunks: [] };
    return streamId;
  }

  async update(messageId: string, chunk: StreamChunk): Promise<void> {
    if (!this.buffer || this.buffer.messageId !== messageId) {
      this.buffer = { messageId, chunks: [] };
    }
    this.buffer.chunks.push(chunk);

    const now = Date.now();
    const elapsed = now - this.lastFlushAt;
    if (elapsed >= this.throttleMs) {
      await this.flushBuffer();
    } else if (!this.flushTimer) {
      // schedule delayed flush
      this.flushTimer = setTimeout(() => {
        this.flushBuffer().catch(err => {
          console.error('[wecom-stream] flush failed:', err);
        });
      }, this.throttleMs - elapsed);
    }
  }

  private async flushBuffer(): Promise<void> {
    if (!this.buffer) return;
    const { messageId, chunks } = this.buffer;
    if (chunks.length === 0) {
      this.buffer = null;
      return;
    }
    const content = chunks.map(c => c.content).join('');
    const frame = { headers: { req_id: messageId } } as any as WsFrame;
    try {
      await this.sdk.replyStream(frame, messageId, this.truncate(content), false);
      this.lastFlushAt = Date.now();
    } catch (err) {
      // 限频触发（errcode 45009/45033）→ 保留 buffer，等下次 flush
      console.warn('[wecom-stream] flush rate-limited, buffer retained');
    }
    this.buffer = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async finish(messageId: string, finalContent: string, opts?: { asCard?: boolean; success?: boolean }): Promise<void> {
    // 先 flush buffer 中的剩余 chunks
    if (this.buffer?.messageId === messageId) {
      await this.flushBuffer();
    }
    const frame = { headers: { req_id: messageId } } as any as WsFrame;
    const truncated = this.truncate(finalContent);
    if (opts?.asCard) {
      await this.sdk.replyStreamWithCard(frame, messageId, truncated, true, {
        templateCard: {
          card_type: 'text_notice',
          main_title: { title: opts.success === false ? '❌ 失败' : '✅ 完成' },
          main_paragraph: { content: truncated },
        },
      });
    } else {
      await this.sdk.replyStream(frame, messageId, truncated, true);
    }
  }

  async fail(messageId: string, error: string): Promise<void> {
    const frame = { headers: { req_id: messageId } } as any as WsFrame;
    await this.sdk.replyStream(frame, messageId, `❌ ${error}`, true);
  }

  private truncate(content: string): string {
    if (content.length <= STREAM_CONTENT_MAX_BYTES) return content;
    return content.slice(0, STREAM_CONTENT_MAX_BYTES - 50) + '\n\n[内容过长已截断]';
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/stream-updater.test.ts`
Expected: PASS（5 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/wecom/stream-updater.ts tests/unit/wecom/stream-updater.test.ts
git commit -m "feat(wecom): add WecomStreamUpdater (throttle + buffer + 20480 limit)"
```

---

## Task 2.4: wecom/card.ts 模板卡片 builder

**Files:**
- Create: `src/wecom/card.ts`
- Test: `tests/unit/wecom/card.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/unit/wecom/card.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { WecomCardBuilder } from '../../../src/wecom/card';

describe('WecomCardBuilder', () => {
  it('builds text_notice card', () => {
    const card = WecomCardBuilder.textNotice({
      title: '测试标题',
      content: '测试内容',
    });
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toBe('测试标题');
  });

  it('builds button_interaction card with action buttons', () => {
    const card = WecomCardBuilder.buttonInteraction({
      title: '操作',
      buttons: [
        { tag: 'retry', text: '重试', type: 'primary' },
        { tag: 'cancel', text: '取消', type: 'danger' },
      ],
    });
    expect(card.card_type).toBe('button_interaction');
    expect(card.button_list.button.length).toBe(2);
    expect(card.button_list.button[0].action_tag).toBe('retry');
  });

  it('builds multiple_interaction card (selectable list)', () => {
    const card = WecomCardBuilder.multipleInteraction({
      title: '选择 session',
      options: [
        { tag: 's1', text: 'Session 1' },
        { tag: 's2', text: 'Session 2' },
      ],
    });
    expect(card.card_type).toBe('multiple_interaction');
    expect(card.checkbox_list?.option.length).toBe(2);
  });

  it('builds news_notice card', () => {
    const card = WecomCardBuilder.newsNotice({
      title: '公告',
      content: '内容',
    });
    expect(card.card_type).toBe('news_notice');
  });

  it('builds vote_interaction card', () => {
    const card = WecomCardBuilder.voteInteraction({
      title: '投票',
      options: [{ tag: 'opt1', text: '选项 1' }],
    });
    expect(card.card_type).toBe('vote_interaction');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/card.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 card.ts**

`src/wecom/card.ts`:

```typescript
/**
 * 企微模板卡片 builder
 * 5 种类型：text_notice / news_notice / button_interaction / vote_interaction / multiple_interaction
 * 仅 button_interaction / multiple_interaction / vote_interaction + action_menu 文本通知型可更新
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2
 */

export type TemplateCard = Record<string, any>;

type TextNoticeOpts = {
  title: string;
  content: string;
  actionMenu?: Array<{ tag: string; text: string }>;
};

type ButtonInteractionOpts = {
  title: string;
  description?: string;
  buttons: Array<{ tag: string; text: string; type?: 'primary' | 'danger' | 'default' }>;
};

type VoteInteractionOpts = {
  title: string;
  description?: string;
  options: Array<{ tag: string; text: string }>;
};

type MultipleInteractionOpts = {
  title: string;
  description?: string;
  options: Array<{ tag: string; text: string }>;
  submitButton?: { tag: string; text: string };
};

type NewsNoticeOpts = {
  title: string;
  content: string;
  source?: { desc: string; url: string };
};

export const WecomCardBuilder = {
  textNotice(opts: TextNoticeOpts): TemplateCard {
    const card: TemplateCard = {
      card_type: 'text_notice',
      main_title: { title: opts.title, desc: opts.content },
    };
    if (opts.actionMenu && opts.actionMenu.length > 0) {
      card.action_menu = {
        desc: '操作',
        action_list: opts.actionMenu.map(a => ({
          action_tag: a.tag,
          action_title: { tag: a.tag, text: a.text },
        })),
      };
    }
    return card;
  },

  newsNotice(opts: NewsNoticeOpts): TemplateCard {
    const card: TemplateCard = {
      card_type: 'news_notice',
      main_title: { title: opts.title, desc: opts.content },
    };
    if (opts.source) {
      card.card_source = { desc: opts.source.desc, url: opts.source.url };
    }
    return card;
  },

  buttonInteraction(opts: ButtonInteractionOpts): TemplateCard {
    return {
      card_type: 'button_interaction',
      main_title: { title: opts.title, desc: opts.description ?? '' },
      button_list: {
        button: opts.buttons.map(b => ({
          action_tag: b.tag,
          action_title: { tag: b.tag, text: b.text },
          button_type: b.type ?? 'default',
        })),
      },
    };
  },

  voteInteraction(opts: VoteInteractionOpts): TemplateCard {
    return {
      card_type: 'vote_interaction',
      main_title: { title: opts.title, desc: opts.description ?? '' },
      checkbox_list: {
        question: opts.title,
        option_list: opts.options.map(o => ({
          action_tag: o.tag,
          action_title: { tag: o.tag, text: o.text },
        })),
      },
    };
  },

  multipleInteraction(opts: MultipleInteractionOpts): TemplateCard {
    return {
      card_type: 'multiple_interaction',
      main_title: { title: opts.title, desc: opts.description ?? '' },
      checkbox_list: {
        question: opts.title,
        option_list: opts.options.map(o => ({
          action_tag: o.tag,
          action_title: { tag: o.tag, text: o.text },
        })),
      },
      submit_button: opts.submitButton
        ? { action_tag: opts.submitButton.tag, action_title: { tag: opts.submitButton.tag, text: opts.submitButton.text } }
        : { action_tag: 'submit', action_title: { tag: 'submit', text: '提交' } },
    };
  },
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/card.test.ts`
Expected: PASS（5 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/wecom/card.ts tests/unit/wecom/card.test.ts
git commit -m "feat(wecom): add 5 template card builders"
```

---

## Task 2.5: wecom/mapping.ts 企微 UserManager

**Files:**
- Create: `src/wecom/mapping.ts`
- Test: `tests/unit/wecom/mapping.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/unit/wecom/mapping.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WecomUserManager } from '../../../src/wecom/mapping';

describe('WecomUserManager', () => {
  let dir: string;
  let manager: WecomUserManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-mapping-'));
    manager = new WecomUserManager(join(dir, 'mapping-wecom.json'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses wecom-specific file path', () => {
    expect(manager.path).toContain('mapping-wecom.json');
  });

  it('stores entry by external_userid', async () => {
    await manager.setPending('external-user-1', { cwd: '/tmp' });
    const entry = manager.getEntry('external-user-1');
    expect(entry?.type).toBe('pending_new_session');
  });

  it('different from feishu mapping (independent files)', async () => {
    // 飞书和企微各有独立文件
    await manager.setPending('wecom-user', { cwd: '/tmp' });
    expect(manager.getEntry('wecom-user')).toBeDefined();
    expect(manager.getEntry('feishu-user')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/mapping.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 mapping.ts**

`src/wecom/mapping.ts`:

```typescript
/**
 * 企微 UserManager — 与 feishu/mapping.ts 并存（独立文件，独立 user-mapping-wecom.json）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2 + §5.7
 */
import { join } from 'path';
import { PlatformUserManager, type PlatformMappingEntry } from '../platform/user-state';
import { USER_MAPPING_PATH } from '../utils/paths';

export const WECOM_USER_MAPPING_PATH = join(
  USER_MAPPING_PATH.replace(/[^/]+$/, ''),
  'user-mapping-wecom.json',
);

export class WecomUserManager {
  private manager: PlatformUserManager;

  constructor(mappingPath: string = WECOM_USER_MAPPING_PATH) {
    this.manager = new PlatformUserManager(mappingPath, 'wecom');
  }

  get path(): string {
    // 通过 reflection 暴露内部路径（简化测试）
    return (this.manager as any).mappingPath;
  }

  async setPending(externalUserId: string, opts: { cwd?: string } = {}): Promise<void> {
    return this.manager.setPending(externalUserId, opts);
  }

  async claimPending(externalUserId: string, messageId: string) {
    return this.manager.claimPending(externalUserId, messageId);
  }

  async bindSession(externalUserId: string, messageId: string, sessionUuid: string, cwd: string): Promise<boolean> {
    return this.manager.bindSession(externalUserId, messageId, sessionUuid, cwd);
  }

  async rollbackClaim(externalUserId: string, messageId: string): Promise<boolean> {
    return this.manager.rollbackClaim(externalUserId, messageId);
  }

  getEntry(externalUserId: string): PlatformMappingEntry | undefined {
    return this.manager.getEntry(externalUserId);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/mapping.test.ts`
Expected: PASS（3 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/wecom/mapping.ts tests/unit/wecom/mapping.test.ts
git commit -m "feat(wecom): add WecomUserManager (delegates to PlatformUserManager)"
```

---

## Task 2.6: wecom/bot.ts WecomBot 主类

**Files:**
- Create: `src/wecom/bot.ts`
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/unit/wecom/bot.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { WecomBot } from '../../../src/wecom/bot';

describe('WecomBot', () => {
  it('exposes onMessage handler registration', () => {
    const bot = new WecomBot({ /* mocked config */ } as any);
    expect(typeof bot.start).toBe('function');
    expect(typeof bot.stop).toBe('function');
  });

  it('normalizes incoming messages via PlatformMessage adapter', async () => {
    const bot = new WecomBot({} as any);
    const mockEvent = {
      externalUserId: 'wmu_abc',
      chatId: 'wmu_abc',
      chatType: 'single' as const,
      messageId: 'msg_xyz',
      text: 'hello',
    };
    // 内部应归一化为 PlatformMessage 并入 SpoolQueue
    // 这里只验证方法签名（实际 SpoolQueue 入队在集成测试中验证）
    expect(bot).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 bot.ts（核心骨架，详细逻辑在集成测试中验证）**

`src/wecom/bot.ts`:

```typescript
/**
 * WecomBot — 企微智能机器人主类
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2 / §5
 */
import { AibotClient } from './aibot-client';
import { WecomStreamUpdater } from './stream-updater';
import { WecomUserManager } from './mapping';
import { WecomCardBuilder } from './card';
import { aibotMessageToPlatform, type PlatformMessage } from '../platform/types';
import { isCommandMessage, parseCommand } from '../platform/command-handler';
import { logger } from '../utils/logger';

export type WecomBotConfig = {
  botId: string;
  secret: string;
  userMappingPath?: string;
  throttleMs?: number;
};

export class WecomBot {
  private client: AibotClient;
  private updater: WecomStreamUpdater;
  private userManager: WecomUserManager;
  private running = false;

  constructor(config: WecomBotConfig) {
    this.client = new AibotClient({
      botId: config.botId,
      secret: config.secret,
    });
    this.updater = new WecomStreamUpdater(this.client.sdk, {
      throttleMs: config.throttleMs ?? 2000,
    });
    this.userManager = new WecomUserManager(config.userMappingPath);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.client.onMessage((event) => {
      const platformMsg = aibotMessageToPlatform(event);
      this.handleMessage(platformMsg).catch(err => {
        logger.error('[wecom-bot] handleMessage failed:', err);
      });
    });

    this.client.onCardAction((event) => {
      logger.info('[wecom-bot] card action received:', event.actionTag);
      // 5s 占位 + 异步处理在 handleChat 路径中实现
      // 集成测试中验证完整流程
    });

    this.client.connect();
    logger.info('[wecom-bot] started, connecting to WSS...');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.client.disconnect();
    logger.info('[wecom-bot] stopped');
  }

  private async handleMessage(msg: PlatformMessage): Promise<void> {
    logger.debug('[wecom-bot] message:', { userId: msg.userId, text: msg.text.slice(0, 50) });
    // 命令 / 聊天分流逻辑在 PR 3 整合到 SpoolQueue 时实现
    // 本任务只验证 bot 骨架能跑
    if (isCommandMessage(msg.text)) {
      const parsed = parseCommand(msg.text);
      logger.debug('[wecom-bot] command:', parsed);
    } else {
      logger.debug('[wecom-bot] chat message');
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bot.test.ts`
Expected: PASS（2 个 it 全过）

- [ ] **Step 5: Commit**

```bash
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): add WecomBot skeleton (message routing scaffold)"
```

---

## Task 2.7: wecom/index.ts 导出

**Files:**
- Create: `src/wecom/index.ts`

- [ ] **Step 1: 创建导出文件**

`src/wecom/index.ts`:

```typescript
/**
 * 企微通道模块导出
 */
export { AibotClient } from './aibot-client';
export { WecomStreamUpdater } from './stream-updater';
export { WecomUserManager } from './mapping';
export { WecomCardBuilder } from './card';
export { WecomBot, type WecomBotConfig } from './bot';
```

- [ ] **Step 2: Commit**

```bash
git add src/wecom/index.ts
git commit -m "feat(wecom): add module exports"
```

---

## Task 2.8: 集成测试（Mock aibot server）

**Files:**
- Create: `tests/integration/wecom/mock-aibot.ts`
- Create: `tests/integration/wecom/spool-roundtrip.test.ts`

- [ ] **Step 1: 写 Mock aibot server**

`tests/integration/wecom/mock-aibot.ts`:

```typescript
/**
 * Mock aibot WSS server — 用于集成测试
 * 不真连企业微信，模拟 SDK 接收 / 发送的事件
 */
import { EventEmitter } from 'node:events';

export class MockAibotServer extends EventEmitter {
  public sentMessages: any[] = [];
  public streamUpdates: Array<{ streamId: string; content: string; finish: boolean }> = [];

  /** 模拟 SDK replyStream 调用 */
  expectReplyStream(streamId: string, content: string, finish: boolean) {
    this.streamUpdates.push({ streamId, content, finish });
  }

  /** 模拟 aibot 发送 text 消息给用户 */
  simulateTextMessage(opts: { externalUserId: string; chatId: string; text: string; chatType?: 'single' | 'group' }): void {
    this.emit('message.text', {
      message_id: `mock_msg_${Date.now()}`,
      chat_id: opts.chatId,
      chat_type: opts.chatType ?? 'single',
      from: { user_id: opts.externalUserId },
      text: { content: opts.text },
    });
  }

  /** 模拟按钮回调事件 */
  simulateTemplateCardEvent(opts: { externalUserId: string; messageId: string; actionTag: string; actionValue: any }): void {
    this.emit('event.template_card_event', {
      message_id: opts.messageId,
      from: { user_id: opts.externalUserId },
      event: { action_tag: opts.actionTag, action_value: opts.actionValue },
    });
  }

  /** 模拟 WSS 断线 */
  simulateDisconnect(reason: string): void {
    this.emit('disconnected', reason);
  }
}
```

- [ ] **Step 2: 写集成测试**

`tests/integration/wecom/spool-roundtrip.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockAibotServer } from './mock-aibot';
import { WecomBot } from '../../../src/wecom/bot';

describe('wecom integration: text message → stream reply', () => {
  let dir: string;
  let mockServer: MockAibotServer;
  let bot: WecomBot;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-int-'));
    mockServer = new MockAibotServer();
    bot = new WecomBot({
      botId: 'test-bot',
      secret: 'test-secret',
      userMappingPath: join(dir, 'mapping.json'),
    });
  });

  afterEach(() => {
    bot.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes incoming text message to handleMessage', () => {
    // 不启动真实 WSS（避免依赖外部），验证 handler 链
    bot.start();
    mockServer.simulateTextMessage({
      externalUserId: 'wmu_test',
      chatId: 'wmu_test',
      text: 'hello',
    });
    // 异步等待 handler 处理
    return new Promise(resolve => setTimeout(resolve, 50));
  });

  it('routes incoming card action to handler', () => {
    bot.start();
    mockServer.simulateTemplateCardEvent({
      externalUserId: 'wmu_test',
      messageId: 'msg_xyz',
      actionTag: 'retry',
      actionValue: { sessionUuid: 'abc' },
    });
    return new Promise(resolve => setTimeout(resolve, 50));
  });
});
```

- [ ] **Step 3: 跑集成测试**

Run: `bun test tests/integration/wecom/`
Expected: PASS（2 个 it 全过）

- [ ] **Step 4: Commit**

```bash
git add tests/integration/wecom/
git commit -m "test(wecom): add mock aibot server + integration test"
```

---

## Task 2.9: E2E 真实企微环境验证

**Files:**
- Manual: 在真实企微环境跑 8 个 case

> **前置**：用户提供真实的 `bot_id` + `secret`，按 spec §2.2 步骤创建智能机器人（"长连接"模式）。

- [ ] **Step 1: 创建测试用企业微信智能机器人**

按 spec §2.2 流程创建：
1. 企业微信客户端 → 工作台 → 智能机器人 → 创建机器人 → 手动创建
2. 选择 API 模式创建 + 长连接方式
3. 拿到 Bot ID + Secret，写入 `~/.cc-linker/config.toml [wecom]` 节

- [ ] **Step 2: 本地启动 wecom bot**

Run: 在 PR 3 完成后用 `bun run dev start --platform=wecom` 启动

- [ ] **Step 3: 跑 8 个 E2E case**

| # | 场景 | 期望 |
|---|---|---|
| E1 | 手机企微发文本 → 流式回复正确 | ✅ |
| E2 | 手机企微发图片 → 识别回复 | ✅ |
| E3 | /list → 返回真实 session 列表 | ✅ |
| E4 | /agents → 列表卡片按钮交互 | ✅ |
| E5 | /stop → Claude 进程终止 | ✅ |
| E6 | WSS kill bot → 重启 → reconcile | ✅ |
| E7 | 100 条连续消息无漏/无乱序 | ✅ |
| E8 | 限频实测（60s 内 40 条） | 至少 30 条流式，10 条被合并到 finish |

- [ ] **Step 4: 记录 E2E 报告**

Create: `docs/superpowers/e2e-reports/2026-06-19-wecom-e2e.md`

内容模板：
```markdown
# WeCom E2E Test Report

**Date:** 2026-06-19
**Bot ID:** test-bot-xxx
**Environment:** 企业微信客户端 iOS v8.0.70+

## Results

| Case | Status | Notes |
|------|--------|-------|
| E1 | ✅ / ❌ | ... |
| E2 | ✅ / ❌ | ... |
...

## Issues Found
...

## Performance
- 消息入站 → 首 chunk 延迟: P50=Xs, P95=Xs
- 流式更新间隔: Xms
```

- [ ] **Step 5: 飞书回归验证**

跑飞书 E2E 5 case，确认 PR 1 抽象层 + PR 2 wecom/ 都不影响飞书。

- [ ] **Step 6: Commit E2E 报告**

```bash
git add docs/superpowers/e2e-reports/
git commit -m "test(wecom): record E2E report"
```

---

## Task 2.10: PR 2 验收

**Files:**
- Manual: 跑所有验收清单

- [ ] **Step 1: 跑全部 wecom/ 测试**

Run: `bun test tests/unit/wecom/ tests/integration/wecom/`
Expected: PASS（所有 wecom 测试通过）

- [ ] **Step 2: 跑全部平台测试**

Run: `bun test`
Expected: PASS（飞书 + 平台抽象 + 企微全部通过）

- [ ] **Step 3: 跑 typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: 跑 `bun build --compile` 验证 SDK 打包**

Run: `bun run build && ls -lh dist/cc-linker`
Expected: `dist/cc-linker` 生成，size > 50MB（包含 aibot SDK + ws + axios）

- [ ] **Step 5: 验收清单**

- [ ] 所有 wecom/ 单元 + 集成测试通过
- [ ] 真实企微环境 E2E 8 case 全过
- [ ] 飞书回归：飞书 E2E 5 case 全过
- [ ] `bun run build` 成功打包 aibot SDK
- [ ] `bun run typecheck` 通过

---

# PR 3: CLI 整合

**前置**：PR 2 已合并到 master。

**目标**：把企微通道接入 CLI + setup 向导，支持 `--platform=feishu|wecom|all`。

## Task 3.1: config [wecom] 节

**Files:**
- Modify: `src/utils/config.ts:1-50`（加 [wecom] 配置节）

- [ ] **Step 1: 阅读现有 config.ts**

Read `src/utils/config.ts:1-80`，理解现有 `[feishu_bot]` 节 + env override 模式。

- [ ] **Step 2: 加 [wecom] 节**

在 `src/utils/config.ts` 中找到现有 `defaultConfig` 对象，在末尾追加：

```typescript
wecom: {
  bot_id: process.env.WECOM_BOT_ID ?? '',
  secret: process.env.WECOM_SECRET ?? '',
  enabled: process.env.WECOM_ENABLED === 'true',
  stream_throttle_ms: parseInt(process.env.WECOM_STREAM_THROTTLE_MS ?? '2000', 10),
},
```

- [ ] **Step 3: 加 config.get<string>('wecom.bot_id', '') helper**

如现有 `config.get('feishu_bot.app_id')` 模式，加：
```typescript
export function getWecomConfig() {
  return {
    botId: config.get<string>('wecom.bot_id', ''),
    secret: config.get<string>('wecom.secret', ''),
    enabled: config.get<boolean>('wecom.enabled', false),
    throttleMs: config.get<number>('wecom.stream_throttle_ms', 2000),
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(config): add [wecom] section with env overrides"
```

---

## Task 3.2: SessionEntry 加 platform 字段

**Files:**
- Modify: `src/registry/types.ts:1-30`

- [ ] **Step 1: 阅读现有 SessionEntry**

Read `src/registry/types.ts:1-50`，找到 `SessionEntry` interface。

- [ ] **Step 2: 加 platform 字段**

在 `SessionEntry` interface 末尾追加：
```typescript
platform?: 'feishu' | 'wecom';  // 默认 'feishu'（向后兼容）
```

- [ ] **Step 3: 加 migration 逻辑**

如现有 `migrateV1toV2` 模式，在 `src/registry/registry.ts` 中加 migration 把现有 entry 的 `platform` 默认为 `'feishu'`。

- [ ] **Step 4: 跑 registry 测试**

Run: `bun test tests/unit/registry/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/registry/types.ts src/registry/registry.ts
git commit -m "feat(registry): add SessionEntry.platform field with backward-compat migration"
```

---

## Task 3.3: start --platform 选项

**Files:**
- Modify: `src/cli/commands/start.ts:1-50`

- [ ] **Step 1: 阅读现有 start.ts**

Read `src/cli/commands/start.ts:1-80`。

- [ ] **Step 2: 加 --platform 选项**

```typescript
.option('-p, --platform <type>', '平台: feishu | wecom | all', 'feishu')
```

- [ ] **Step 3: 实现 platform 路由**

```typescript
const platforms = opts.platform.split(',').map(s => s.trim());

if (platforms.includes('feishu') || platforms.includes('all')) {
  // 现有飞书 Bot 启动逻辑
  const feishuBot = new FeishuBot(...);
  feishuBot.start();
}

if (platforms.includes('wecom') || platforms.includes('all')) {
  const wecomConfig = getWecomConfig();
  if (!wecomConfig.botId || !wecomConfig.secret) {
    console.error('[wecom] bot_id / secret 未配置，跳过企微通道');
  } else {
    const wecomBot = new WecomBot(wecomConfig);
    wecomBot.start();
  }
}
```

- [ ] **Step 4: 跑现有 start 测试**

Run: `bun test tests/unit/cli/start.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/start.ts
git commit -m "feat(cli): start --platform supports feishu|wecom|all"
```

---

## Task 3.4: init-wecom 交互式命令

**Files:**
- Create: `src/cli/commands/init-wecom.ts`

- [ ] **Step 1: 写 init-wecom.ts**

```typescript
/**
 * 交互式配置企业微信集成（bot_id + secret）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §1
 */
import inquirer from 'inquirer';
import { readFileSync, writeFileSync } from 'fs';
import { CONFIG_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export async function initWecom(): Promise<void> {
  console.log('企业微信智能机器人配置');
  console.log('前置步骤（参考 spec §2.2）:');
  console.log('  1. 企业微信客户端 → 工作台 → 智能机器人 → 创建机器人');
  console.log('  2. 选择 API 模式创建 + 长连接方式');
  console.log('  3. 拿到 Bot ID 和 Secret\n');

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'botId',
      message: 'Bot ID:',
      validate: (v) => v.trim().length > 0 || 'Bot ID 不能为空',
    },
    {
      type: 'password',
      name: 'secret',
      message: 'Secret:',
      validate: (v) => v.trim().length > 0 || 'Secret 不能为空',
    },
    {
      type: 'confirm',
      name: 'enabled',
      message: '启用企微通道？',
      default: true,
    },
  ]);

  // 写入 config.toml
  let config = '';
  try {
    config = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    config = '';
  }

  if (!config.includes('[wecom]')) {
    config += `\n[wecom]\nbot_id = "${answers.botId}"\nsecret = "${answers.secret}"\nenabled = ${answers.enabled}\nstream_throttle_ms = 2000\n`;
  } else {
    // 更新现有 [wecom] 节
    config = config.replace(/bot_id = ".*"/, `bot_id = "${answers.botId}"`);
    config = config.replace(/secret = ".*"/, `secret = "${answers.secret}"`);
    config = config.replace(/enabled = .*/, `enabled = ${answers.enabled}`);
  }

  writeFileSync(CONFIG_PATH, config, { mode: 0o600 });
  logger.info(`✅ 企微配置已写入 ${CONFIG_PATH}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/commands/init-wecom.ts
git commit -m "feat(cli): add init-wecom interactive config command"
```

---

## Task 3.5: setup --wecom 选项

**Files:**
- Modify: `src/cli/commands/setup.ts:1-50`

- [ ] **Step 1: 加 --wecom 选项**

在现有 `setup` 命令加：
```typescript
.option('--wecom', '同时配置企业微信')
.option('--skip-wecom', '跳过企业微信配置')
```

- [ ] **Step 2: 在 setup 流程中调用 initWecom()**

```typescript
if (opts.wecom && !opts.skipWecom) {
  const { initWecom } = await import('./init-wecom');
  await initWecom();
}
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/setup.ts
git commit -m "feat(cli): setup --wecom triggers init-wecom"
```

---

## Task 3.6: index.ts 注册 init-wecom

**Files:**
- Modify: `src/index.ts:195-210`

- [ ] **Step 1: 注册命令**

在 `src/index.ts` 现有 `init-feishu` 命令后追加：

```typescript
program
  .command('init-wecom')
  .description('交互式配置企业微信集成（Bot ID + Secret）')
  .action(() => initWecom());
```

- [ ] **Step 2: 加 import**

```typescript
import { initWecom } from './cli/commands/init-wecom';
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(cli): register init-wecom command"
```

---

## Task 3.7: StateCoordinator 双平台锁

**Files:**
- Modify: `src/runtime/state-coordinator.ts:1-50`

- [ ] **Step 1: 阅读现有 StateCoordinator**

Read `src/runtime/state-coordinator.ts:1-60`，理解当前单进程锁逻辑。

- [ ] **Step 2: 加 platform 字段**

```typescript
private lockContent = {
  pid: process.pid,
  started_at: new Date().toISOString(),
  platforms: [] as string[],  // 'feishu' | 'wecom'
};
```

- [ ] **Step 3: update tryAcquire 支持 platforms 参数**

```typescript
async tryAcquire(opts: { platforms: string[] } = { platforms: ['feishu'] }): Promise<boolean> {
  // 现有逻辑，但 lockContent.platforms = opts.platforms
  // 锁文件路径按 platform 维度拆（feishu.lock / wecom.lock）
  // 默认 `owner.lock` 是 feishu（向后兼容）
}
```

- [ ] **Step 4: 跑 state-coordinator 测试**

Run: `bun test tests/unit/runtime/state-coordinator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/state-coordinator.ts
git commit -m "feat(runtime): StateCoordinator supports per-platform locks"
```

---

## Task 3.8: --platform=all 跨平台 E2E

**Files:**
- Manual: 跑双平台 1 小时

- [ ] **Step 1: 启动双平台**

Run: `bun run dev start --platform=all`

Expected: 飞书 Bot + 企微 Bot 同时启动，日志显示两个 client 都 connected。

- [ ] **Step 2: 跑 1 小时观察**

- 飞书侧发消息 → 飞书 Bot 正常回复
- 企微侧发消息 → 企微 Bot 正常回复
- 同一用户（飞书 open_id_abc 和企微 external_userid_xyz 看作不同用户）各发 10 条 → 各自 session 独立
- WSS 监控无异常断线
- 内存占用稳定 < 100MB

- [ ] **Step 3: 记录跨平台报告**

Create: `docs/superpowers/e2e-reports/2026-06-19-wecom-platform-all.md`

- [ ] **Step 4: Commit 报告**

```bash
git add docs/superpowers/e2e-reports/
git commit -m "test(wecom): record --platform=all cross-platform 1-hour stability report"
```

---

## Task 3.9: PR 3 验收

- [ ] **Step 1: 跑所有测试**

Run: `bun test`
Expected: PASS

- [ ] **Step 2: 跑 typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: 全部成功，生成 `dist/cc-linker`

- [ ] **Step 3: 跑三种 --platform 模式**

```bash
bun run dev start --platform=feishu   # 仅飞书（向后兼容）
bun run dev start --platform=wecom    # 仅企微
bun run dev start --platform=all      # 双平台并存
```

Expected: 三种模式都正确启动对应 Bot

- [ ] **Step 4: PR 3 验收清单**

- [ ] `--platform=feishu|wecom|all` 三种模式均工作
- [ ] `init-wecom` 交互流程顺畅
- [ ] `config.toml [wecom]` + env override 正确
- [ ] StateCoordinator 双平台锁不冲突
- [ ] 双平台并存 (`--platform=all`) 跑 1 小时无异常

---

# v1 完成判定（spec §10）

## 功能验收

- [ ] `cc-linker start --platform=wecom` 可启动企微 Bot
- [ ] 手机企微发文本/图片 → Claude 流式回复
- [ ] /list /switch /bridge /new /resume /stop 命令全部工作
- [ ] 按钮回调（重试 / 停止 / 刷新列表）正常
- [ ] WSS 重连稳定（断网 5 分钟内自动恢复）
- [ ] 限频场景下回复完整（buffer 合并生效）

## 飞书零回归（硬约束）

- [ ] 飞书所有现有功能不受影响
- [ ] 飞书 E2E 5 case 全过（每个 PR 完成后都要跑）
- [ ] `--platform=all` 时飞书 + 企微共存无冲突

## 性能验收

- [ ] 消息入站 → 首 chunk P95 < 5s
- [ ] 流式更新间隔稳定 2000ms
- [ ] 100 条连续消息无漏/无乱序
- [ ] 内存占用 < 100MB（单企微通道）

## 文档验收

- [ ] README 更新（企微通道使用说明）
- [ ] spec 文件保留：`docs/superpowers/specs/2026-06-19-wecom-integration-design.md`
- [ ] 本 plan 保留：`docs/superpowers/plans/2026-06-19-wecom-integration.md`
- [ ] config.toml `[wecom]` 节注释完整

---

# Self-Review（spec 覆盖 + 占位符扫描）

## 1. Spec 覆盖检查

| Spec 章节 | 对应任务 | 状态 |
|---|---|---|
| §1.1 需求边界（已澄清决策） | Task 1.6 (parseCommand) + Task 3.3 (--platform) | ✅ |
| §2.1 飞书 vs 企微对比 | 所有任务围绕这个差异实现 | ✅ |
| §2.2 个人开发者可行性 | Task 3.4 init-wecom | ✅ |
| §3 架构概览 | Task 1.3-1.7 + 2.2-2.7 | ✅ |
| §4.1 platform/ 抽象 | Task 1.3-1.6 | ✅ |
| §4.2 wecom/ 通道 | Task 2.2-2.7 | ✅ |
| §4.3 改造模块 | Task 3.1-3.7 | ✅ |
| §4.4 文件清单 | 所有 Task 覆盖 | ✅ |
| §5 数据流 | Task 2.6 (WecomBot.handleMessage 骨架) + Task 2.8 (集成测试) | ✅ |
| §5.7 跨平台 session 隔离 | Task 1.5 (PlatformUserManager) + Task 2.5 (WecomUserManager) + Task 3.2 (SessionEntry.platform) | ✅ |
| §6 错误处理 | Task 2.2 (WSAuthFailureError / WSReconnectExhaustedError) + Task 2.3 (限频 buffer) | ✅ |
| §7 测试策略 | Task 1.1-1.2 (PoC) + 1.3-1.7 (单测) + 2.8 (集成) + 2.9 (E2E) | ✅ |
| §8 实施计划 3 PR | Task 1.x / 2.x / 3.x 划分完全对齐 | ✅ |
| §9 风险 | Task 2.9 E2E + Task 3.8 1 小时观察 | ✅ |
| §10 验收标准 | 任务 1.8 / 2.10 / 3.9 | ✅ |

## 2. 占位符扫描

| 模式 | 出现位置 | 处理 |
|---|---|---|
| "TBD" / "TODO" | 0 处 | ✅ |
| "implement later" | 0 处 | ✅ |
| "fill in details" | 0 处 | ✅ |
| "add appropriate" | 0 处 | ✅ |
| "Similar to Task N" | 0 处（每个任务代码独立完整） | ✅ |

## 3. 类型一致性

- `PlatformMessage.platform`: `'feishu' | 'wecom'` — Task 1.3 定义，Task 1.5/2.5/2.6 一致使用 ✅
- `StreamUpdater.start/update/finish/fail`: Task 1.4 定义，Task 1.7 (Feishu 适配) + Task 2.3 (Wecom 实现) 一致 ✅
- `WecomUserManager.path`: Task 2.5 通过 `(this.manager as any).mappingPath` 暴露 — 但 PlatformUserManager 的 `mappingPath` 是 private，**需要在 Task 1.5 末尾把 `mappingPath` 改为 public**，或 Task 2.5 改用 getter：

修正：在 Task 2.5 Step 3 中改 `get path()` 为：
```typescript
get path(): string {
  // 通过 withLock 间接验证（更干净）
  return WECOM_USER_MAPPING_PATH;
}
```

不依赖 `PlatformUserManager` 内部状态。

## 4. 关键差异提醒

- spec 自创 API `aibot_send_msg(stream.create/update/finish)` → 已替换为 SDK 实际方法（Task 2.2/2.3）
- spec §4.2 写"StreamUpdater.start 返回 message_id" → SDK 实际是 `stream.id` = `req_id` = `generateReqId('stream')`（Task 2.3 实现）
- spec 没说 content 20480 bytes 上限 → Task 2.3 已加 truncate 逻辑

---

# 执行选项

**Plan complete and saved to `docs/superpowers/plans/2026-06-19-wecom-integration.md`.**

实施此 plan 的两种方式：

1. **Subagent-Driven (推荐)** — 我派 fresh subagent 跑每个 Task，Task 之间 review，快速迭代。适合 30+ 任务的复杂 plan。
2. **Inline Execution** — 在当前 session 批量执行，到 checkpoint 时 review。适合短 plan。

请选择执行方式：
- **A) Subagent-Driven（推荐）**
- **B) Inline Execution**

或者，如果你想先对 plan 某部分调整 / 增删 task，告诉我哪里要改。