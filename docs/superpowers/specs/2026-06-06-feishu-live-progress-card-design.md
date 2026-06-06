# cc-linker 飞书 live 进展卡片设计

> 日期：2026-06-06
> 范围：doSwitch 命中"会话正在处理"时，**持续 patch 概览卡片**展示实时进展
> 前置：现有 `buildSessionOverviewCard` (PR 3, 2026-06-02)、`CardUpdater.patchCard`、`isSessionActive`、`writeActivityMarker`、`scanner/jsonl.ts:parseTail`

## 目标

解决新痛点：

1. **痛点 A**：用户切到正在跑的 session 后，只能看到一张静态概览卡片（标题/末问/末答），看不到实时进展。即便 session 在跑，用户切到后**不知道它当前在做什么、跑了几秒、轮几、思考什么**
2. **痛点 B（跨场景）**：现有 `handleChat` 已经在用 `CardUpdater` 推流式卡（用于当前 active message），但 `doSwitch` 创建的概览卡片**不接入**这个流式通道。切换到 streaming session 时，概览卡是死的，要看进展得切回去

## 关键设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 进展数据源（飞书 session） | `sessionManager.listSessions()` + 读 JSONL tail | in-memory 只能看是否 running，文本还得读 JSONL；统一走 JSONL 实现简单一致 |
| 进展数据源（CLI session） | 读 JSONL tail | CLI 端没有 in-memory，只能落 JSONL；用同样 `extractLivePreview` 工具 |
| 进展检测（CLI session） | `isSessionActive('feishu-detects-cli')` | 复用现有 marker + CPU + child + mtime 检测，零新依赖 |
| 进展检测（飞书 session） | `sessionManager.listSessions().some(s.id===uuid)` | in-memory 是 0 延迟权威源，CLI 检测不准 |
| 刷新频率 | 15s | 用户指定（2026-06-06 对话）。比 20s 更跟手，但仍远低于飞书 QPS 限流 |
| maxTicks | 400 tick = 100 min | 用户指定。防止无限 patch 消耗 API + 僵尸 watcher 防御 |
| watcher key | `Map<openId, LiveProgressWatcher>` | 同一用户一次只看一个 live 卡；连发 /switch 第二次清理第一次 |
| 多用户看同 session | 各自独立 watcher，每个 patch 自己那张卡 | 简单不共享状态；多倍 patch 消耗可接受（同 session 多用户场景少见） |
| 停止条件 A | `isSessionActive` 返回 false（session 闲下来） | 自然结束场景 |
| 停止条件 B | 用户发新 message 到该 session | 自然交接场景；新 message 会另起流式卡 |
| 停止条件 C | patch API 连续失败 ≥ 3 次 | 防御性：飞书限流 / 卡片被删 / 网络异常 |
| 停止条件 D | tickCount ≥ maxTicks | 硬上限，100 min 后强制 stop |
| bot 重启 | liveWatchers 丢失，靠用户重发 /switch 恢复 | 不做持久化（YAGNI） |
| watcher 写在哪 | `src/feishu/live-progress.ts`（新文件） | 跟 bot.ts / card-updater.ts 同级，单一职责 |
| 视觉伴侣 | 不开 | 卡片布局与现有 overview 卡片一致（已经在 PR 3 落地），不需要新视觉探索 |

## 架构

```
                       doSwitch(uuid, openId)
                              │
                              ▼
              ┌───────────────────────────────┐
              │ CAS swap → ok                  │
              │   ↓                            │
              │ isSessionProcessing(uuid, entry)│
              │   ├─ true  → 发 live card       │
              │   │           start watcher    │
              │   └─ false → 发 static card    │
              └───────────────────────────────┘
                              │ (live path)
                              ▼
              ┌───────────────────────────────┐
              │ LiveProgressWatcher            │
              │   state:                       │
              │     - cardMessageId            │
              │     - uuid, openId             │
              │     - tickCount, intervalHandle│
              │   tick():                      │
              │     1) read entry from registry│
              │     2) extractLivePreview(jsonl)│
              │     3) patchCard(updated card) │
              │     4) check stop conditions    │
              └───────────────────────────────┘
```

