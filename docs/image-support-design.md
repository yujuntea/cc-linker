# cc-linker 飞书图片消息支持设计方案

> 版本: v1.0
> 日期: 2026-05-28
> 状态: 待评审

---

## 1. 背景与现状分析

### 1.1 当前行为

cc-linker 飞书机器人仅处理文本消息。当用户在飞书私聊中发送图片时，消息被静默丢弃：

```typescript
// src/feishu/bot.ts:111-114
if (event.message_type !== 'text') {
  logger.debug(`忽略非文本消息: ${event.message_id} (message_type=${event.message_type})`);
  return;  // 图片、文件、富文本全部在此被丢弃
}
```

### 1.2 四层阻断点

| 层 | 文件 | 位置 | 阻断行为 |
|----|------|------|----------|
| 1. 消息类型过滤 | `bot.ts` | `onMessage()` | `event.message_type !== 'text'` 直接 return |
| 2. 类型定义 | `bot.ts` | `FeishuMessageEvent` | `message_type: 'text'` 硬编码，不接受其他值 |
| 3. 内容提取 | `bot.ts` | `onMessage()` | 只取 `JSON.parse(content).text`，图片的 `image_key` 字段被忽略 |
| 4. Claude 调用 | `session.ts` | `_doSendMessage()` | `args.push('-p', text)` 只传纯文本给 Claude CLI |

### 1.3 用户影响

- 用户在飞书端截图、拍照发送给 bot 时，无任何响应
- 无法通过飞书分享设计稿、错误截图、UI 截图等视觉内容给 Claude
- 与 Claude Code 本地终端的能力差距明显（终端中 Claude 的 `Read` 工具原生支持读取图片）

### 1.4 Claude 图片能力现状

**Claude CLI（`claude -p` 模式）：**
- `Read` 工具原生支持读取 PNG、JPG、WebP、GIF 格式图片
- 无需特殊 CLI flag，只需在 prompt 中引用图片的本地文件路径
- Claude 会自动使用 Read 工具读取路径指向的图片文件

**Anthropic Agent SDK（`@anthropic-ai/claude-agent-sdk`）：**
- `query({ prompt: string })` 只接受文本 prompt
- 但 Claude agent 在执行过程中同样可使用 Read 工具读取本地图片

**结论：** 只要将图片下载到本地并在 prompt 中引用路径，Claude 即可"看到"图片内容。

---

## 2. 需求概述

### 2.1 目标

让飞书用户能够发送图片消息给 bot，bot 下载图片后交由 Claude 理解并回复。

### 2.2 用户故事

| 角色 | 需求 |
|------|------|
| 飞书用户 | 我想发截图给 bot 让它描述图片内容 |
| 飞书用户 | 我想发错误截图让 Claude 帮我分析问题 |
| 飞书用户 | 我想发设计稿/原型图让 Claude 写实现代码 |
| 飞书用户 | 我想发代码截图让 Claude 帮我 review |
| 飞书用户 | 我不想做任何额外配置，发图片就应该能用 |

### 2.3 范围界定

**本期（Phase 1）：**
- ✅ 支持 `message_type = 'image'` 的纯图片消息
- ✅ 支持单张图片的理解和回复
- ✅ 自动下载、存储、清理图片
- ✅ 无需用户额外配置

**后续迭代：**
- ❌ `message_type = 'post'`（富文本图文混排消息）— 后续版本
- ❌ 多图同时发送（多次单图消息可以正常处理）— 后续版本
- ❌ 文件消息（PDF、Word 等）— 后续版本
- ❌ 视频/音频消息 — 后续版本

---

## 3. 核心设计原则

| 原则 | 说明 |
|------|------|
| **零配置** | 图片支持默认开启，用户无需修改任何配置 |
| **透明代理** | bot 只负责下载和传递图片，不进行任何图片处理或 OCR |
| **复用 Claude 能力** | 利用 Claude 的 Read 工具原生读图，不引入额外图片识别依赖 |
| **优雅降级** | 图片下载失败时回复友好提示，不影响文本消息处理 |
| **存储安全** | 图片本地加密存储（0o600 权限），24 小时自动清理 |
| **向后兼容** | 不改变现有文本消息的任何行为 |

