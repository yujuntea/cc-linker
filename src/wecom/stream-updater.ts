/**
 * 企微 StreamUpdater 实现
 * 用 SDK replyStream 流式消息协议 (同 stream.id 持续 patch)
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2
 * 接口形状对齐 src/feishu/card-updater.ts:120-186 (FeishuStreamUpdater 包 CardUpdater)
 */
import type { WSClient, WsFrame } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';
import type { StreamUpdater, StreamUpdateToolUse } from '../platform/stream-updater';
import type { WecomCompleteCardSender } from './complete-card';
import { logger } from '../utils/logger';

const STREAM_CONTENT_MAX_BYTES = 20480; // SDK 硬限制
const DEFAULT_THROTTLE_MS = 1500;  // PR 6.10: 跟飞书侧 CardUpdater throttle_ms=1500 对齐 (之前 2000 太慢, 流式增量慢 33%)
/**
 * PR 6.10: thinking 末尾显示字符数
 * 跟飞书侧 feishu/card-updater.ts:533 maxThinkingBytes=Math.min(2000, maxCardBytes) 对齐
 * 之前写死 500 字符截断, 用户看不到完整思考过程末尾
 */
const THINKING_TAIL_CHARS = 2000;

type BufferedChunk = {
  thinking: string;
  text: string;
  elapsedMs: number;
  toolUses: StreamUpdateToolUse[];
};

export type WecomStreamUpdaterOptions = {
  throttleMs?: number;
};

/**
 * 渲染 (thinking, text, toolUses) 到 markdown 字符串
 *
 * PR 6.12: 仿飞书 CardUpdater.buildStreamingCard (src/feishu/card-updater.ts:524-593) 结构
 * 飞书用 "思考过程:" / "当前操作:" / "回复:" 三段加粗标签 + markdown 渲染,
 * wecom 端 replyStream 推 markdown 字符串, 服务端渲染时需要结构化标签才能看到完整思考过程.
 *
 * 修法:
 * - 加 "**思考过程：**" 标签 (跟飞书一致)
 * - thinking 内容不用 `>` 引用 (企微 markdown 引擎可能不渲染), 改用 plain text + 截断
 * - text 加 "**回复：**" 标签 (跟飞书一致)
 * - toolUses 加 "**当前操作：**" 标签 (跟飞书一致)
 * - 末尾加 "⏱ 已用时 Xs" (跟飞书一致)
 *
 * 历史: PR 6.10 加 THINKING_TAIL_CHARS=2000 跟飞书 maxThinkingBytes 对齐,
 *   但 markdown 结构跟飞书不一致 → 用户截图反馈 "没有思考过程展示"
 */
function renderMarkdown(thinking: string, text: string, toolUses: StreamUpdateToolUse[], elapsedMs: number): string {
  const lines: string[] = [];

  // PR 6.12: 仿飞书 buildStreamingCard 结构
  if (thinking) {
    // PR 6.12: 不用 `>` 引用 (企微 markdown 引擎可能不渲染引用块), 用 plain text
    // 截断到 THINKING_TAIL_CHARS 跟飞书 maxThinkingBytes 对齐
    lines.push(`**思考过程：**\n${thinking.slice(-THINKING_TAIL_CHARS)}`);
  }
  if (toolUses.length > 0) {
    lines.push(`**当前操作：**`);
    for (const t of toolUses) lines.push(`- \`${t.name}\`: ${t.inputSummary}`);
  }
  if (text) {
    lines.push(`**回复：**\n${text}`);
  } else if (!thinking && !toolUses.length) {
    // PR 6.18: thinking 空时占位提示 (MiniMax-M3 适配 Claude SDK 不全, emit 空 thinking)
    // 17:25 GLM session 真实验收: thinkingLen=0 但有 response → 用户以为 SDK bug
    // 修法: 显示占位 '本次回复较快, 未输出思考过程' 让用户知道是模型行为
    lines.push(`**回复：**\n${text || '_本次回复较快, 模型未输出思考过程_'}`);
  }
  // 末尾加 "⏱ 已用时 Xs" 跟飞书一致 (飞书: ⏱ 已用时 ${elapsedSec}s)
  const elapsedSec = Math.floor(elapsedMs / 1000);
  lines.push(`⏱ 已用时 ${elapsedSec}s`);
  return lines.join('\n\n');
}