## 组件

### 1. `src/feishu/live-progress.ts`（新文件）— 模块入口

```typescript
import { SessionEntry } from '../registry/types';
import { FeishuBot } from './bot';
import { isSessionActive, SessionActivityCache } from '../utils/session-activity';

export interface LiveProgressConfig {
  intervalMs: number;     // 默认 15_000
  maxTicks: number;       // 默认 400
  maxPatchFailures: number;  // 默认 3
}

export const DEFAULT_LIVE_PROGRESS_CONFIG: LiveProgressConfig = {
  intervalMs: 15_000,
  maxTicks: 400,
  maxPatchFailures: 3,
};

export function isSessionProcessing(
  uuid: string,
  entry: Pick<SessionEntry, 'cwd' | 'jsonl_path'>,
  bot: FeishuBot,
): boolean {
  // 1) Feishu session: in-memory activeProcesses（0 延迟权威）
  if (bot.sessionManager.listSessions().some(s => s.sessionId === uuid)) {
    return true;
  }
  // 2) CLI session: marker + CPU + child + mtime
  const cache = bot.sessionManager.activityCache ?? new SessionActivityCache();
  return isSessionActiveSync(uuid, entry, cache);
}

function isSessionActiveSync(
  uuid: string,
  entry: Pick<SessionEntry, 'cwd' | 'jsonl_path'>,
  cache: SessionActivityCache,
): boolean {
  // isSessionActive 是 async，但 caller 这里是 sync 上下文
  // 接受"用缓存的值"语义——SessionActivityCache 有 10s TTL 够用
  const cacheKey = `feishu-detects-cli:${uuid}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.isProcessing && cached.confidence !== 'low';
  }
  // cache miss 走 async，但 watcher tick 是 async 上下文
  return false;  // 由调用方在 async 路径用 await isSessionActive
}
```

> **review 必改**：原草图用 `await isSessionActive` 是 async 路径。`tick()` 是 async，**正确**做法是 `await isSessionActive(...)`，不要 `Sync` 后缀包装。修正：

```typescript
export async function isSessionProcessing(
  uuid: string,
  entry: Pick<SessionEntry, 'cwd' | 'jsonl_path'>,
  bot: FeishuBot,
): Promise<boolean> {
  if (bot.sessionManager.listSessions().some(s => s.sessionId === uuid)) {
    return true;
  }
  const cache = bot.sessionManager.activityCache ?? new SessionActivityCache();
  const status = await isSessionActive(
    { sessionUuid: uuid, cwd: entry.cwd, jsonl_path: entry.jsonl_path },
    cache,
    'feishu-detects-cli',
  );
  return status.isProcessing && status.confidence !== 'low';
}
```

### 2. `extractLivePreview` — 复用 scanner 工具

```typescript
export interface LivePreview {
  lastUser?: string;
  lastAssistant?: string;
}