---

## 4. 术语表

| 术语 | 定义 |
|------|------|
| image_key | 飞书分配的图片资源标识符，格式如 `img_v3_xxxx` |
| message_id | 飞书消息唯一标识，用于关联图片资源下载 |
| messageResource | 飞书 API 端点 `im.v1.messageResource.get`，用于下载消息中嵌入的资源文件 |
| Read 工具 | Claude Code 内置工具，支持读取本地文件（包括图片） |

---

## 5. 技术方案选型

### 5.1 图片下载 API 选择

飞书提供了两个图片相关 API：

| API | 用途 | 能否下载用户发送的图片 |
|-----|------|----------------------|
| `im.v1.image.get` | 下载机器人自己上传的图片 | ❌ 不行 |
| `im.v1.messageResource.get` | 下载消息中的资源文件（图片、视频、音频、文件） | ✅ 可以 |

**选择 `messageResource.get`。**

飞书 SDK 签名：

```typescript
client.im.v1.messageResource.get({
  params: { type: 'image' },
  path: {
    message_id: string,   // 消息 ID
    file_key: string,      // 图片的 image_key
  },
})
// 返回:
// {
//   writeFile: (filePath: string) => Promise<unknown>,
//   getReadableStream: () => Readable,
//   headers: any,
// }
```

`writeFile` 方法可直接将图片保存到本地文件，是最简便的方式。

### 5.2 图片传递给 Claude 的方式

**方案对比：**

| 方案 | 描述 | 复杂度 | 可靠性 |
|------|------|--------|--------|
| A. Prompt 内嵌路径 | 将图片本地路径写入 prompt 文本，指示 Claude 用 Read 工具读取 | 低 | 高 |
| B. Base64 编码 | 将图片转为 base64 内联到 prompt | 高 | 低（prompt 膨胀） |
| C. Claude CLI `--file` flag | 用 `--file` 传递文件资源 | 中 | 中（格式限制） |

**选择方案 A。** 理由：
- 最简单，不需要修改 `session.ts`
- Claude 的 Read 工具原生支持图片，可靠性最高
- prompt 长度增加极小（仅文件路径）

**Prompt 模板：**

```
[用户发送了一张图片: ~/.cc-linker/images/msg-xxx_img-xxx.png]
请查看以上图片文件，然后理解图片内容。
```

纯图片消息（无文字）时自动补充默认指令 "请描述这张图片的内容。"

### 5.3 飞书消息 content 格式

**图片消息（`message_type: 'image'`）：**

```json
{
  "image_key": "img_v3_0abc-defg-hijk"
}
```

> 注意：图片消息的 content 中只有 `image_key`，没有文字内容。

**富文本消息（`message_type: 'post'`，后续迭代）：**

```json
{
  "zh_cn": {
    "title": "标题",
    "content": [
      [
        { "tag": "text", "text": "这是文字 " },
        { "tag": "img", "image_key": "img_v3_xxxx", "width": 300, "height": 200 }
      ]
    ]
  }
}
```

---

## 6. 详细设计

### 6.1 新增模块：`src/feishu/image.ts`

负责图片下载、解析、路径管理和清理。

