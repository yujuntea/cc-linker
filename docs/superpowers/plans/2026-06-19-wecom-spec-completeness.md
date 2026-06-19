# WeCom Spec Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 把 wecom 集成从 spec 完成度 ~75% 提升到 ~95% — 实现 spec §10.1 中尚未实现的 4 个验收项 + review 报告中的 8 个 Major 修复 + 15 个 Minor 修复 + Agent View 跨平台扩展。

**Architecture**: 3 个独立 PR (PR 6/7/8)，每个 PR 可独立 ship。每个 PR 内严格 TDD，每个 Task 都有 failing test → 最小实现 → passing test → commit。飞书零回归是硬约束（spec §10.2）。

**Tech Stack**: Bun TypeScript + @wecom/aibot-node-sdk + SpoolQueue (file-based) + ClaudeSessionManager + feishu bot 零回归基线

**前置**:
- HEAD: daf5b13（在 PR 5 合并后，包含 C-1/C-2/C-3/C-4/M-3 修复）
- 飞书基线: `bun test` 1167+ 全过
- 分支策略: 每个 PR 一个 feature branch + worktree

---

## 范围

### PR 6: Spec §10.1 验收项补全（最高优先级）

spec §10.1 列出 6 类功能验收，其中 4 类在 PR 5 仍是 stub/缺失：

1. ❌ **手机企微发文本/图片 → Claude 流式回复** — 当前只处理文本，图片未走 handleChat
2. ❌ **/list /switch /bridge /new /resume /stop 命令全部工作** — /bridge 和 /stop 是 stub
3. ❌ **按钮回调（重试 / 停止 / 刷新列表）正常** — 4 个 actionTag 全 stub
4. ❌ **/agents** — 当前 stub（spec §10.1 不要求，但 spec §6 提到 bg sessions）

### PR 7: 质量 & 技术债

review 报告 8 个 Major + 15 个 Minor，分 4 个优先级：

- **P0 (PR 7 必修)**: M-1 (handleCommand 群聊), M-3 (writeAtomic fsync, 已在 C 批修), M-4 (reconciler wecom), M-7 (handleCommandResume lastActiveAt)
- **P1 (PR 7 推荐)**: M-2 (dispatch loop 立即 stop), M-5 (spool cleanup mtime), M-6 (streamId userId keying), M-8 (state-coordinator fsync)
- **P2 (PR 7 可选)**: 15 个 minor (m-1 ~ m-15)
- **P3 (PR 9+ 推)**: claimPending 重新接通 dispatch loop

### PR 8: Agent View 跨平台（可选）

spec §6 + 2026-06-01-feishu-agent-view-design.md 给出飞书侧完整实现，企微侧需要：
- 抽象 AgentSnapshotFetcher 平台无关
- WecomAgentViewManager 复用 AgentViewManager 流程 + 卡片适配
- /agents /peek /reply /stop 在 wecom 路径用 template_card 渲染

---

# PR 6: Spec §10.1 验收项补全

**目标**: 实现 spec §10.1 中 4 个未完成项，每个 Task TDD。

**架构决策**:
- 图片消息: 复用 feishu 的 `image_cache` 模式（`~/.cc-linker/image_cache/<msgId>.bin`），避免重写下载逻辑
- 按钮回调: 用 actionTag 字符串路由到 handleCardAction 内的具体处理函数
- /bridge: spec §5.7 模型，企微侧只读飞书 RegistryEntry（`~/.cc-linker/registry.json`），写入只限企微 user-mapping
- /stop: 调 `claude stop <short>` 命令（与飞书侧一致）

**前置**: PR 5 已合 (含 C-1/C-2/C-3/C-4/M-3 修复)

---

## Task 6.1: handleChat 图片消息支持（spec §10.1 第 1 项）

**Files:**
- Modify: `src/wecom/aibot-client.ts:80-140` (parseAibotMessage 添加 image 字段)
- Modify: `src/platform/types.ts:40-80` (PlatformMessage 加 image 字段)
- Modify: `src/wecom/bot.ts:421-540` (handleChat 处理 image)
- Create: `src/wecom/image-handler.ts` (~80 行, 下载 + 缓存 + 转换)
- Test: `tests/unit/wecom/image-handler.test.ts`

- [ ] **Step 1: 写 PlatformMessage 类型扩展测试**

在 `tests/unit/platform/types.test.ts` 加：

```typescript
import { describe, it, expect } from 'bun:test';
import type { PlatformMessage } from '../../../src/platform/types';

describe('PlatformMessage image field', () => {
  it('image field is optional, defaults to undefined', () => {
    const msg: PlatformMessage = {
      messageId: 'm1',
      platform: 'wecom',
      userId: 'u1',
      text: 'hi',
    };
    expect(msg.image).toBeUndefined();
  });

  it('image field accepts {url, base64, mimeType} payload', () => {
    const msg: PlatformMessage = {
      messageId: 'm2',
      platform: 'wecom',
      userId: 'u2',
      text: '',
      image: { url: 'https://example.com/a.png', mimeType: 'image/png' },
    };
    expect(msg.image?.url).toBe('https://example.com/a.png');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/platform/types.test.ts -v`
Expected: FAIL with "Property 'image' does not exist on type 'PlatformMessage'"

- [ ] **Step 3: 扩展 PlatformMessage 类型**

`src/platform/types.ts:40-80` 加：

```typescript
export type PlatformImagePayload = {
  url: string;
  base64?: string;  // 预下载的 base64（避免 Claude CLI 二次下载）
  mimeType: string;
  sizeBytes?: number;
};

export type PlatformMessage = {
  messageId: string;
  platform: Platform;
  userId: string;
  text: string;
  image?: PlatformImagePayload;  // 新增
  metadata?: Record<string, any>;
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/platform/types.test.ts -v`
Expected: PASS

- [ ] **Step 5: 写 aibot-client 解析 image 测试**

`tests/unit/wecom/aibot-client.test.ts` 加：

