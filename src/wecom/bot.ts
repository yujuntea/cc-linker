/**
 * WecomBot — 企微智能机器人主类
 * 集成 SpoolQueue + ClaudeSessionManager（可注入）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2 / §5
 * 参考 src/feishu/bot.ts:325-356 (enqueue 模式) + 359-401 (dispatch worker pool)
 */
import { aibotMessageToPlatform, type PlatformMessage } from '../platform/types';
import { isCommandMessage, parseCommand } from '../platform/command-handler';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { AibotClient, type AibotMessageHandler } from './aibot-client';
import { WecomStreamUpdater } from './stream-updater';
import { WecomUserManager } from './mapping';
import { WecomCardBuilder, type TemplateCard } from './card';
import { WecomImageHandler } from './image-handler';
import { WecomCompleteCardSender, buildCompleteCard, transformToWireShape } from './complete-card';
import {
  buildListCard,
  buildDirListCard,
  buildModelCard,
  buildResumeCard,
  buildStopCard,
  buildAgentsRefreshCard,
} from './card-builders';
import { SpoolQueue, type SpoolMessage, type TargetSnapshot } from '../queue/spool';
import type { ClaudeSessionManager } from '../proxy/session';
import type { StreamChunk } from '../proxy/stream-parser';
import { RegistryManager } from '../registry/registry';
import { ProviderManager } from '../utils/providers';

/**
 * PR 7 m-2 + PR 6.20 + PR 6.21: appendChunk 累加器 — 把 handleChat onProgress 闭包里的累加逻辑
 * 提到独立函数, 让单测直接验证分支。
 *
 * PR 6.20: 返回新 state 对象 (不变异入参), 因为 JS 字符串 immutable。
 * PR 6.21: 加 toolUses 累积 — tool_use chunk 累加到 state.toolUses 数组。
 *   之后 handleChat 把累积的 toolUses 透传给 stream-updater complete()
 *   让用户看到工具调用过程 (Bash/Read/Grep 等)。
 *
 * 行为约定:
 * - thinking chunk → state.thinking += chunk.content
 * - text chunk → state.text += chunk.content
 * - tool_use chunk → state.toolUses.push({ name, inputSummary })
 * - 返回新 state 对象 (不 mutate 入参)
 */
export type AccumulatedChunk = {
  thinking: string;
  text: string;
  toolUses: Array<{ name: string; inputSummary: string }>;
};

export function appendChunk(
  state: AccumulatedChunk,
  chunk: StreamChunk,
): AccumulatedChunk {
  if (chunk.type === 'thinking') {
    return {
      thinking: state.thinking + chunk.content,
      text: state.text,
      toolUses: state.toolUses,
    };
  }
  if (chunk.type === 'text') {
    return {
      thinking: state.thinking,
      text: state.text + chunk.content,
      toolUses: state.toolUses,
    };
  }
  if (chunk.type === 'tool_use') {
    // PR 6.21: tool_use chunk 累加 toolUses 数组
    // input 是 object, 摘要前 80 字符 (避免 markdown 卡片过长)
    const inputJson = JSON.stringify(chunk.input).slice(0, 80);
    return {
      thinking: state.thinking,
      text: state.text,
      toolUses: [...state.toolUses, { name: chunk.name, inputSummary: inputJson }],
    };
  }
  return state;
}

/**
 * PR 6.8.1: 按 chatType 决定 sendMessage receiveId
 *
 * 历史: PR 6 M-1 fix (commit 33968ae) 用 `metadata.chatId ?? userId` 错方向 —
 *   私聊 (chatType=p2p/single) 场景下 chatId 是 msgid 而非 chatid,
 *   企微 sendMessage 拒收, errcode=93006 invalid chatid, 持续重试。
 *   (12:09:45+ production 真实失败案例, /list p2p 场景)
 *
 * 修法:
 * - chatType='group' + 有 chatId → chatId (群发到群)
 * - chatType='p2p' | 'single' | undefined → userId (私聊发给用户, 不论 chatId 是什么)
 * - chatType='group' 但无 chatId → userId (防御性 fallback)
 */
export function resolveReceiveId(msg: SpoolMessage): string {
  const meta = msg.metadata as any;
  const chatType = meta?.chatType;
  if (chatType === 'group' && meta?.chatId) {
    return meta.chatId;
  }
  return msg.userId;
}

export type WecomBotConfig = {
  botId: string;
  secret: string;
  userMappingPath?: string;
  throttleMs?: number;
  /** 可注入依赖 - 默认用真实实现 */
  client?: AibotClient;
  spoolQueue?: SpoolQueue;
  /**
   * PR 2 v1.2.1 final (F9 修复): 可选 userManager 注入点
   * 默认 new WecomUserManager(userMappingPath)，测试场景可注入 mock
   */
  userManager?: WecomUserManager;
  /**
   * PR 4.1: ClaudeSessionManager 注入点。
   * - 注入 → handleChat 真接 Claude 流式 (replyStream 流式 patch)
   * - 未注入 → handleChat 走 PoC echo 路径 (向后兼容单测 / wecom-only staging)
   *
   * 仿飞书侧 createSessionFromPromptStreaming 模板
   * @see src/feishu/bot.ts:2600-2700
   */
  sessionManager?: ClaudeSessionManager;
  /**
   * PR 6 Task 6.1: 图片消息下载 + 缓存注入点。
   * - 注入 → handleChat 在 Claude 调用前处理 msg.images 数组 (download + cacheToDisk)
   * - 未注入 → 跳过图片处理 (向后兼容旧测试 / staging)
   */
  imageHandler?: WecomImageHandler;
  /**
   * PR 6 Task 6.7: RegistryManager 注入点 — list-refresh card action 用。
   * - 注入 → case 'list-refresh' 调 registryManager.listActive() + 推 template_card
   * - 未注入 → 静默 (logger.warn, 不发 sendMessage), 不发通用 markdown 兜底
   *
   * 不注入默认 (new RegistryManager()) 会让 wecom-only 启动读真实 registry.json,
   *   跟其他可选依赖 (sessionManager / imageHandler) 的 "默认 no-op" 风格不一致,
   *   所以显式要求上游 (CLI 启动入口) 注入, 单测场景通过 mock 验证。
   */
  registryManager?: RegistryManager;
  /**
   * PR 7.5.1: ProviderManager 注入 - /model 命令持久化 defaultProvider 用
   * 飞书侧 feishu/bot.ts:34 import ProviderManager from '../utils/providers'
   * 企微侧 PR 7.5.1 镜像实现. 必须实际集成, 不是只注入.
   */
  providerManager?: ProviderManager;
  /**
   * PR 7.5.2: WecomCompleteCardSender 注入点 — 命令响应推卡片用 (buildListCard/buildDirListCard/buildModelCard)
   * 默认 new WecomCompleteCardSender(this.client.sdk) — 跟 PR 7 完成卡 sender 风格一致
   */
  completeCardSender?: WecomCompleteCardSender;
};

/**
 * PR 7.5.2 Task 2.0: handleCommandListCard 返回结构 — PR 7.5.2 Task 2.2 用 .entries 喂 buildListCard
 * @see docs/superpowers/specs/2026-06-21-wecom-command-cards-design.md §4.1
 */
type ListCardData = {
  markdown: string;
  entries: Array<{
    sessionUuid: string;
    title: string;
    messageCount: number;
    lastActive: string;
    cwd?: string | undefined;  // 内部用 (渲染 markdown 模板), Task 2.2 卡片化不依赖
  }>;
  totalActive: number;
  currentUuid: string | null;  // PR 7.5.2 M7 fix: 标记当前 user 的 session 用
};

/**
 * PR 7.5.2 Task 2.0: handleCommandListDir 返回结构 — PR 7.5.2 Task 2.2 用 .dirs/.parent/.hasMore 喂 buildDirListCard
 * @see docs/superpowers/specs/2026-06-21-wecom-command-cards-design.md §4.2
 */
type DirListData = {
  markdown: string;
  cwd: string;
  parent: string | null;
  dirs: Array<{ name: string; fullPath: string }>;
  hasMore: boolean;
};

/**
 * PR 7.5.2 Task 2.0: handleCommandAgents 返回结构 — PR 7.5.3 Task 3.2 用 .bgCount 喂 buildAgentsRefreshCard
 * @see docs/superpowers/specs/2026-06-21-wecom-command-cards-design.md §4.5
 */
type AgentsData = {
  markdown: string;
  bgCount: number;
};

export class WecomBot {
  private client: AibotClient;
  private updater: WecomStreamUpdater;
  private userManager: WecomUserManager;
  private spoolQueue: SpoolQueue;
  /**
   * PR 4.1: 可选 ClaudeSessionManager 注入。未注入时 handleChat 走 PoC echo 路径。
   */
  private sessionManager?: ClaudeSessionManager;
  /**
   * PR 6 Task 6.1: 可选 WecomImageHandler 注入。未注入时跳过图片下载 (向后兼容旧测试)。
   */
  private imageHandler?: WecomImageHandler;
  /**
   * PR 6 Task 6.7: 可选 RegistryManager 注入。case 'list-refresh' 用。
   * 未注入 → 静默 (logger.warn, 不发 sendMessage), 跟 confirm-stop 一致。
   */
  private registryManager?: RegistryManager;
  /**
   * PR 7.5.1: ProviderManager 注入 - /model 集成用
   * 未注入时 /model 命令仍走 PR 5 stub (返回 '已设置 model: <name>' 占位 markdown)
   */
  private providerManager?: ProviderManager;
  /**
   * PR 7.5.2: 完成卡片 sender — 命令路径推卡片用 (/list /listdir /model)
   * 跟 PR 7 流式完成卡 sender 共享同一类 (WecomCompleteCardSender.send),
   *   但这里用 buildListCard / buildDirListCard / buildModelCard 而非 buildCompleteCard
   */
  private wecomCompleteCardSender: WecomCompleteCardSender;
  private running = false;
  /**
   * PR 7 Task 7.5 (M-2): dispatch loop 的可中断 timer handle。
   * 历史: startDispatchLoop 用 setTimeout(r, 2000) 等下一轮 tick, stop() 设置
   *   this.running = false, 但 await 还在 sleep 2s — 整个 loop 函数不退出。
   * 修法: 持 timer handle + sleep promise 的 resolve, stop() clearTimeout
   *   并手动调用 resolve 让 await 立即完成, loop 跳出 while 立即退出。
   * 同时把 loop 函数的 promise 保存下来, 让单测 / 外部代码 await 验证
   *   "stop 后 loop 真正退出"。
   * @internal
   */
  private _dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private _dispatchSleepResolve: (() => void) | null = null;
  private _dispatchLoopPromise: Promise<void> | null = null;

  constructor(config: WecomBotConfig) {
    this.client = config.client ?? new AibotClient({
      botId: config.botId,
      secret: config.secret,
    });
    this.updater = new WecomStreamUpdater(this.client.sdk, {
      throttleMs: config.throttleMs ?? 1500,  // PR 6.10: 跟飞书侧对齐, 默认 throttle 1500ms
    });
    // PR 6.8.4: 注入默认 msgFallback (用于 startProcessing/flushBuffer 错误兜底)
    // 注: 类级别 fallback 没有 msg context (chatId/userId), 所以默认只 log 不 send
    //   handleChat 内 per-call msgFallback (PR 6.8.3/6.8.1) 提供完整 chatType 路由
    //   这里 setMsgFallback 主要是为了满足类字段存在 + 让 startProcessing 测试可注入 mock
    this.updater.setMsgFallback(async (_markdown: string) => {
      // 默认 fallback: 只 log, 不 send (无 msg context, 路由不到具体 user/group)
      // 真实生产: handleChat 内 complete() 的 per-call msgFallback 会覆盖 (优先级更高)
    });
    // PR 7.3: 注入完成卡片 sender (stateless, 一次注入多次复用)
    this.updater.setCompleteCardSender(new WecomCompleteCardSender(this.client.sdk));
    this.userManager = config.userManager ?? new WecomUserManager(config.userMappingPath);
    this.spoolQueue = config.spoolQueue ?? new SpoolQueue();
    this.sessionManager = config.sessionManager;
    this.imageHandler = config.imageHandler;
    this.registryManager = config.registryManager;
    this.providerManager = config.providerManager;
    // PR 7.5.2: 注入完成卡片 sender (默认 new, 跟 PR 7 流式完成卡 sender 同源)
    this.wecomCompleteCardSender = config.completeCardSender ?? new WecomCompleteCardSender(this.client.sdk);
  }