```typescript
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, chmodSync } from 'fs';
import { IMAGES_DIR } from '../utils/paths';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

// ─── 类型 ───

/** 从 content JSON 中解析出的图片信息 */
interface ImageInfo {
  imageKey: string;
}

// ─── 常量 ───

/** 图片文件扩展名（飞书通常返回 JPEG/PNG） */
const IMAGE_EXTENSION = '.png';

// ─── 核心函数 ───

/**
 * 从图片消息的 content 中提取 image_key
 *
 * @param content - event.content JSON 字符串，格式: '{"image_key":"img_v3_xxxx"}'
 * @returns image_key 字符串，解析失败返回 null
 */
export function extractImageKey(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    return parsed.image_key ?? null;
  } catch {
    return null;
  }
}

/**
 * 从飞书下载消息中的图片到本地
 *
 * 调用 im.v1.messageResource.get API，使用 writeFile 直接保存。
 *
 * @param client  - Feishu SDK Client 实例（@larksuiteoapi/node-sdk）
 * @param messageId - 飞书消息 ID
 * @param imageKey  - 图片的 image_key
 * @returns 本地文件绝对路径
 * @throws 下载失败或文件超大小限制时抛出错误
 */
export async function downloadMessageImage(
  client: any,
  messageId: string,
  imageKey: string,
): Promise<string> {
  // 确保目录存在
  if (!existsSync(IMAGES_DIR)) {
    mkdirSync(IMAGES_DIR, { recursive: true, mode: 0o700 });
  }

  const localPath = join(IMAGES_DIR, `${messageId}_${imageKey}${IMAGE_EXTENSION}`);

  // 调用飞书 API 下载
  const response = await client.im.v1.messageResource.get({
    params: { type: 'image' },
    path: { message_id: messageId, file_key: imageKey },
  });

  // 保存到本地并设置安全权限
  await response.writeFile(localPath);
  chmodSync(localPath, 0o600);

  // 校验文件大小
  const maxSize = config.get<number>('images.max_size_bytes', 10 * 1024 * 1024);
  const stat = statSync(localPath);
  if (stat.size > maxSize) {
    unlinkSync(localPath);
    throw new Error(`图片大小 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过限制 ${(maxSize / 1024 / 1024).toFixed(0)}MB`);
  }

  logger.info(`图片已下载: ${imageKey} → ${localPath} (${(stat.size / 1024).toFixed(1)}KB)`);
  return localPath;
}

/**
 * 组装包含图片路径引用的 prompt
 *
 * 将图片路径以结构化文本形式嵌入 prompt 开头，
 * 指示 Claude 使用 Read 工具读取图片后理解内容。
 *
 * @param text       - 用户原始文字消息（可为空）
 * @param imagePaths - 图片本地路径列表
 * @returns 完整 prompt 字符串
 */
export function buildPromptWithImages(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text;

  const imageRefs = imagePaths
    .map((path, i) => `[用户发送了第${i + 1}张图片: ${path}]`)
    .join('\n');

  const instruction = '请查看以上图片文件，然后理解图片内容。';
  const body = text.trim() || '请描述这张图片的内容。';

  return `${imageRefs}\n${instruction}\n${body}`;
}

/**
 * 清理过期图片文件
 *
 * 按文件修改时间判断，删除超过 maxAgeHours 的文件。
 * 在 bot 启动时和 dispatch 循环中调用。
 *
 * @param maxAgeHours - 最大保留时长（小时），默认从配置读取
 */
export function cleanupOldImages(maxAgeHours?: number): void {
  const maxAge = maxAgeHours ?? config.get<number>('images.cleanup_max_age_hours', 24);
  const maxAgeMs = maxAge * 60 * 60 * 1000;

  if (!existsSync(IMAGES_DIR)) return;

  const now = Date.now();
  let cleaned = 0;

  try {
    const files = readdirSync(IMAGES_DIR);
    for (const file of files) {
      const filePath = join(IMAGES_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // 单文件清理失败不影响整体
      }
    }
  } catch (err) {
    logger.warn(`图片清理失败: ${err}`);
  }

  if (cleaned > 0) {
    logger.info(`已清理 ${cleaned} 个过期图片文件`);
  }
}
```

### 6.2 新增路径常量

**修改：`src/utils/paths.ts`**

```typescript
// 新增一行
export const IMAGES_DIR = join(CC_LINKER_DIR, 'images');
```

### 6.3 消息类型扩展

**修改：`src/feishu/bot.ts` — `FeishuMessageEvent` 类型**

```typescript
// BEFORE
export type FeishuMessageEvent = {
  open_id: string;
  message_id: string;
  content: string;
  chat_type: 'p2p' | 'group';
  message_type: 'text';
};

// AFTER
export type FeishuMessageEvent = {
  open_id: string;
  message_id: string;
  content: string;
  chat_type: 'p2p' | 'group';
  message_type: 'text' | 'image';   // 新增 image
};
```