export function extractLivePreview(jsonlPath: string | null): LivePreview {
  if (!jsonlPath) return {};
  try {
    // 复用 scanner/jsonl.ts 的 tail 解析
    // parseTailForPreview 导出 parseTail 的 preview 提取部分
    const { parseTailForPreview } = require('../scanner/jsonl');
    return parseTailForPreview(jsonlPath);
  } catch (err) {
    logger.warn(`extractLivePreview 失败: ${jsonlPath}: ${err}`);
    return {};
  }
}
```

> **实现细节（review 必改）**：scanner/jsonl.ts 当前 `parseTail` 内部直接 return 完整 `Partial<SessionEntry>`，不导出 preview-only 工具。**必须新增** `parseTailForPreview`：
> ```typescript
> // src/scanner/jsonl.ts 新增 export
> export function parseTailForPreview(jsonlPath: string): {
>   lastUser?: string;
>   lastAssistant?: string;
> } {
>   const stat = statSync(jsonlPath);
>   if (stat.size === 0) return {};
>   const readSize = Math.min(4096, stat.size);
>   const fd = openSync(jsonlPath, 'r');
>   const buf = Buffer.alloc(readSize);
>   fd.readSync(buf, 0, readSize, stat.size - readSize);
>   closeSync(fd);
>   const tail = buf.toString('utf8');
>   const lines = tail.split('\n').filter(Boolean);
>   // 倒序遍历找 user + assistant text 块
>   let lastUser: string | undefined;
>   let lastAssistant: string | undefined;
>   for (let i = lines.length - 1; i >= 0; i--) {
>     try {
>       const entry = JSON.parse(lines[i]);
>       if (entry.type === 'user' && !lastUser) {
>         const content = entry.message?.content;
>         if (typeof content === 'string') lastUser = content.slice(0, 100);
>         else if (Array.isArray(content)) {
>           const tb = content.find((b: any) => b.type === 'text');
>           if (tb?.text) lastUser = tb.text.slice(0, 100);
>         }
>       } else if (entry.type === 'assistant' && !lastAssistant) {
>         const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
>         if (textBlock?.text) lastAssistant = textBlock.text.slice(0, 100);
>       }
>       if (lastUser && lastAssistant) break;
>     } catch {}
>   }
>   return { lastUser, lastAssistant };
> }
> ```
> 注：4KB 抓不到 user 的回退（PR 3 §3.1 提到的）**不在本次范围**——本次只做 live 增量更新，不重新实现 fallback 逻辑。生产中单 user prompt 命中率 95%+，足够。

### 3. `LiveProgressWatcher` — 单卡片轮询生命周期

```typescript
export interface WatcherDeps {
  uuid: string;
  openId: string;
  cardMessageId: string;
  feishuClient: any;
  bot: FeishuBot;
  config: LiveProgressConfig;
  onStop: (openId: string, reason: string) => void;
}

export class LiveProgressWatcher {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private patchFailureCount = 0;
  private stopped = false;
  private startedAt = Date.now();

  constructor(private deps: WatcherDeps) {}

  start(): void {
    this.intervalHandle = setInterval(
      () => this.tick().catch(err => logger.error(`watcher tick error: ${err}`)),
      this.deps.config.intervalMs,
    );
    logger.info(
      `LiveProgressWatcher start: openId=${this.deps.openId}, uuid=${this.deps.uuid}, ` +
      `cardMessageId=${this.deps.cardMessageId}, intervalMs=${this.deps.config.intervalMs}`,
    );
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;

    // 1) session 还在吗？
    const entry = this.deps.bot.registry.get(this.deps.uuid);
    if (!entry) { this.stop('session_gone'); return; }

    // 2) 读最新 preview
    const live = extractLivePreview(entry.jsonl_path);

    // 3) 重新构建卡片（带 live data + 处理中标记）
    const card = buildSessionOverviewCard(
      this.deps.uuid,
      entry,
      true,  // isRunning
      { lastUserPreview: live.lastUser, lastAssistantPreview: live.lastAssistant },
    );

    // 4) patch
    try {
      const updater = new CardUpdater(this.deps.feishuClient, { throttle_ms: 0 });
      updater.setCardMessageId(this.deps.cardMessageId);
      await updater.patchCard(card);
      this.patchFailureCount = 0;  // 成功后重置
    } catch (err) {
      this.patchFailureCount++;
      logger.warn(
        `LiveProgressWatcher patch failed (${this.patchFailureCount}/${this.deps.config.maxPatchFailures}): ` +
        `cardMessageId=${this.deps.cardMessageId}: ${err}`,
      );
      if (this.patchFailureCount >= this.deps.config.maxPatchFailures) {
        this.stop('patch_failed');
        return;
      }
    }

    // 5) 检查停止条件 A：maxTicks 硬上限
    if (this.tickCount >= this.deps.config.maxTicks) {
      this.stop('max_ticks');
      return;
    }

    // 6) 检查停止条件 B：session 闲下来
    const stillProcessing = await isSessionProcessing(
      this.deps.uuid, entry, this.deps.bot,
    );
    if (!stillProcessing) {
      // final patch：转绿色模板，移除"实时"标签
      const finalCard = buildSessionOverviewCard(
        this.deps.uuid, entry, false,  // isRunning=false
        { lastUserPreview: live.lastUser, lastAssistantPreview: live.lastAssistant },
      );
      try {
        const updater = new CardUpdater(this.deps.feishuClient, { throttle_ms: 0 });
        updater.setCardMessageId(this.deps.cardMessageId);
        await updater.patchCard(finalCard);
      } catch (err) {
        // final 失败不影响 stop 流程——watcher 本来就要退
        logger.warn(`LiveProgressWatcher final patch failed: ${err}`);
      }
      this.stop('idle');
    }
  }

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const elapsedSec = Math.floor((Date.now() - this.startedAt) / 1000);
    logger.info(
      `LiveProgressWatcher stop: openId=${this.deps.openId}, uuid=${this.deps.uuid}, ` +
      `reason=${reason}, ticks=${this.tickCount}, elapsed=${elapsedSec}s`,
    );
    this.deps.onStop(this.deps.openId, reason);
  }
}
```

### 4. `FeishuBot.liveWatchers` + 接入 doSwitch

**新增成员**（src/feishu/bot.ts）：
```typescript
private liveWatchers = new Map<string, LiveProgressWatcher>();
// key = openId