export class WecomStreamUpdater implements StreamUpdater {
  /**
   * PR 7 m-3: 限频窗口常量 (毫秒). 跟 DEFAULT_THROTTLE_MS 保持同值 (2000),
   * 对外暴露为 class constant, 允许测试和上层代码引用而不依赖魔法数。
   */
  static readonly THROTTLE_MS = 1500;  // PR 6.10: 跟飞书侧对齐, 提升流式增量刷新频率
  private sdk: WSClient;
  private throttleMs: number;
  private currentStreamId: string | null = null;
  /**
   * PR 2 v1.2.1 final (F2 修复) + M-7 final review: 单一 lastInboundFrame 字段
   * complete/error/cancel/flushBuffer 都用它，不再 fallback 到 currentStreamId
   * 避免 846605 "invalid req_id" bug 复现
   *
   * 历史: M-7 删了 setInboundFrame / inboundFrame alias（field 多了容易混用），
   * 强制调用方传 startProcessing(userId, inboundFrame)
   *
   * PR 7 Task 7.4 (M-6): 单 user 设计 (有意为之, spec §5.6 "企微 userId 不区分 p2p/group")
   * 企微单 user 同时只能有 1 个 in-flight 流；与飞书 CardUpdater 不同 (飞书支持 p2p + group 多流)。
   * 因此 lastInboundFrame / currentStreamId 是单字段, 不按 userId key。
   * 若未来需多 user 并发, 改为 Map<userId, {streamId, frame}> 并同步 startProcessing/complete/error/cancel。
   */
  private lastInboundFrame: any = null;
  /**
   * PR 7.2 + PR 7.3 + PR 7 final cleanup: 流式上下文, complete() 末尾用作完成卡片 ctx
   * - lastUserId: startProcessing 时记录 (complete() 末尾唯一需要的 ctx 字段)
   * - sessionTitle/UUID/cwd: 不再由 stream-updater 持有 — 由 caller 通过 completeCtx 完整传
   *   (历史: PR 7.3 fix #1 删了 setLastSessionMeta 写入路径, 字段永远 undefined → 删掉)
   */
  private lastUserId: string | null = null;
  private buffer: BufferedChunk | null = null;
  private lastFlushAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * PR 6.8.4: msgFallback 类字段 + setMsgFallback, 让 startProcessing/flushBuffer 也能 fallback
   *
   * 历史: PR 6.8.3 只在 complete() 加 msgFallback 参数 (per-call), 但 replyStream 静默成功
   *   bug 同样会发生在 startProcessing (errcode=93006 invalid chatid) — Promise resolve 无 throw
   * 修法: 类字段 msgFallback + setMsgFallback 注入, 终态方法 (startProcessing/flushBuffer/complete) 统一 fallback
   *
   * 注: 仍然保留 complete() 的 msgFallback 参数 (per-call, 优先级高于类字段)
   */
  private msgFallback?: (text: string) => Promise<void>;

  /**
   * PR 6.8.4: 设置全局 msgFallback (用于 startProcessing / flushBuffer 错误兜底)
   * 调用方: WecomBot 在创建 updater 后立即 setMsgFallback, 后续 startProcessing/flushBuffer 错误自动转 sendMessage
   */
  setMsgFallback(fn: (text: string) => Promise<void>): void {
    this.msgFallback = fn;
  }

  /**
   * PR 7.2: 注入完成卡片 sender (跟现有 setMsgFallback 同模式)
   * 调用方: WecomBot 构造后立即调一次 (stateless, 多次 complete 复用)
   */
  private completeCardSender?: WecomCompleteCardSender;