```typescript
it('parses image message from aibot event', () => {
  const event = {
    msgid: 'msg-img-1',
    from: { user_id: 'ext-img' },
    chat: { chat_id: 'chat-img' },
    msgtype: 'image',
    image: { url: 'https://example.com/img.png', size: 12345 },
  } as any;
  const result = aibotMessageToPlatform(event);
  expect(result.image).toBeDefined();
  expect(result.image?.url).toBe('https://example.com/img.png');
  expect(result.image?.mimeType).toBe('image/png');
  expect(result.text).toBe('');  // 图片消息 text 为空
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `bun test tests/unit/wecom/aibot-client.test.ts -v`
Expected: FAIL with "result.image is undefined"

- [ ] **Step 7: 实现 aibot-client 解析 image**

`src/wecom/aibot-client.ts:80-140` 的 `aibotMessageToPlatform` 加：

```typescript
// 在返回 PlatformMessage 之前
let image: PlatformImagePayload | undefined;
if (aibotMsg.msgtype === 'image' && aibotMsg.image) {
  const ext = aibotMsg.image.url?.split('.').pop()?.toLowerCase() || 'png';
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
  };
  image = {
    url: aibotMsg.image.url,
    mimeType: mimeMap[ext] ?? 'image/png',
    sizeBytes: aibotMsg.image.size,
  };
}
return { ..., image };
```

- [ ] **Step 8: 跑测试确认通过**

Run: `bun test tests/unit/wecom/aibot-client.test.ts -v`
Expected: PASS

- [ ] **Step 9: 写 image-handler 单元测试**

`tests/unit/wecom/image-handler.test.ts` (新建):

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { WecomImageHandler } from '../../../src/wecom/image-handler';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('WecomImageHandler', () => {
  let dir: string;
  let handler: WecomImageHandler;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-img-'));
    handler = new WecomImageHandler({ cacheDir: dir });
  });

  it('downloads image from URL and caches to file', async () => {
    // 用 fetch mock (此处写一个简单的 httpbin.org 测试)
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const base64 = await handler.fetchAsBase64(url);
    expect(base64).toBeTruthy();
    expect(base64.length).toBeGreaterThan(0);
  });

  it('caches image to disk by messageId', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const base64 = await handler.fetchAsBase64(url);
    handler.cacheToDisk('msg-test-1', base64);
    const cachePath = join(dir, 'msg-test-1.bin');
    expect(existsSync(cachePath)).toBe(true);
    expect(readFileSync(cachePath, 'utf8')).toBe(base64);
  });
});
```

- [ ] **Step 10: 跑测试确认失败**

Run: `bun test tests/unit/wecom/image-handler.test.ts -v`
Expected: FAIL with "WecomImageHandler is not a constructor"

- [ ] **Step 11: 实现 WecomImageHandler**

`src/wecom/image-handler.ts` (新建):

```typescript
/**
 * 企微图片下载 + 缓存
 * PR 6 Task 6.1: handleChat 图片消息支持
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §10.1 第 1 项
 */
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { logger } from '../utils/logger';

export type ImageHandlerConfig = {
  cacheDir: string;
  maxSizeBytes?: number;  // default 10MB
};

export class WecomImageHandler {
  private readonly cacheDir: string;
  private readonly maxSizeBytes: number;

  constructor(config: ImageHandlerConfig) {
    this.cacheDir = config.cacheDir;
    this.maxSizeBytes = config.maxSizeBytes ?? 10 * 1024 * 1024;
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Fetch image from URL and return as base64.
   * @param url HTTPS URL or data: URL (for tests)
   */
  async fetchAsBase64(url: string): Promise<string> {
    if (url.startsWith('data:')) {
      // data: URL (e.g. data:image/png;base64,xxx)
      const match = url.match(/^data:[^;]+;base64,(.+)$/);
      if (!match) throw new Error('Invalid data: URL');
      return match[1];
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Image fetch failed: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxSizeBytes) {
      throw new Error(`Image too large: ${buffer.byteLength} > ${this.maxSizeBytes}`);
    }
    return Buffer.from(buffer).toString('base64');
  }

  /**
   * Cache base64 image to disk by messageId.
   * @returns absolute path of cached file
   */
  cacheToDisk(messageId: string, base64: string): string {
    const safeId = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(this.cacheDir, `${safeId}.bin`);
    writeFileSync(path, base64, { mode: 0o600 });
    logger.info(`[wecom-image] cached image: messageId=${messageId} path=${path}`);
    return path;
  }
}
```

- [ ] **Step 12: 跑测试确认通过**

Run: `bun test tests/unit/wecom/image-handler.test.ts -v`
Expected: PASS (2/2)

- [ ] **Step 13: 写 handleChat image 路径测试**

`tests/unit/wecom/bot.test.ts` 加：

```typescript
it('handleChat: 图片消息走 image 路径, 调 ClaudeSessionManager', async () => {
  const sessionManager = { sendStreamingMessage: mock() };
  const imageHandler = { fetchAsBase64: mock(() => Promise.resolve('aGVsbG8=')) };
  const bot = new WecomBot({
    botId, secret, userManager, sessionManager, imageHandler,
  });
  await bot.__test_handleChat({
    messageId: 'msg-img-2',
    serialKey: 'new:ext-img',
    platform: 'wecom',
    userId: 'ext-img',
    text: '',
    image: { url: 'https://example.com/x.png', mimeType: 'image/png' },
    metadata: { inboundFrame: { headers: { req_id: 'req-img' } } },
  });
  expect(imageHandler.fetchAsBase64).toHaveBeenCalledWith('https://example.com/x.png');
  expect(sessionManager.sendStreamingMessage).toHaveBeenCalled();
  const args = sessionManager.sendStreamingMessage.mock.calls[0];
  expect(args[1]).toContain('[图片]');  // 或 [image:...] 标识
});
```

- [ ] **Step 14: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -v`
Expected: FAIL with "imageHandler is not provided"

- [ ] **Step 15: 实现 handleChat image 路径**

`src/wecom/bot.ts:421` 修改：

```typescript
private async handleChat(msg: SpoolMessage): Promise<void> {
  logger.info(`[wecom-bot] handleChat: userId=${msg.userId}, text=${msg.text.slice(0, 50)}`);

  // C-1+C-2 修复: owner 验证（保留现有代码）
  if (!this.userManager.validateOwner(msg.userId)) { ... }

  // PR 6 Task 6.1: 图片消息处理
  if (msg.image && this.imageHandler) {
    try {
      const base64 = await this.imageHandler.fetchAsBase64(msg.image.url);
      this.imageHandler.cacheToDisk(msg.messageId, base64);
      // 拼接到 text 让 Claude CLI 看到
      msg.text = `[图片: ${msg.image.mimeType}, ${msg.image.sizeBytes ?? '?'}B, base64=${base64.slice(0, 50)}...]\n${msg.text}`;
    } catch (err) {
      logger.error(`[wecom-bot] handleChat image download failed: ${err}`);
      // 失败时仍走 chat 路径但带错误说明
      msg.text = `[图片下载失败] ${msg.text}`;
    }
  }

  // PoC fallback（保留现有代码）
  if (!this.sessionManager) { ... }

  // Claude 流式路径（保留现有代码, 422+ 行）
  ...
}
```

并在 WecomBotConfig 加 `imageHandler?: WecomImageHandler;` 字段。

- [ ] **Step 16: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bot.test.ts -v`
Expected: PASS (新增 image 测试通过, 已有测试不破)

