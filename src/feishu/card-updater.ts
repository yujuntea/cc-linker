import { logger } from '../utils/logger';
import { config } from '../utils/config';

export type CardState = 'processing' | 'streaming' | 'complete' | 'error';

interface CardUpdaterOptions {
  throttle_ms?: number;
  max_card_bytes?: number;
  show_thinking?: boolean;
}

interface FeishuClient {
  im: {
    v1: {
      message: {
        create: (payload: any) => Promise<any>;
        patch: (payload: any) => Promise<any>;
      };
    };
  };
}

export class CardUpdater {
  private client: FeishuClient;
  private cardMessageId: string | null = null;
  private lastPatchAt = 0;
  private pendingUpdate: { thinking: string; text: string; elapsed: number } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly throttleMs: number;
  private readonly maxCardBytes: number;
  private readonly showThinking: boolean;
  private state: CardState = 'processing';

  constructor(client: FeishuClient, options: CardUpdaterOptions = {}) {
    this.client = client;
    this.throttleMs = options.throttle_ms ?? config.get<number>('stream.throttle_ms', 1500);
    this.maxCardBytes = options.max_card_bytes ?? config.get<number>('stream.max_card_bytes', 25000);
    this.showThinking = options.show_thinking ?? config.get<boolean>('stream.show_thinking', true);
  }

  getCardMessageId(): string | null { return this.cardMessageId; }
  getState(): CardState { return this.state; }

  async startProcessing(openId: string): Promise<string> {
    const card = this.buildProcessingCard();
    const resp = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    this.cardMessageId = resp.data?.message_id ?? null;
    if (!this.cardMessageId) throw new Error('Failed to create processing card');
    this.state = 'processing';
    this.lastPatchAt = Date.now();
    return this.cardMessageId;
  }

  async updateStream(thinking: string, text: string, elapsedMs: number): Promise<void> {
    this.pendingUpdate = { thinking, text, elapsed: elapsedMs };
    const now = Date.now();
    if (now - this.lastPatchAt >= this.throttleMs) {
      await this.flushPending();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(async () => {
        this.pendingTimer = null;
        await this.flushPending();
      }, this.throttleMs - (now - this.lastPatchAt));
    }
  }

  private async flushPending(): Promise<void> {
    if (!this.pendingUpdate || !this.cardMessageId) return;
    // Clear any pending timer — we're flushing now, no need for deferred call
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    const { thinking, text, elapsed } = this.pendingUpdate;
    await this.patchCard(this.buildStreamingCard(thinking, text, elapsed));
    this.pendingUpdate = null;
    this.state = 'streaming';
  }