  setCompleteCardSender(sender: WecomCompleteCardSender): void {
    this.completeCardSender = sender;
  }

  /**
   * PR 6.8.4: 检查 WsFrame errcode (aibot SDK 错误通过 ws frame body 推回, 不 throw)
   * 14:50:09 真实验收: replyStream Promise resolve, 但 body.errcode=93006 invalid chatid
   *   → catch 跳过 → 卡片空白
   * 修法: replyStream 后检查 errcode, 错误 throw 触发 fallback
   */
  private checkWsFrameErrcode(wsFrame: any, op: string): void {
    const errcode = wsFrame?.body?.errcode ?? wsFrame?.errcode;
    if (errcode && errcode !== 0) {
      const errmsg = wsFrame?.body?.errmsg ?? wsFrame?.errmsg ?? 'unknown';
      throw new Error(`[wecom-stream] ${op} replyStream errcode=${errcode} errmsg=${errmsg}`);
    }
  }

  constructor(sdk: WSClient, opts: WecomStreamUpdaterOptions = {}) {
    this.sdk = sdk;
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  }

  async startProcessing(userId: string, inboundFrame?: any): Promise<string> {
    this.currentStreamId = generateReqId('stream');
    if (!inboundFrame) {
      throw new Error('WecomStreamUpdater.startProcessing: inboundFrame is required (SDK replyStream 需要 inbound frame 的 headers.req_id)');
    }
    // 存下 inboundFrame 供 complete/error/cancel/flushBuffer 复用
    this.lastInboundFrame = inboundFrame;
    // PR 7.2: 记录 userId, complete() 末尾用作完成卡片 ctx
    this.lastUserId = userId;
    const initialMarkdown = '🤔 思考中...';
    try {
      const wsFrame = await this.sdk.replyStream(inboundFrame, this.currentStreamId, this.truncate(initialMarkdown), false) as any;
      // PR 6.8.4: 检查 WsFrame errcode (静默成功但实际错误)
      this.checkWsFrameErrcode(wsFrame, 'startProcessing');
      logger.info(`[wecom-stream] startProcessing OK: streamId=${this.currentStreamId.slice(0, 8)}... userId=${userId}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[wecom-stream] startProcessing replyStream failed: ${errMsg}`);
      // 兜底: sendMessage 通道告诉用户流式启动失败
      if (this.msgFallback) {
        try {
          await this.msgFallback(`❌ 流式启动失败: ${errMsg}`);
        } catch (fbErr) {
          logger.error(`[wecom-stream] startProcessing fallback also failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
        }
      }
      throw err;
    }
    this.lastFlushAt = Date.now();
    this.buffer = null;
    return this.currentStreamId;
  }

  async updateStream(
    thinking: string,
    text: string,
    elapsedMs: number,
    toolUses: StreamUpdateToolUse[] = [],
  ): Promise<void> {
    this.buffer = { thinking, text, elapsedMs, toolUses };

    const now = Date.now();
    const elapsed = now - this.lastFlushAt;
    if (elapsed >= this.throttleMs) {
      await this.flushBuffer();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushBuffer().catch(err => {
          logger.error(`[wecom-stream] flush failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, this.throttleMs - elapsed);
    }
  }

  private async flushBuffer(): Promise<void> {
    if (!this.buffer || !this.currentStreamId) return;
    if (!this.lastInboundFrame) return;  // 没 inboundFrame 就别 flush（避免 846605）
    const { thinking, text, elapsedMs, toolUses } = this.buffer;
    const markdown = renderMarkdown(thinking, text, toolUses, elapsedMs);
    try {
      const wsFrame = await this.sdk.replyStream(this.lastInboundFrame, this.currentStreamId, this.truncate(markdown), false) as any;
      // PR 6.8.4: 检查 WsFrame errcode (静默成功但实际错误)
      this.checkWsFrameErrcode(wsFrame, 'flushBuffer');
      this.lastFlushAt = Date.now();
    } catch (err) {
      // ⚠️ 只吞限频错误 (errcode 45009/45033)，保留 buffer 等下次 flush。
      // 其他错误（网络/SDK crash）必须 rethrow，由 bot 层处理——吞掉会丢回复。
      const errcode = (err as any)?.errcode ?? (err as any)?.code;
      if (errcode === 45009 || errcode === 45033) {
        logger.warn('[wecom-stream] flush rate-limited, buffer retained');
        return; // 保留 buffer，不走到下面的 "this.buffer = null"
      }
      logger.error(`[wecom-stream] flushBuffer replyStream failed: ${err instanceof Error ? err.message : String(err)}`);
      // PR 6.8.4: 兜底 sendMessage 通道 (用类字段 msgFallback)
      if (this.msgFallback) {
        try {
          await this.msgFallback(`❌ 流式推送失败: ${err instanceof Error ? err.message : String(err)}`);
        } catch (fbErr) {
          logger.error(`[wecom-stream] flushBuffer fallback also failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
        }
      }
      throw err;
    }
    this.buffer = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * 终态方法通用前置处理：
   * 1. Guard: currentStreamId 为空说明未 start 或已终态，直接 return（幂等）
   * 2. 清 flushTimer：避免 timer fire 把终态消息再覆盖回上一帧（CardUpdater.cancelPending 同坑）
   */
  private async prepareTerminal(): Promise<boolean> {
    if (!this.currentStreamId) return false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer) {
      try { await this.flushBuffer(); } catch { /* ignore */ }
    }
    return true;
  }

  /**
   * 终态方法统一前置 — 验证 lastInboundFrame 必须存在
   * PR 2 v1.2.1 final (F2): 拒绝 fallback 到 generated streamId（846605 根因）
   *
   * PR 2 v1.2.1 final (M-3): complete/error/cancel 抛错被 try/catch 吞掉
   * 历史 bug: replyStream 抛错（典型场景：user 中途发新消息导致 server-side 流
   *   标识滚动，req_id 失效）会冒泡到 dispatch 循环，只 log 不重试，用户看不到反馈。
   * 修法: 终态方法 try/catch + 仅 log。SDK 服务端行为不可控，吞错降级优于崩溃。
   */
  private getTerminalFrame(): { streamId: string; frame: any } | null {
    if (!this.currentStreamId || !this.lastInboundFrame) return null;
    return { streamId: this.currentStreamId, frame: this.lastInboundFrame };
  }

  async complete(
    response: string,
    _tokensIn: number,
    _tokensOut: number,
    _durationMs: number,
    _numTurns: number,
    // PR 6.8.3: 终态 replyStream 失败时兜底 (sendMessage markdown)。
    // 之前 8s 流式静默失败时, 卡片停留在空白 thinking, 用户看不到错误。
    // 现在 replyStream throw → 调 fallback 走 sendMessage 错误消息。
    // PR 6.8.4: per-call 参数 + 类字段 msgFallback 同时支持, per-call 优先
    msgFallback?: (text: string) => Promise<void>,
    // PR 6.13: complete 接 thinking + toolUses 渲染完整结构 (PR 6.12 教训)
    // 历史: updateStream 中间 patch 不保证触发 (Claude 跑 < 1500ms throttle 时),
    //   complete 只推 finalText, thinking 不渲染 → 用户看不到思考过程
    // 修法: handleChat 传 thinking + toolUses, complete 渲染
    //   '**思考过程：**\n{thinking}\n\n**当前操作：**\n...\n\n**回复：**\n{response}'
    thinking?: string,
    toolUses?: StreamUpdateToolUse[],
    // PR 7.2: 上下文传给完成卡片 (sessionTitle/UUID/cwd + PR 7 final chatId for group chat)
    completeCtx?: { sessionTitle?: string; sessionUuid?: string; cwd?: string; chatId?: string },
  ): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const t = this.getTerminalFrame();
    if (!t) {
      logger.warn('[wecom-stream] complete skipped: missing inboundFrame (startProcessing never called with frame)');
      return;
    }
    // PR 6.8.4: per-call 优先, 否则用类字段
    const fb = msgFallback ?? this.msgFallback;
    // PR 6.13: 渲染完整结构 (仿飞书 buildStreamingCard + buildCompleteCard)
    const finalMarkdown = thinking || toolUses
      ? renderMarkdown(thinking ?? '', response, toolUses ?? [], _durationMs)
      : response;
    try {
      const wsFrame = await this.sdk.replyStream(t.frame, t.streamId, this.truncate(finalMarkdown), true) as any;
      // PR 6.8.4: 检查 WsFrame errcode (14:50:09 真实验收: 静默成功 errcode=93006 invalid chatid)
      this.checkWsFrameErrcode(wsFrame, 'complete');
      logger.info(`[wecom-stream] complete OK: streamId=${t.streamId.slice(0, 8)}... contentLen=${finalMarkdown.length}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[wecom-stream] complete replyStream failed: ${errMsg}`);
      // 兜底: 走 sendMessage 通道, 用户至少能看到错误 (不是空白卡片)
      if (fb) {
        try {
          await fb(`❌ 流式回复失败: ${errMsg}`);
          logger.info(`[wecom-stream] complete fallback sendMessage succeeded`);
        } catch (fbErr) {
          logger.error(`[wecom-stream] complete fallback sendMessage also failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`);
        }
      }
    }
    // PR 7.2: 流式关闭后, 主动 sendMessage 完成卡片
    // 防御: sendMessage 失败不能影响已发流式 (用户已看到 finalMarkdown)
    if (this.completeCardSender && this.lastUserId) {
      try {
        await this.completeCardSender.send({
          userId: this.lastUserId,
          sessionTitle: completeCtx?.sessionTitle,
          sessionUuid: completeCtx?.sessionUuid,
          cwd: completeCtx?.cwd,
          chatId: completeCtx?.chatId,
          durationMs: _durationMs,
        });
      } catch (cardErr) {
        logger.warn(`[wecom-stream] complete card send failed: ${cardErr instanceof Error ? cardErr.message : String(cardErr)}`);
      }
    }
    this.clearTerminalState();
  }

  async error(message: string): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const t = this.getTerminalFrame();
    if (!t) {
      logger.warn('[wecom-stream] error skipped: missing inboundFrame');
      return;
    }
    try {
      await this.sdk.replyStream(t.frame, t.streamId, `❌ ${message}`, true);
    } catch (err) {
      logger.error(`[wecom-stream] error replyStream failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.clearTerminalState();
  }

  async cancel(reason?: string): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const t = this.getTerminalFrame();
    if (!t) {
      logger.warn('[wecom-stream] cancel skipped: missing inboundFrame');
      return;
    }
    try {
      await this.sdk.replyStream(t.frame, t.streamId, `⏹ 已取消${reason ? `: ${reason}` : ''}`, true);
    } catch (err) {
      logger.error(`[wecom-stream] cancel replyStream failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.clearTerminalState();
  }

  /** 终态后清理 — 避免下个 startProcessing 复用旧 inboundFrame */
  private clearTerminalState(): void {
    this.currentStreamId = null;
    this.lastInboundFrame = null;
    // PR 7.2: 清理流式上下文, 避免下次 complete 误用上次的 userId
    this.lastUserId = null;
  }

  private truncate(content: string): string {
    if (content.length <= STREAM_CONTENT_MAX_BYTES) return content;
    return content.slice(0, STREAM_CONTENT_MAX_BYTES - 50) + '\n\n[内容过长已截断]';
  }
}