### 6.4 SpoolMessage 扩展

**修改：`src/queue/spool.ts`**

```typescript
export interface SpoolMessage {
  messageId: string;
  openId: string;
  text: string;
  target: TargetSnapshot;
  serialKey: string;
  status: SpoolStatus;
  createdAt: string;
  updatedAt: string;
  replyMessageId?: string;
  responseText?: string;
  retryCount?: number;
  nextAttemptAt?: string;
  error?: string;
  imagePaths?: string[];   // NEW: 下载的图片本地路径列表
}
```

**序列化兼容性：** `imagePaths` 为 `undefined` 时不影响已有 JSON 文件的反序列化。SpoolQueue 的 `enqueue()` 方法已有 `JSON.stringify(spoolMsg)` 写入，新增字段自动序列化。

### 6.5 消息处理流程改造

**修改：`src/feishu/bot.ts` — `onMessage()` 方法**

```typescript
async onMessage(event: FeishuMessageEvent): Promise<void> {
  // 1. 保留原有检查：群聊、owner 验证、消息去重

  // 2. 放开消息类型过滤
  // BEFORE: if (event.message_type !== 'text') { return; }
  // AFTER:
  if (!['text', 'image'].includes(event.message_type)) {
    logger.debug(`忽略不支持的消息类型: ${event.message_id} (message_type=${event.message_type})`);
    return;
  }

  // 3. 根据消息类型提取内容
  let text = '';
  let imagePaths: string[] = [];

  if (event.message_type === 'image') {
    // 图片消息处理
    if (!config.get<boolean>('images.enabled', true)) {
      await this.replyFn('⚠️ 图片处理功能已禁用', {
        messageId: event.message_id,
        openId: event.open_id,
        requestUuid: stableUuid(event.message_id),
      });
      return;
    }

    if (!this.feishuClient) {
      await this.replyFn('⚠️ 图片处理功能未就绪（缺少飞书客户端配置），请发送文字消息。', {
        messageId: event.message_id,
        openId: event.open_id,
        requestUuid: stableUuid(event.message_id),
      });
      return;
    }

    const imageKey = extractImageKey(event.content);
    if (!imageKey) {
      logger.warn(`图片消息解析失败: ${event.message_id}, content=${event.content}`);
      return;
    }

    try {
      const localPath = await downloadMessageImage(
        this.feishuClient, event.message_id, imageKey,
      );
      imagePaths = [localPath];
      text = '';  // 图片消息无文字内容
    } catch (err: any) {
      logger.error(`图片下载失败: ${event.message_id}: ${err.message}`);
      await this.replyFn(`⚠️ 图片下载失败: ${err.message}`, {
        messageId: event.message_id,
        openId: event.open_id,
        requestUuid: stableUuid(event.message_id),
      });
      return;
    }
  } else {
    // 文本消息处理（原有逻辑）
    try {
      const content = JSON.parse(event.content);
      text = content.text ?? '';
    } catch {
      text = event.content;
    }
    text = text.trim();
  }

  // 4. 空消息检查（纯图片消息 text 可以为空，但 imagePaths 不为空时允许）
  if (!text && imagePaths.length === 0) return;

  // 5. 消息长度限制（仅检查文字部分）
  const MAX_MESSAGE_LENGTH = 10000;
  if (text.length > MAX_MESSAGE_LENGTH) {
    // ... 原有长度限制逻辑 ...
    return;
  }

  // 6. 命令检测（图片消息不会是命令，直接走聊天流程）
  const isCommand = text.startsWith('/') && text.length > 1 && text[1] !== ' ';
  const target = isCommand
    ? { type: 'no_target' as const, openId: event.open_id, mappingVersion: this.userManager.getVersion() }
    : await this.resolveChatTarget(event.open_id, event.message_id);

  // 7. 构造 SpoolMessage（新增 imagePaths）
  const serialKey = target.type === 'session' && target.sessionUuid
    ? target.sessionUuid
    : `new:${event.open_id}`;

  const spoolMsg: SpoolMessage = {
    messageId: event.message_id,
    openId: event.open_id,
    text,
    target,
    serialKey,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    imagePaths,   // NEW
  };

  const enqueued = this.spoolQueue.enqueue(spoolMsg);
  // ... 原有入队失败处理 ...
}
```

