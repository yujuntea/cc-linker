/**
 * FeishuStreamUpdater — 把 CardUpdater 包成 StreamUpdater 接口
 * 不改 CardUpdater 行为，仅作为接口契约的飞书侧实现
 * **v1.2 修正**：保留 `private cardUpdater` 引用
 * handleChatStreaming 仍可直接 `.cardUpdater.shouldFallbackToText()` 调 4 个接口外方法
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §3.2 v1.1 + §4.1
 * 参考 src/feishu/card-updater.ts:120-186 (CardUpdater 真实方法签名)
 */
import type { StreamUpdater, StreamUpdateToolUse } from '../platform/stream-updater';
import type { CardUpdater } from './card-updater';

export class FeishuStreamUpdater implements StreamUpdater {
  /** 暴露给 handleChatStreaming 调 4 个接口外方法 (shouldFallbackToText/truncateContent/getCardMessageId/dispose) */
  constructor(private readonly cardUpdater: CardUpdater) {}

  /** 获取底层 CardUpdater（handleChatStreaming 用） */
  getCardUpdater(): CardUpdater {
    return this.cardUpdater;
  }

  async startProcessing(userId: string): Promise<string> {
    return this.cardUpdater.startProcessing(userId);
  }

  async updateStream(
    thinking: string,
    text: string,
    elapsedMs: number,
    toolUses: StreamUpdateToolUse[] = [],
  ): Promise<void> {
    await this.cardUpdater.updateStream(thinking, text, elapsedMs, toolUses);
  }

  async complete(
    response: string,
    tokensIn: number,
    tokensOut: number,
    durationMs: number,
    numTurns: number,
  ): Promise<void> {
    await this.cardUpdater.complete(response, tokensIn, tokensOut, durationMs, numTurns);
  }

  async error(message: string): Promise<void> {
    await this.cardUpdater.error(message);
  }

  async cancel(reason?: string): Promise<void> {
    await this.cardUpdater.cancel(reason);
  }
}