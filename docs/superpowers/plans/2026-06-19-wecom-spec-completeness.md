# WeCom Spec Completeness Implementation Plan (PR 6-8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 把 wecom 集成从 spec 完成度 ~78% 提升到 ~95% — 实现 spec §10.1 剩余验收项（3 项）+ 修剩余 review 报告 Major/Minor + Agent View 跨平台扩展。

**Architecture**: 3 个独立 PR (PR 6/7/8)，每个 PR 可独立 ship。每个 PR 内严格 TDD，每个 Task 都有 failing test → 最小实现 → passing test → commit。飞书零回归是硬约束（spec §10.2）。

**Tech Stack**: Bun TypeScript + @wecom/aibot-node-sdk + SpoolQueue (file-based) + ClaudeSessionManager + feishu bot 零回归基线

---

## 已完成的前置 commit（PR 5 / 5.1 主批 + M-3.2 补批）

HEAD `f1b5cbd` 已包含 9 个修复 commit，本 plan 引用为已完成状态：

| Commit | 范围 | 修复问题 |
|---|---|---|
| `b703708` | M-3 writeAtomic fsync | `src/queue/spool.ts` 0 字节防护 |
| `4ec04b4` | C-3 deprecate claimPending + C-4 setSession explicit cleanup | `src/wecom/mapping.ts` |
| `f11a55f` | C-1+C-2 owner validation (handleChat 入口) | `src/wecom/bot.ts` — **被 f1b5cbd 覆盖** |
| `33968ae` | M-1 group chat chatId + M-7 handleCommandResume 重读 | `src/wecom/bot.ts` — **M-1 被 f1b5cbd 覆盖** |
| `bb64bc2` | (本 plan 文档) | docs/superpowers/plans/... |
| `32c2a5f` | 标记 /bridge 废弃 (wecom + platform) | src/wecom + platform/command-handler |
| `1f726e3` | 标记 /bridge 废弃 (tests + spec + CLAUDE.md) | 多处文档 |
| `0d2fbcd` | M-3.2 fsync `src/registry/registry.ts` saveSync | (最高风险, session registry) |
| `dedd79c` | M-3.2 fsync `src/feishu/list-snapshot.ts` saveSnapshot | |
| `0b888e9` | M-3.2 fsync `src/runtime/state-coordinator.ts` tryAcquire | |
| `a2d7d96` | M-3.2 fsync `src/utils/providers.ts` importFromCCSwitch | |
| `f1b5cbd` | **PR 5.1 followup**: M-1 production no-op + C-1+C-2 silent + command path | `src/wecom/bot.ts` |
| `448f6bc` | **PR 6.8.1 followup**: M-1 方向修 — receiveId 按 chatType 路由 (group→chatId, p2p/single→userId) | `src/wecom/bot.ts` |

**重要决策**:
- `/bridge` 命令**永久废弃** (2026-06-20 决定), 历史 cc-connect 命令, cc-linker 移除 cc-connect 后孤儿, **不再复活** (spec §5.7 显式 YAGNI 跨平台 session 同步)
- spec §10.1 第 3 项验收改为 "**/bridge 命令返回 YAGNI 提示**" 而非"全部工作"
- 任何子任务如提到 `/bridge` 复活视为 P0 错误, 应立即停止并报告

---

## 范围

### PR 6: Spec §10.1 剩余验收项（高优先级）

**剩余 3 项未完成**（/bridge 已废弃不计）:
1. ❌ **手机企微发图片 → Claude 流式回复** — 当前只处理文本
2. ❌ **按钮回调（重试 / 停止 / 刷新列表）正常** — 4 个 actionTag 全 stub
3. ❌ **/stop <short> 真实 E2E 验证** — PR 5 已实现, 但无边界测试覆盖

**已删除项**:
- ~~/bridge 跨平台 session 同步~~ → spec §5.7 YAGNI, 永久废弃

### PR 7: 质量 & 技术债（剩余）

review 报告原始 8 Major + 15 Minor，**主批已修 6 项**（C-1/C-2/C-3/C-4/M-1/M-3/M-7），**M-3.2 补批修了 4 个文件 fsync**，**PR 5.1 修了 M-1 production + C-1+C-2 silent + command path**，**PR 6.8.1 修了 M-1 方向错** (receiveId 按 chatType 路由)。**剩余 3 Major + 11 Minor**:

- **P0 必修**: M-4 (reconciler wecom), M-8 (state-coordinator fsync, 已被 M-3.2 修, 仅 verify), M-2 (dispatch loop 立即 stop)
- **P1 推荐**: M-5 (spool cleanup mtime, 需核 review 报告), M-6 (streamId userId keying, 需核 review 报告)
- **P2 可选**: 11 个 minor (m-1 ~ m-15 中 11 个未修, m-1/m-6/m-14 与已修任务重叠 skip)

### PR 8: Agent View 跨平台（可选, 未来 PR）

spec §6 + 2026-06-01-feishu-agent-view-design.md 给出飞书侧完整实现，企微侧需要：
- 抽象 AgentSnapshotFetcher 平台无关
- WecomAgentViewManager 复用 AgentViewManager 流程 + 卡片适配
- /agents /peek /reply /stop 在 wecom 路径用 template_card 渲染

---

# PR 6: Spec §10.1 剩余验收项

**目标**: 实现 spec §10.1 中 3 个未完成项（不含已废弃 /bridge），每个 Task TDD。

**前置**: HEAD `f1b5cbd` (已含 9 commit 修复)

---

## Task 6.1: handleChat 图片消息支持（spec §10.1 第 1 项）

**关键修正** (相对初版 plan): 平台层 `PlatformMessage` **已有** `images?: Array<{fileKey, url?}>` 数组字段 (src/platform/types.ts:36)，`aibot-client.ts:127-161` 已经在 emit `images` 数组。**不要新加 `image` 单数字段**，复用现有 `images` 数组。

**Files:**
- Modify: `src/wecom/bot.ts` handleChat (处理 images)
- Create: `src/wecom/image-handler.ts` (~80 行, 下载 + 缓存)
- Test: `tests/unit/wecom/image-handler.test.ts`