### 6.6 Prompt 组装注入

**修改：`src/feishu/bot.ts` — `handleChat` 相关方法**

在所有调用 `sessionManager.sendMessage()` / `sendStreamingMessage()` / `sendSDKMessage()` 的地方，使用 `buildPromptWithImages()` 替换原始 `msg.text`。

**影响的方法：**

| 方法 | 行号（约） | 改动 |
|------|-----------|------|
| `handleChatNonStreaming()` | ~549 | `sessionManager.sendMessage(sessionUuid, msg.text, ...)` → `sessionManager.sendMessage(sessionUuid, buildPromptWithImages(msg.text, msg.imagePaths), ...)` |
| `handleChatStreaming()` | ~606 | 同上 `sendStreamingMessage()` |
| `handleChatSDK()` | ~705 | 同上 `sendSDKMessage()` |
| `createSessionFromPrompt()` | ~1438 | 同上 `sendMessage(null, prompt, ...)` |
| `createSessionFromPromptStreaming()` | ~850 | 同上 `sendStreamingMessage(null, prompt, ...)` |
| `createSessionFromPromptSDK()` | ~989 | 同上 `sendSDKMessage(null, prompt, ...)` |

**统一改造方式：** 在 `handleChat` 入口处组装 prompt：

```typescript
private async handleChat(msg: SpoolMessage): Promise<void> {
  // 在分发前统一组装包含图片引用的 prompt
  // 注意：不能修改 msg.text（会被写入 registry preview），
  // 所以单独构造 prompt 变量
  // ...
}
```

各子方法内部改为接收 `prompt` 参数而非直接使用 `msg.text`。或更简单地，在每个子方法内部调用处组装：

```typescript
// handleChatNonStreaming 内部
const promptText = buildPromptWithImages(msg.text, msg.imagePaths);
const result = await this.sessionManager.sendMessage(
  sessionUuid, promptText, cwd, false, msg.serialKey, settingsPath,
);
```

> **注意：** `last_message_preview` 的处理需要兼容图片消息：
>
> ```typescript
> // 各 handleChat* 方法中写入 registry 时：
> last_message_preview: preview(msg.text) || (msg.imagePaths?.length ? '[图片]' : ''),
> ```
>
> 纯图片消息（`msg.text` 为空）时显示为 `[图片]`，文字+图片消息时显示文字 preview。

### 6.7 配置项

**修改：`src/utils/config.ts`**

```typescript
// ConfigData 接口新增
interface ConfigData {
  // ... 现有字段 ...
  images: {
    enabled: boolean;              // 是否启用图片支持
    max_size_bytes: number;        // 单张图片最大大小（字节）
    cleanup_max_age_hours: number; // 图片保留时长（小时）
  };
}

// DEFAULTS 新增
const DEFAULTS: ConfigData = {
  // ... 现有默认值 ...
  images: {
    enabled: true,
    max_size_bytes: 10 * 1024 * 1024,  // 10MB
    cleanup_max_age_hours: 24,
  },
};
```

### 6.8 图片清理集成

**修改：`src/feishu/bot.ts` — `dispatch()` 方法**

在 dispatch 循环的每次迭代开始时，调用清理函数：

```typescript
// 在 FeishuBot 类中增加节流标记
private lastImageCleanup = 0;

async dispatch(): Promise<void> {
  if (this.running) return;
  this.running = true;

  try {
    while (!this.stopRequested) {
      // 每小时清理一次过期图片（避免频繁扫描目录）
      const now = Date.now();
      if (now - this.lastImageCleanup > 60 * 60 * 1000) {
        cleanupOldImages();
        this.lastImageCleanup = now;
      }

      // ... 原有 dispatch 逻辑 ...
    }
  } finally {
    this.running = false;
  }
}
```

---

## 7. 完整数据流

