import { describe, it, expect, mock } from 'bun:test';
import { FeishuStreamUpdater } from '../../../src/feishu/stream-updater';
import type { CardUpdater } from '../../../src/feishu/card-updater';

describe('FeishuStreamUpdater integration with handleChatStreaming call pattern', () => {
  it('handleChatStreaming uses updater.complete() (not cardUpdater.complete directly)', async () => {
    const completeCalls: any[] = [];
    const cardUpdater = {
      startProcessing: mock(async () => 'card-123'),
      updateStream: mock(async () => {}),
      complete: mock(async (...args: any[]) => { completeCalls.push(args); }),
      error: mock(async () => {}),
      cancel: mock(async () => {}),
      shouldFallbackToText: mock(() => false),
      truncateContent: mock((s: string) => s),
      getCardMessageId: mock(() => 'card-123'),
      dispose: mock(() => {}),
    } as any as CardUpdater;

    const updater = new FeishuStreamUpdater(cardUpdater);

    const msgId = await updater.startProcessing('ou_abc');
    expect(msgId).toBe('card-123');

    await updater.updateStream('thinking', 'text', 1500);

    await updater.complete('final response', 100, 200, 5000, 1);

    expect(cardUpdater.startProcessing).toHaveBeenCalled();
    expect(cardUpdater.updateStream).toHaveBeenCalled();
    expect(cardUpdater.complete).toHaveBeenCalledWith('final response', 100, 200, 5000, 1);

    const underlying = updater.getCardUpdater();
    expect(underlying.shouldFallbackToText('text')).toBe(false);
    expect(underlying.truncateContent('text')).toBe('text');
    expect(underlying.getCardMessageId()).toBe('card-123');
    underlying.dispose();
  });

  it('SpoolMessage enqueue includes userId + platform fields', () => {
    const event = { open_id: 'ou_abc', message_id: 'om_xyz', content: 'hello', chat_type: 'p2p' as const, message_type: 'text' as const };
    const spoolMessage = {
      messageId: event.message_id,
      openId: event.open_id,
      text: event.content,
      userId: event.open_id,
      platform: 'feishu' as const,
      target: { type: 'no_target' as const },
      serialKey: `new:${event.open_id}`,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(spoolMessage.userId).toBe('ou_abc');
    expect(spoolMessage.platform).toBe('feishu');
    expect(spoolMessage.openId).toBe('ou_abc');
  });
});