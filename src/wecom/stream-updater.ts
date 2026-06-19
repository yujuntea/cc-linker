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
  /** inbound frame — replyStream 需要用它的 headers.req_id */
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

  async startProcessing(userId: string): Promise<string> {
    this.currentStreamId = generateReqId('stream');
    // 关键：用 inbound frame 的 req_id（SDK 要求这个 req_id 与 inbound 时一致）
    const frame = this.inboundFrame ?? { headers: { req_id: this.currentStreamId } };
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
    // 合并到 buffer（最新一次 update 覆盖 thinking 累积）
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
    const { thinking, text, elapsedMs, toolUses } = this.buffer;
    const markdown = renderMarkdown(thinking, text, toolUses, elapsedMs);
    const frame = this.inboundFrame ?? { headers: { req_id: this.currentStreamId } };
    try {
      await this.sdk.replyStream(frame, this.currentStreamId, this.truncate(markdown), false);
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
    // flush 残留 buffer（如果还有），失败也继续终态（终态消息更重要）
    if (this.buffer) {
      try { await this.flushBuffer(); } catch { /* ignore */ }
    }
    return true;
  }

  async complete(
    response: string,
    _tokensIn: number,
    _tokensOut: number,
    _durationMs: number,
    _numTurns: number,
  ): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const frame = this.inboundFrame ?? { headers: { req_id: this.currentStreamId! } };
    await this.sdk.replyStream(frame, this.currentStreamId!, this.truncate(response), true);
    this.currentStreamId = null;
  }

  async error(message: string): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const frame = this.inboundFrame ?? { headers: { req_id: this.currentStreamId! } };
    await this.sdk.replyStream(frame, this.currentStreamId!, `❌ ${message}`, true);
    this.currentStreamId = null;
  }

  async cancel(reason?: string): Promise<void> {
    if (!(await this.prepareTerminal())) return;
    const frame = this.inboundFrame ?? { headers: { req_id: this.currentStreamId! } };
    await this.sdk.replyStream(frame, this.currentStreamId!, `⏹ 已取消${reason ? `: ${reason}` : ''}`, true);
    this.currentStreamId = null;
  }

  private truncate(content: string): string {
    if (content.length <= STREAM_CONTENT_MAX_BYTES) return content;
    return content.slice(0, STREAM_CONTENT_MAX_BYTES - 50) + '\n\n[内容过长已截断]';
  }
}