  /**
   * PR 7.5.15 → PR 7.5.16: 命令同步直发 — 在 onMessage 内 (5s req_id 窗口内) 直接
   *   replyTemplateCard / reply, 不走 SpoolQueue dispatch.
   *
   * 根因演进 (经过 15 个 PR 锁定, PR 7.5.16 终态):
   *   aibot server 用 rendezvous 协议 — inbound event 的 req_id 5s 后过期.
   *   cc-linker SpoolQueue dispatch loop 1-3s + handleCommand 处理时间,
   *   到 sendViaReply 时 req_id 已失效 → server 拒收 (errcode=846605).
   *
   *   PR 7.5.15 修法: 在 onMessage (fresh inbound frame) 同步调 replyWelcome.
   *     仍失败 (errcode=846605) — SDK 文档明确 replyWelcome 仅 enter_chat 事件用,
   *     不能用于普通 text 消息 (aibot_msg_callback).
   *
   *   PR 7.5.16 修法: text 消息 sync reply 改用 replyTemplateCard (template_card 卡片)
   *     或 reply (markdown/text) — 都走 WsCmd.RESPONSE = 'aibot_respond_msg' 协议,
   *     跟 replyStream 同协议. replyWelcome 走 WsCmd.RESPONSE_WELCOME =
   *     'aibot_respond_welcome_msg', 仅 enter_chat 事件能调.
   *
   * 支持范围:
   * - /list — 只读 in-memory registryManager.sessions, 同步可处理, 走 replyTemplateCard
   * - /status /help /whoami — 同步返回 string, 走 reply (markdown)
   * - /model /listdir /switch /resume /new /agents /stop /cancel
   *   → 需要写 user-mapping 或读 cwd 等, 走 enqueue 路径
   *
   * 返回:
   * - true → 已同步处理, 调用方应跳过 enqueue (避免 dispatch 重复推卡)
   * - false → 未处理, 调用方继续走 enqueue 路径
   * - throw → 调用方 catch 后 fallback 到 enqueue
   *
   * @param msg 平台消息 (含 inboundFrame — aibot ws 原始 msg, headers.req_id)
   */
  async handleCommandSynchronously(msg: PlatformMessage): Promise<boolean> {
    // 1. 必须有 inboundFrame (用 fresh req_id), 没 frame 走 enqueue
    if (!msg.inboundFrame) {
      return false;
    }
    // 2. 必须是命令 (parseCommand 识别)
    const parsed = parseCommand(msg.text);
    if (!parsed) {
      return false;
    }

    // 3. 只处理能同步拿数据的命令
    switch (parsed.cmd) {
      case 'list':
        return this._syncHandleList(msg);
      case 'status':
        return this._syncHandleStatus(msg);
      case 'help':
        return this._syncHandleHelp(msg);
      case 'whoami':
        return this._syncHandleWhoami(msg);
      default:
        // /model /listdir /switch /resume /new /agents /stop /cancel
        //   → 需要写 user-mapping 或读 cwd 等, 走 enqueue 路径
        return false;
    }
  }