- [ ] **Step 17: 跑全量测试 + typecheck**

Run: `bun test && bun run typecheck`
Expected: 1167+ 全过, typecheck clean

- [ ] **Step 18: Commit**

```bash
git add src/platform/types.ts src/wecom/aibot-client.ts src/wecom/image-handler.ts \
  src/wecom/bot.ts tests/unit/wecom/image-handler.test.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.1 image message support in handleChat"
```

---

## Task 6.2: /bridge 跨平台 session 同步（spec §10.1 第 2 项）

**Files:**
- Modify: `src/wecom/bot.ts:200-260` (handleCommand switch case 加 bridge 分支)
- Create: `src/wecom/bridge.ts` (~100 行, 跨平台 registry 读取)
- Test: `tests/unit/wecom/bridge.test.ts`

- [ ] **Step 1: 写 bridge 测试**

`tests/unit/wecom/bridge.test.ts` (新建):

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WecomBridge } from '../../../src/wecom/bridge';

describe('WecomBridge', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-bridge-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads feishu session from registry.json', async () => {
    const registryPath = join(dir, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({
      version: 5,
      sessions: {
        'feishu-uuid-1': {
          origin: 'feishu', cwd: '/Users/x/proj',
          jsonl_path: '/Users/x/.claude/projects/x/abc.jsonl',
          project_name: 'proj', status: 'active',
          title: 'PR 2 review', message_count: 42,
        },
      },
    }));
    const bridge = new WecomBridge({ registryPath });
    const sessions = await bridge.listFeishuSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionUuid).toBe('feishu-uuid-1');
    expect(sessions[0].title).toBe('PR 2 review');
  });

  it('filters sessions by project cwd prefix', async () => {
    // 类似 setup, 测 prefix 匹配
  });

  it('importSession writes to wecom user-mapping', async () => {
    const bridge = new WecomBridge({ registryPath: '...', wecomMappingPath: '...' });
    await bridge.importSession('ext-user-1', 'feishu-uuid-1', '/Users/x/proj');
    // 验证 wecom user-mapping.json 包含新 entry
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bridge.test.ts -v`
Expected: FAIL with "WecomBridge is not a constructor"

- [ ] **Step 3: 实现 WecomBridge**

`src/wecom/bridge.ts` (新建):

```typescript
/**
 * 企微 /bridge 命令实现 - 跨平台 session 同步
 * PR 6 Task 6.2: spec §10.1 第 2 项 + spec §5.7
 *
 * 模型: 企微侧只读飞书 RegistryEntry (single source of truth),
 *       写只限于企微 user-mapping (双写会破坏 spec §5.7 隔离模型)
 */
import { readFile } from 'fs/promises';
import { withLock } from '../utils/lock';
import { logger } from '../utils/logger';
import { WecomUserManager } from './mapping';

export type BridgeConfig = {
  registryPath: string;
  wecomUserManager: WecomUserManager;
};

export type FeishuSessionSummary = {
  sessionUuid: string;
  cwd: string;
  title: string;
  messageCount: number;
  projectName: string;
  status: string;
};

export class WecomBridge {
  private readonly registryPath: string;
  private readonly userManager: WecomUserManager;

  constructor(config: BridgeConfig) {
    this.registryPath = config.registryPath;
    this.userManager = config.wecomUserManager;
  }

  /** 读飞书 registry, 列出所有 active sessions */
  async listFeishuSessions(): Promise<FeishuSessionSummary[]> {
    try {
      const raw = await readFile(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      const sessions = parsed.sessions ?? {};
      return Object.entries(sessions)
        .filter(([_, s]: [string, any]) => s.origin === 'feishu' && s.status === 'active')
        .map(([uuid, s]: [string, any]) => ({
          sessionUuid: uuid,
          cwd: s.cwd,
          title: s.title ?? '(无标题)',
          messageCount: s.message_count ?? 0,
          projectName: s.project_name ?? 'unknown',
          status: s.status,
        }));
    } catch (err) {
      logger.warn(`[wecom-bridge] read registry failed: ${err}`);
      return [];
    }
  }

  /** 按 cwd prefix 过滤 (用户想"找 proj 下的 session") */
  async listByCwdPrefix(prefix: string): Promise<FeishuSessionSummary[]> {
    const all = await this.listFeishuSessions();
    return all.filter(s => s.cwd.startsWith(prefix));
  }

  /** 导入飞书 session 到企微 user-mapping (只写企微侧) */
  async importSession(externalUserId: string, feishuSessionUuid: string, cwd: string): Promise<boolean> {
    try {
      await this.userManager.setSession(externalUserId, feishuSessionUuid, cwd);
      logger.info(`[wecom-bridge] imported feishu session to wecom: ${feishuSessionUuid} → userId=${externalUserId}`);
      return true;
    } catch (err) {
      logger.error(`[wecom-bridge] import failed: ${err}`);
      return false;
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bridge.test.ts -v`
Expected: PASS

- [ ] **Step 5: 在 WecomBot 中注入 WecomBridge**

`src/wecom/bot.ts:19-41` WecomBotConfig 加：

```typescript
export type WecomBotConfig = {
  ...现有字段...
  bridge?: WecomBridge;  // PR 6 Task 6.2
};
```

并在 `WecomBot` 类加 `private bridge?: WecomBridge;` 字段 + 构造函数注入。

- [ ] **Step 6: 写 /bridge 命令测试**

`tests/unit/wecom/bot.test.ts` 加：

```typescript
it('handleCommand /bridge: 列出飞书 session', async () => {
  const bridge = {
    listFeishuSessions: mock(() => Promise.resolve([
      { sessionUuid: 'fs-1', cwd: '/tmp', title: 'test', messageCount: 5, projectName: 'p', status: 'active' },
    ])),
    importSession: mock(() => Promise.resolve(true)),
  };
  const bot = new WecomBot({ botId, secret, userManager, bridge, ... });
  await bot.__test_handleCommand({
    messageId: 'm1', serialKey: 'cmd:u1', platform: 'wecom',
    userId: 'u1', text: '/bridge list',
  });
  expect(bridge.listFeishuSessions).toHaveBeenCalled();
});

it('handleCommand /bridge import <uuid>: 导入飞书 session', async () => {
  // 类似, 验证 importSession 被调
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -v`
Expected: FAIL with "unknown command /bridge"

- [ ] **Step 8: 实现 /bridge 命令**

`src/wecom/bot.ts:200` switch case 加：

```typescript
case 'bridge': {
  if (!this.bridge) {
    responseText = '❌ /bridge 未启用 (bridge 未注入)';
    break;
  }
  if (args.length === 0 || args[0] === 'list') {
    // /bridge [list]
    const sessions = await this.bridge.listFeishuSessions();
    if (sessions.length === 0) {
      responseText = '📭 飞书侧无 active session';
    } else {
      const lines = sessions.slice(0, 10).map((s, i) =>
        `  ${i + 1}. ${s.title}\n     uuid: ${s.sessionUuid}\n     cwd: ${s.cwd}\n     msgs: ${s.messageCount}`
      );
      responseText = `📋 飞书 active sessions (${sessions.length}):\n${lines.join('\n')}\n\n用法: /bridge import <uuid>`;
    }
  } else if (args[0] === 'import' && args[1]) {
    // /bridge import <uuid>
    const feishuUuid = args[1];
    const target = await this.bridge.listFeishuSessions();
    const session = target.find(s => s.sessionUuid === feishuUuid);
    if (!session) {
      responseText = `❌ 未找到飞书 session: ${feishuUuid}`;
    } else {
      const ok = await this.bridge.importSession(msg.userId, feishuUuid, session.cwd);
      responseText = ok
        ? `✅ 已导入飞书 session: ${feishuUuid}\n  cwd: ${session.cwd}\n\n下条消息将用这个 session 续聊`
        : '❌ 导入失败 (查看 logs)';
    }
  } else {
    responseText = '❌ 用法: /bridge [list] | /bridge import <uuid>';
  }
  break;
}
```

并在 `handleCommandHelp` (bot.ts:296) 更新帮助文本，去掉 "/bridge 推 PR 6+"。

- [ ] **Step 9: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bot.test.ts -v`
Expected: PASS

- [ ] **Step 10: 跑全量 + typecheck + commit**

```bash
bun test && bun run typecheck
git add src/wecom/bridge.ts src/wecom/bot.ts tests/unit/wecom/bridge.test.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.2 /bridge cross-platform session sync"
```

---

## Task 6.3: /stop <short> 真实实现（spec §10.1 第 2 项 + spec §6）

**Files:**
- Modify: `src/wecom/bot.ts:228` (handleCommand switch case 'stop')
- Create: `src/wecom/bg-session-stopper.ts` (~60 行, 调 claude stop)
- Test: `tests/unit/wecom/bg-session-stopper.test.ts`

- [ ] **Step 1: 写 bg-session-stopper 测试**

`tests/unit/wecom/bg-session-stopper.test.ts` (新建):

```typescript
import { describe, it, expect, mock } from 'bun:test';
import { WecomBgSessionStopper } from '../../../src/wecom/bg-session-stopper';

describe('WecomBgSessionStopper', () => {
  it('stop 调 claude stop <short> 并返回 exit code', async () => {
    const exec = mock(() => Promise.resolve({ exitCode: 0, stdout: 'stopped', stderr: '' }));
    const stopper = new WecomBgSessionStopper({ exec });
    const result = await stopper.stop('abc123');
    expect(exec).toHaveBeenCalledWith('claude', ['stop', 'abc123']);
    expect(result.ok).toBe(true);
  });

  it('stop 失败 (非 0 exit code) 返回 ok=false + stderr', async () => {
    const exec = mock(() => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'session not found' }));
    const stopper = new WecomBgSessionStopper({ exec });
    const result = await stopper.stop('nonexistent');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('session not found');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bg-session-stopper.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 实现 WecomBgSessionStopper**

`src/wecom/bg-session-stopper.ts` (新建):

```typescript
/**
 * 企微 /stop <short> 实现 - 调 claude stop
 * PR 6 Task 6.3: spec §10.1 第 2 项 + spec §6 bg session
 *
 * 模型: 与飞书侧 `claude stop` 调用对齐 (PR 2.5 引入)
 */
import { logger } from '../utils/logger';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type BgStopperConfig = {
  exec?: ExecFn;  // 可注入 (测试用)
};

export type StopResult = {
  ok: boolean;
  error?: string;
};

const defaultExec: ExecFn = async (cmd, args) => {
  const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

export class WecomBgSessionStopper {
  private readonly exec: ExecFn;

  constructor(config: BgStopperConfig = {}) {
    this.exec = config.exec ?? defaultExec;
  }

  async stop(short: string): Promise<StopResult> {
    try {
      const result = await this.exec('claude', ['stop', short]);
      if (result.exitCode === 0) {
        logger.info(`[wecom-bg-stop] stopped ${short}: ${result.stdout}`);
        return { ok: true };
      }
      logger.warn(`[wecom-bg-stop] stop ${short} failed (exit ${result.exitCode}): ${result.stderr}`);
      return { ok: false, error: result.stderr || `exit ${result.exitCode}` };
    } catch (err) {
      logger.error(`[wecom-bg-stop] stop ${short} threw: ${err}`);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/unit/wecom/bg-session-stopper.test.ts -v`
Expected: PASS (2/2)

- [ ] **Step 5: 在 WecomBot 注入 stopper + 实现 /stop 命令**

`src/wecom/bot.ts:19-41` 加 `bgStopper?: WecomBgSessionStopper;` 字段，构造函数注入。

`src/wecom/bot.ts:228` switch case 'stop' 改为：

```typescript
case 'stop': {
  if (args.length === 0) {
    responseText = '❌ 用法: /stop <short-id>\n\n(short-id 是 bg session 的 7 位 ID, /agents 查看)';
    break;
  }
  if (!this.bgStopper) {
    responseText = '❌ /stop 未启用 (bgStopper 未注入)';
    break;
  }
  const short = args[0];
  const result = await this.bgStopper.stop(short);
  responseText = result.ok
    ? `✅ 已停止 bg session: ${short}`
    : `❌ 停止失败: ${result.error}`;
  break;
}
```

- [ ] **Step 6: 写 /stop 单测**

`tests/unit/wecom/bot.test.ts` 加：

```typescript
it('handleCommand /stop <short>: 调 bgStopper.stop', async () => {
  const bgStopper = { stop: mock(() => Promise.resolve({ ok: true })) };
  const bot = new WecomBot({ ..., bgStopper });
  await bot.__test_handleCommand({
    messageId: 'm1', serialKey: 'cmd:u1', platform: 'wecom',
    userId: 'u1', text: '/stop abc1234',
  });
  expect(bgStopper.stop).toHaveBeenCalledWith('abc1234');
});

it('handleCommand /stop (无 short): 返回用法提示', async () => {
  const bot = new WecomBot({ ... });
  await bot.__test_handleCommand({
    messageId: 'm2', serialKey: 'cmd:u1', platform: 'wecom',
    userId: 'u1', text: '/stop',
  });
  // 验证 sendMessage 收到 "❌ 用法: /stop <short-id>"
});
```

- [ ] **Step 7: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
bun run typecheck
git add src/wecom/bg-session-stopper.ts src/wecom/bot.ts tests/unit/wecom/bg-session-stopper.test.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.3 /stop <short> real implementation"
```

---

## Task 6.4: Card action 'retry' 实现（spec §10.1 第 3 项）

**Files:**
- Modify: `src/wecom/bot.ts:655-677` (executeCardAction)
- Test: `tests/unit/wecom/bot.test.ts` (新增 card action 测试)

- [ ] **Step 1: 写 retry action 测试**

`tests/unit/wecom/bot.test.ts` 加：

```typescript
it('executeCardAction retry: 调 spoolQueue.requeueFromProcessing 重新入队', async () => {
  const spoolQueue = {
    requeueFromProcessing: mock(() => Promise.resolve()),
    markDone: mock(),
  };
  const bot = new WecomBot({ ..., spoolQueue });
  await bot.__test_executeCardAction({
    externalUserId: 'ext-1', messageId: 'msg-1', actionTag: 'retry',
    actionValue: {}, inboundFrame: { headers: { req_id: 'req-1' } },
  });
  expect(spoolQueue.requeueFromProcessing).toHaveBeenCalledWith('msg-1', expect.any(String));
});
```

- [ ] **Step 2: 暴露 executeCardAction 给测试**

`src/wecom/bot.ts:655` executeCardAction 之前加测试 seam：

```typescript
public async __test_executeCardAction(event: Parameters<typeof this.executeCardAction>[0]): Promise<void> {
  return this.executeCardAction(event);
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -v`
Expected: FAIL

- [ ] **Step 4: 实现 retry action**

`src/wecom/bot.ts:662-673` switch case 改为：

```typescript
switch (event.actionTag) {
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
  case 'stop': {
    // 见 Task 6.5
    break;
  }
  case 'confirm-stop': {
    // 见 Task 6.6
    break;
  }
  case 'list-refresh': {
    // 见 Task 6.7
    break;
  }
  default:
    logger.warn(`[wecom-bot] unknown card action: ${event.actionTag}`);
}
```

- [ ] **Step 5: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.4 card action retry implementation"
```

---

## Task 6.5: Card action 'stop' 实现（in-flight cancel）

**Files:**
- Modify: `src/wecom/bot.ts:662` (case 'stop')
- Modify: `src/wecom/stream-updater.ts` (加 cancel 流)
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写 stop action 测试**

```typescript
it('executeCardAction stop: 触发 in-flight cancel, 调 updater.cancel', async () => {
  const updater = { cancel: mock(() => Promise.resolve()) };
  const bot = new WecomBot({ ..., updater });
  await bot.__test_executeCardAction({
    externalUserId: 'ext-1', messageId: 'msg-1', actionTag: 'stop',
    actionValue: {}, inboundFrame: { headers: { req_id: 'req-1' } },
  });
  expect(updater.cancel).toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/unit/wecom/bot.test.ts -v`
Expected: FAIL

- [ ] **Step 3: 在 WecomStreamUpdater 加 cancel 方法**

`src/wecom/stream-updater.ts` 加：

```typescript
/**
 * PR 6 Task 6.5: in-flight cancel - 终止当前流
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §6.4
 */
async cancel(reason: string = '用户取消'): Promise<void> {
  if (!this.lastInboundFrame) {
    logger.warn('[wecom-stream] cancel called but no active stream');
    return;
  }
  // 状态切到 cancel + 推回 final 卡片
  this.lastState = 'cancelled';
  const cancelCard = WecomCardBuilder.textNotice({
    title: '已取消',
    content: reason,
  });
  try {
    await this.client.replyStream(
      { headers: { req_id: this.lastInboundFrame.headers.req_id } } as any,
      { msgtype: 'template_card', template_card: cancelCard as any },
    );
  } catch (err) {
    logger.error(`[wecom-stream] cancel replyStream failed: ${err}`);
  }
  this.lastInboundFrame = null;
}
```

- [ ] **Step 4: 实现 stop action**

`src/wecom/bot.ts:662` case 'stop' 加：

```typescript
case 'stop': {
  // 触发 in-flight cancel
  await this.updater.cancel('用户从卡片点击停止');
  // markDone 不调 - 让消息保持 processing 直到 replyStream 完成
  break;
}
```

- [ ] **Step 5: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add src/wecom/stream-updater.ts src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.5 card action stop + in-flight cancel"
```

---

## Task 6.6: Card action 'confirm-stop' 实现（硬杀进程）

**Files:**
- Modify: `src/wecom/bot.ts:662` (case 'confirm-stop')
- Modify: `src/proxy/session.ts` (ClaudeSessionManager 加 killSession API)
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写 confirm-stop 测试**

```typescript
it('executeCardAction confirm-stop: 调 sessionManager.terminateProcessTree 硬杀', async () => {
  const sessionManager = { terminateProcessTree: mock(() => Promise.resolve()) };
  const bot = new WecomBot({ ..., sessionManager });
  await bot.__test_executeCardAction({
    externalUserId: 'ext-1', messageId: 'msg-1', actionTag: 'confirm-stop',
    actionValue: { sessionUuid: 'uuid-1' }, inboundFrame: { headers: { req_id: 'req-1' } },
  });
  expect(sessionManager.terminateProcessTree).toHaveBeenCalledWith('uuid-1');
});
```

- [ ] **Step 2: 检查 terminateProcessTree 是否已存在**

`src/proxy/session.ts` 应该已经有 `terminateProcessTree` 方法（CLAUDE.md 提到）。如果已有，直接复用；如果没有，加：

```typescript
async terminateProcessTree(sessionUuid: string): Promise<void> {
  const proc = this.activeProcs.get(sessionUuid);
  if (!proc) {
    logger.warn(`[claude-session] terminateProcessTree: no active proc for ${sessionUuid}`);
    return;
  }
  // SIGTERM → 3s → SIGKILL
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL');
  }, 3000);
  this.activeProcs.delete(sessionUuid);
}
```

- [ ] **Step 3: 实现 confirm-stop action**

`src/wecom/bot.ts:662` case 'confirm-stop' 加：

```typescript
case 'confirm-stop': {
  const sessionUuid = event.actionValue?.sessionUuid;
  if (!sessionUuid || !this.sessionManager) {
    logger.warn(`[wecom-bot] confirm-stop: missing sessionUuid or sessionManager`);
    break;
  }
  await this.sessionManager.terminateProcessTree(sessionUuid);
  await this.client.sdk.sendMessage(event.externalUserId, {
    msgtype: 'markdown',
    markdown: { content: `✅ 已硬杀 session: ${sessionUuid}` },
  });
  break;
}
```

- [ ] **Step 4: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add src/wecom/bot.ts src/proxy/session.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.6 card action confirm-stop terminateProcessTree"
```

---

## Task 6.7: Card action 'list-refresh' 实现（重新拉 sessions 列表）

**Files:**
- Modify: `src/wecom/bot.ts:662` (case 'list-refresh')
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写 list-refresh 测试**

```typescript
it('executeCardAction list-refresh: 重新读 feishu sessions + 推新卡片', async () => {
  const bridge = {
    listFeishuSessions: mock(() => Promise.resolve([
      { sessionUuid: 'fs-1', cwd: '/tmp', title: 'test', messageCount: 5, projectName: 'p', status: 'active' },
    ])),
  };
  const bot = new WecomBot({ ..., bridge });
  await bot.__test_executeCardAction({
    externalUserId: 'ext-1', messageId: 'msg-1', actionTag: 'list-refresh',
    actionValue: {}, inboundFrame: { headers: { req_id: 'req-1' } },
  });
  expect(bridge.listFeishuSessions).toHaveBeenCalled();
  // 验证 sendMessage / replyWelcome 收到更新卡片
});
```

- [ ] **Step 2: 实现 list-refresh action**

`src/wecom/bot.ts:662` case 'list-refresh' 加：

```typescript
case 'list-refresh': {
  if (!this.bridge) {
    responseText = '❌ /bridge 未启用';
    break;
  }
  const sessions = await this.bridge.listFeishuSessions();
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

- [ ] **Step 3: 跑测试 + commit**

```bash
bun test tests/unit/wecom/bot.test.ts -v
git add src/wecom/bot.ts tests/unit/wecom/bot.test.ts
git commit -m "feat(wecom): PR 6 Task 6.7 card action list-refresh"
```

---

## Task 6.8: PR 6 集成 + 飞书零回归

**Files:**
- Modify: `src/wecom/index.ts` (导出新模块)
- Modify: `src/cli/commands/start.ts` (注入 bridge/bgStopper/imageHandler)
- Test: 全量 `bun test`

- [ ] **Step 1: 跑全量测试**

Run: `bun test`
Expected: 1167+ + 6 个新 image-handler + 2 个 bridge + 2 个 bg-stopper + 7 个 bot = ~1184+ 全过

- [ ] **Step 2: 飞书零回归**

Run: `bun test tests/unit/feishu/ tests/integration/feishu/`
Expected: 全部通过，零回归

- [ ] **Step 3: 在 start.ts 注入新模块**

`src/cli/commands/start.ts` 在 wecom-only 分支加：

```typescript
import { WecomBridge } from '../../wecom/bridge';
import { WecomBgSessionStopper } from '../../wecom/bg-session-stopper';
import { WecomImageHandler } from '../../wecom/image-handler';
import { join } from 'path';
import { expandPath } from '../../utils/paths';

// ... 在创建 WecomBot 处:
const imageHandler = new WecomImageHandler({
  cacheDir: join(expandPath('~/.cc-linker'), 'image_cache'),
});
const bridge = new WecomBridge({
  registryPath: expandPath('~/.cc-linker/registry.json'),
  wecomUserManager: userManager,
});
const bgStopper = new WecomBgSessionStopper();

const wecomBot = new WecomBot({
  ...,
  imageHandler,
  bridge,
  bgStopper,
});
```

- [ ] **Step 4: typecheck + E2E 冒烟 (可选)**

```bash
bun run typecheck
# 启动 wecom-only 模式
bun run dev start --platform=wecom --daemon
bun run dev daemon status
bun run dev stop
```

Expected: 启动成功, daemon 拉起, 停止无残留

- [ ] **Step 5: Commit + 推 PR**

```bash
git add src/wecom/index.ts src/cli/commands/start.ts
git commit -m "feat(wecom): PR 6 wire image/bridge/bgStopper in start.ts"

# 推分支
git push -u origin feat/wecom-pr6-spec-completeness
gh pr create --base master --title "PR 6: WeCom spec §10.1 验收项补全 (image + /bridge + /stop + 4 actionTag)"
```

---

# PR 7: 质量 & 技术债

**目标**: 修复 review 报告中的 8 个 Major + 15 个 Minor，分 3 个 P 级别批次。

**前置**: PR 6 已合

---

## Task 7.1: M-3 writeAtomic fsync（已在主批修，本 Task 仅 verify）

- [ ] **Step 1: 确认 PR 5 主批的 M-3 commit**

```bash
git log --oneline -20 | grep "M-3"
```

Expected: 有 commit `fix(spool): M-3 writeAtomic fsync for 0-byte safety (symmetric with saveMapping)`

- [ ] **Step 2: 跑测试确认 0 字节自愈回归**

```bash
bun test tests/unit/queue/spool.test.ts
```

Expected: PASS, 含 PR 4.1 引入的 0 字节自愈测试

- [ ] **Step 3: 标记 done**

如果 commit 存在且测试 pass，标 done。否则执行 PR 6 Task 6.4 类似 fsync 修复（与主批 fix 完全一致）。

---

## Task 7.2: M-4 startupReconcile 加 wecom 路径

**Files:**
- Modify: `src/runtime/reconciler.ts:43-69` (startupReconcile 加 platform filter)
- Test: `tests/unit/runtime/reconciler.test.ts`

- [ ] **Step 1: 读 startupReconcile 当前实现**

Read: `src/runtime/reconciler.ts`

- [ ] **Step 2: 写测试**

```typescript
it('startupReconcile 处理 wecom 平台消息', async () => {
  // 创建 ~/.cc-linker/spool/processing/wecom/msg-1.json
  // mock state-coordinator, 调 startupReconcile('wecom')
  // 验证 msg-1 移到 pending
});

it('startupReconcile 默认 (无 platform) 处理 feishu + wecom 全部', async () => {
  // 类似, 验证不传 platform 时两个平台都处理
});
```

- [ ] **Step 3: 跑测试确认失败**

- [ ] **Step 4: 实现 platform filter**

仿照 `listProcessing` / `listPending` 加 `platform?` 参数。

- [ ] **Step 5: 跑测试 + commit**

```bash
git add src/runtime/reconciler.ts tests/unit/runtime/reconciler.test.ts
git commit -m "fix(runtime): M-4 startupReconcile support wecom platform"
```

---

## Task 7.3: M-5 spool cleanup lex → mtime

**Files:**
- Modify: `src/queue/spool.ts:441-487` (cleanup 函数)
- Test: `tests/unit/queue/spool.test.ts`

- [ ] **Step 1: 写测试**

```typescript
it('cleanup: 按 mtime 排序, 不是 lex order', async () => {
  // 创建 3 个文件, mtime 顺序: c (最早) → a → b (最新)
  // cleanup 保留 2 个最新, 应保留 a + b
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 改用 `stat` 拿 mtime 排序**

- [ ] **Step 4: 跑测试 + commit**

```bash
git commit -m "fix(spool): M-5 cleanup sort by mtime not lex order"
```

---

## Task 7.4: M-6 streamId 加 userId keying

**Files:**
- Modify: `src/wecom/stream-updater.ts:64` (streamId 单字段)
- Test: `tests/unit/wecom/stream-updater.test.ts`

- [ ] **Step 1: 写测试**

```typescript
it('stream-updater: 多 user 并发流互不干扰', async () => {
  // 并发触发 user1 + user2 的流
  // 验证 replyStream 收到的 req_id 分别对应 user1 + user2
});
```

- [ ] **Step 2: 改 Map<userId, frame> 替代单字段**

- [ ] **Step 3: 跑测试 + commit**

```bash
git commit -m "fix(wecom): M-6 streamId key by userId for multi-user safety"
```

---

## Task 7.5: M-7 handleCommandResume lastActiveAt 重读

**Files:**
- Modify: `src/wecom/bot.ts:323-330` (handleCommandResume)
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写测试**

```typescript
it('handleCommandResume: 返回新 lastActiveAt, 不是旧的', async () => {
  const userManager = {
    getEntry: mock(() => ({ type: 'session', sessionUuid: 'u', cwd: '/tmp', lastActiveAt: 'OLD' })),
    touchSession: mock(() => Promise.resolve()),
    getEntry: mock(() => ({ type: 'session', sessionUuid: 'u', cwd: '/tmp', lastActiveAt: 'NEW' })),  // 第二次调用返回新值
  };
  // ...
  // 验证返回文本含 NEW, 不含 OLD
});
```

- [ ] **Step 2: 改 handleCommandResume touchSession 后重新 getEntry**

- [ ] **Step 3: 跑测试 + commit**

```bash
git commit -m "fix(wecom): M-7 handleCommandResume return new lastActiveAt"
```

---

## Task 7.6: M-8 state-coordinator fsync

**Files:**
- Modify: `src/runtime/state-coordinator.ts:107-115`
- Test: 现有 + 加 1 个

- [ ] **Step 1: 仿 M-3 修法, 改 writeLock 用 openSync + writeSync + fsyncSync + closeSync + renameSync**

- [ ] **Step 2: 跑测试 + commit**

```bash
git commit -m "fix(runtime): M-8 state-coordinator write lock fsync"
```

---

## Task 7.7: M-2 dispatch loop 立即 stop

**Files:**
- Modify: `src/wecom/bot.ts:125-167` (startDispatchLoop)
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写测试**

```typescript
it('stop 立即中断 dispatch loop (不等待 setTimeout 2s)', async () => {
  const start = Date.now();
  bot.stop();
  await new Promise(r => setTimeout(r, 50));
  expect(Date.now() - start).toBeLessThan(500);
});
```

- [ ] **Step 2: 改 setTimeout 为可中断 timer (clearTimeout in stop)**

- [ ] **Step 3: 跑测试 + commit**

```bash
git commit -m "fix(wecom): M-2 dispatch loop stop within 100ms not 2s"
```

---

## Task 7.8: M-1 handleCommand 群聊 chatId 路由

**Files:**
- Modify: `src/wecom/bot.ts:241` (handleCommand sendMessage)
- Test: `tests/unit/wecom/bot.test.ts`

- [ ] **Step 1: 写测试**

```typescript
it('handleCommand: 群聊消息 (metadata.chatId) 用 chatId 而非 userId', async () => {
  const sdk = { sendMessage: mock() };
  const bot = new WecomBot({ ..., client: { sdk, ... } });
  await bot.__test_handleCommand({
    ..., userId: 'u1', metadata: { chatId: 'chat-1' },
  });
  expect(sdk.sendMessage).toHaveBeenCalledWith('chat-1', expect.any(Object));
});
```

- [ ] **Step 2: 改 receiveId 优先用 metadata.chatId**

```typescript
const receiveId = (msg.metadata as any)?.chatId ?? msg.userId;
await this.client.sdk.sendMessage(receiveId, { ... });
```

- [ ] **Step 3: 跑测试 + commit**

```bash
git commit -m "fix(wecom): M-1 handleCommand routes to chatId for group chat"
```

---

## Task 7.9: 15 个 minor 修复（分组批量）

**Files:** 多个

每个 minor 1 个独立 commit，重复 TDD 模式：
- m-1: dispatch 全表扫描 → 加 platform 索引（与 M-4 重叠, skip）
- m-2: text/thinking 闭包提取独立函数
- m-3: stream-updater 限频窗口常量提取
- m-4: card.ts `as any` → 加 WecomTemplateCard 类型
- m-5: init-wecom token 校验 (verify 步骤)
- m-6: secret 空串覆盖 (与 PR 2 review 误报类似, skip)
- m-7: replyWelcome 失败无补发 (推 PR 8+)
- m-8: lockKey userId vs openId (加注释)
- m-9: action_menu 硬编码 desc 提取
- m-10: logger.stack 序列化 secrets (加 sanitizer)
- m-11: botId/secret 验证 (与 m-5 重叠)
- m-12: 30s grace period 优化
- m-13: init-wecom 覆盖确认 prompt
- m-14: reconciler platform filter (与 M-4 重叠, skip)
- m-15: metadata.chatId 未存 (加存)

```bash
# 每个 minor 1 commit
for minor in m-2 m-3 m-4 m-5 m-7 m-8 m-9 m-10 m-12 m-13 m-15; do
  # 1. 写测试
  # 2. 实现
  # 3. 跑测试
  # 4. commit "fix(wecom): ${minor} ..."
done
```

---

## Task 7.10: claimPending 重新接通 dispatch loop

**Files:**
- Modify: `src/wecom/bot.ts:421-540` (handleChat)
- Test: 现有 + 加 1 个 claim 流程测试

- [ ] **Step 1: 在 handleChat 入口处先调 claimPending 取代直接读 pending**

```typescript
private async handleChat(msg: SpoolMessage): Promise<void> {
  // ... 现有 owner 验证 ...
  
  // PR 7 Task 7.10: claimPending 重新接通 (去 @deprecated)
  const claimResult = await this.userManager.claimPending(msg.userId, msg.messageId);
  if (claimResult.status === 'unauthorized') {
    // 已在 owner 验证拦住, 不应到这
    return;
  }
  if (claimResult.status === 'creating') {
    // 已有 claim, 等或放弃
    logger.warn(`[wecom-bot] handleChat: userId=${msg.userId} in creating state, skipping`);
    this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    return;
  }
  if (claimResult.status === 'no_pending') {
    // 没 pending, 走默认路径 (有 session 续聊 / 没 session 新建)
  }
  if (claimResult.status === 'claimed') {
    // 刚 claim, 走 new 路径
  }
  
  // ... 现有 Claude 流式逻辑 ...
  
  // 流式完成后调 bindSessionToClaim 取代 setSession
  if (claimResult.status === 'claimed' && result.sessionId) {
    await this.userManager.bindSessionToClaim(msg.userId, msg.messageId, result.sessionId, cwd);
  }
}
```

- [ ] **Step 2: 跑测试 (5 个 mapping 测试 + 6 个 bot 测试)**

- [ ] **Step 3: commit**

```bash
git commit -m "feat(wecom): PR 7 Task 7.10 re-enable claimPending in dispatch"
```

---

## Task 7.11: PR 7 集成 + 飞书零回归

- [ ] **Step 1: 跑全量测试 + typecheck**

- [ ] **Step 2: 飞书零回归**

- [ ] **Step 3: commit 收尾 + 推 PR**

```bash
git push -u origin feat/wecom-pr7-quality
gh pr create --base master --title "PR 7: WeCom quality & tech debt (M-1~M-8 + 11 minor + claimPending re-enable)"
```

---

# PR 8: Agent View 跨平台（可选，未来 PR）

**目标**: 把 spec §6 + 2026-06-01-feishu-agent-view-design.md 的飞书 AgentViewManager 抽象到 platform 层，企微侧用 template_card 适配。

**前置**: PR 7 已合, 飞书 AgentView 已稳定

---

## Task 8.1: 抽象 AgentSnapshotFetcher 平台无关

**Files:**
- Create: `src/platform/agent-snapshot.ts` (interface + abstract class)
- Modify: `src/agent-view/snapshot-fetcher.ts` (继承 platform 抽象)

[详细步骤类似 PR 6 Task 6.1, 略]

---

## Task 8.2: WecomAgentViewManager 复用 + 卡片适配

**Files:**
- Create: `src/wecom/agent-view-manager.ts` (~250 行)
- Modify: `src/wecom/bot.ts` (注入 agentViewManager)
- Test: `tests/unit/wecom/agent-view-manager.test.ts`

[详细步骤略, 复用飞书 AgentViewManager.handleList/handlePeek/handleReplyRequest/handleReply/handleStop/handleAttach, 卡片用 WecomCardBuilder 渲染]

---

## Task 8.3: /agents /peek /reply /stop wecom 路径

[详细步骤略]

---

## Task 8.4: PR 8 集成

- [ ] 跑全量 + 飞书零回归 + typecheck
- [ ] 推 PR `feat/wecom-pr8-agent-view`

---

# 验收清单（全部 PR 完成后）

## spec §10.1 验收

- [ ] cc-linker start --platform=wecom 可启动企微 Bot
- [ ] 手机企微发文本 → Claude 流式回复 ✅ (PR 4.1)
- [ ] 手机企微发图片 → Claude 流式回复 ✅ (PR 6 Task 6.1)
- [ ] /list /switch /new /resume 命令全部工作 ✅ (PR 4.5 C)
- [ ] /bridge /stop 命令全部工作 ✅ (PR 6 Task 6.2 + 6.3)
- [ ] 按钮回调（重试 / 停止 / 刷新列表）正常 ✅ (PR 6 Task 6.4-6.7)
- [ ] WSS 重连稳定 ✅ (PR 2)
- [ ] 限频场景下回复完整 ✅ (PR 2)
- [ ] setup 多渠道工作 ✅ (PR 3.5)

## 飞书零回归

- [ ] 飞书 E2E 5 case 全过
- [ ] --platform=all 时飞书 + 企微共存无冲突

## spec 完成度

- [ ] 从 75% → 95% (剩余 5% 是 /cancel 真接 abort + agent view wecom + WSS 5min 重连 E2E 真实压测)
- [ ] Review 报告 8 Major 全部修复 ✅
- [ ] 15 Minor 修复 ≥ 11 个 ✅
- [ ] claimPending 重新接通 ✅

## 文档

- [ ] README 更新 (PR 6 完成后)
- [ ] spec §10.1 验收勾选
- [ ] config.toml [wecom] 节注释更新