  async complete(response: string, tokensIn: number, tokensOut: number, durationMs: number, numTurns: number): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildCompleteCard(response, tokensIn, tokensOut, durationMs, numTurns));
    this.state = 'complete';
  }

  async error(message: string): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildErrorCard(message));
    this.state = 'error';
  }

  shouldFallbackToText(content: string): boolean {
    return new TextEncoder().encode(content).length > this.maxCardBytes;
  }

  truncateContent(content: string): string {
    return truncateBytes(content, this.maxCardBytes);
  }

  /** Create a permission request card with Allow/Deny buttons */
  async createPermissionCard(
    openId: string,
    toolName: string,
    action: string,
    promptIndex: number,
  ): Promise<string> {
    const card = this.buildPermissionCard(toolName, action, promptIndex);
    const resp = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    const messageId = resp.data?.message_id ?? null;
    if (!messageId) throw new Error('Failed to create permission card');
    this.cardMessageId = messageId;
    this.state = 'processing';
    this.lastPatchAt = Date.now();
    return messageId;
  }

  /** Update existing permission card with result */
  async updatePermissionCard(approved: boolean): Promise<void> {
    const card = approved
      ? this.buildPermissionResultCard(true)
      : this.buildPermissionResultCard(false);
    await this.patchCard(card);
  }

  /** Allow external code to set cardMessageId for permission card patching */
  setCardMessageId(messageId: string): void {
    this.cardMessageId = messageId;
  }

  private buildPermissionCard(
    toolName: string,
    action: string,
    promptIndex: number,
  ): Record<string, unknown> {
    const actionLabel = this.getToolActionLabel(toolName);
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🔐 需要权限确认' },
        template: 'orange',
      },
      elements: [
        {
          tag: 'markdown',
          content: `Claude 想要执行以下操作：\n\n**${actionLabel}：**\n\`\`\`\n${esc(action)}\n\`\`\``,
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 允许' },
              type: 'primary',
              value: { type: 'permission_approve', index: promptIndex },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 拒绝' },
              type: 'default',
              value: { type: 'permission_deny', index: promptIndex },
            },
          ],
        },
      ],
    };
  }

  private buildPermissionResultCard(approved: boolean): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: approved ? '✅ 已允许' : '❌ 已拒绝',
        },
        template: approved ? 'green' : 'red',
      },
      elements: [
        {
          tag: 'markdown',
          content: approved
            ? '操作已被允许，Claude 将继续执行。'
            : '操作已被拒绝，Claude 将尝试其他方式。',
        },
      ],
    };
  }

  private getToolActionLabel(toolName: string): string {
    const labels: Record<string, string> = {
      Bash: 'Bash 命令',
      Edit: '文件编辑',
      Write: '文件写入',
      Read: '文件读取',
      Glob: '文件搜索',
      Grep: '内容搜索',
      WebFetch: '网络请求',
      WebSearch: '网络搜索',
    };
    return labels[toolName] ?? toolName;
  }

  dispose(): void {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
  }

  private async patchCard(card: Record<string, unknown>): Promise<void> {
    if (!this.cardMessageId) return;
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: this.cardMessageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err: any) {
      logger.warn(`CardUpdater: patch failed: ${err.message}`);
    }
  }

  private buildProcessingCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '⏳ 正在处理...' }, template: 'blue' },
      elements: [{ tag: 'markdown', content: 'Claude 正在处理你的请求，预计 **2-10 秒**...' }],
    };
  }

  private buildStreamingCard(thinking: string, text: string, elapsedMs: number): Record<string, unknown> {
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const elements: Array<Record<string, unknown>> = [];
    // Show full content but enforce byte limit to stay within Feishu's 30KB card body
    const maxThinkingBytes = Math.min(2000, this.maxCardBytes);
    const maxTextBytes = Math.min(8000, this.maxCardBytes);
    if (this.showThinking && thinking) {
      elements.push({ tag: 'markdown', content: `**思考过程：**\n> ${esc(truncateBytes(thinking, maxThinkingBytes))}` });
    }
    if (text) {
      elements.push({ tag: 'markdown', content: `**回复：**\n${esc(truncateBytes(text, maxTextBytes))}` });
    }
    elements.push({ tag: 'markdown', content: `⏱ 已用时 ${elapsedSec}s` });
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '💭 处理中' }, template: 'blue' },
      elements,
    };
  }

  private buildCompleteCard(response: string, tokensIn: number, tokensOut: number, durationMs: number, numTurns: number): Record<string, unknown> {
    const display = this.truncateContent(response);
    const footer: string[] = [];
    const totalTokens = tokensIn + tokensOut;
    if (totalTokens > 0) footer.push(`🪙 ${formatTokenCount(totalTokens)} tokens`);
    footer.push(`⏱ 耗时: **${Math.floor(durationMs / 1000)}s**`);
    if (numTurns > 0) footer.push(`📊 轮数: **${numTurns}**`);
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '✅ 处理完成' }, template: 'green' },
      elements: [
        { tag: 'markdown', content: esc(display) },
        { tag: 'hr' },
        { tag: 'markdown', content: footer.join('  |  ') },
      ],
    };
  }

  private buildErrorCard(message: string): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❌ 处理失败' }, template: 'red' },
      elements: [{ tag: 'markdown', content: `错误原因：**${esc(message)}**\n\n请检查 Claude CLI 是否可用，或稍后重试。` }],
    };
  }
}

function esc(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;

  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + '...';
}

function formatTokenCount(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