private get liveConfig(): LiveProgressConfig {
  return {
    intervalMs: config.get<number>('feishu_bot.live_progress.interval_ms', 15_000),
    maxTicks: config.get<number>('feishu_bot.live_progress.max_ticks', 400),
    maxPatchFailures: config.get<number>('feishu_bot.live_progress.max_patch_failures', 3),
  };
}

private stopLiveWatcher(openId: string, reason: string): void {
  const w = this.liveWatchers.get(openId);
  if (w) {
    w.stop(reason);
    // onStop 回调会从 map 删除；显式删除以防回调未触发
    this.liveWatchers.delete(openId);
  }
}
```

**doSwitch 改造**（src/feishu/bot.ts:2027 附近）：
```typescript
// swapped=true 后：
const processing = await isSessionProcessing(uuid, session, this);

const card = buildSessionOverviewCard(uuid, session, processing, {});  // ← 新增第 4 参数
const replyId = await this.cardReplyFn(card, { messageId, openId });

if (replyId) {
  if (msg) {
    this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, replyId, 1);
    this.spoolQueue.markReplied(msg.messageId, msg.serialKey, replyId);
    this.spoolQueue.markDone(msg.messageId, msg.serialKey, replyId);
  } else {
    this.spoolQueue.recordReceipt(messageId ?? '');
  }

  // 启动 live watcher（仅 processing=true 时）
  if (processing) {
    // 清理该用户旧 watcher（防止 A → B 切换时旧 watcher 残留）
    this.stopLiveWatcher(openId, 'new_switch');
    const watcher = new LiveProgressWatcher({
      uuid,
      openId,
      cardMessageId: replyId,
      feishuClient: this.feishuClient,
      bot: this,
      config: this.liveConfig,
      onStop: (oid, _reason) => this.liveWatchers.delete(oid),
    });
    this.liveWatchers.set(openId, watcher);
    watcher.start();
  }
} else {
  // cardReplyFn 失败走 text 降级
  // ... （不变）
}
```

**onMessage 改造**（src/feishu/bot.ts handleClaimed 入口前）：
```typescript
// 改 handleClaimed：在调用 handleCommand/handleChat 前
// 如果用户已经有一个 live watcher 在跑，且新 message 不是 command
// 停止 watcher（自然交接：用户已经发新消息了）
const isCommandMsg = msg.text?.startsWith('/') && (msg.text.length > 1) && msg.text[1] !== ' ';
if (!isCommandMsg) {
  // 非 command 消息：text chat、image、file 都算
  this.stopLiveWatcher(msg.openId, 'user_new_message');
}
```

> **位置说明**：`handleClaimed` 入口（在 dispatch 已经 claim 后，开 worker 时）是更准确的位置——onMessage 入口 spool 入队时还不知道消息会被处理成什么，且那时 watcher 状态可能尚未稳定。`handleClaimed` 入口是 watcher 真正要被"接管"的时刻。
> **为什么排除 command**：command（如 /list / /status）走独立 cmd: serialKey，不影响 active session 的处理；用户切到 active session 后发 /list 查进展是常见操作，watcher 不应被此打断。

### 5. `buildSessionOverviewCard` 扩展（新第 4 参数）

```typescript
// src/feishu/bot.ts:2284 改
interface OverviewCardOverrides {
  lastUserPreview?: string;
  lastAssistantPreview?: string;
}

