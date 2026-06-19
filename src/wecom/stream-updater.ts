/**
 * 企微 StreamUpdater 实现
 * 用 SDK replyStream 流式消息协议 (同 stream.id 持续 patch)
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2
 * 接口形状对齐 src/feishu/card-updater.ts:120-186 (FeishuStreamUpdater 包 CardUpdater)
 */
import type { WSClient, WsFrame } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';
import type { StreamUpdater, StreamUpdateToolUse } from '../platform/stream-updater';
import { logger } from '../utils/logger';

const STREAM_CONTENT_MAX_BYTES = 20480; // SDK 硬限制
const DEFAULT_THROTTLE_MS = 2000;

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
 */
function renderMarkdown(thinking: string, text: string, toolUses: StreamUpdateToolUse[], elapsedMs: number): string {
  const lines: string[] = [];
  if (thinking) lines.push(`> ${thinking.slice(-500)}`);  // thinking 只显示最后 500 字符
  if (toolUses.length > 0) {
    lines.push(`\n**工具调用**：`);
    for (const t of toolUses) lines.push(`- \`${t.name}\`: ${t.inputSummary}`);
  }
  if (text) lines.push(`\n${text}`);
  lines.push(`\n_${(elapsedMs / 1000).toFixed(1)}s_`);
  return lines.join('\n');
}

export class WecomStreamUpdater implements StreamUpdater {
  private sdk: WSClient;
  private throttleMs: number;
  private currentStreamId: string | null = null;
  /**
   * PR 2 v1.2.1 final (F2 修复): lastInboundFrame 在 startProcessing 存好
   * complete/error/cancel/flushBuffer 都用它，不再 fallback 到 currentStreamId
   * 避免 846605 "invalid req_id" bug 复现
   */
  private lastInboundFrame: any = null;
  /**
   * 保留 setInboundFrame API 作为 backward-compat
   * 新代码优先用 startProcessing(userId, inboundFrame)
   */
  private inboundFrame: any = null;
  private buffer: BufferedChunk | null = null;
  private lastFlushAt = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sdk: WSClient, opts: WecomStreamUpdaterOptions = {}) {
    this.sdk = sdk;
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  }

  /** 注入 inbound frame（必须先于 startProcessing 调用） */
  setInboundFrame(frame: any): void {
    this.inboundFrame = frame;
  }

  async startProcessing(userId: string, inboundFrame?: any): Promise<string> {
    this.currentStreamId = generateReqId('stream');
    const frame = inboundFrame ?? this.inboundFrame;
    if (!frame) {
      throw new Error('WecomStreamUpdater.startProcessing: inboundFrame is required (SDK replyStream 需要 inbound frame 的 headers.req_id)');
    }
    // 存下 inboundFrame 供 complete/error/cancel/flushBuffer 复用
    this.lastInboundFrame = frame;
    const initialMarkdown = '🤔 思考中...';
    await this.sdk.replyStream(frame, this.currentStreamId, this.truncate(initialMarkdown), false);
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
      await this.sdk.replyStream(this.lastInboundFrame, this.currentStreamId, this.truncate(markdown), false);
      this.lastFlushAt = Date.now();
    } catch (err) {
      // ⚠️ 只吞限频错误 (errcode 45009/45033)，保留 buffer 等下次 flush。
      // 其他错误（网络/SDK crash）必须 rethrow，由 bot 层处理——吞掉会丢回复。
      const errcode = (err as any)?.errcode ?? (err as any)?.code;
      if (errcode === 45009 || errcode === 45033) {
        logger.warn('[wecom-stream] flush rate-limited, buffer retained');
        return; // 保留 buffer，不走到下面的 "this.buffer = null"
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
  ): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const t = this.getTerminalFrame();
    if (!t) {
      logger.warn('[wecom-stream] complete skipped: missing inboundFrame (startProcessing never called with frame)');
      return;
    }
    await this.sdk.replyStream(t.frame, t.streamId, this.truncate(response), true);
    this.clearTerminalState();
  }

  async error(message: string): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const t = this.getTerminalFrame();
    if (!t) {
      logger.warn('[wecom-stream] error skipped: missing inboundFrame');
      return;
    }
    await this.sdk.replyStream(t.frame, t.streamId, `❌ ${message}`, true);
    this.clearTerminalState();
  }

  async cancel(reason?: string): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const t = this.getTerminalFrame();
    if (!t) {
      logger.warn('[wecom-stream] cancel skipped: missing inboundFrame');
      return;
    }
    await this.sdk.replyStream(t.frame, t.streamId, `⏹ 已取消${reason ? `: ${reason}` : ''}`, true);
    this.clearTerminalState();
  }

  /** 终态后清理 — 避免下个 startProcessing 复用旧 inboundFrame */
  private clearTerminalState(): void {
    this.currentStreamId = null;
    this.lastInboundFrame = null;
    this.inboundFrame = null;
  }

  private truncate(content: string): string {
    if (content.length <= STREAM_CONTENT_MAX_BYTES) return content;
    return content.slice(0, STREAM_CONTENT_MAX_BYTES - 50) + '\n\n[内容过长已截断]';
  }
}