```
用户在飞书私聊发送图片
        │
        ▼
飞书 WSClient 收到 im.message.receive_v1 事件
  {
    message: {
      message_id: "msg-abc123",
      message_type: "image",
      content: '{"image_key":"img_v3_xxxx"}'
    }
  }
        │
        ▼
start.ts: EventDispatcher → bot.onMessage(event)
        │
        ▼
bot.onMessage():
  ├── 检查 chat_type === 'p2p'  ✓
  ├── 检查 message_type ∈ ['text', 'image']  ✓ (image)
  ├── 验证 owner  ✓
  ├── 消息去重  ✓
  │
  ├── message_type === 'image':
  │     ├── extractImageKey(content) → "img_v3_xxxx"
  │     ├── downloadMessageImage(client, "msg-abc123", "img_v3_xxxx")
  │     │     └── client.im.v1.messageResource.get() → writeFile(path)
  │     │     └── 校验文件大小 ≤ 10MB
  │     │     └── 返回 "~/.cc-linker/images/msg-abc123_img_v3_xxxx.png"
  │     └── imagePaths = ["~/.cc-linker/images/msg-abc123_img_v3_xxxx.png"]
  │
  ├── resolveChatTarget() → session/new_session_claim/no_target
  │
  └── spoolQueue.enqueue({ text: "", imagePaths: [...] })
        │
        ▼
dispatch() → handleClaimed() → handleChat()
        │
        ▼
handleChat() → handleChatSDK() / handleChatStreaming():
  ├── promptText = buildPromptWithImages(msg.text, msg.imagePaths)
  │     → "[用户发送了一张图片: ~/.cc-linker/images/msg-abc123_img_v3_xxxx.png]
  │        请查看以上图片文件，然后理解图片内容。
  │        请描述这张图片的内容。"
  │
  └── sessionManager.sendSDKMessage(sessionUuid, promptText, cwd, ...)
        │
        ▼
Claude Agent SDK → query({ prompt: promptText })
        │
        ▼
Claude 执行:
  ├── Read("~/.cc-linker/images/msg-abc123_img_v3_xxxx.png")
  │     → 读取图片内容（Claude 多模态能力）
  └── 生成图片描述/分析回答
        │
        ▼
流式回复 → CardUpdater → 飞书交互卡片 → 用户看到回答
```

---

## 8. 用户交互场景

### 8.1 场景一：发送单张图片（有活跃会话）

```
用户: [发送一张截图]

Bot: [处理中卡片...]
     这张截图显示的是一个登录页面的错误提示，
     错误信息是 "Invalid credentials"。
     可能的原因包括：
     1. 用户名或密码输入错误
     2. ...
```

### 8.2 场景二：发送图片创建新会话

```
用户: /new ~/project

Bot: ✅ 已设置新会话目录，请继续发送第一条消息。

用户: [发送一张设计稿截图]

Bot: [处理中卡片...]
     这是一个移动端商城首页的设计稿，主要包含：
     - 顶部搜索栏和轮播 Banner
     - 分类导航图标栏
     - 商品瀑布流列表
     需要我帮你实现这个页面吗？
```

### 8.3 场景三：图片下载失败

```
用户: [发送一张超大图片]

Bot: ⚠️ 图片下载失败: 图片大小 15.2MB 超过限制 10MB
```

### 8.4 场景四：图片功能未就绪

```
用户: [发送图片]

Bot: ⚠️ 图片处理功能未就绪（缺少飞书客户端配置），请发送文字消息。
```

---

## 9. 异常处理与边界情况

### 9.1 图片下载失败

| 场景 | 处理 |
|------|------|
| 飞书 API 返回错误（权限不足、image_key 无效） | 回复友好错误提示，记录 error 日志 |
| 网络超时 | 飞书 SDK 自带超时，捕获异常后回复提示 |
| 磁盘空间不足 | writeFile 抛出异常，捕获后回复提示 |
| 图片大小超过限制 | 下载后检测大小，超限则删除文件并回复提示 |

### 9.2 消息解析失败