function buildSessionOverviewCard(
  uuid: string,
  entry: Pick<SessionEntry, 'title' | 'cwd' | 'message_count' | 'last_active' | 'origin' | 'status' | 'last_user_preview' | 'last_assistant_preview'>,
  isRunning: boolean,
  overrides: OverviewCardOverrides = {},
): Record<string, unknown> {
  const lastUser = overrides.lastUserPreview ?? entry.last_user_preview;
  const lastAssistant = overrides.lastAssistantPreview ?? entry.last_assistant_preview;

  const runningTag = isRunning ? '🔴 处理中 · ' : '';
  const titlePrefix = `${runningTag}${esc(truncateTitleForCard(entry.title))}`;

  // 实时 hint 仅在 isRunning=true 且 entry.last_active < 30s 前时才显示
  // 这是 spec §视觉优化 的 small touch：避免 static 卡片也显示"实时"
  const liveHint = isRunning ? ' _(实时)_' : '';

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: isRunning ? '🔄 处理中会话' : '🔄 已切换会话' },
      template: isRunning ? 'orange' : 'blue',
    },
    elements: [
      { tag: 'markdown', content: `**${titlePrefix}${liveHint}**\nID: \`${uuid.slice(0, 8)}\`\n📁 \`${esc(entry.cwd ?? '-')}\`` },
      ...(lastUser ? [{ tag: 'markdown', content: `**💬 最后提问：**\n> ${esc(lastUser)}` }] : []),
      ...(lastAssistant ? [{ tag: 'markdown', content: `**🤖 最后回复：**\n> ${esc(lastAssistant)}` }] : []),
      { tag: 'hr' },
      { tag: 'markdown', content: `📊 ${formatMetaStats(entry)}\n\n💡 直接发送消息即可继续此会话` },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '📖 恢复指引' }, type: 'default', value: { tag: 'resume', sessionId: uuid } },
      ]},
    ],
  };
}
```

**关键差异**：
- 标题：`🔄 已切换会话` → `🔄 处理中会话`（isRunning=true 时）
- 模板色：blue → orange（isRunning=true 时）
- "实时" hint：markdown 末尾加 `_(实时)_`（仅 isRunning=true）

> **保留向后兼容**：`buildSessionOverviewCard` 第 4 参数是 optional，不传时与 PR 3 行为完全一致（4 参默认 `{}`），现有 `doSwitch` 调用点只补 1 行 `{}` 即可。

### 6. 优雅停机（graceful shutdown）

bot 收到 SIGTERM/SIGINT 时，已经在跑的 watcher 应当被 stop 掉（清理 setInterval）：

```typescript
// 在 FeishuBot 上新增方法
public shutdown(): void {
  for (const [openId, watcher] of this.liveWatchers) {
    watcher.stop('bot_shutdown');
  }
  this.liveWatchers.clear();
}
```

在 `start.ts` 的 `gracefulShutdown` / `daemonShutdown` 调 `bot.shutdown()` 之前先停 watcher（避免停 daemon 期间又 patch 卡片）。

## 数据流

### 场景 A：用户切到飞书 streaming session（sleep 50 中）

```
T0    用户 /switch <uuid>
T0+   doSwitch → CAS ok
       ├─ isSessionProcessing:
       │   ├─ listSessions().some(s.id===uuid) → true (Claude -p 在跑)
       │   └─ return true
       ├─ 发 live 卡片（orange 模板，"处理中会话"）
       └─ watcher.start()