- [ ] **Step 1: 写 WecomImageHandler 测试** (tests/unit/wecom/image-handler.test.ts 新建)

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { WecomImageHandler } from '../../../src/wecom/image-handler';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('WecomImageHandler', () => {
  let dir: string;
  let handler: WecomImageHandler;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-img-'));
    handler = new WecomImageHandler({ cacheDir: dir });
  });

  it('fetchAsBase64: data: URL 直接返回 base64', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect(await handler.fetchAsBase64(url)).toBeTruthy();
  });

  it('cacheToDisk: 按 messageId 缓存 base64 到文件', () => {
    handler.cacheToDisk('msg-1', 'aGVsbG8=');
    expect(existsSync(join(dir, 'msg-1.bin'))).toBe(true);
    expect(readFileSync(join(dir, 'msg-1.bin'), 'utf8')).toBe('aGVsbG8=');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/image-handler.test.ts -v`
Expected: FAIL with "WecomImageHandler is not a constructor"

- [ ] **Step 3: 实现 WecomImageHandler**

`src/wecom/image-handler.ts` (新建):

```typescript
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { logger } from '../utils/logger';

export type ImageHandlerConfig = {
  cacheDir: string;
  maxSizeBytes?: number;
};

export class WecomImageHandler {
  private readonly cacheDir: string;
  private readonly maxSizeBytes: number;

  constructor(config: ImageHandlerConfig) {
    this.cacheDir = config.cacheDir;
    this.maxSizeBytes = config.maxSizeBytes ?? 10 * 1024 * 1024;
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
  }

  async fetchAsBase64(url: string): Promise<string> {
    if (url.startsWith('data:')) {
      const match = url.match(/^data:[^;]+;base64,(.+)$/);
      if (!match) throw new Error('Invalid data: URL');
      return match[1];
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxSizeBytes) {
      throw new Error(`Image too large: ${buffer.byteLength} > ${this.maxSizeBytes}`);
    }
    return Buffer.from(buffer).toString('base64');
  }

  cacheToDisk(messageId: string, base64: string): string {
    const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(this.cacheDir, `${safeId}.bin`);
    writeFileSync(path, base64, { mode: 0o600 });
    logger.info(`[wecom-image] cached image: messageId=${messageId} path=${path}`);
    return path;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/image-handler.test.ts -v`
Expected: PASS (2/2)

- [ ] **Step 5: 写 handleChat images 路径测试** (tests/unit/wecom/bot.test.ts 加)

```typescript
it('Task 6.1: handleChat 处理 images 数组, 调 imageHandler 缓存', async () => {
  const sessionManager = { sendStreamingMessage: mock(() => Promise.resolve({ sessionId: 's1' })) };
  const imageHandler = {
    fetchAsBase64: mock(() => Promise.resolve('aGVsbG8=')),
    cacheToDisk: mock(() => '/cache/path'),
  };
  const userManager = {
    validateOwner: () => true,
    getEntry: () => undefined,
    setSession: mock(() => Promise.resolve()),
  };
  const bot = new WecomBot({
    botId, secret, userManager, sessionManager, imageHandler,
  });
  await bot.__test_handleChat({
    messageId: 'msg-img-1',
    serialKey: 'new:ext-img',
    platform: 'wecom',
    userId: 'ext-img',
    text: '看这张图',
    images: [{ fileKey: 'media-1', url: 'https://example.com/x.png' }],
    metadata: { inboundFrame: { headers: { req_id: 'req-img' } } },
  } as any);
  expect(imageHandler.fetchAsBase64).toHaveBeenCalledWith('https://example.com/x.png');
  expect(imageHandler.cacheToDisk).toHaveBeenCalledWith('msg-img-1', 'aGVsbG8=');
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -v`
Expected: FAIL

- [ ] **Step 7: 实现 handleChat images 路径**

`src/wecom/bot.ts` handleChat 在 owner 验证后加：

```typescript
// PR 6 Task 6.1: 图片消息处理（复用现有 images 数组）
if (msg.images && msg.images.length > 0 && this.imageHandler) {
  for (const img of msg.images) {
    if (!img.url) continue;
    try {
      const base64 = await this.imageHandler.fetchAsBase64(img.url);
      this.imageHandler.cacheToDisk(msg.messageId, base64);
      msg.text = `[图片: fileKey=${img.fileKey}, base64=${base64.slice(0, 50)}...]\n${msg.text}`;
    } catch (err) {
      logger.error(`[wecom-bot] handleChat image download failed: ${err}`);
      msg.text = `[图片下载失败: ${img.fileKey}] ${msg.text}`;
    }
  }
}
```

并在 WecomBotConfig 加 `imageHandler?: WecomImageHandler;` 字段。

- [ ] **Step 8: 跑测试确认通过 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
bun run typecheck
git add src/wecom/image-handler.ts src/wecom/bot.ts tests/unit/wecom/image-handler.test.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.1 image message support via existing images array"
```

---

## Task 6.2: /bridge YAGNI 提示（spec §10.1 替代验收项）

**关键修正**: `/bridge` 已废弃（PR 5 文档 + 代码标记完成）。本 Task 仅为 spec §10.1 验收项的**占位实现**——返回 YAGNI 提示，而非复活功能。

**Files:**
- Modify: `src/wecom/bot.ts` handleCommand (switch case 加 bridge)
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写 /bridge YAGNI 测试**

```typescript
it('Task 6.2: /bridge 命令返回 YAGNI 提示 (spec §5.7 显式 YAGNI)', async () => {
  const sdk = { sendMessage: mock() };
  const bot = new WecomBot({ ..., client: { sdk, ... } });
  await bot.__test_handleCommand({
    messageId: 'm1', serialKey: 'cmd:u1', platform: 'wecom',
    userId: 'u1', text: '/bridge list',
  });
  const sent = sdk.sendMessage.mock.calls[0][1].markdown.content;
  expect(sent).toContain('YAGNI');
  expect(sent).toContain('5.7');
});
```

- [ ] **Step 2: 实现 /bridge YAGNI case**

`src/wecom/bot.ts` switch case 加：

```typescript
case 'bridge': {
  // PR 6 Task 6.2: /bridge 已废弃 (2026-06-20 决定, spec §5.7 YAGNI 跨平台 session 同步)
  // 历史: cc-connect 集成命令, cc-linker 移除 cc-connect 后孤儿, 不复活
  responseText = `❌ /bridge 已废弃 (spec §5.7 显式 YAGNI 跨平台 session 同步)\n\n如需跨平台 session 管理, 直接在终端用 \`cc-linker switch <uuid>\``;
  break;
}
```

并在 `handleCommandHelp` 帮助文本保留 "/bridge 已废弃" 提示（PR 5 已加）。

- [ ] **Step 3: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.2 /bridge YAGNI placeholder (spec §5.7)"
```

---

## Task 6.3: /stop <short> 真实实现 + 边界测试

**关键修正**: PR 5 已实现 `/stop <short>` (`handleCommandStop` 方法, 调 `claude stop <shortId>` via execFile)，**不需要新加 WecomBgSessionStopper 类**。本 Task 仅加边界测试覆盖。

**Files:**
- Modify: `tests/unit/wecom/bot.test.ts` (加边界测试)

- [ ] **Step 1: 写 /stop 边界测试**

```typescript
describe('Task 6.3: /stop 边界测试', () => {
  it('/stop 无 short: 返回用法提示', async () => {
    const sdk = { sendMessage: mock() };
    const bot = new WecomBot({ ..., client: { sdk, ... }, userManager: { validateOwner: () => true } });
    await bot.__test_handleCommand({
      messageId: 'm1', serialKey: 'cmd:u1', platform: 'wecom',
      userId: 'u1', text: '/stop',
    });
    const sent = sdk.sendMessage.mock.calls[0][1].markdown.content;
    expect(sent).toContain('用法');
  });

  it('/stop claude 退出码非 0: 返回 stderr', async () => {
    // mock spawn 返回 exit 1 + stderr "session not found"
    const sdk = { sendMessage: mock() };
    // 调 bot.__test_handleCommand '/stop nonexistent'
    // 验证返回文本含 "session not found"
  });
});
```

- [ ] **Step 2: 跑测试 + commit**（如失败，PR 5 已有基础实现，可能需要补一些边角）

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add tests/unit/wecom/bot.test.ts
git commit -m "test(wecom): PR 6 Task 6.3 /stop edge cases"
```

---

## Task 6.4: Card action 'retry' 实现（spec §10.1 第 3 项）

**Files:**
- Modify: `src/wecom/bot.ts` executeCardAction
- Modify: `src/wecom/bot.ts` (加 `__test_executeCardAction` test seam)
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 加 test seam + 写 retry 测试**

`src/wecom/bot.ts` executeCardAction 之前加：
```typescript
public async __test_executeCardAction(event: { externalUserId: string; messageId: string; actionTag: string; actionValue: any; inboundFrame?: any }): Promise<void> {
  return this.executeCardAction(event);
}
```

`tests/unit/wecom/bot.test.ts` 加：
```typescript
it('Task 6.4: card action retry: 调 spoolQueue.requeueFromProcessing 重新入队', async () => {
  const spoolQueue = {
    requeueFromProcessing: mock(() => Promise.resolve()),
    markDone: mock(),
  };
  const bot = new WecomBot({ ..., spoolQueue });
  await bot.__test_executeCardAction({
    externalUserId: 'ext-1', messageId: 'msg-1', actionTag: 'retry',
    actionValue: {}, inboundFrame: { headers: { req_id: 'req-1' } },
  });
  // 注: requeueFromProcessing 实际签名 (messageId, serialKey), 现有测试 mock 都接受
  expect(spoolQueue.requeueFromProcessing).toHaveBeenCalled();
});
```

- [ ] **Step 2: 实现 retry action** (`src/wecom/bot.ts` executeCardAction switch case switch case)

```typescript
case 'retry': {
  // 重发原消息 - 从 processing 重新入队 pending
  await this.spoolQueue.requeueFromProcessing(event.messageId, `retry:${event.externalUserId}`);
  logger.info(`[wecom-bot] card action retry: requeued ${event.messageId}`);
  await this.client.sdk.sendMessage(event.externalUserId, {
    msgtype: 'markdown',
    markdown: { content: `✅ 已重试: ${event.messageId}` },
  });
  break;
}
```

- [ ] **Step 3: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.4 card action retry implementation"
```

---

## Task 6.5: Card action 'stop' 接到现有 stream-updater.cancel()

**关键修正**: `src/wecom/stream-updater.ts:190-203` **已存在** `cancel()` 方法（有 `prepareTerminal` 防御性逻辑）。**不要重写** cancel，本 Task 只接 case 'stop' 到现有方法。

**Files:**
- Modify: `src/wecom/bot.ts` executeCardAction switch case (case 'stop')
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写 stop action 测试**

```typescript
it('Task 6.5: card action stop: 调 updater.cancel 触发 in-flight cancel', async () => {
  // mock updater.cancel, 验证被调
  const updater = { cancel: mock(() => Promise.resolve()) };
  const bot = new WecomBot({ ..., updater });
  await bot.__test_executeCardAction({
    externalUserId: 'ext-1', messageId: 'msg-1', actionTag: 'stop',
    actionValue: {}, inboundFrame: { headers: { req_id: 'req-1' } },
  });
  expect(updater.cancel).toHaveBeenCalled();
});
```

- [ ] **Step 2: 实现 stop action** (`src/wecom/bot.ts` executeCardAction switch case)

```typescript
case 'stop': {
  // 触发 in-flight cancel (现有 stream-updater.cancel() 方法)
  await this.updater.cancel('用户从卡片点击停止');
  break;
}
```

- [ ] **Step 3: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.5 card action stop → existing updater.cancel"
```

---

## Task 6.6: Card action 'confirm-stop' (ClaudeSessionManager 实际 API)

**关键修正**: `src/proxy/session.ts` 的 `terminateProcessTree(pid: number)` 是**顶层函数不是 method**，类内字段名是 `activeProcesses: Map<string, ClaudeSession>` 而非 `activeProcs`。需要给 `ClaudeSessionManager` 加一个接受 sessionUuid 的 method。

**Files:**
- Modify: `src/proxy/session.ts` (ClaudeSessionManager 加 `killSessionByUuid(uuid)`)
- Modify: `src/wecom/bot.ts` executeCardAction switch case (case 'confirm-stop')
- Test: `tests/unit/wecom/bot.test.ts` + `tests/unit/proxy/session.test.ts`

- [ ] **Step 1: 写 ClaudeSessionManager.killSessionByUuid 测试** (tests/unit/proxy/session.test.ts)

```typescript
it('killSessionByUuid: 用 uuid 找 activeProcess 然后调顶层 terminateProcessTree', async () => {
  // mock activeProcesses map 含 uuid-1
  // 验证 terminateProcessTree 被调
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/proxy/session.test.ts -v`

- [ ] **Step 3: 实现 ClaudeSessionManager.killSessionByUuid**

`src/proxy/session.ts` 在 ClaudeSessionManager 类内加：

```typescript
async killSessionByUuid(sessionUuid: string): Promise<boolean> {
  const session = this.activeProcesses.get(sessionUuid);
  if (!session) {
    logger.warn(`[claude-session] killSessionByUuid: no active session for ${sessionUuid}`);
    return false;
  }
  if (session.pid) {
    terminateProcessTree(session.pid);
  } else {
    session.proc?.kill('SIGTERM');
    setTimeout(() => session.proc?.kill('SIGKILL'), 3000);
  }
  this.activeProcesses.delete(sessionUuid);
  return true;
}
```

(实际字段名以 session.ts 真实定义为准——执行前先读文件确认)

- [ ] **Step 4: 写 confirm-stop card action 测试** + **Step 5: 实现 confirm-stop action**

`src/wecom/bot.ts` executeCardAction switch case:
```typescript
case 'confirm-stop': {
  const sessionUuid = event.actionValue?.sessionUuid;
  if (!sessionUuid || !this.sessionManager) {
    logger.warn(`[wecom-bot] confirm-stop: missing sessionUuid or sessionManager`);
    break;
  }
  const killed = await (this.sessionManager as any).killSessionByUuid(sessionUuid);
  await this.client.sdk.sendMessage(event.externalUserId, {
    msgtype: 'markdown',
    markdown: { content: killed ? `✅ 已硬杀 session: ${sessionUuid}` : `❌ 未找到 session: ${sessionUuid}` },
  });
  break;
}
```

- [ ] **Step 6: 跑测试 + commit**

```bash
bun test tests/unit/proxy/session.test.ts tests/unit/wecom/bot.test.ts -v
git add src/proxy/session.ts src/wecom/bot.ts tests/unit/proxy/session.test.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.6 card action confirm-stop → ClaudeSessionManager.killSessionByUuid"
```

---

## Task 6.7: Card action 'list-refresh' 改用 RegistryManager

**关键修正**: 原 plan 用 bridge.listFeishuSessions, 但 /bridge 已废弃。`RegistryManager.listActive()` **当前不存在**，需先在 `src/registry/registry.ts` 加这个方法（基于 `Object.values(this.sessions).filter(s => s.status === 'active')`）。

**Files:**
- Modify: `src/registry/registry.ts` (RegistryManager 加 `listActive()` method)
- Modify: `src/wecom/bot.ts` executeCardAction (case 'list-refresh')
- Test: `tests/unit/wecom/bot.test.ts` + `tests/unit/registry/registry.test.ts`

- [ ] **Step 1: 写 RegistryManager.listActive 测试** (`tests/unit/registry/registry.test.ts` 加)

```typescript
it('RegistryManager.listActive: 返回 status==="active" 的 sessions', async () => {
  const manager = new RegistryManager({ registryPath: '/tmp/registry-test.json' });
  await manager.flush();
  // 写 2 active + 1 stopped
  await manager.upsert('uuid-1', { origin: 'feishu', cwd: '/tmp', status: 'active', title: 'A' } as any);
  await manager.upsert('uuid-2', { origin: 'feishu', cwd: '/tmp', status: 'active', title: 'B' } as any);
  await manager.upsert('uuid-3', { origin: 'feishu', cwd: '/tmp', status: 'stopped', title: 'C' } as any);
  const active = await manager.listActive();
  expect(active.length).toBe(2);
  expect(active.find(s => s.sessionUuid === 'uuid-1')).toBeDefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/registry/registry.test.ts -v`
Expected: FAIL with "manager.listActive is not a function"

- [ ] **Step 3: 实现 RegistryManager.listActive**

`src/registry/registry.ts` 在 `RegistryManager` 类内加：

```typescript
async listActive(): Promise<SessionEntry[]> {
  await this.reload();
  return Object.values(this.sessions).filter(s => s.status === 'active');
}
```

(实际方法以 registry.ts 现状为准, 关键: 过滤 status='active')

- [ ] **Step 4: 写 list-refresh card action 测试** (`tests/unit/wecom/bot.test.ts` 加)

```typescript
it('Task 6.7: card action list-refresh: 调 registryManager.listActive 重新拉列表', async () => {
  const registryManager = {
    listActive: mock(() => Promise.resolve([
      { sessionUuid: 's-1', title: 'PR 2 review', cwd: '/Users/x/proj', messageCount: 42 },
    ])),
  };
  const bot = new WecomBot({ ..., registryManager });
  await bot.__test_executeCardAction({
    externalUserId: 'ext-1', messageId: 'msg-1', actionTag: 'list-refresh',
    actionValue: {}, inboundFrame: { headers: { req_id: 'req-1' } },
  });
  expect(registryManager.listActive).toHaveBeenCalled();
});
```

- [ ] **Step 5: 实现 list-refresh action**

`src/wecom/bot.ts` executeCardAction switch case 'list-refresh'：

```typescript
case 'list-refresh': {
  if (!this.registryManager) {
    responseText = '❌ registryManager 未注入';
    break;
  }
  const sessions = await this.registryManager.listActive();
  const card = WecomCardBuilder.textNotice({
    title: `飞书 sessions (${sessions.length})`,
    content: sessions.length === 0
      ? '无 active session'
      : sessions.slice(0, 5).map(s => `• ${s.title} (${s.messageCount ?? 0} msgs)`).join('\n'),
  });
  await this.client.sdk.sendMessage(event.externalUserId, {
    msgtype: 'template_card',
    template_card: card as any,
  });
  break;
}
```

并在 WecomBotConfig 加 `registryManager?: RegistryManager;` 字段（type import）。

- [ ] **Step 6: 跑测试 + commit**

```bash
bun test tests/unit/registry/registry.test.ts tests/unit/wecom/bot.test.ts -v
git add src/registry/registry.ts src/wecom/bot.ts tests/unit/registry/registry.test.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.7 card action list-refresh + RegistryManager.listActive"
```

- [ ] **Step 1: 写 list-refresh 测试**

```typescript
it('Task 6.7: card action list-refresh: 调 registryManager.listActive 重新拉列表', async () => {
  const registryManager = {
    listActive: mock(() => Promise.resolve([
      { sessionUuid: 's-1', title: 'PR 2 review', cwd: '/Users/x/proj', messageCount: 42 },
    ])),
  };
  const bot = new WecomBot({ ..., registryManager });
  await bot.__test_executeCardAction({
    externalUserId: 'ext-1', messageId: 'msg-1', actionTag: 'list-refresh',
    actionValue: {}, inboundFrame: { headers: { req_id: 'req-1' } },
  });
  expect(registryManager.listActive).toHaveBeenCalled();
});
```

- [ ] **Step 2: 实现 list-refresh action**

`src/wecom/bot.ts` executeCardAction switch case:
```typescript
case 'list-refresh': {
  if (!this.registryManager) {
    responseText = '❌ registryManager 未注入';
    break;
  }
  const sessions = await this.registryManager.listActive();
  const card = WecomCardBuilder.textNotice({
    title: `飞书 sessions (${sessions.length})`,
    content: sessions.length === 0
      ? '无 active session'
      : sessions.slice(0, 5).map(s => `• ${s.title} (${s.messageCount} msgs)`).join('\n'),
  });
  await this.client.sdk.sendMessage(event.externalUserId, {
    msgtype: 'template_card',
    template_card: card as any,
  });
  break;
}
```

并在 WecomBotConfig 加 `registryManager?: RegistryManager;` 字段（type import）。

- [ ] **Step 3: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.7 card action list-refresh → RegistryManager.listActive"
```

---

## Task 6.8: PR 6 集成 + 飞书零回归

**Files:**
- Modify: `src/cli/commands/start.ts` (注入 imageHandler + registryManager)
- Test: 全量 `bun test`

- [ ] **Step 1: 跑全量测试**

Run: `bun test`
Expected: 1172 + 12 new tests (Task 6.1-6.7 各 1-2 个) = **1184+** pass, 0 fail, 0 regression

- [ ] **Step 2: 飞书零回归**

Run: `bun test tests/unit/feishu/ tests/integration/feishu/`
Expected: 全部通过

- [ ] **Step 3: 在 start.ts 注入新模块**

`src/cli/commands/start.ts` 在 wecom-only 分支加：
```typescript
import { WecomImageHandler } from '../../wecom/image-handler';
import { join } from 'path';
import { expandPath } from '../../utils/paths';

const imageHandler = new WecomImageHandler({
  cacheDir: join(expandPath('~/.cc-linker'), 'image_cache'),
});
// registryManager 已在 start.ts: 顶部持有, 注入 wecomBot 即可
const wecomBot = new WecomBot({
  ...,
  imageHandler,
  registryManager,
});
```

- [ ] **Step 4: typecheck + E2E 冒烟**

```bash
bun run typecheck
bun run dev start --platform=wecom --daemon
bun run dev daemon status
bun run dev stop
```

- [ ] **Step 5: Commit + 推 PR**

```bash
git add src/cli/commands/start.ts
git commit -m "feat(wecom): PR 6 wire imageHandler+registryManager in start.ts"
git push -u origin feat/wecom-pr6-spec-completeness
gh pr create --base master --title "PR 6: WeCom spec §10.1 剩余验收项 (image + 4 actionTag + /stop verify + /bridge YAGNI)"
```

---

# PR 7: 质量 & 技术债（剩余）

**目标**: 修剩余 review 报告 Major + 11 Minor，分 P 级别。

**前置**: PR 6 已合, HEAD 含 commit `f1b5cbd` + 6 个 PR 6 commit

---

## Task 7.1: M-3.2 4 文件 fsync verify

**M-3.2 已修** (commits 0d2fbcd + dedd79c + 0b888e9 + a2d7d96), 本 Task 仅 verify。

- [ ] **Step 1: 跑测试确认 0 字节自愈回归**

```bash
bun test tests/unit/registry/ tests/unit/feishu/ tests/unit/runtime/ tests/unit/utils/
```

Expected: PASS, 1172+ 全过

- [ ] **Step 2: 标 done**

---

## Task 7.2: M-4 startupReconcile 加 wecom 路径

**Files:**
- Modify: `src/runtime/reconciler.ts` (startupReconcile 加 platform 过滤)
- Modify: `src/cli/commands/start.ts` (caller 传 platform)
- Test: `tests/unit/runtime/reconciler.test.ts`

- [ ] **Step 1: 读 startupReconcile 当前实现 + caller**

Read: `src/runtime/reconciler.ts` + `src/cli/commands/start.ts` 找 caller

- [ ] **Step 2: 写测试** (tests/unit/runtime/reconciler.test.ts 加)

```typescript
it('M-4: startupReconcile(platform=wecom) 只处理 wecom 平台消息', async () => {
  // 创建 processing 目录: wecom/msg-1.json + feishu/msg-2.json
  // mock state-coordinator
  // 调 startupReconcile({ platform: 'wecom' })
  // 验证 msg-1 移到 pending, msg-2 不动
});

it('M-4: startupReconcile() 默认处理 feishu + wecom 全部', async () => {
  // 不传 platform, 两个都处理
});
```

- [ ] **Step 3: 跑测试确认失败**

- [ ] **Step 4: 实现 platform filter**

仿照 `listProcessing` / `listPending` 已有的 `platform` 参数模式（commit 33968ae + PR 3 已实现），给 startupReconcile 加 `platform?: 'feishu' | 'wecom'` 参数。

`src/cli/commands/start.ts` 改 caller：
```typescript
// 旧: await startupReconcile(spoolQueue);
// 新: await startupReconcile(spoolQueue, { platform: 'wecom' });  // or undefined for all
```

- [ ] **Step 5: 跑测试 + commit**

```bash
git add src/runtime/reconciler.ts src/cli/commands/start.ts tests/unit/runtime/reconciler.test.ts
git commit -m "fix(runtime): M-4 startupReconcile support wecom platform filter"
```

---

## Task 7.3: M-5 spool cleanup lex → mtime (verify only)

**review 报告可能误报** — `src/queue/spool.ts:436/456/476/495` 已经用 `mtimeMs` 比较清理。**先 grep 确认**再决定是否需要修。

- [ ] **Step 1: grep 确认**

```bash
grep -n "mtimeMs\|mtime\|readdirSync.*sort" src/queue/spool.ts | head -20
```

- [ ] **Step 2: 如已用 mtime, 标 done, 写 1 个 test 锁住行为**

如已用 mtime, 加 1 个测试覆盖: cleanup 保留 2 个最新 (按 mtime), 不按 lex。

- [ ] **Step 3: 如未用 mtime, 按原 plan 改 + commit**

---

## Task 7.4: M-6 streamId userId keying (verify only)

**review 报告可能误报** — 单 user 限制是有意为之 (spec §5.6 "企微 userId 不区分 p2p/group")。**先 grep 确认**再决定。

- [ ] **Step 1: grep 确认单 user 限制是有意设计**

```bash
grep -n "lastInboundFrame\|currentStreamId" src/wecom/stream-updater.ts | head -10
```

- [ ] **Step 2: 如确为有意设计, 标 done, 写 JSDoc 注释锁住行为**

如 `lastInboundFrame` 是单字段且无 userId key, 加注释:
```typescript
/**
 * 单 user 设计: 企微单 user 同时只能有 1 个 in-flight 流
 * (与飞书 CardUpdater 不同, 飞书支持 p2p + group 多个流)
 * spec §5.6 明确
 */
private lastInboundFrame: any = null;
```

---

## Task 7.5: M-2 dispatch loop 立即 stop

**Files:**
- Modify: `src/wecom/bot.ts` startDispatchLoop
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写测试**

```typescript
it('M-2: stop 立即中断 dispatch loop (不等待 setTimeout 2s)', async () => {
  const bot = new WecomBot({ botId, secret, userManager: { validateOwner: () => true } });
  bot.start();
  const start = Date.now();
  bot.stop();
  await new Promise(r => setTimeout(r, 50));
  expect(Date.now() - start).toBeLessThan(500);  // <500ms, not 2s
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 改 startDispatchLoop 用可中断 timer**

`src/wecom/bot.ts` startDispatchLoop:
```typescript
private startDispatchLoop(): void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = async () => {
    while (!stopped && this.running) {
      try {
        // ... 现有 dispatch 逻辑 ...
      } catch (err) { ... }
      if (stopped || !this.running) break;
      await new Promise<void>(r => {
        timer = setTimeout(r, 2000);
      });
    }
  };
  loop();
  // 暴露 timer 给 stop() clear
  (this as any)._dispatchTimer = timer;
}

stop(): void {
  if (!this.running) return;
  this.running = false;
  if ((this as any)._dispatchTimer) clearTimeout((this as any)._dispatchTimer);
  this.client.disconnect();
  logger.info('[wecom-bot] stopped');
}
```

(实际改法以 wecom/bot.ts 现状为准, 关键点: clearTimeout in stop)

- [ ] **Step 4: 跑测试 + commit**

```bash
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "fix(wecom): M-2 dispatch loop stop within 100ms not 2s"
```

---

## Task 7.6: 11 个 minor 修复（**重写**为 11 独立 task）

**关键修正**: 原 plan 用 for 循环伪步骤, 违反 no-placeholder 规则。本节**省略详细代码**（如需实施, 单独 dispatch subagent 处理每个 minor）；列 11 个独立 task + 简短描述。

每个 minor 1 个独立 commit, 重复 TDD 模式: 写失败测试 → 跑确认失败 → 最小实现 → 跑测试 → commit。

| # | 范围 | 描述 |
|---|---|---|
| m-2 | `src/wecom/bot.ts` handleChat 闭包 | text/thinking 累加闭包提取独立函数 |
| m-3 | `src/wecom/stream-updater.ts` | 限频窗口 2000ms 提常量 THROTTLE_MS |
| m-4 | `src/wecom/card.ts` | `as any` 加 WecomTemplateCard type |
| m-5 | `src/cli/commands/init-wecom.ts` | token 校验 (verify 步骤补) |
| m-7 | `src/wecom/stream-updater.ts` | replyWelcome 失败补发 (推 PR 8+) |
| m-8 | `src/wecom/mapping.ts` | lockKey userId vs openId 加注释 |
| m-9 | `src/wecom/card.ts` | action_menu 硬编码 desc 提取 |
| m-10 | `src/utils/logger.ts` | logger.stack 序列化 secrets (sanitizer) |
| m-12 | `src/wecom/bot.ts` | 30s grace period 优化 |
| m-13 | `src/cli/commands/init-wecom.ts` | 覆盖确认 prompt |
| m-15 | `src/wecom/bot.ts` handleMessage | metadata.chatId 持久化 (PR 5.1 f1b5cbd 已加, verify) |

**已 skip 的 minor**:
- m-1, m-6, m-11, m-14: 与已修任务 (M-3.2, M-2 修法, C-4) 重叠或误报

**实施方式**: 11 个 subagent 串行或并发 (互不依赖, 飞书零回归硬约束), 每个 1 commit。

---

## Task 7.7: PR 7 集成 + 飞书零回归

- [ ] **Step 1: 跑全量测试 + typecheck**

```bash
bun test
bun run typecheck
```

Expected: 1172 + 11 minor 新测试 = 1183+ pass, 0 fail; typecheck clean

- [ ] **Step 2: 飞书零回归**

```bash
bun test tests/unit/feishu/ tests/integration/feishu/
```

Expected: 全部通过, 0 regression

- [ ] **Step 3: commit 收尾 + 推 PR**

```bash
git push -u origin feat/wecom-pr7-quality
gh pr create --base master --title "PR 7: WeCom quality & tech debt (M-2/M-4 + 11 minor)"
```

---

# PR 8: Agent View 跨平台（可选, 未来 PR）

**目标**: 把 spec §6 + 2026-06-01-feishu-agent-view-design.md 飞书 AgentViewManager 抽象到 platform 层, 企微侧用 template_card 适配。

**前置**: PR 7 已合, 飞书 AgentView 稳定 (PR 2.5+)

**复用模式**: 飞书 AgentViewManager 已经支持 `agent_view_*` 16 个 actionTag + handleList/handlePeek/handleReplyRequest/handleReply/handleStop/handleAttach 完整流程。企微侧只需要:
1. 把 `AgentSnapshotFetcher` 抽象 platform 接口
2. 新建 `WecomAgentViewManager` 复用 6 个 handle 方法
3. 飞书 16 个 case + 企微 4 个 case (`agents`/`peek`/`reply`/`stop`) 共享 dispatcher

**Files:**
- Create: `src/platform/agent-snapshot.ts` (interface, 复用 snapshot-fetcher.ts 逻辑)
- Create: `src/wecom/agent-view-manager.ts` (~250 行, 复用飞书 + 卡片适配)
- Modify: `src/wecom/bot.ts` (注入 agentViewManager, 路由 /agents)
- Modify: `src/agent-view/manager.ts` (把 SnapshotFetcher 改为依赖 platform interface)
- Test: `tests/unit/wecom/agent-view-manager.test.ts`

---

## Task 8.1: 抽象 AgentSnapshotFetcher 平台无关

- [ ] **Step 1: 写 platform/agent-snapshot.ts interface 测试**

```typescript
describe('PlatformAgentSnapshotFetcher', () => {
  it('interface 包含 fetchAll 方法', () => {
    const fetcher: PlatformAgentSnapshotFetcher = mock();
    expect(typeof fetcher.fetchAll).toBe('function');
  });
});
```

- [ ] **Step 2: 创建 platform/agent-snapshot.ts**

```typescript
import type { AgentSession } from '../agent-view/types';

export interface PlatformAgentSnapshotFetcher {
  /** 读所有活跃 bg sessions, 平台无关 */
  fetchAll(): Promise<AgentSession[]>;
  /** 读单个 session 详情, 平台无关 */
  fetchOne(short: string): Promise<AgentSession | null>;
}
```

- [ ] **Step 3: 让 FeishuAgentSnapshotFetcher 实现此 interface**

`src/agent-view/snapshot-fetcher.ts` 加 `implements PlatformAgentSnapshotFetcher` + 改方法签名。

- [ ] **Step 4: 跑测试 + commit**

```bash
git add src/platform/agent-snapshot.ts src/agent-view/snapshot-fetcher.ts tests/unit/platform/agent-snapshot.test.ts
git commit -m "refactor(agent-view): extract PlatformAgentSnapshotFetcher interface"
```

---

## Task 8.2: WecomAgentViewManager 复用 + 卡片适配

- [ ] **Step 1: 写 WecomAgentViewManager 测试**

```typescript
describe('WecomAgentViewManager', () => {
  it('handleList 用 template_card 渲染 agents 列表', async () => {
    const fetcher = { fetchAll: mock(() => Promise.resolve([{ short: 'a1', status: 'running' }])) };
    const cardBuilder = { textNotice: mock(() => ({ msgtype: 'template_card' })) };
    const mgr = new WecomAgentViewManager({ fetcher, cardBuilder });
    const card = await mgr.handleList('ext-1');
    expect(cardBuilder.textNotice).toHaveBeenCalled();
    expect(card.msgtype).toBe('template_card');
  });
});
```

- [ ] **Step 2: 实现 WecomAgentViewManager**

`src/wecom/agent-view-manager.ts` (新建):

```typescript
import { WecomCardBuilder } from './card';
import type { PlatformAgentSnapshotFetcher } from '../platform/agent-snapshot';
import type { AgentSession } from '../agent-view/types';

export type WecomAgentViewManagerConfig = {
  fetcher: PlatformAgentSnapshotFetcher;
};

export class WecomAgentViewManager {
  constructor(private config: WecomAgentViewManagerConfig) {}

  async handleList(externalUserId: string): Promise<any> {
    const sessions = await this.config.fetcher.fetchAll();
    const content = sessions.length === 0
      ? '无活跃 bg sessions'
      : sessions.slice(0, 5).map(s => `• ${s.short} ${s.status}`).join('\n');
    return WecomCardBuilder.textNotice({
      title: `Bg Sessions (${sessions.length})`,
      content,
    });
  }

  async handlePeek(externalUserId: string, short: string): Promise<any> {
    const session = await this.config.fetcher.fetchOne(short);
    if (!session) {
      return WecomCardBuilder.textNotice({ title: '未找到', content: short });
    }
    return WecomCardBuilder.textNotice({
      title: `Session ${short}`,
      content: session.lastOutput?.slice(0, 200) ?? '(无输出)',
    });
  }

  async handleStop(externalUserId: string, short: string): Promise<any> {
    // 调 claude stop (复用 Task 6.3 同样的 execFile pattern)
    // 注: 与 wecom/bot.ts handleCommandStop 保持一致, 避免重复实现
    return new Promise<any>((resolve) => {
      const proc = Bun.spawn(['claude', 'stop', short], { stdout: 'pipe', stderr: 'pipe' });
      proc.exited.then((exitCode) => {
        const card = WecomCardBuilder.textNotice({
          title: exitCode === 0 ? '已停止' : '停止失败',
          content: exitCode === 0
            ? `✅ bg session ${short} 已停止`
            : `❌ 停止 ${short} 失败 (exit ${exitCode})`,
        });
        resolve(card);
      });
    });
  }
}
```

- [ ] **Step 3: 跑测试 + commit**

```bash
git add src/wecom/agent-view-manager.ts tests/unit/wecom/agent-view-manager.test.ts
git commit -m "feat(wecom): PR 8 Task 8.2 WecomAgentViewManager with template_card rendering"
```

---

## Task 8.3: 接入 WecomBot (/agents 命令 + 卡片回调)

- [ ] **Step 1: 写 WecomBot 集成测试**

```typescript
it('/agents 调 WecomAgentViewManager.handleList 推 template_card', async () => {
  const agentViewManager = { handleList: mock(() => Promise.resolve({ msgtype: 'template_card' })) };
  const bot = new WecomBot({ ..., agentViewManager });
  await bot.__test_handleCommand({ ..., text: '/agents' });
  expect(agentViewManager.handleList).toHaveBeenCalled();
});
```

- [ ] **Step 2: 在 WecomBot 注入 agentViewManager + 路由**

`src/wecom/bot.ts` 加 `agentViewManager?: WecomAgentViewManager;` 字段 + handleCommand switch case `agents` + 卡片回调 agent_view_peek/stop 路由。

- [ ] **Step 3: 跑测试 + commit**

```bash
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 8 Task 8.3 wire agentViewManager in WecomBot"
```

---

## Task 8.4: PR 8 集成 + 飞书零回归

- [ ] **Step 1: 跑全量测试 + typecheck**

```bash
bun test
bun run typecheck
```

Expected: 1172 + Task 6.1-6.7 (PR 6 ~8) + Task 7.x (PR 7 ~15) + Task 8.1-8.3 (PR 8 ~6) = **1200+** 全过; typecheck clean

- [ ] **Step 2: 飞书零回归**

```bash
bun test tests/unit/feishu/ tests/integration/feishu/
```

Expected: 全部通过, 0 regression

- [ ] **Step 3: 推 PR**

```bash
git push -u origin feat/wecom-pr8-agent-view
gh pr create --base master --title "PR 8: Agent View for WeCom (跨平台扩展)"
```

---

# 验收清单（全部 PR 完成后）

## spec §10.1 验收（PR 6 完成后全 ✅）

- [ ] cc-linker start --platform=wecom 可启动企微 Bot ✅ (PR 2)
- [ ] 手机企微发文本 → Claude 流式回复 ✅ (PR 4.1)
- [ ] 手机企微发图片 → Claude 流式回复 ✅ (PR 6 Task 6.1)
- [ ] /list /switch /new /resume 命令全部工作 ✅ (PR 4.5 C)
- [ ] /stop <short> 命令工作 ✅ (PR 5 + PR 6 Task 6.3 verify)
- [ ] **/bridge 命令返回 YAGNI 提示** ✅ (PR 6 Task 6.2) — 替代"全部工作"
- [ ] 按钮回调（重试 / 停止 / 刷新列表）正常 ✅ (PR 6 Task 6.4-6.7)
- [ ] WSS 重连稳定 ✅ (PR 2)
- [ ] 限频场景下回复完整 ✅ (PR 2)
- [ ] setup 多渠道工作 ✅ (PR 3.5)

## 飞书零回归（硬约束）

- [ ] 飞书 E2E 5 case 全过
- [ ] --platform=all 时飞书 + 企微共存无冲突

## spec 完成度

- [ ] 从 78% → 95% (剩余 5% 是 PR 8 agent view wecom + WSS 5min 重连真实压测)
- [ ] review 报告原 8 Major 全部修复 ✅ (C-1/C-2/C-3/C-4/M-1/M-3/M-7 + M-3.2 4 files + M-1 production 5.1 fix + M-1 方向修 PR 6.8.1)
- [ ] 15 Minor 修复 ≥ 11 个 (PR 7 Task 7.6)

## 已完成 commit 引用

- 9 个修复 commit: b703708, 4ec04b4, f11a55f, 33968ae, 32c2a5f, 1f726e3, 0d2fbcd, dedd79c, 0b888e9, a2d7d96, f1b5cbd
- + PR 6 预计 8 个新 commit (Task 6.1-6.8)
- + PR 7 预计 4+ 个新 commit (M-2, M-4, 11 minor + 集成)
- + PR 8 预计 4 个新 commit (Task 8.1-8.4)

## 文档

- [ ] README 更新 (PR 6 完成后)
- [ ] spec §10.1 验收勾选
- [ ] config.toml [wecom] 节注释更新
- [ ] spec §5.7 显式 YAGNI 加注 (跨平台 session 同步)

---

# 计划修订历史

- 2026-06-19 18:11: 初始版本（bb64bc2）
- 2026-06-20: 重大修订（基于 plan reviewer + code reviewer 报告）
  - 删除 Task 6.2 (/bridge), 替换为 YAGNI 提示（spec §5.7 + 2026-06-20 决定）
  - Task 6.1: 改用现有 `images` 数组而非新加 `image` 单数字段
  - Task 6.3: 缩为 verify + 边界测试（PR 5 已实现 /stop, 无需新加 WecomBgSessionStopper）
  - Task 6.5: 不重写 stream-updater.cancel, 只接 case 'stop' 到现有方法
  - Task 6.6: 字段名 `activeProcs` → `activeProcesses`, 改为加 ClaudeSessionManager.killSessionByUuid method
  - Task 6.7: 改用 RegistryManager.listActive 而非 WecomBridge
  - Task 7.5/7.8: 删除（已 commit 33968ae 修）
  - Task 7.10: 删除（与 commit 4ec04b4 C-3 deprecate 矛盾）
  - Task 7.9: 11 minor 拆为 11 独立 task 描述
  - Task 8.1-8.3: 展开具体步骤（原版"略"违反 no-placeholder 规则）
  - 加 9 个已修 commit 引用
  - 验收清单 /bridge 项改为 "YAGNI 提示"