| 场景 | 处景 |
|------|------|
| `content` JSON 解析失败 | `extractImageKey()` 返回 null，静默忽略消息 |
| `content` 中无 `image_key` 字段 | 同上 |
| 消息类型为 'image' 但 content 格式异常 | 记录 warn 日志，忽略 |

### 9.3 feishuClient 不可用

| 场景 | 处理 |
|------|------|
| bot 启动时未配置 app_id/app_secret | `feishuClient` 为 null，回复配置错误提示 |
| bot 运行中 feishuClient 连接断开 | API 调用抛异常，捕获后回复错误提示 |

### 9.4 并发安全

| 场景 | 处理 |
|------|------|
| 用户连续快速发送多张图片 | 每张图片独立下载、独立消息入队，通过 serialKey 保证同一会话串行处理 |
| 同一 image_key 在不同消息中出现 | 文件名包含 message_id，不会冲突 |
| 图片下载和清理并发 | 清理只删除 mtime 超过 24h 的文件，刚下载的文件不会被误删 |

### 9.5 向后兼容

| 场景 | 处理 |
|------|------|
| 升级后旧 SpoolMessage JSON 无 `imagePaths` | 反序列化为 `undefined`，不影响文本消息处理 |
| 用户发送 'post' 消息 | 走旧逻辑（被 `includes` 过滤掉），与当前行为一致 |
| 未配置 `images` 配置项 | 使用默认值（enabled=true），零配置即可工作 |

---

## 10. 安全考量

### 10.1 文件存储安全

- 图片目录 `~/.cc-linker/images/` 权限 `0o700`（仅所有者可访问）
- 下载的图片文件权限 `0o600`（仅所有者可读写）—— `downloadMessageImage()` 中通过 `chmodSync(localPath, 0o600)` 显式设置
- 24 小时自动清理，不留长期存储

### 10.2 API 调用安全

- 使用飞书 OAuth 鉴权（复用现有 app_id/app_secret）
- `messageResource.get` 需要 `im:resource` 权限（与 `im:message` 同级，一般已授予）
- 不将 image_key 或图片路径打印到回复消息中

### 10.3 资源限制

- 单张图片大小限制：10MB（可配置）
- 图片保留时长：24 小时（可配置）
- 图片下载受飞书 API 速率限制约束（与现有消息处理共享配额）

### 10.4 prompt 注入风险

- 图片路径以 `[用户发送了一张图片: /path]` 格式嵌入 prompt
- 路径由系统生成（`{messageId}_{imageKey}.png`），不包含用户可控内容
- 不存在通过图片路径注入 prompt 的风险

---

## 11. 飞书应用权限检查

确保飞书应用已开启以下权限：

| 权限 | 用途 | 状态 |
|------|------|------|
| `im:message` | 接收和发送消息 | ✅ 已有 |
| `im:resource` | 下载消息中的资源文件（图片等） | ⚠️ 需确认已开启 |

> 如未开启 `im:resource` 权限，需在飞书开放平台 → 应用管理 → 权限管理中添加并发布新版本。

---

## 12. 需要修改的文件清单

| 文件 | 类型 | 改动描述 |
|------|------|----------|
| `src/feishu/image.ts` | **新建** | 图片下载、key 提取、prompt 组装、过期清理 |
| `src/utils/paths.ts` | 修改 | 新增 `IMAGES_DIR` 常量 |
| `src/utils/config.ts` | 修改 | 新增 `images` 配置节和默认值 |
| `src/queue/spool.ts` | 修改 | `SpoolMessage` 新增 `imagePaths` 字段 |
| `src/feishu/bot.ts` | 修改 | 消息类型过滤、图片处理分支、prompt 组装注入 |
| `tests/unit/feishu/image.test.ts` | **新建** | 图片工具函数单元测试 |
| `tests/unit/feishu/bot.test.ts` | 修改 | 补充图片消息测试用例 |

### 不需要修改的文件

| 文件 | 原因 |
|------|------|
| `src/proxy/session.ts` | 图片路径通过 prompt 文本传入，无需修改 spawn 逻辑 |
| `src/feishu/card-updater.ts` | 流式卡片输出逻辑不变 |
| `src/feishu/mapping.ts` | 用户状态模型不变 |
| `src/registry/` | 注册表 schema 不变 |
| `src/cli/commands/start.ts` | 已有 `bot.setFeishuClient(client)` 逻辑不变 |