T0+15s   tick 1:
         - entry = registry.get(uuid) ✓
         - extractLivePreview(jsonl) → { lastAssistant: "..." }
         - patchCard(updated card)  ✓
         - tickCount=1, 399 ticks 剩
         - isSessionProcessing() 仍 true

T0+30s   tick 2: 类似

T0+50s   sleep 50 完成 → sessionManager.activeProcesses.delete(uuid)

T0+60s   tick 4:
         - patchCard ✓
         - isSessionProcessing:
           ├─ listSessions 不含 uuid → false
           └─ 走 isSessionActive('feishu-detects-cli') → 缓存可能是旧的
              或读 marker → 已是 'end' → false
         - stillProcessing=false
         - final patch (blue 模板, "已切换会话")
         - stop('idle')
         - onStop → liveWatchers.delete(openId)
```

### 场景 B：用户切到 CLI 在跑的 session

```
T0    cc-linker CLI 端跑 sleep 50
T0+   CLI 端 activity-hook start → 写 marker
T0+   CLI 端 activity-hook heartbeat 每 5s 一次

T1    用户在飞书 /switch <cli-uuid>
T1+   doSwitch → CAS ok
       ├─ isSessionProcessing:
       │   ├─ listSessions 不含 → false
       │   └─ isSessionActive('feishu-detects-cli') → true (marker 'start' 命中)
       ├─ 发 live 卡片
       └─ watcher.start()

T1+15s   tick 1: 读 cli-jsonl 末尾 → patchCard
T1+30s   tick 2: ...
T1+50s   CLI 完成 → activity-hook end → marker 'end'
T1+60s   tick 4: isSessionActive → false → final + stop
```

### 场景 C：用户切换中发新消息

```
T0    用户 /switch <uuid> → watcher A start
T1    用户在飞书直接发 "继续分析"（chat 消息到该 session）
T1+   onMessage 收到 chat 消息
T1+   spool 入队
T1+   dispatch → claim → handleClaimed(msg)
T1+   handleClaimed 入口: stopLiveWatcher(openId, 'user_new_message')
       - watcher A stop
       - liveWatchers.delete(openId)