  /**
   * PR 7.5.17: 终极 fallback — sync 命令统一走 replyStream (FINAL fix).
   *
   * 历史演进:
   *   PR 7.5.15: replyWelcome → errcode=846605 (replyWelcome 仅 enter_chat 事件用).
   *   PR 7.5.16: replyTemplateCard / reply (markdown) → errcode=40016 invalid button size
   *     (aibot server 实际不支持 first-reply template_card, 即使 wire shape 跟 SDK canonical types
   *     完全一致, server 仍拒收).
   *   经过 16 个 PR 穷举, 唯一在真机验证可工作的 path 是 replyStream (PR 4.1 handleChat
   *     已稳定用 8+ 个月).
   *
   * 修法: handleCommandSynchronously 改为统一调 replyStream(frame, streamId, markdown, true).
   *   把 list/status/help/whoami 渲染为带结构化标签的 markdown (模仿飞书 buildListCard 风格:
   *   👉 current marker + /switch <uuid> 操作指引 + cwd code block 等).
   *   用户看不到 button_interaction card, 但看到 markdown 卡片化渲染, 体验比 fallback markdown 好.
   *
   * Trade-off: 用户需手打命令 (不能 click button), 后续 PR 可探索 aibot admin 控制台
   *   template_card 权限配置 / 客户端 SDK 升级.
   */
  private async _syncHandleMarkdown(msg: PlatformMessage, markdown: string): Promise<boolean> {
    const inboundFrame = msg.inboundFrame;
    if (!inboundFrame) return false;

    const streamId = 'sync-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    try {
      await this.client.sdk.replyStream(inboundFrame, streamId, markdown, true);
      return true;
    } catch (err) {
      logger.warn(`[wecom-bot] sync replyStream failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * PR 7.5.20: /list 同步直发 — 对齐飞书 buildListCard 信息密度.
   *
   * 历史:
   *   PR 7.5.17: 上一版 markdown 把 10 sessions 挤在一起, 没分隔
   *     → 用户反馈 "sessions not visually separated" + "/switch /resume 命令难以 copy".
   *   PR 7.5.18: 探索过更激进的卡片方案 (numbered list + nested bullet), 仍不够清晰.
   *   PR 7.5.19: 加 SEP 分隔 + code block 包裹 (含 /switch + /resume 两命令)
   *     → 用户反馈: 飞书版本信息更全 (status badge, AI summary, project_name,
   *       相对时间), WeCom 仍信息缺失; code block 两个命令不好单独复制.
   *
   * 修法 (PR 7.5.20):
   *   - 加 origin (终端/cli/feishu) — 仿飞书 formatOrigin
   *   - 加 project_name — 仿飞书 buildListCard 信息行
   *   - ISO timestamp → 相对时间 (formatTimeAgo: 1分钟前, 17小时前)
   *   - msgs → 条 (与飞书一致)
   *   - ⭐ **当前** 标签位置调整 (紧跟标题)
   *   - 每个命令独立 code block (用户反馈不要 /resume, 只留 /switch)
   *   - status badge (🔴) 留给未来 sessionManager.runningUuids 集成 (飞书已有,
   *     WeCom 暂未集成 sessionManager status polling, SessionEntry.status 类型不含 'running')
   *
   * 参考: src/feishu/bot.ts:3860+ buildListCard
   */
  private async _syncHandleList(msg: PlatformMessage): Promise<boolean> {
    if (!this.registryManager) {
      // 没 registryManager 注入 → 走 enqueue (老 handleCommandListCard 路径)
      return false;
    }
    try {
      const allActive = this.registryManager.sessions;
      // PR 7.5.20: active sessions 列表 (保持 PR 7.5.19 的 active filter — status 类型不含 'running')
      const activeEntries = Object.entries(allActive)
        .filter(([_, s]) => s.status === 'active')
        .sort(([_, a], [__, b]) => (b.last_active ?? '').localeCompare(a.last_active ?? ''))
        .slice(0, 10);
      const totalActive = Object.values(allActive).filter(s => s.status === 'active').length;
      const currentEntry = this.userManager.getEntry(msg.userId);
      const currentUuid = currentEntry?.type === 'session' ? currentEntry.sessionUuid : null;

      if (activeEntries.length === 0) {
        const markdown = '📋 我的会话（最近 0 个）\n\n当前没有可用会话。\n可使用 `/new <路径>` 创建新会话。';
        try {
          await this.client.sdk.replyStream(msg.inboundFrame!, 'list-' + Date.now(), markdown, true);
        } catch (err) { /* ignore */ }
        return true;
      }

      // PR 7.5.20: 对齐飞书 buildListCard 信息密度
      //   - 加 origin / project_name
      //   - relative time (formatTimeAgo) 替代 ISO timestamp
      //   - 每个命令独立 code block (只保留 /switch)
      // PR 7.5.21: 加 AI 预览 + 运行中 badge (对齐飞书)
      //   - 🤖 last_assistant_preview (SessionEntry 已有, scanner 已 populate)
      //   - 🔴 运行中 (从 sessionManager.listSessions() 拿活跃 sessionId 集合)
      const lines: string[] = [];
      lines.push(`📋 我的会话（最近 ${activeEntries.length} 个，共 ${totalActive} 个）`);
      lines.push('');
      lines.push('💡 点击 code block 复制命令，粘贴到输入框即可切换');
      lines.push('');

      // PR 7.5.21: 收集 running session UUID 集合 (从 sessionManager.activeProcesses)
      const runningUuids = new Set<string>();
      if (this.sessionManager && typeof this.sessionManager.listSessions === 'function') {
        try {
          for (const sess of this.sessionManager.listSessions()) {
            if (sess && sess.sessionId) runningUuids.add(sess.sessionId);
          }
        } catch (err) {
          logger.warn(`[wecom-bot] sessionManager.listSessions() failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      activeEntries.forEach(([uuid, s], index) => {
        const isCurrent = uuid === currentUuid;
        const isRunning = runningUuids.has(uuid);
        const title = (s.title ?? 'Untitled').slice(0, 24);
        const msgs = s.message_count ?? 0;
        const lastActive = this._formatTimeAgo(s.last_active);
        const origin = this._formatOrigin(s.status);
        const projectName = s.project_name ?? '';
        const cwd = s.cwd ?? '-';
        // PR 7.5.21: AI 最后消息预览 (限 60 字符 + markdown esc)
        const aiPreview = s.last_assistant_preview
          ? this._formatAIPreview(s.last_assistant_preview)
          : null;

        const currentMark = isCurrent ? '⭐ **当前**' : '';
        const runningMark = isRunning ? ' 🔴 **运行中**' : '';

        lines.push(`**${index + 1}. ${title}**${runningMark}${currentMark ? ' ' + currentMark : ''}`);
        lines.push(`ID: \`${uuid.slice(0, 8)}\` | ${msgs}条 | ${lastActive} | ${origin} | ${projectName}`);
        lines.push(`📁 \`${cwd}\``);
        // PR 7.5.21: AI 预览行 (对齐飞书 🤖)
        if (aiPreview) {
          lines.push(`🤖 ${aiPreview}`);
        }
        // PR 7.5.20 简化: 只有 /switch 命令 (用户反馈不需要 /resume)
        lines.push('');
        lines.push('切换:');
        lines.push('```');
        lines.push(`/switch ${uuid.slice(0, 8)}`);
        lines.push('```');
        lines.push('');
      });

      if (totalActive > activeEntries.length) {
        lines.push(`... 还有 ${totalActive - activeEntries.length} 个更早的会话未显示`);
      }
      lines.push('━━━━━━━━━━━━━━━━');

      const markdown = lines.join('\n');
      const streamId = 'list-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      try {
        await this.client.sdk.replyStream(msg.inboundFrame!, streamId, markdown, true);
        logger.info(`[wecom-bot] sync /list: replyStream ok (entries=${activeEntries.length}, totalActive=${totalActive})`);
        return true;
      } catch (err) {
        logger.warn(`[wecom-bot] sync /list replyStream failed: ${err instanceof Error ? err.message : String(err)}, fall through to enqueue`);
        return false;
      }
    } catch (err) {
      logger.warn(`[wecom-bot] sync /list build failed: ${err instanceof Error ? err.message : String(err)}, fall through to enqueue`);
      return false;
    }
  }

  /**
   * PR 7.5.20: 时间格式化 (相对时间, 仿飞书 formatTimeAgo)
   */
  private _formatTimeAgo(isoStr: string | undefined): string {
    if (!isoStr) return '?';
    const then = new Date(isoStr).getTime();
    if (isNaN(then)) return '?';
    const now = Date.now();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}秒前`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}分钟前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}小时前`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 30) return `${diffDay}天前`;
    const diffMonth = Math.floor(diffDay / 30);
    return `${diffMonth}个月前`;
  }

  /**
   * PR 7.5.20: origin 格式化 (仿飞书 formatOrigin)
   */
  private _formatOrigin(status: string | undefined): string {
    if (!status) return '未知';
    if (status === 'active') return '终端';
    return status;
  }

  /**
   * PR 7.5.21: 格式化 AI 最后消息预览 (对齐飞书 esc() + 限 60 字符)
   *   - 取第一非空行 (避免多行 markdown 干扰 code block / 列表渲染)
   *   - 转义 markdown 特殊字符 (避免渲染问题)
   *   - 截断到 60 字符 (跟飞书 preview() 一致)
   */
  private _formatAIPreview(raw: string): string {
    const firstLine = raw.split('\n').find(l => l.trim().length > 0) ?? '';
    const escaped = firstLine
      .replace(/\\/g, '\\\\')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/`/g, '\\`')
      .trim();
    return escaped.length > 60 ? escaped.slice(0, 57) + '...' : escaped;
  }

  /**
   * PR 7.5.17: /status 同步直发 — 终极 fallback 用 replyStream (markdown).
   */
  private async _syncHandleStatus(msg: PlatformMessage): Promise<boolean> {
    try {
      const text = this.handleCommandStatus(msg.userId);
      const ok = await this._syncHandleMarkdown(msg, text);
      if (ok) {
        logger.info(`[wecom-bot] sync /status: replyStream (markdown) ok`);
      }
      return ok;
    } catch (err) {
      logger.warn(`[wecom-bot] sync /status failed: ${err instanceof Error ? err.message : String(err)}, fall through to enqueue`);
      return false;
    }
  }

  /**
   * PR 7.5.17: /help 同步直发 — 终极 fallback 用 replyStream (markdown).
   */
  private async _syncHandleHelp(msg: PlatformMessage): Promise<boolean> {
    try {
      const text = this.handleCommandHelp();
      const ok = await this._syncHandleMarkdown(msg, text);
      if (ok) {
        logger.info(`[wecom-bot] sync /help: replyStream (markdown) ok`);
      }
      return ok;
    } catch (err) {
      logger.warn(`[wecom-bot] sync /help failed: ${err instanceof Error ? err.message : String(err)}, fall through to enqueue`);
      return false;
    }
  }

  /**
   * PR 7.5.17: /whoami 同步直发 — 终极 fallback 用 replyStream (markdown).
   */
  private async _syncHandleWhoami(msg: PlatformMessage): Promise<boolean> {
    try {
      const text = this.handleCommandWhoami(msg.userId);
      const ok = await this._syncHandleMarkdown(msg, text);
      if (ok) {
        logger.info(`[wecom-bot] sync /whoami: replyStream (markdown) ok`);
      }
      return ok;
    } catch (err) {
      logger.warn(`[wecom-bot] sync /whoami failed: ${err instanceof Error ? err.message : String(err)}, fall through to enqueue`);
      return false;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // PR 4.1: 启动日志 — Claude 流式已接通 (PR 2/3 PoC 模式正式转正)
    // 历史: PR 2 v1.2.1 final (C-1) 标 3 行 PoC WARN，避免 review 同事误用。
    //   846605 invalid req_id 根因已在 M-3 + F7 修复（必传 inboundFrame.headers.req_id）。
    //   handleChat 真接 ClaudeSessionManager.sendStreamingMessage。
    if (this.sessionManager) {
      logger.info('[wecom-bot] handleChat → ClaudeSessionManager 流式模式 (replyStream 必传 inboundFrame)');
    } else {
      logger.warn('[wecom-bot] sessionManager 未注入，handleChat 走 PoC echo 路径（仅用于 staging/单测）');
    }

    this.client.onMessage((event) => {
      logger.info(`[wecom-bot] onMessage received: ${JSON.stringify(event).slice(0, 300)}`);
      const platformMsg = aibotMessageToPlatform(event);
      logger.info(`[wecom-bot] platformMsg: ${JSON.stringify(platformMsg)}`);

      // PR 7.5.15 → PR 7.5.16: 命令同步直发 — 在 onMessage 内同步调
      //   replyTemplateCard (/list) 或 reply (/status /help /whoami).
      //   拿到 inbound 5s 窗口, 不走 SpoolQueue (1-3s dispatch) → 不超时.
      //   只支持同步可处理的命令 (/list 读 in-memory registry);
      //   异步命令 (handleCommandListDir 等) 返回 false 走原 enqueue 路径.
      //   如果同步成功, 不再 enqueue, 避免 dispatch 后续重复推卡.
      this.handleCommandSynchronously(platformMsg).then(handled => {
        if (handled) {
          logger.info(`[wecom-bot] onMessage: 命令 ${platformMsg.text.slice(0, 30)} 已同步直发, 跳过 enqueue`);
          return;
        }
        this.handleMessage(platformMsg).catch(err => {
          logger.error(`[wecom-bot] handleMessage failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }).catch(err => {
        logger.error(`[wecom-bot] handleCommandSynchronously crashed: ${err instanceof Error ? err.message : String(err)}, fall through to enqueue`);
        this.handleMessage(platformMsg).catch(err2 => {
          logger.error(`[wecom-bot] handleMessage failed after sync crash: ${err2 instanceof Error ? err.message : String(err2)}`);
        });
      });
    });

    // PR 2 v1.2.1 E2E staging: 启动 dispatch worker loop
    // PR 3 会重构为共享 FeishuBot.dispatch 的实现
    this.startDispatchLoop();

    this.client.onCardAction((event) => {
      this.handleCardAction(event).catch(err => {
        logger.error(`[wecom-bot] handleCardAction failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    this.client.connect();
    logger.info('[wecom-bot] started, connecting to WSS...');
  }

  /**
   * 停 bot + 立即中断 dispatch loop。
   *
   * PR 7 Task 7.5 (M-2) 修法: 同步设置 this.running = false, 然后 clearTimeout
   *   + 手动调 sleep resolve, 立即让 loop 的 await 跳出, 不等 2s tick。
   * 返回 Promise<void>, await 等待 loop 真正退出 + client.disconnect 完成,
   *   调用方能可靠地等 "bot 彻底停" (跟飞书侧 gracefulShutdown 对齐)。
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // PR 7 M-2: clearTimeout + 手动 resolve sleep promise, 让 loop 的 await 立即完成
    if (this._dispatchTimer) {
      clearTimeout(this._dispatchTimer);
      this._dispatchTimer = null;
    }
    if (this._dispatchSleepResolve) {
      const resolve = this._dispatchSleepResolve;
      this._dispatchSleepResolve = null;
      resolve();
    }
    this.client.disconnect();
    // await loop 真正退出 (sleep promise 已 resolve, 应当立即走 while check → break)
    if (this._dispatchLoopPromise) {
      await this._dispatchLoopPromise;
      this._dispatchLoopPromise = null;
    }
    logger.info('[wecom-bot] stopped');
  }

  /**
   * PR 2 v1.2.1 E2E staging: dispatch worker loop
   * PR 3 会重构为共享 FeishuBot.dispatch 的实现
   *
   * **当前 E2E 简化**：从 SpoolQueue 拉消息 → handleChat → replyStream 推回
   * Claude 集成（sessionManager.sendStreamingMessage）需要 init ClaudeSessionManager
   * 是更大的工作，PR 3 Task 3.6 做；本 task 只验证 SDK replyStream 真能发
   *
   * **重试机制**：处理失败时 requeueFromProcessing 让消息回 pending
   * 否则下一轮 claimNext(serialKey) 看到 processing 还有 active 就拒绝
   *
   * **PR 2 v1.2.1 (M1 修复)**: 轮询周期 500ms → 2000ms，与飞书侧 bot.dispatch 对齐
   * 减少 fs 全表扫描 IO（每秒 4 次 → 1 次）；PR 3 共享 FeishuBot.dispatch 后会变事件驱动
   *
   * **PR 7 Task 7.5 (M-2)**: 用可中断 timer + tracked promise 实现 stop 立即退出。
   * 修前: setTimeout(r, 2000) 无法中断, stop() 后整个 loop 函数仍 sleep 2s,
   *   → 测试 / daemon restart 时常卡 2s, 跟飞书侧 startForeground.dispatchLoop 不一致
   * 修法: sleep 接受 timer handle 暴露到 this._dispatchTimer, stop() 时 clearTimeout
   *   让 await 立即 resolve, loop 跳出 while 立即退出。loop promise 存到
   *   this._dispatchLoopPromise, 让单测 / 外部代码 await 验证 stop 后 loop 真正退出。
   */
  private startDispatchLoop(): void {
    let stopped = false;
    const loop = async () => {
      while (!stopped && this.running) {
        try {
          // 0. PR 2 v1.2.1 final (M-6): 同步回滚 user-mapping 中过时的 claim
          // 历史 bug: spool 60s 重新入队但 user-mapping.pending_new_session_claimed
          //   仍卡 10min，导致用户后续消息在 claimPending 阶段被 `creating` 状态挡住。
          // 修法: 每次 tick 调一次 rollbackTimedOutClaims()，默认 10 分钟超时
          //   （虽然慢于 60s spool requeue，但确保不永久卡 user-mapping）。
          await this.userManager.rollbackTimedOutClaims();

          // 1. 重试卡在 processing 超时的消息（>stale_timeout 的丢回 pending）
          // PR 6.17: stale_timeout 60s → 10min (读 config runtime.stale_timeout_ms)
          // 历史: GLM session 17:15-17:17 反复 requeue, 因为 MiniMax-M3 思考慢, 60s 就误判卡住.
          //   requeue 触发新一轮 handleClaimed + 新 Claude spawn, 同一 messageId 多次 spawn
          //   → 用户看不到 thinking 累积 (每次 handleChat 局部变量清零).
          // 修法: 调高到 10min (600_000ms) 或读 config, 给 MiniMax-M3 足够思考时间.
          const staleTimeoutMs = config.get<number>('runtime.stale_timeout_ms', 10 * 60 * 1000);
          const processing = this.spoolQueue.listProcessing('wecom');
          for (const msg of processing) {
            const age = Date.now() - new Date(msg.updatedAt).getTime();
            if (age > staleTimeoutMs) {
              logger.warn(`[wecom-bot] requeue stale processing: ${msg.messageId} (${Math.round(age / 1000)}s, threshold=${Math.round(staleTimeoutMs / 1000)}s)`);
              this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
            }
          }

          // 2. 拉所有 pending → claim → handle
          // PR 2 v1.2.1 final (M-4): 传 'wecom' 过滤（同 listProcessing 注释）
          const pending = this.spoolQueue.listPending('wecom');
          for (const msg of pending) {
            const claimed = this.spoolQueue.claimNext(msg.serialKey);
            if (claimed) {
              this.handleClaimed(claimed).catch(err => {
                logger.error(`[wecom-bot] handleClaimed failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          }
        } catch (err) {
          logger.error(`[wecom-bot] dispatch loop error: ${err instanceof Error ? err.message : String(err)}`);
        }
        // PR 7 M-2: 可中断 sleep — 把 timer + resolve 暴露到 this, stop() 时
        // clearTimeout 并手动调 resolve, 让 await 立即完成, loop 跳出 while 立即退出
        if (stopped || !this.running) break;
        await new Promise<void>(r => {
          this._dispatchSleepResolve = r;
          this._dispatchTimer = setTimeout(() => {
            this._dispatchTimer = null;
            this._dispatchSleepResolve = null;
            r();
          }, 2000);
        });
      }
    };
    this._dispatchLoopPromise = loop();
  }

  /**
   * PR 2 v1.2.1 E2E staging: handleClaimed
   * 简化版：命令 vs 普通消息分路径
   * 命令暂时 echo back; 普通消息直接 handleChat
   */
  private async handleClaimed(msg: SpoolMessage): Promise<void> {
    logger.info(`[wecom-bot] handleClaimed: serialKey=${msg.serialKey}, text=${msg.text.slice(0, 50)}`);

    // PR 5.1 followup: C-1+C-2 command path 修复 — owner 验证移到 handleClaimed 统一入口
    // 历史: 原 C-1+C-2 修复只在 handleChat 入口加 validateOwner, handleCommand 没受保护
    //   → 攻击者可 /switch <uuid> 切换 owner session, /stop <short> 终止 bg session
    // 修法: handleClaimed 入口加 validateOwner, 覆盖 handleCommand + handleChat + handleCardAction 全部子路径
    if (!this.userManager.validateOwner(msg.userId)) {
      logger.warn(`[wecom-bot] handleClaimed: unauthorized userId=${msg.userId}, msgType=${msg.serialKey.startsWith('cmd:') ? 'cmd' : 'chat'}, skipping`);
      // 直接 sendMessage 而非 updater.error (后者依赖 startProcessing, 未授权路径无 stream state → silent no-op)
      try {
        await this.client.sdk.sendMessage(msg.userId, {
          msgtype: 'markdown',
          markdown: { content: '❌ 未授权用户' },
        });
      } catch (sendErr) {
        logger.warn(`[wecom-bot] unauthorized notify failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
      }
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;
    }

    // 命令直接 echo（完整命令处理是 PR 3 Task 3.6）
    if (msg.serialKey.startsWith('cmd:')) {
      await this.handleCommand(msg);
      return;
    }
    // PR 6.8.4: 续聊 session 路径也识别 /xxx 命令
    // 历史: 续聊 session 的 serialKey 是 `<sessionId>:<msgId>` 不带 `cmd:` 前缀,
    //   原代码不识别命令 → /list /switch /resume 等被 Claude 当 user prompt 处理
    //   (14:49:40 /list 真实验收: Claude 跑 4s 返回 43 chars 不可预期内容)
    // 修法: 续聊路径先 parseCommand, 是命令走 handleCommand, 否则 handleChat
    if (!msg.serialKey.startsWith('new:')) {
      const parsed = parseCommand(msg.text);
      if (parsed) {
        logger.info(`[wecom-bot] handleClaimed: 续聊时识别命令 /${parsed.cmd} (text=${msg.text.slice(0, 30)})`);
        await this.handleCommand(msg);
        return;
      }
    }
    // 普通聊天: 走 handleChat
    await this.handleChat(msg);
  }

  private async handleCommand(msg: SpoolMessage): Promise<void> {
    // PR 4.5 C: 命令路由 — 仿飞书侧命令处理，但用 sendMessage 推回 (没 CardUpdater)
    // 历史: PR 2/3/4.1 阶段命令只 echo back (set up stub 收命令 E2E), 真实路由 PR 4.5+ 实现
    // 简化版: 只支持 /new /list /status /help; /switch /resume /agents 推 PR 5+ 实现
    // /bridge 已废弃 (历史 cc-connect 集成命令, cc-linker 移除 cc-connect 后孤儿, 2026-06-20 决定不复活)
    const parsed = parseCommand(msg.text);
    if (!parsed) {
      logger.warn(`[wecom-bot] handleCommand: parseCommand failed for "${msg.text.slice(0, 50)}", skipping`);
      return;
    }

    logger.info(`[wecom-bot] handleCommand: cmd=/${parsed.cmd} args=${JSON.stringify(parsed.args)} userId=${msg.userId}`);

    // PR 6.9 + PR 6.11: /list 改 multi-session markdown 列表 (推回逻辑不统一, 直接走 handleCommandListCard)
    // 历史: case 'list' 走 handleCommandList 返回 markdown, 但用户期望 multi-session 列表
    // PR 6.9 改成 template_card (textNotice), 但 aibot 服务端 textNotice 类型必须带 card_action,
    //   errcode=42045 "Template_Card card_action Missing or Invalid"
    // PR 6.11: 改成 markdown 消息, 保留多 session 渲染逻辑
    // 修法: case 'list' 直接 await handleCommandListCard (内部 sendMessage markdown + markDone),
    //   跳过后续统一 sendMessage 推送路径 (return 跳出 handleCommand)
    if (parsed.cmd === 'list') {
      // PR 7.5.5 hotfix: 推卡用 replyTemplateCard (不用 sendMessage 的 5s ack 路径)
      // PR 7.5.2: 推 buildListCard 卡片代替 markdown
      if (!this.registryManager) {
        // registryManager 未注入 → 走 markdown 兜底 (跟 Task 2.0 fallback 路径一致)
        await this.handleCommandListCard(msg);
        return;
      }
      let data: Omit<ListCardData, 'markdown'>;
      try {
        data = await this._handleCommandListCardInternal(msg);
      } catch (err) {
        logger.error(`[wecom-bot] list card data fetch failed: ${err instanceof Error ? err.message : String(err)}, fallback to markdown`);
        await this.handleCommandListCard(msg);
        return;
      }
      const card = buildListCard({
        entries: data.entries,
        totalActive: data.totalActive,
      });
      const inboundFrame = msg.metadata?.inboundFrame;
      const receiveId = resolveReceiveId(msg);
      try {
        if (inboundFrame) {
          // 优选 replyTemplateCard (5s replyWelcome 窗口, 不超时)
          await this.wecomCompleteCardSender.sendViaReply(inboundFrame, { userId: msg.userId, chatId: receiveId }, card);
        } else {
          // fallback: sendMessage (无 inboundFrame 时, 比如续聊 session path)
          await this.wecomCompleteCardSender.send({ userId: msg.userId, chatId: receiveId, template_card: card });
        }
      } catch (err) {
        logger.error(`[wecom-bot] list card send failed: ${err instanceof Error ? err.message : String(err)}, fallback to markdown`);
        await this.handleCommandListCard(msg);
        return;
      }
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;
    }

    let responseText: string;
    try {
      switch (parsed.cmd) {
        case 'new':
          responseText = await this.handleCommandNew(msg.userId, parsed.args);
          break;
        case 'list':
          // PR 6.9: unreachable — 上面 if (parsed.cmd === 'list') 已拦截走 handleCommandListCard
          responseText = 'unreachable';
          break;
        case 'status':
          responseText = await this.handleCommandStatus(msg.userId);
          break;
        case 'help':
          responseText = this.handleCommandHelp();
          break;
        // PR 5: 6 个新命令
        case 'switch': {
          responseText = await this.handleCommandSwitch(msg.userId, parsed.args);
          // PR 7.5.3: 切换成功后附加 PR 7 完成卡 (复用 buildCompleteCard, 3 主按钮 + 4 action_menu)
          //   异步发, 不阻塞 responseText 推回
          // PR 7.5.5 hotfix: 优选 replyTemplateCard (5s replyWelcome 窗口, 不超时)
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
            const inboundFrame = msg.metadata?.inboundFrame;
            if (inboundFrame) {
              this.wecomCompleteCardSender.sendViaReply(inboundFrame, { userId: msg.userId }, card)
                .catch(err => logger.warn(`[wecom-bot] complete card after switch failed: ${err instanceof Error ? err.message : String(err)}`));
            } else {
              this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card })
                .catch(err => logger.warn(`[wecom-bot] complete card after switch failed: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
          break;
        }
        case 'resume':
          responseText = await this.handleCommandResume(msg.userId, parsed.args);
          // PR 7.5.3: 附加 buildResumeCard (text_notice + 1 switch 按钮, no value 走 list 语义)
          // PR 7.5.5 hotfix: 优选 replyTemplateCard
          {
            const entry = this.userManager.getEntry(msg.userId);
            const card = buildResumeCard({ sessionUuid: entry?.sessionUuid ?? '' });
            const inboundFrame = msg.metadata?.inboundFrame;
            if (inboundFrame) {
              this.wecomCompleteCardSender.sendViaReply(inboundFrame, { userId: msg.userId }, card)
                .catch(err => logger.warn(`[wecom-bot] resume card send failed: ${err instanceof Error ? err.message : String(err)}`));
            } else {
              this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card })
                .catch(err => logger.warn(`[wecom-bot] resume card send failed: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
          break;
        case 'agents': {
          // PR 7.5.2 Task 2.0: handleCommandAgents 改返 AgentsData 结构, 取 .markdown 喂统一推送
          // PR 7.5.3: 同时附加 buildAgentsRefreshCard (text_notice + agents-refresh action_menu)
          // PR 7.5.5 hotfix: 优选 replyTemplateCard
          const agentsData = await this.handleCommandAgents(msg.userId, parsed.args);
          responseText = agentsData.markdown;
          {
            const card = buildAgentsRefreshCard({ bgCount: agentsData.bgCount });
            const inboundFrame = msg.metadata?.inboundFrame;
            if (inboundFrame) {
              this.wecomCompleteCardSender.sendViaReply(inboundFrame, { userId: msg.userId }, card)
                .catch(err => logger.warn(`[wecom-bot] agents card send failed: ${err instanceof Error ? err.message : String(err)}`));
            } else {
              this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card })
                .catch(err => logger.warn(`[wecom-bot] agents card send failed: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
          break;
        }
        case 'stop': {
          responseText = await this.handleCommandStop(msg.userId, parsed.args);
          // PR 7.5.3: 附加 buildStopCard (text_notice + 1 switch 按钮, no value 走 list 语义)
          // PR 7.5.5 hotfix: 优选 replyTemplateCard
          if (parsed.args.length > 0 && responseText.startsWith('✅')) {
            const card = buildStopCard({ shortId: parsed.args[0] });
            const inboundFrame = msg.metadata?.inboundFrame;
            if (inboundFrame) {
              this.wecomCompleteCardSender.sendViaReply(inboundFrame, { userId: msg.userId }, card)
                .catch(err => logger.warn(`[wecom-bot] stop card send failed: ${err instanceof Error ? err.message : String(err)}`));
            } else {
              this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card })
                .catch(err => logger.warn(`[wecom-bot] stop card send failed: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
          break;
        }
        case 'cancel':
          responseText = await this.handleCommandCancel(msg.userId, parsed.args);
          break;
        case 'model': {
          if (parsed.args.length === 0 || !parsed.args[0]) {
            // PR 7.5.2 F2 fix: 无 alias 走 buildModelCard, 不调 handleCommandModel
            if (!this.providerManager) {
              responseText = '❌ 用法: /model <model-alias> (providerManager 未注入)';
              break;
            }
            const currentEntry = this.userManager.getEntry(msg.userId);
            const currentAlias = currentEntry?.type === 'session' || currentEntry?.type === 'pending_new_session'
              ? (currentEntry as any).defaultProvider
              : undefined;
            const providers = this.providerManager.list().map(p => ({ alias: p.alias, name: p.name }));
            const card = buildModelCard({ providers, currentAlias });
            // PR 7.5.5 hotfix: 优选 replyTemplateCard (5s replyWelcome 窗口, 不超时)
            const inboundFrame = msg.metadata?.inboundFrame;
            try {
              if (inboundFrame) {
                await this.wecomCompleteCardSender.sendViaReply(inboundFrame, { userId: msg.userId }, card);
              } else {
                await this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card });
              }
              this.spoolQueue.markDone(msg.messageId, msg.serialKey);
              return;  // 卡片已发, 跳外层 sendMessage
            } catch (sendErr) {
              logger.error(`[wecom-bot] model card send failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
              responseText = '❌ 模型卡片发送失败, 请重试';
            }
            break;
          }
          // 有 alias → 走 handleCommandModel (Task 1.4 集成, 实际写 user-mapping)
          responseText = await this.handleCommandModel(msg.userId, parsed.args);
          break;
        }
        // PR 6.13: /listdir 命令 — 列 cwd 下子目录 (仿飞书 doListDir 但简化无 CardKit)
        // 历史: 飞书 /listdir 渲染 CardKit 模板卡片 (buildDirListCard); wecom 推 markdown 列表
        // PR 7.3 fix #7: 保持原样 (responseText 由 handleCommandListDir 返回)
        //   走外层 sendMessage (bot.ts:478-483), 避免双推送
        //   按钮路径 (executeCardAction case 'listdir') 走 renderListDir
        case 'listdir': {
          // PR 7.5.2: 推 buildDirListCard (Task 2.0 拆 DirListData 结构)
          const data = await this.handleCommandListDir(msg.userId);
          if (data.markdown.startsWith('❌')) {
            // 错误路径 (目录不存在 / 读目录失败) → 走 markdown 兜底 (PR 6.13 既有行为)
            responseText = data.markdown;
          } else {
            // 正常路径: 推卡片
            const card = buildDirListCard({
              cwd: data.cwd,
              parent: data.parent,
              dirs: data.dirs,
              hasMore: data.hasMore,
            });
            // PR 7.5.5 hotfix: 优选 replyTemplateCard (5s replyWelcome 窗口, 不超时)
            const inboundFrame = msg.metadata?.inboundFrame;
            try {
              if (inboundFrame) {
                await this.wecomCompleteCardSender.sendViaReply(inboundFrame, { userId: msg.userId }, card);
              } else {
                await this.wecomCompleteCardSender.send({ userId: msg.userId, template_card: card });
              }
              this.spoolQueue.markDone(msg.messageId, msg.serialKey);
              return;  // 卡片已发, 跳外层 sendMessage
            } catch (sendErr) {
              logger.error(`[wecom-bot] listdir card send failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}, fallback to markdown`);
              responseText = data.markdown;
            }
          }
          break;
        }
        // PR 6.14: /whoami 命令 — 显示当前 user externalUserId + 配置提示
        // 仿飞书 feishu/bot.ts:1009 case 'whoami', 帮助用户诊断 owner 配置
        case 'whoami':
          responseText = this.handleCommandWhoami(msg.userId);
          break;
        // PR 6 Task 6.2: /bridge 已废弃 (2026-06-20 决定, spec §5.7 YAGNI 跨平台 session 同步)
        // 历史: cc-connect 集成命令, cc-linker 移除 cc-connect 后孤儿, 不复活
        // 替代: 用户在终端用 `cc-linker switch <uuid>` 跨平台管理 session
        // PR 6.14: 显式删除 /bridge case + 不再 default 提示 (用户截图反馈 "这个不用对用户展示")
        //   改: bridge 命令走 default 返"未知命令"即可, 用户不需要知道历史
        // case 'bridge': 已删除 — 历史原因在 commit msg 保留
        default:
          responseText = `❌ 未知命令: /${parsed.cmd}\n\n可用命令: /new /list /listdir /status /help /switch /resume /agents /stop /cancel /model /whoami`;
      }
    } catch (err) {
      logger.error(`[wecom-bot] handleCommand /${parsed.cmd} error: ${err instanceof Error ? err.message : String(err)}`);
      responseText = `❌ 命令执行失败: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 推回 (用 sendMessage 不用 WecomStreamUpdater, 因为命令响应是终态文本不走流)
    // PR 5 (M-1 修复): 群聊场景 metadata.chatId 优先, fallback userId
    // 历史: 之前硬编码 userId, 群聊场景下 metadata.chatId 不同时, 企微会发错对象
    // PR 6.8.1: M-1 fix 方向错 (chatId 优先) — 私聊场景下 chatId 是 msgid, 企微 errcode=93006
    //   修法: 按 chatType 决定 receiveId (group→chatId, p2p/single/undefined→userId)
    try {
      const receiveId = resolveReceiveId(msg);
      await this.client.sdk.sendMessage(receiveId, {
        msgtype: 'markdown',
        markdown: { content: responseText },
      });
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    } catch (err) {
      logger.error(`[wecom-bot] handleCommand sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
      } catch (requeueErr) { /* ignore */ }
    }
  }

  /**
   * PR 4.5 C: /new 命令 - 强制新建 session (调 setPending, 下条消息走 handleChat 新建路径)
   */
  private async handleCommandNew(userId: string, args: string[]): Promise<string> {
    const cwd = args[0] ?? '/tmp';
    await this.userManager.setPending(userId, { cwd });
    return `✅ 已创建 pending session (cwd=${cwd})\n\n下条消息将走新建 session 路径`;
  }

  /**
   * PR 4.5 C: /list 命令 - 列出用户当前 session 状态 (旧版, 返回 markdown 文本, 给 handleCommandListCard fallback 用)
   */
  private handleCommandList(userId: string, _args: string[]): string {
    const entry = this.userManager.getEntry(userId);
    if (!entry) {
      return '📭 当前无 active session, 发送任意消息走新建 session 路径';
    }
    if (entry.type === 'session') {
      return `📋 当前 session:\n  sessionUuid: ${entry.sessionUuid}\n  cwd: ${entry.cwd ?? '(unknown)'}\n  lastActiveAt: ${entry.lastActiveAt ?? '(unknown)'}`;
    }
    if (entry.type === 'pending_new_session') {
      return '⏳ 等待下条消息触发新建 session';
    }
    if (entry.type === 'pending_new_session_claimed') {
      return '⏳ 新 session 创建中 (claimed), 请稍候';
    }
    return `📋 当前状态: ${entry.type}`;
  }

  /**
   * PR 6.9 + PR 6.11: /list 命令新实现 — 推 multi-session markdown 列表
   *
   * 历史:
   * - PR 4.5 C 旧 handleCommandList 只显示当前 user 关联的 session 详情, 用户期望 multi-session 列表
   * - PR 6.9 改成 template_card (textNotice), 但 textNotice 类型必须带 card_action.type=1/2,
   *   没 action_menu 时 aibot 服务端 errcode=42045 "Template_Card card_action Missing or Invalid"
   *   (微信开放社区: 文本通知型卡片字段取值范围是1.2,不能设置为0)
   * - PR 6.11 改成 markdown 消息, 保留多 session 渲染逻辑
   *
   * 修法:
   * - 拉 registryManager.sessions (Record<uuid, SessionEntry>) 拿完整 uuid + metadata
   * - 按 last_active 倒序取前 10 条
   * - 标当前 user session 为 👉
   * - 渲染成 markdown (title 加重 / uuid 标 code block)
   * - sendMessage markdown 推回
   * - markDone 收尾
   *
   * 防御:
   * - registryManager 未注入 → 退到老 handleCommandList (向后兼容 wecom-only staging)
   * - sendMessage throw → requeueFromProcessing (跟统一推送路径一致)
   */
  private async handleCommandListCard(msg: SpoolMessage): Promise<void> {
    logger.info(`[wecom-bot] handleCommandListCard: userId=${msg.userId}`);

    // PR 7.5.2 Task 2.0: 拆 _Internal 返回结构 + _renderXxxMarkdown 渲染字符串
    // 调用方 0 regression: handleCommandListCard 仍走 sendMessage markdown + markDone
    // Task 2.2 调 _handleCommandListCardInternal 拿结构数据喂 buildListCard
    if (!this.registryManager) {
      // registryManager 未注入 (wecom-only staging / 旧测试) → 走老 markdown 路径
      logger.warn('[wecom-bot] handleCommandListCard: registryManager not injected, fallback to markdown');
      await this.fallbackListMarkdown(msg);
      return;
    }

    let data: ListCardData;
    try {
      const internal = await this._handleCommandListCardInternal(msg);
      data = { ...internal, markdown: this._renderListMarkdown(internal) };
      logger.info(`[wecom-bot] handleCommandListCard: rendering ${internal.entries.length}/${internal.totalActive} sessions for userId=${msg.userId}`);
    } catch (err) {
      logger.error(`[wecom-bot] handleCommandListCard: registry access failed: ${err instanceof Error ? err.message : String(err)}, fallback to markdown`);
      await this.fallbackListMarkdown(msg);
      return;
    }

    // 2. sendMessage markdown (行为不变 — 跟 P0#2 / P1#6 一致)
    try {
      const receiveId = resolveReceiveId(msg);
      await this.client.sdk.sendMessage(receiveId, {
        msgtype: 'markdown',
        markdown: { content: data.markdown },
      });
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      logger.info(`[wecom-bot] handleCommandListCard: sent markdown to ${receiveId}`);
    } catch (err) {
      logger.error(`[wecom-bot] handleCommandListCard: sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
      // PR 6.21 P1#6: 异常路径 markDone 兜底, 跟 P0#2 一样不 requeue
      // 命令响应已是终态 (sendMessage 失败但消息已处理), requeue 触发重复 dispatch 死循环
      try {
        this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      } catch (markDoneErr) {
        logger.warn(`[wecom-bot] handleCommandListCard markDone failed: ${markDoneErr instanceof Error ? markDoneErr.message : String(markDoneErr)}`);
      }
    }
  }

  /**
   * PR 7.5.2 Task 2.0: 读 registry 拿结构化数据 (无 markdown 渲染, 无 sendMessage).
   * Task 2.2 用 entries + currentUuid 喂 buildListCard.
   */
  private async _handleCommandListCardInternal(msg: SpoolMessage): Promise<Omit<ListCardData, 'markdown'>> {
    // PR 6.9: 用 registryManager.sessions (Record<uuid, SessionEntry>) 拿完整 uuid
    // listActive() 返回 SessionEntry[] 没 uuid, 反查 O(n²) 不好
    // sessions 是 in-memory cache (start.ts syncBeforeCommand 已 flush 最新数据)
    const allActive = this.registryManager!.sessions;
    const activeEntries = Object.entries(allActive)
      .filter(([_, s]) => s.status === 'active')
      .sort(([_, a], [__, b]) => (b.last_active ?? '').localeCompare(a.last_active ?? ''))
      .slice(0, 10)
      .map(([sessionUuid, s]) => ({
        sessionUuid,
        title: s.title ?? '(无标题)',
        // 渲染时要用 cwd 字段 (PR 6.9 模板), Task 2.2 卡片化不依赖
        cwd: s.cwd,
        messageCount: s.message_count ?? 0,
        lastActive: s.last_active ?? '',
      }));
    const totalActive = Object.values(allActive).filter(s => s.status === 'active').length;
    const currentEntry = this.userManager.getEntry(msg.userId);
    const currentUuid = currentEntry?.type === 'session' ? currentEntry.sessionUuid : null;
    return { entries: activeEntries, totalActive, currentUuid };
  }

  /**
   * PR 7.5.2 Task 2.0: 渲染 list markdown 字符串 (与原 handleCommandListCard 输出完全一致,
   * 保留 cwd + msgs + lastActive + uuid 前 8 字符 + 👉 marker)
   */
  private _renderListMarkdown(internal: Omit<ListCardData, 'markdown'>): string {
    if (internal.entries.length === 0) {
      return '📭 当前无 active session';
    }
    const header = `📋 **活跃 sessions (${internal.entries.length}${internal.totalActive > 10 ? '+' : ''})**\n\n`;
    const lines = internal.entries.map(e => {
      const marker = e.sessionUuid === internal.currentUuid ? '👉' : '　';
      const cwd = e.cwd ? ` \`${e.cwd}\`` : '';
      const msgs = e.messageCount != null ? ` (${e.messageCount} msgs)` : '';
      const lastActive = e.lastActive ? ` _${e.lastActive.slice(0, 16)}_` : '';
      return `${marker} **${e.title}**${msgs}${cwd}${lastActive}\n   \`${e.sessionUuid.slice(0, 8)}…\``;
    });
    return header + lines.join('\n\n') +
      `\n\n_(共 ${internal.totalActive} 个, 只显示前 ${internal.entries.length}; 续聊用 \`/switch <uuid>\`)_`;
  }

  /**
   * PR 6.9: handleCommandListCard 的 markdown 兜底 — registryManager 缺失/出错时调用
   * 复用老 handleCommandList 返回 markdown, 走统一 sendMessage 推送路径
   */
  private async fallbackListMarkdown(msg: SpoolMessage): Promise<void> {
    const text = this.handleCommandList(msg.userId, []);
    try {
      const receiveId = resolveReceiveId(msg);
      await this.client.sdk.sendMessage(receiveId, {
        msgtype: 'markdown',
        markdown: { content: text },
      });
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    } catch (err) {
      logger.error(`[wecom-bot] fallbackListMarkdown: sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
      // PR 6.21 P1#6: 异常路径 markDone 兜底 (跟 P0#2 一致)
      try {
        this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      } catch (markDoneErr) {
        logger.warn(`[wecom-bot] fallbackListMarkdown markDone failed: ${markDoneErr instanceof Error ? markDoneErr.message : String(markDoneErr)}`);
      }
    }
  }

  /**
   * PR 4.5 C: /status 命令 - 显示 bot 配置状态
   */
  private handleCommandStatus(_userId: string): string {
    const ownerExternalUserId = config.get<string>('wecom.owner_external_user_id', '');
    const botId = config.get<string>('wecom.bot_id', '');
    return `📊 Wecom Bot 状态:\n  bot_id: ${botId || '(未配置)'}\n  owner_configured: ${!!ownerExternalUserId}\n  claude_streaming: ${this.sessionManager ? 'enabled' : 'PoC echo'}\n  user_mapping_path: ${this.userManager.path}`;
  }

  /**
   * PR 4.5 C: /help 命令 - 列出可用命令
   * PR 5: 加 6 个新命令: /switch /resume /agents /stop /cancel /model
   */
  private handleCommandHelp(): string {
    return `🤖 cc-linker wecom Bot 命令:\n  /new [cwd]    - 强制新建 session\n  /list         - 列出当前 session\n  /listdir      - 浏览 cwd 子目录\n  /status       - 显示 bot 状态\n  /help         - 显示本帮助\n  /switch <uuid> - 切换到指定 session\n  /resume       - 续聊当前 session (刷 lastActiveAt)\n  /agents       - 列出活跃 bg sessions\n  /stop <short> - 停止 bg session\n  /cancel       - 取消当前 reply (PR 5 简化: 仅返回状态)\n  /model <name> - 切换 model alias (PR 5 临时实现, 持久化推 PR 6+)\n  /whoami       - 显示当前 user + owner 配置提示`;
  }

  /**
   * PR 5: /switch <uuid> - 切换到指定 Claude session
   *
   * 行为：把 user-mapping 的 sessionUuid 改为参数指定值 (走 setSession)
   * 注意：先读现有 entry 拿 cwd（保留用户工作目录）；无 entry 时用 /tmp fallback
   */
  private async handleCommandSwitch(userId: string, args: string[]): Promise<string> {
    if (args.length === 0 || !args[0]) {
      return '❌ 用法: /switch <session-uuid>';
    }
    const newSessionUuid = args[0];
    const entry = this.userManager.getEntry(userId);
    const cwd = entry?.cwd ?? '/tmp';
    await this.userManager.setSession(userId, newSessionUuid, cwd);
    return `✅ 已切换 session: ${newSessionUuid}\n  cwd: ${cwd}\n\n下条消息会用这个 session 续聊`;
  }

  /**
   * PR 5: /resume - 续聊当前 session
   *
   * 行为：如果 user-mapping 有 active session，调 touchSession 刷 lastActiveAt
   * 区别于 /switch: /switch 切换到指定 sessionUuid, /resume 保持原 session 只刷活跃时间
   */
  private async handleCommandResume(userId: string, _args: string[]): Promise<string> {
    // PR 5 (M-7 修复): 先读 entry 验证 type === 'session', 然后 touchSession, 最后重读 entry
    // 历史: 只在调用前 getEntry 一次, touchSession 异步更新 lastActiveAt 后,
    //   返回文本用的是旧 entry.lastActiveAt, 用户看到旧时间
    // 修法: touchSession 之后重新 getEntry 拿新 entry, 用新 entry.lastActiveAt 拼返回
    const beforeEntry = this.userManager.getEntry(userId);
    if (!beforeEntry || beforeEntry.type !== 'session') {
      return '❌ 当前无 active session, 发送任意消息走新建 session 路径';
    }
    await this.userManager.touchSession(userId);
    const afterEntry = this.userManager.getEntry(userId);
    return `✅ session 已 touch (lastActiveAt 更新):\n  sessionUuid: ${afterEntry?.sessionUuid ?? '(unknown)'}\n  cwd: ${afterEntry?.cwd ?? '(unknown)'}\n  lastActiveAt: ${afterEntry?.lastActiveAt ?? '(unknown)'}`;
  }

  /**
   * PR 5: /agents - 列出活跃 bg sessions
   *
   * 简化版实现：读 ~/.claude/jobs/ 目录下每个 state.json 列出 shortId + status
   * 完整 AgentView 卡片渲染逻辑推 PR 6+ (需要 bg session 的 peek/reply/stop 交互)
   */
  private async handleCommandAgents(_userId: string, _args: string[]): Promise<AgentsData> {
    try {
      const { readdirSync, readFileSync, existsSync } = await import('fs');
      const { join } = await import('path');
      const { homedir } = await import('os');
      const jobsDir = join(homedir(), '.claude', 'jobs');
      if (!existsSync(jobsDir)) {
        return { markdown: '📭 无活跃 bg sessions (jobs 目录不存在)', bgCount: 0 };
      }
      const entries = readdirSync(jobsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .slice(0, 10);  // 限 10 个
      if (entries.length === 0) {
        return { markdown: '📭 无活跃 bg sessions', bgCount: 0 };
      }
      const lines = ['📋 活跃 bg sessions:'];
      let bgCount = 0;
      for (const entry of entries) {
        const statePath = join(jobsDir, entry.name, 'state.json');
        if (!existsSync(statePath)) continue;
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          const status = state.status ?? 'unknown';
          const name = state.name ?? state.shortId ?? entry.name;
          lines.push(`  • ${name} [${status}] (${entry.name})`);
          bgCount++;
        } catch { /* skip malformed state.json */ }
      }
      return { markdown: lines.join('\n'), bgCount };
    } catch (err) {
      const errMsg = `❌ 读取 bg sessions 失败: ${err instanceof Error ? err.message : String(err)}`;
      return { markdown: errMsg, bgCount: 0 };
    }
  }

  /**
   * PR 5: /stop <shortId> - 停止 bg session
   *
   * 行为：调 `claude stop <shortId>` 子进程
   * 完整 AgentView.stop 路径推 PR 6+ (需要状态机守卫 + 用户确认)
   */
  private async handleCommandStop(_userId: string, args: string[]): Promise<string> {
    if (args.length === 0 || !args[0]) {
      return '❌ 用法: /stop <short-id>';
    }
    const shortId = args[0];
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const exec = promisify(execFile);
      await exec('claude', ['stop', shortId]);
      return `✅ 已停止 bg session: ${shortId}`;
    } catch (err) {
      return `❌ 停止失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * PR 5: /cancel - 取消当前 reply
   *
   * 简化版：仅返回状态消息（不像 feishu 侧有 cancelledMessageIds 状态机）
   * 企微侧无 in-flight cancel 完整实现（需要 replyStream 终止 + activeChunks 清理）
   * TODO PR 6+: 集成 in-flight cancel (类似 feishu 的 cancelledMessageIds)
   */
  private async handleCommandCancel(userId: string, _args: string[]): Promise<string> {
    const entry = this.userManager.getEntry(userId);
    if (!entry || entry.type !== 'session') {
      return '❌ 当前无 active session';
    }
    return `⚠️  cancel 命令: 企微侧 in-flight cancel 待实现 (PR 6+)\n  当前 session: ${entry.sessionUuid}\n  cwd: ${entry.cwd ?? '(unknown)'}`;
  }

  /**
   * PR 7.5.1 + C1 fix: handleCommandModel 实际集成 ProviderManager
   * 旧版 (PR 5 stub): 只 log + 返回 markdown 占位 "已设置 model: <name>"
   * 新版:
   * - alias = '--clear' → 调 userManager.clearDefaultProvider(userId) + 返回"已清除"
   * - alias = '<name>'  → ProviderManager.resolve(alias) 验证 → userManager.setDefaultProvider → 返回"已设置"
   *   - PR 7.5 C1 fix: ProviderManager.resolve 返回 null (不抛错), 必须显式 null 检查返回错误
   * - 无 alias → handleCommand case 'model' 入口拦截, 走 buildModelCard 路径 (PR 7.5.2)
   *   这里保留兜底返回 (防止未来直调 bypass case 'model')
   */
  private async handleCommandModel(userId: string, args: string[]): Promise<string> {
    if (args.length === 0 || !args[0]) {
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

  /**
   * PR 6.14: /whoami 命令 — 显示当前 user externalUserId + owner 配置提示
   * 仿飞书 feishu/bot.ts:1009 case 'whoami' (返回 open_id)
   * 历史: 用户调试 owner_external_user_id 配置时需要知道自己的 external_user_id
   */
  private handleCommandWhoami(userId: string): string {
    const ownerExternalUserId = config.get<string>('wecom.owner_external_user_id', '');
    const isOwner = !ownerExternalUserId || ownerExternalUserId === userId;
    return `👤 你的 external_user_id: \`${userId}\`\n\n${
      isOwner
        ? '✅ 已配置为 owner (wecom.owner_external_user_id)\n\n其他人发的消息会被 bot 拒绝'
        : `⚠️ 当前配置 owner 是 \`${ownerExternalUserId}\`, 你不是 owner\n\n如需限制仅你本人使用，把上面的 userId 填到 config.toml 的 [wecom] owner_external_user_id`
    }`;
  }

  /**
   * PR 6.13: /listdir 命令 — 读 cwd 下子目录并推 markdown 列表
   *
   * 历史: wecom 没 /listdir (飞书 doListDir 渲染 CardKit 卡片, 但 wecom 无 CardKit)
   * 修法: 简化版 — 读 user-mapping entry.cwd (fallback /tmp) → readdirSync → 推 markdown 列表
   *
   * 跟飞书 doListDir 差异:
   * - 飞书: CardKit textNotice card (buildDirListCard), 可点击目录切换 cwd
   * - wecom: markdown 列表 (PR 6.11 教训: textNotice 没 action_menu 时 42045)
   * - wecom: 没法直接 "点击目录切换 cwd", 用户需 /new <路径> 切换
   *
   * 防御: cwd 不存在 → 报错 + cwd 路径提示
   */
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

  /**
   * PR 7.3: 抽公共方法 — 渲染 /listdir 结果 markdown
   * 委托给现有 handleCommandListDir (已含 existsSync / readdirSync 完整逻辑 + cwd 优先级 fallback)
   * 共享给: executeCardAction case 'listdir' (按钮路径, sendMessage 推送)
   * @param userId 企微 external_userid (推送目标)
   */
  private async renderListDir(userId: string): Promise<void> {
    const data = await this.handleCommandListDir(userId);
    await this.client.sdk.sendMessage(userId, {
      msgtype: 'markdown',
      markdown: { content: data.markdown },
    });
  }

  private async handleCommandListDir(userId: string): Promise<DirListData> {
    try {
      const internal = await this._handleCommandListDirInternal(userId);
      return { ...internal, markdown: this._renderDirListMarkdown(internal) };
    } catch (err: any) {
      // PR 7.5.2 Task 2.0: 保留原 error markdown (跟 PR 6.13 原版一字不差)
      // 原版: cwd 不存在 → "❌ 目录不存在: ${cwd}\n\n使用 `/new <路径>` 切换到有效目录"
      // 其它读目录失败 → "❌ 无法读取目录: ${err.message}"
      const errMsg = err?.message?.startsWith('目录不存在')
        ? `❌ ${err.message}\n\n使用 \`/new <路径>\` 切换到有效目录`
        : `❌ 无法读取目录: ${err.message ?? String(err)}`;
      return {
        markdown: errMsg,
        cwd: '(unknown)',
        parent: null,
        dirs: [],
        hasMore: false,
      };
    }
  }

  /**
   * PR 7.5.2 Task 2.0: 读 cwd 子目录返回结构 (无 markdown 渲染, 无 sendMessage).
   * Task 2.2 用 .dirs/.parent/.hasMore 喂 buildDirListCard.
   */
  private async _handleCommandListDirInternal(userId: string): Promise<Omit<DirListData, 'markdown'>> {
    const { readdirSync, existsSync } = await import('fs');
    const { dirname } = await import('path');

    // PR 6.15 + PR 6.16: cwd 优先级 — user-mapping entry.cwd → 平台 config → 通用 config → /tmp fallback
    // 历史:
    //   PR 6.13: 只读 user-mapping entry.cwd, 缺则 /tmp fallback → 用户反馈
    //   PR 6.15: 加 wecom.default_cwd 平台配置 (仿飞书 feishu_bot.default_cwd)
    //   PR 6.16: 用户提意"飞书微信不必各配一遍" → 加通用 [general] default_cwd 公共 fallback
    const entry = this.userManager.getEntry(userId);
    const cwd = entry?.cwd
      ?? config.get<string>('wecom.default_cwd', '')
      ?? config.get<string>('general.default_cwd', '')
      ?? '/tmp';

    if (!existsSync(cwd)) {
      // 抛带"目录不存在"前缀的错, 外层 catch 把它转成原版 markdown
      throw new Error(`目录不存在: ${cwd}`);
    }

    // 读子目录 (排除隐藏目录, 按字母排序, 限 20 条避免 markdown 过长)
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .slice(0, 20);

    const totalDirs = entries.length;
    const hasMore = totalDirs > 20;

    // parent 上级目录 (根目录无 parent)
    const parent = cwd !== dirname(cwd) ? dirname(cwd) : null;
    const dirs = entries.map(name => ({ name, fullPath: `${cwd}/${name}`.replace('//', '/') }));

    return { cwd, parent, dirs, hasMore };
  }

  /**
   * PR 7.5.2 Task 2.0: 渲染 /listdir markdown 字符串 (与原 handleCommandListDir 输出完全一致)
   */
  private _renderDirListMarkdown(internal: Omit<DirListData, 'markdown'>): string {
    const lines = [`📂 **目录浏览**: \`${internal.cwd}\``, ''];
    if (internal.parent) lines.push(`⬆️ 上级目录: \`${internal.parent}\``);
    if (internal.dirs.length === 0) {
      lines.push('📁 当前目录下没有子目录');
    } else {
      for (const dir of internal.dirs) {
        lines.push(`📁 ${dir.name}`);
      }
    }
    if (internal.hasMore) lines.push(`\n_... 还有更多子目录未显示_`);
    lines.push('\n💡 使用 `/new <路径>` 切换到指定目录');
    return lines.join('\n');
  }

  private async handleChat(msg: SpoolMessage): Promise<void> {
    logger.info(`[wecom-bot] handleChat: userId=${msg.userId}, text=${msg.text.slice(0, 50)}`);

    // PR 5.1 followup: C-1+C-2 owner 验证已上移到 handleClaimed 统一入口
    // (PR 5 原修复在 handleChat 入口, 但漏掉 handleCommand 路径; 现统一在 handleClaimed 处理)

    // PR 6 Task 6.1: 图片消息处理（复用现有 images 数组, 不新加 image 单数字段）
    // - 复用 platform 层 PlatformMessage.images 数组字段 (spec §10.1 第 1 项约束)
    // - handleMessage 已透传 msg.images 到 metadata.images (沿用 metadata 扩展点, 不加 SpoolMessage 字段)
    // - imageHandler 未注入时跳过 (向后兼容旧测试 / staging)
    // - 失败容错: 单张图下载失败 → 改写 text 为 [图片下载失败], 不阻塞后续图片 / Claude 调用
    const images = msg.metadata?.images as Array<{ fileKey: string; url?: string }> | undefined;
    if (images && images.length > 0 && this.imageHandler) {
      for (const img of images) {
        if (!img.url) continue;
        try {
          const base64 = await this.imageHandler.fetchAsBase64(img.url);
          this.imageHandler.cacheToDisk(msg.messageId, base64);
          msg.text = `[图片: fileKey=${img.fileKey}, base64=${base64.slice(0, 50)}...]\n${msg.text}`;
        } catch (err) {
          logger.error(`[wecom-bot] handleChat image download failed: ${err instanceof Error ? err.message : String(err)}`);
          msg.text = `[图片下载失败: ${img.fileKey}] ${msg.text}`;
        }
      }
    }

    // PR 4.1: PoC fallback — sessionManager 未注入时走 sendMessage echo 路径
    // 用于 staging / 单测 (确保向后兼容未升级的 wecom-only 启动)
    // PR 6.8.1: receiveId 按 chatType 路由 (group→chatId, p2p/single→userId)
    if (!this.sessionManager) {
      logger.warn(`[wecom-bot] handleChat: sessionManager 未注入, 走 PoC echo 路径 (messageId=${msg.messageId})`);
      try {
        const responseText = `✅ 收到! 你是 WuYuJun, 我已收到你的消息: "${msg.text}"\n\n_(PR 2 E2E staging, sessionManager 未注入)_`;
        const receiveId = resolveReceiveId(msg);
        await this.client.sdk.sendMessage(receiveId, {
          msgtype: 'markdown',
          markdown: { content: responseText },
        });
        this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      } catch (err) {
        logger.error(`[wecom-bot] handleChat (PoC) error: ${err instanceof Error ? err.message : String(err)}`);
        try {
          this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
        } catch (requeueErr) { /* ignore */ }
      }
      return;
    }

    // PR 4.1: 真接 Claude 流式 (仿飞书侧 createSessionFromPromptStreaming 模板)
    // @see src/feishu/bot.ts:2600-2700
    const inboundFrame = msg.metadata?.inboundFrame as any;
    if (!inboundFrame) {
      logger.error(`[wecom-bot] handleChat: missing inboundFrame in metadata, cannot stream (messageId=${msg.messageId})`);
      try {
        this.spoolQueue.requeueFromProcessing(msg.messageId, msg.serialKey);
      } catch (requeueErr) { /* ignore */ }
      return;
    }

    const startTime = Date.now();
    let thinking = '';
    let text = '';
    // PR 6.21: toolUses 累加器 (appendChunk 返回新对象, caller re-assign 闭包变量)
    let toolUses: Array<{ name: string; inputSummary: string }> = [];

    try {
      // 1. 启动 replyStream 流（必传 inboundFrame — M-7 修复后 fail-fast）
      await this.updater.startProcessing(msg.userId, inboundFrame);

      // 2. PR 4.5 B: 接续聊 — 查 user-mapping 拿现有 sessionUuid + cwd
      // 历史: PR 4.1 简化总是 sessionId=null 新建, 用户续聊失效 (claude 永远开新 session)
      // 修法: 读 WecomUserManager.getEntry → 有 session 走 resume (sessionId 传 existing-uuid);
      //        没 session 走新建 (sessionId=null + cwd fallback /tmp)
      // 防御: sessionUuid 为空串/falsy 视同"无 session", 走新建 (避免 claude -p --resume '' 出错)
      //
      // B1 修复: /new 命令 (handleCommandNew) 调 setPending 创建 pending_new_session
      //   状态，handleChat 这里也检查 pending 状态 — 用 pending.cwd 强制走 new 路径。
      //   修前: pending 状态被忽略, setSession 立即覆盖 → /new 实际是 no-op
      //   修后: pending 状态被识别, 用 pending.cwd 走 new + 保留 pending 信息
      const existingEntry = this.userManager.getEntry(msg.userId);
      const isPending = existingEntry?.type === 'pending_new_session';
      const existingSessionUuid = existingEntry?.type === 'session' && existingEntry.sessionUuid
        ? existingEntry.sessionUuid
        : null;
      // B1: pending 状态强制 new; 有 session 续聊; 都没走 new
      const isNewSession = !existingSessionUuid || isPending;
      const sessionId: string | null = isNewSession ? null : existingSessionUuid;
      // B1: pending 状态用 pending 里的 cwd; 有 session 续聊用 existingCwd; 都没用 /tmp
      const cwd: string = isPending
        ? (existingEntry?.cwd ?? '/tmp')
        : isNewSession
          ? '/tmp'
          : (existingEntry?.cwd ?? '/tmp');
      const lockKey: string = isNewSession ? `new:${msg.userId}` : existingSessionUuid!;
      // PR 6.22: spawn 时记 entry.casToken, setSession 前 CAS 验证 (P1#5 真 CAS 修 TOCTOU)
      const spawnEntryCasToken = isPending ? (existingEntry?.casToken ?? null) : null;

      // 3. 调 ClaudeSessionManager 流式 — onProgress 累加 thinking/text/toolUses + throttle patch
      // PR 7 m-2 + PR 6.20 + PR 6.21: appendChunk 返回新 state 对象, caller 必须 re-assign
      //   (JS 字符串 immutable, 旧版 mutate 新对象属性但闭包变量不变)
      const result = await this.sessionManager.sendStreamingMessage(
        sessionId, msg.text, cwd,
        (chunk: StreamChunk) => {
          const next = appendChunk({ thinking, text, toolUses }, chunk);
          thinking = next.thinking;
          text = next.text;
          toolUses = next.toolUses;
          const elapsed = Date.now() - startTime;
          this.updater.updateStream(thinking, text, elapsed).catch(e =>
            logger.warn(`[wecom-bot] updateStream failed: ${e instanceof Error ? e.message : String(e)}`)
          );
        },
        isNewSession, lockKey,
      );

      // 4. 终态: sessionId 缺失 → error, 成功 → complete
      if (!result.sessionId) {
        await this.updater.error(result.error ?? 'Claude 未返回 session_id');
        this.spoolQueue.markDone(msg.messageId, msg.serialKey);
        return;
      }

      // 5. PR 4.5 B: 持久化 session 映射
      // - 新建场景: 调 setSession 直接 set (跳过 claim 流程, 企微侧简化)
      // - 续聊场景: session 没变, 调 touchSession 刷 lastActiveAt
      //
      // PR 6.21 P1#5 + PR 6.22 真 CAS 修 TOCTOU:
      // 历史: 旧版用 cwd 比较 (PR 6.21 P1#5), 但 getEntry 和 setSession 之间有时间窗,
      //   多次 /new cwd 相同时假阳性. 修法: spawn 时记 entry.casToken, setSession 前
      //   验证 casToken 没变 (真 CAS). 失败跳过 setSession — 让用户后续消息走最新 mapping.
      if (isNewSession) {
        if (isPending && spawnEntryCasToken) {
          // CAS: 验证 spawn 时的 casToken 跟当前一致 (没被并发 /new 改写)
          const ok = await this.userManager.trySetSession(msg.userId, spawnEntryCasToken, result.sessionId, cwd);
          if (ok) {
            logger.info(`[wecom-bot] handleChat: 新建 session 已持久化 (pending CAS 成功) userId=${msg.userId} sessionUuid=${result.sessionId}`);
          } else {
            logger.warn(`[wecom-bot] handleChat: pending CAS 失败 (casToken 变化, 用户并发 /new), 跳过 setSession. userId=${msg.userId}`);
          }
        } else {
          // 非 pending 场景 (例如用户发了消息但没 /new, 走 fallback /tmp new path)
          await this.userManager.setSession(msg.userId, result.sessionId, cwd);
          logger.info(`[wecom-bot] handleChat: 新建 session 已持久化 (fallback /tmp) userId=${msg.userId} sessionUuid=${result.sessionId}`);
        }
      } else {
        await this.userManager.touchSession(msg.userId);
      }

      // PR 6.8.5: 防御性 fallback — text 累加器只收到 thinking 没 text chunk 时
      //   (e.g. Claude 只输出 thinking 没 text, 或 SDK 不 emit partial text),
      //   complete 传 0 长字符串导致 replyStream 显示空白方框 (15:09:50 真实验收).
      // 仿飞书侧 feishu/bot.ts:2441-2443 同款模式: text || result.response || '(空回复)'
      // PR 6.13: 同步 finalText 变量到前面赋值声明, 因为 let → const 后续不能修改
      const finalText = text || result.response || '(空回复)';
      logger.info(`[wecom-bot] handleChat finalize: textLen=${text.length} thinkingLen=${thinking.length} responseLen=${result.response?.length ?? 0} finalTextLen=${finalText.length}`);

      // PR 6.8.3: 兜底 sendMessage 通道 — replyStream 静默失败时用户至少能看到错误
      // 之前 8s 真实企微 E2E: 卡片始终空白, replyStream 调了但 WSS 没真发送
      // 现在 replyStream throw → 调 sendMessage 走 markdown 错误, 路由用 resolveReceiveId (PR 6.8.1)
      const receiveIdForFallback = resolveReceiveId(msg);
      // PR 6.13: 传 thinking + 累计 toolUses 给 complete → 仿飞书 buildCompleteCard 结构
      // 历史: PR 6.12 renderMarkdown 加 "思考过程：" 标签, 但 updateStream 中间 patch 不保证触发
      //   (Claude 跑 < throttle 时不 patch), complete 只推 finalText 不含 thinking, 用户看不到思考过程.
      // 修法: handleChat 持 state.thinking/text, complete 时把它 + thinking 一起传, 渲染完整 markdown.
      await this.updater.complete(
        finalText, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1,
        async (markdown: string) => {
          await this.client.sdk.sendMessage(receiveIdForFallback, {
            msgtype: 'markdown',
            markdown: { content: markdown },
          });
        },
        // PR 6.21: thinking + toolUses 都传给 complete, renderMarkdown 显示完整 "当前操作：" 段
        thinking, toolUses,
        // PR 7.3 + PR 7 final cleanup: 完成卡片 ctx
        //   - sessionTitle 暂不传 (handleChat 拿不到, 主标题不显示 session 名, 未来扩展)
        //   - chatId: 群聊场景必须传, 群用户才能收到完成卡片 (单聊 chatId === userId 无影响)
        //   - 复用 receiveIdForFallback (resolveReceiveId): 已经按 chatType 路由 group→chatId, p2p→userId
        {
          sessionUuid: result.sessionId,  // ClaudeSessionManager 返回值里有 sessionId 字段
          cwd: cwd,
          chatId: receiveIdForFallback,
        },
      );
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
    } catch (err) {
      // PR 6.21 P0#2: 错误路径 markDone, 不 requeue
      // 历史: 旧版 catch 调 requeueFromProcessing, 但错误已经是终态 (updater.error 已推送),
      //   requeue 触发新一轮 handleClaimed + spawn Claude (同 serialKey 锁冲突), 导致消息
      //   卡 processing 死循环 + 用户看到重复 '思考中...' 卡片。
      // 修法: 错误已是终态, markDone 收尾。updater.error 失败 swallow (不可控)。
      logger.error(`[wecom-bot] handleChat Claude flow error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        await this.updater.error(err instanceof Error ? err.message : String(err));
      } catch (e2) {
        logger.warn(`[wecom-bot] updater.error failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
      // 兜底: 如果 markDone 失败 (消息已不在 processing), 不要再 requeue (避免死循环)
      try {
        this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      } catch (markDoneErr) {
        logger.warn(`[wecom-bot] markDone in catch failed: ${markDoneErr instanceof Error ? markDoneErr.message : String(markDoneErr)}`);
      }
    }
  }

  /**
   * 把入站消息归一化 + 派生 serialKey + 入 SpoolQueue
   * 参考 feishu/bot.ts:325-345 (enqueue 模式)
   *
   * **PR 2 v1.2.1 (M2 修复)**: target.type 根据 WecomUserManager.getEntry(userId).sessionUuid
   * 动态选 existing_session vs new_session_claim，避免续聊消息被强制走新会话路径
   *
   * **SpoolMessage 字段策略（PR 1 v1.2 兼容）**：
   * - openId / text: 写空串（企微侧永远不读这两个字段，但保留必填约束以兼容 ~70 个飞书调用方 grep msg.openId/spoolMsg.openId）
   * - userId / platform: 写 wecom 真值（spec §3.3 兼容策略）
   */
  private async handleMessage(msg: PlatformMessage & { inboundFrame?: any }): Promise<void> {
    logger.info(`[wecom-bot] handleMessage entered: userId=${msg.userId}, text=${msg.text.slice(0, 50)}`);
    const isCommand = isCommandMessage(msg.text);

    // 查 user-mapping 看是否有活跃 session
    const existingEntry = this.userManager.getEntry(msg.userId);
    const existingSessionUuid = existingEntry?.type === 'session' ? existingEntry.sessionUuid : null;

    // PR 2 v1.2.1 final (F10 修复): serialKey 决策表 — 重构掉嵌套三元
    const serialKey = this.deriveSerialKey(msg, isCommand, existingSessionUuid);
    const target: TargetSnapshot = existingSessionUuid
      ? { type: 'session', sessionUuid: existingSessionUuid, cwd: existingEntry?.cwd }
      : { type: 'new_session_claim', sessionUuid: undefined, cwd: undefined };

    const spoolMsg: SpoolMessage = {
      messageId: msg.messageId,
      // PR 2 v1.2.1: openId 保留为飞书必填 alias (string 类型不能改 nullable)
      // 企微侧写空串，飞书侧 reader 应先判 msg.platform === 'wecom' 走 msg.userId 路径
      // 而不是误用 openId=''（参见 feishu/bot.ts 大量 msg.openId 使用）
      openId: '',
      text: msg.text,
      // userId/platform: 平台无关真值（spec §3.3）
      userId: msg.userId,
      platform: 'wecom',
      target,
      serialKey,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // PR 2 v1.2.1 修复: inboundFrame 存到 metadata 而不是 responseText
      // 避免语义破坏（responseText 在飞书侧是 AI 回复）+ 敏感信息（response_url）落地到 SpoolQueue
      metadata: (() => {
        // PR 5.1 followup: M-1 production fix — handleMessage 写 chatId/chatType 到 metadata
        // 历史: commit 33968ae M-1 修复 handleCommand 用 metadata.chatId, 但 handleMessage 从不写 chatId,
        //   → 群聊 sendMessage 永远 fallback userId, 私聊回复给发送者而非发到群 (production no-op)
        // 修法: handleMessage enqueue 时把 chatId + chatType 写到 metadata
        const m: Record<string, any> = { chatId: msg.chatId, chatType: msg.chatType };
        if (msg.inboundFrame) m.inboundFrame = msg.inboundFrame;
        // PR 6 Task 6.1: 把 PlatformMessage.images 透传到 metadata.images
        // 不在 SpoolMessage 加新字段 (保持 wecom 模块边界), 复用现有 metadata 扩展点
        if (msg.images && msg.images.length > 0) m.images = msg.images;
        return m;
      })(),
    };

    logger.info(`[wecom-bot] enqueue attempt: serialKey=${serialKey}`);
    const enqueued = await this.spoolQueue.enqueue(spoolMsg);
    logger.info(`[wecom-bot] enqueue result: ${enqueued} for messageId=${msg.messageId}`);
    if (!enqueued) {
      logger.warn(`[wecom-bot] enqueue failed: ${msg.messageId}`);
    }

    if (isCommand) {
      const parsed = parseCommand(msg.text);
      logger.debug(`[wecom-bot] command parsed: ${JSON.stringify(parsed)}`);
      // 命令执行由 PR 3 集成到 handleClaimed 时实现
    }
  }

  /**
   * PR 2 v1.2.1 final (F10 修复): serialKey 决策表
   * 4 种 case：
   * 1. 有 session + 命令 → session serialKey（命令附在 session 上）
   * 2. 有 session + 聊天 → session serialKey（续聊）
   * 3. 无 session + 命令 → cmd: serialKey
   * 4. 无 session + 聊天 → new: serialKey
   */
  private deriveSerialKey(msg: PlatformMessage, isCommand: boolean, existingSessionUuid: string | null): string {
    if (existingSessionUuid) {
      // 有 session: 无论命令/聊天都走 session serialKey
      return `${existingSessionUuid}:${msg.messageId}`;
    }
    if (isCommand) {
      return `cmd:${msg.userId}:${msg.messageId}`;
    }
    return `new:${msg.userId}`;
  }

  /**
   * 卡片按钮回调: 5s 占位 + 异步处理
   * 参考 spec §5.4 + sdk replyWelcome 5s 窗口约束
   */
  private async handleCardAction(event: {
    externalUserId: string;
    messageId: string;
    actionTag: string;
    actionValue: any;
    inboundFrame?: any;  // SDK callback 事件，含 headers.req_id
  }): Promise<void> {
    logger.info(`[wecom-bot] card action: userId=${event.externalUserId}, actionTag=${event.actionTag}`);

    // 1. 5s 内 replyWelcome 发占位卡片
    // PR 6.22 修复 #3: 删 placeholderCard 死代码 (PR 6.11 改用 text msgtype 后未使用)
    let replyWelcomeOk = false;
    try {
      // PR 2 v1.2.1 final (F7 修复): 拒绝 fallback 到 messageId（那是发给用户的原消息 ID，
      // 不是 SDK 内部流标识 — fallback 复现 846605 "invalid req_id" 根因）
      const reqId = event.inboundFrame?.headers?.req_id;
      if (!reqId) {
        logger.error(`[wecom-bot] handleCardAction: missing inboundFrame.headers.req_id, cannot replyWelcome`);
        // P1#3: 继续走 setImmediate (executeCardAction 不依赖 replyWelcome),
        //   但用户看不到占位, 需要 fallback 通知
      } else {
        // replyWelcome 类型只支持 text/template_card. text 最稳.
        await this.client.sdk.replyWelcome(
          { headers: { req_id: reqId } } as any,
          { msgtype: 'text', text: { content: `⏳ 处理中... (执行 ${event.actionTag})` } },
        );
        replyWelcomeOk = true;
      }
    } catch (err) {
      // P1#3: replyWelcome 失败 (5s 窗口已过, 企微 SDK errcode 42045, etc.) 不静默
      //   直接 return — 用户看不到反馈。改成: 异步 sendMessage 告诉用户操作触发
      //   (executeCardAction 还会执行, 但用户先看到提示)
      logger.warn(`[wecom-bot] replyWelcome failed (5s window may have passed or template_card unsupported): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!replyWelcomeOk) {
      // P1#3: replyWelcome 失败 → 异步 sendMessage 通知用户 (5s 后, 用户已离开键盘)
      //   executeCardAction 同步执行, 用户可能没看到提示, 但比静默失败好
      setImmediate(async () => {
        try {
          await this.client.sdk.sendMessage(event.externalUserId, {
            msgtype: 'markdown',
            markdown: { content: `⏳ 处理中... (执行 ${event.actionTag})` },
          });
        } catch (sendErr) {
          logger.warn(`[wecom-bot] replyWelcome fallback sendMessage failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
        }
      });
    }

    // 2. 异步执行实际动作
    setImmediate(() => {
      this.executeCardAction(event).catch(err => {
        logger.error(`[wecom-bot] executeCardAction failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  private async executeCardAction(event: {
    externalUserId: string;
    messageId: string;
    actionTag: string;
    actionValue: any;
    inboundFrame?: any;
  }): Promise<void> {
    switch (event.actionTag) {
      case 'continue': {
        // PR 7.3: 幂等保护 — 已有 session / pending 时不发新
        const current = this.userManager.getEntry(event.externalUserId);
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
        // PR 7.5.3 双语义:
        //   - 有 value.sessionUuid → 切到具体 session (用户从 /list 卡片点 🔄 切换)
        //   - 无 value → 列 active sessions (PR 7.3 ship 行为, 用户从完成卡点 📂 切换 session)
        const targetUuid = event.actionValue?.sessionUuid;
        if (targetUuid) {
          await this.handleCommandSwitch(event.externalUserId, [targetUuid]);
        } else {
          await this.renderActiveSessionsList(event.externalUserId);
        }
        break;
      }
      case 'listdir': {
        await this.renderListDir(event.externalUserId);
        break;
      }
      case 'select_dir': {
        // PR 7.5.2: /listdir 卡片按钮回调 — 路径存在则调 handleCommandNew(userId, [path])
        const path = event.actionValue?.sessionUuid;
        if (!path) {
          logger.warn(`[wecom-bot] select_dir: missing sessionUuid (path) in actionValue`);
          break;
        }
        // 路径校验 (handleCommandNew 没 existsSync 检查, case 内自己校验)
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
        // PR 7.5.2: /model 卡片按钮回调 — 实际写 user-mapping entry.defaultProvider
        const alias = event.actionValue?.sessionUuid;
        if (!alias) {
          logger.warn(`[wecom-bot] select_model: missing sessionUuid (alias) in actionValue`);
          break;
        }
        await this.handleCommandModel(event.externalUserId, [alias]);
        break;
      }
      case 'clear_model': {
        // PR 7.5.2: /model 卡片清除默认按钮 — 调 handleCommandModel(['--clear'])
        await this.handleCommandModel(event.externalUserId, ['--clear']);
        break;
      }
      case 'retry': {
        // PR 6.21 P1#4: 重试 — 旧版用错的 serialKey `retry:${user}` 调 requeueFromProcessing,
        //   但卡片回调本身不在 SpoolQueue 中 (来自 SDK onCardAction), messageId 通常已是
        //   done/failed 状态, requeue 不生效。用户点 retry 没效果。
        // 修法: 提示用户重新发送消息 (wecom 端卡片回调无法触发完整 handleClaimed 路径,
        //   因为 dispatch loop 处理 SpoolQueue, 不处理卡片回调).
        logger.info(`[wecom-bot] card action retry: user=${event.externalUserId}, msgId=${event.messageId}`);
        await this.client.sdk.sendMessage(event.externalUserId, {
          msgtype: 'markdown',
          markdown: { content: `🔁 **重试提示**: 请**重新发送您的消息**（当前会话重新触发 Claude 处理）\n\n💡 历史消息 ID \`${event.messageId}\` 已存档无法重试` },
        });
        break;
      }
      case 'stop': {
        // PR 6 Task 6.5: 触发 in-flight cancel
        // 注: 现有 stream-updater.cancel() 方法 (line 190-203) 含 prepareTerminal 防御性逻辑
        //   不重写, 直接接 case
        await this.updater.cancel('用户从卡片点击停止');
        break;
      }
      case 'confirm-stop': {
        // PR 6 Task 6.6: 硬杀 Claude 子进程
        // 历史: PR 5 stub 只 log + sendMessage 兜底, 实际不杀进程
        // 修法: 调 sessionManager.killSessionByUuid(sessionUuid)
        const sessionUuid = event.actionValue?.sessionUuid;
        if (!sessionUuid) {
          logger.warn(`[wecom-bot] confirm-stop: missing sessionUuid in actionValue`);
          break;
        }
        if (!this.sessionManager || typeof (this.sessionManager as any).killSessionByUuid !== 'function') {
          logger.warn(`[wecom-bot] confirm-stop: sessionManager or killSessionByUuid not available`);
          break;
        }
        const killed = await (this.sessionManager as any).killSessionByUuid(sessionUuid);
        await this.client.sdk.sendMessage(event.externalUserId, {
          msgtype: 'markdown',
          markdown: { content: killed
            ? `✅ 已硬杀 session: ${sessionUuid}`
            : `❌ 未找到 session: ${sessionUuid}` },
        });
        break;
      }
      case 'list-refresh': {
        // PR 7.3: 抽公共方法 renderActiveSessionsList, 跟 case 'switch' 共用
        await this.renderActiveSessionsList(event.externalUserId);
        break;
      }
      case 'agents-refresh': {
        // PR 7.5.3: 重新跑 /agents 命令响应 (从 buildAgentsRefreshCard 卡片右上角点 🔄 刷新)
        const agentsData = await this.handleCommandAgents(event.externalUserId, []);
        await this.client.sdk.sendMessage(event.externalUserId, {
          msgtype: 'markdown',
          markdown: { content: agentsData.markdown },
        });
        break;
      }
      default:
        logger.warn(`[wecom-bot] unknown card action: ${event.actionTag}`);
    }
  }

  /**
   * PR 4.1: 测试 seam — 暴露 handleChat 给单测直接调用。
   * 生产路径是 startDispatchLoop → handleClaimed → handleChat；
   * 单测里不想跑 2s tick + SpoolQueue 文件 IO 时直接调它。
   * @internal
   */
  public async __test_handleChat(msg: SpoolMessage): Promise<void> {
    return this.handleChat(msg);
  }

  /**
   * PR 5.1 followup: 测试 seam — 暴露 handleClaimed 给单测直接调用。
   * 测 owner 验证 (validateOwner 在 handleClaimed 入口, 不在 handleChat) 时用。
   * @internal
   */
  public async __test_handleClaimed(msg: SpoolMessage): Promise<void> {
    return this.handleClaimed(msg);
  }

  /**
   * PR 4.5 C: 测试 seam — 暴露 handleCommand 给单测直接调用。
   * @internal
   */
  public async __test_handleCommand(msg: SpoolMessage): Promise<void> {
    return this.handleCommand(msg);
  }

  /**
   * PR 6 Task 6.4: 测试 seam — 暴露 executeCardAction 给单测直接调用。
   * 生产路径是 onCardAction → setImmediate → executeCardAction；单测里不想
   * 跑 SDK 的 5s replyWelcome 窗口，直接调它。
   * @internal
   */
  public async __test_executeCardAction(event: {
    externalUserId: string;
    messageId: string;
    actionTag: string;
    actionValue: any;
    inboundFrame?: any;
  }): Promise<void> {
    return this.executeCardAction(event);
  }
}