---

## 13. 实现计划

### Phase 1：核心图片支持（本期）

**目标：** 用户发送图片 → bot 理解并回复

1. [ ] 新建 `src/feishu/image.ts`
   - `extractImageKey(content)` — 解析 image_key
   - `downloadMessageImage(client, messageId, imageKey)` — 下载图片
   - `buildPromptWithImages(text, imagePaths)` — 组装 prompt
   - `cleanupOldImages(maxAgeHours?)` — 清理过期图片

2. [ ] `src/utils/paths.ts` — 新增 `IMAGES_DIR`

3. [ ] `src/utils/config.ts` — 新增 `images` 配置节

4. [ ] `src/queue/spool.ts` — `SpoolMessage` 新增 `imagePaths`

5. [ ] `src/feishu/bot.ts`
   - `FeishuMessageEvent.message_type` 扩展
   - `onMessage()` 图片处理分支
   - `handleChat*()` 方法注入 `buildPromptWithImages()`
   - `dispatch()` 集成 `cleanupOldImages()`
   - 图片消息的 preview 显示为 "[图片]"

6. [ ] 测试
   - `tests/unit/feishu/image.test.ts` — 工具函数测试
   - `tests/unit/feishu/bot.test.ts` — 图片消息处理测试

### Phase 2：富文本支持（后续）

1. [ ] 支持 `message_type = 'post'` 的富文本消息
2. [ ] `extractPostContent()` 解析图文混排内容
3. [ ] 下载 post 中的所有图片，组装混合 prompt

### Phase 3：进阶功能（远期）

1. [ ] 多图消息支持（批量下载、批量引用）
2. [ ] 文件消息支持（PDF、Word 等）
3. [ ] 图片 OCR 兜底（当 Claude 无法理解时）
4. [ ] 图片压缩/缩放（节省 Claude token 消耗）

---

## 14. 验证方案

### 14.1 单元测试

```bash
# 图片工具函数
bun test tests/unit/feishu/image.test.ts

# Bot 图片消息处理
bun test tests/unit/feishu/bot.test.ts
```

**测试用例清单：**

| 函数 | 测试用例 |
|------|----------|
| `extractImageKey` | 正常解析 / content 为空 / JSON 格式错误 / 无 image_key 字段 |
| `buildPromptWithImages` | 无图片(返回原文) / 单图+文字 / 纯图片(无文字) / 多图 |
| `downloadMessageImage` | mock feishuClient.writeFile 成功 / 超大小限制 / 文件权限 0o600 |
| `cleanupOldImages` | 清理过期文件 / 保留新文件 / 目录不存在 |

### 14.2 手动 E2E 测试

```bash
# 启动 bot
bun run dev start
```

1. 在飞书私聊中发送一张小图片 → 验证 bot 回复了图片描述
2. 检查 `~/.cc-linker/images/` 目录有下载的图片文件，且文件权限为 0o600、目录权限为 0o700
3. 发送纯文字消息 → 验证行为不变
4. 发送超大图片 → 验证收到大小超限提示
5. 重启 bot 后发送图片 → 验证功能正常

### 14.3 类型检查

```bash
bun run typecheck
```

---

## 15. 评审 Checklist

- [ ] 设计方案是否满足所有用户故事？
- [ ] 四层阻断点是否全部正确处理？
- [ ] `messageResource.get` API 使用是否正确？（非 `image.get`）
- [ ] prompt 组装方式是否合理？Claude Read 工具是否可靠读取本地图片？
- [ ] 图片存储安全性（权限、清理、大小限制）是否充分？
- [ ] 向后兼容性是否充分（旧 SpoolMessage、旧配置）？
- [ ] 异常处理是否覆盖所有场景？
- [ ] feishuClient 不可用时的降级是否合理？
- [ ] 飞书应用 `im:resource` 权限是否已开启？
- [ ] 实现计划是否合理？Phase 1 是否足够 MVP？