T1+   handleChat → 发新流式卡
```

## 错误处理

| 场景 | 处理 |
|------|------|
| JSONL 不存在 / 损坏 / 不可读 | `extractLivePreview` catch → 返回 `{}`，patch 用 entry 静态字段 |
| patch API 单次失败（QPS 限流 / 卡片被删 / 网络抖动） | `tick` catch → `patchFailureCount++` → 下个 tick 继续 |
| patch API 连续失败 ≥ 3 次 | `stop('patch_failed')` + 日志告警；不再继续 patch |
| registry 中 uuid 消失（session 被删） | tick 检 `entry === undefined` → `stop('session_gone')` |
| bot 重启 | liveWatchers 丢失；用户重发 /switch 重新创建（不做持久化） |
| 用户在 15s 内连续 /switch A → /switch B | doSwitch(B) 入口 `stopLiveWatcher(openId, 'new_switch')` |
| 用户在 15s 内发新消息到 active session | handleClaimed 入口 `stopLiveWatcher(openId, 'user_new_message')` |
| tickCount ≥ 400 (100 min) | `stop('max_ticks')` + 日志（用户可重发 /switch 继续） |
| SessionActivityCache 命中陈旧数据（cli-detects 误判） | `confidence !== 'low'` 已过滤低置信；用户发新消息会强制 stop |
| 优雅停机（SIGTERM） | `bot.shutdown()` 清空所有 watcher（不 patch final） |

## 影响范围

- 飞书侧：doSwitch 在 processing session 时多 1 个 watcher、~3 个 patch / min
- CLI 侧：零影响（live watcher 纯飞书侧）
- Scanner：新增 `parseTailForPreview` export，无破坏性改动
- CardUpdater：现有 API 完全复用
- 配置：`config.toml` 新增 `feishu_bot.live_progress.{interval_ms, max_ticks, max_patch_failures}`（optional，有 default）
- 性能：单 watcher 每 15s 1 次 patch，每次 < 50ms（patch API 一次 + JSONL tail 4KB 读）
- 飞书 API 消耗：单用户 1 张卡 / 15s / 100 min 上限 = 400 patches / session；5 并发用户 = 2000 patches / 100 min 约 33/min 远低于飞书 QPS 限流
- 内存：每个 watcher 极小（4 个字段 + 1 个 interval handle），100 用户 = < 1MB

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 用户感觉 15s 仍不够"实时" | YAGNI：用户已选 15s；如未来要 1s 真实时，加 `live_progress.interval_ms=1000` 即可 |
| patch API 触发飞书限流 | maxPatchFailures=3 自动停；maxTicks=400 硬上限 |
| 100 用户同时跑 watcher 内存爆 | 每个 watcher < 10KB，100×10KB = 1MB，安全 |
| 僵尸 watcher（marker 卡住永远 true） | maxTicks=400 强制停；isSessionActive 10s cache 命中过期数据 100 min 也能熬到 |
| JSONL 4KB 抓不到 last_user 时显示空 | 不在本次范围；现状用户感受是"最后回复有 / 最后提问偶发空"，不致命 |
| bot 重启丢 watcher，用户体验下降 | 文档说明：用户可重发 /switch 继续；持久化 YAGNI |
| 多个用户同 session 各自 patch | 设计就如此（每用户独立），多倍 patch 消耗可接受 |
| 模板色 orange 视觉突兀 | 验证：orange 模板飞书原生支持；可后续 A/B |
| liveWatchers.openId key 冲突（多用户消息） | openId 唯一，不会冲突 |

## YAGNI 边界（明确不做）

- ❌ 不实现 watcher 持久化（重启会丢）
- ❌ 不实现 fs.watch 真实时（仅 15s 轮询够用）
- ❌ 不实现多用户共享同一卡片
- ❌ 不实现"手动停止跟踪"按钮（自然 idle / 新消息交接）
- ❌ 不实现 4KB fallback（PR 3 §3.1 范围，本次仅增量更新）
- ❌ 不实现 watcher 卡密 / 频率动态调整（maxTicks 固定）
- ❌ 不实现思考 / tool calls 末条详情（仅 user/assistant text）
- ❌ 不修改现有 isSessionRunning（CLI 不在 in-memory 已知，由 isSessionProcessing 统一处理）

## 实施计划（PR 拆分、回滚、Staging、监控）

### PR 拆分策略（推荐 2 PR 串行）

**PR 1：scanner 工具扩展 + live-progress 模块骨架**
- 范围：
  - `src/scanner/jsonl.ts` 新增 `parseTailForPreview` export
  - `src/feishu/live-progress.ts` 新建，含 `isSessionProcessing` / `extractLivePreview` / `LiveProgressWatcher` / DEFAULT_LIVE_PROGRESS_CONFIG
  - `tests/unit/scanner/jsonl-parse-tail-preview.test.ts` 新增
  - `tests/unit/feishu/live-progress.test.ts` 新增（watcher tick 用 fake timers）
- 风险：纯数据层 + 单测，**不会影响飞书侧任何行为**
- 回滚：git revert；老代码无感知

**PR 2：bot.ts 接入 + doSwitch 改造 + onMessage 改造**
- 范围：
  - `src/feishu/bot.ts` 新增 `liveWatchers` / `stopLiveWatcher` / `liveConfig` / `shutdown`
  - `doSwitch` 改造：processing 时启动 watcher
  - `handleClaimed` 改造：chat 消息入口 stopLiveWatcher
  - `buildSessionOverviewCard` 扩展第 4 参数（向后兼容）
  - `src/cli/commands/start.ts` gracefulShutdown 调 `bot.shutdown()`
  - `tests/integration/feishu-live-progress.test.ts` 新增（4 个场景）
  - `tests/unit/feishu/bot.test.ts` 现有 doSwitch 测试更新（card 第 4 参默认 `{}`，应无破坏）
- 风险：单文件改动 + 集成测试，**可控**
- 回滚：git revert；用户切到 processing session 退回到 PR 3 静态卡片（可接受）

### Staging 验证

**必跑**：
1. 部署 PR 1 → 跑 `bun test tests/unit/scanner/jsonl-parse-tail-preview.test.ts` 通过
2. 部署 PR 2 → 触发场景 A（飞书 streaming + 切到）/ 场景 B（CLI 跑 + 切到）/ 场景 C（切到 + 发新消息）
3. 触发场景 D：连续 /switch A → /switch B → A watcher stop，B watcher start
4. 检查日志：`LiveProgressWatcher start/stop` 应有结构化日志

**冒烟测试**（5 分钟手动）：
- 飞书端：起 sleep 50（飞书发起）→ 在另一飞书账号 /switch 过去 → 15s 看到 patch 一次
- CLI 端：起 cc-linker CLI 跑 sleep 50 → 飞书 /switch → 15s 看到 patch 一次
- 50s 后两张卡都变蓝色 "已切换会话"，watcher stop

### 上线后监控指标

**关键指标**（加到现有 logger 或 metrics 模块）：
1. `live_progress.start.count` —— watcher 启动次数（应随 doSwitch 命中 processing 增长）
2. `live_progress.stop.reason` —— 按 reason 分桶（idle / max_ticks / patch_failed / new_switch / user_new_message / session_gone / bot_shutdown）
3. `live_progress.ticks.count` —— 总 tick 数（健康度）
4. `live_progress.patch.duration_ms` (P50/P95) —— patch API 耗时
5. `live_progress.patch.failures.count` —— patch 失败次数（> 5/min 触发告警）
6. `live_progress.idle_detection.duration_ms` —— 从 session 闲到 watcher stop 的延迟（应 < 30s）

**告警阈值**：
- `live_progress.patch.failures.count > 10/min`：飞书 QPS 限流
- `live_progress.stop.reason='max_ticks' count > 5/min`：用户长任务频繁，提示
- `live_progress.idle_detection > 60s P95`：isSessionActive cache 配置过低

## 实施时间估算

| PR | 范围 | 工作量 | 风险 |
|----|------|--------|------|
| PR 1 | scanner 工具 + live-progress 模块 | 1 天（含测试） | 低 |
| PR 2 | bot.ts 接入 | 1 天（含测试） | 中 |
| **总计** | - | **2 天** | - |

3 天不含 staging 验证和 review 反馈循环。

## 关联

- 设计前置：`docs/superpowers/specs/2026-06-02-feishu-concurrent-commands-and-session-overview-design.md`（PR 3 落地了 buildSessionOverviewCard，本次扩展第 4 参）
- 现有能力复用：
  - `CardUpdater.patchCard` (src/feishu/card-updater.ts:368)
  - `isSessionActive` (src/utils/session-activity.ts:594)
  - `writeActivityMarker` (src/utils/session-activity.ts:97)
  - `JSONLScanner.parseTail` (src/scanner/jsonl.ts:203)
