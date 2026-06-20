/**
 * PR 6.8.3: WecomStreamUpdater.complete() 失败时调 msgFallback 兜底
 *
 * 背景: 8s 流式静默失败时, replyStream 调了但 WSS 没真发送, 卡片始终空白
 * 修法: complete() 接受可选 msgFallback 参数, replyStream 抛错时调 fallback 走 sendMessage
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { WecomStreamUpdater } from '../../../src/wecom/stream-updater';

const mockInboundFrame = (id = 'inbound_1') => ({ headers: { req_id: id } });

describe('PR 6.8.3: WecomStreamUpdater.complete fallback', () => {
  let mockSdk: any;
  let updater: WecomStreamUpdater;

  beforeEach(() => {
    const calls: any[] = [];
    mockSdk = {
      replyStream: (...args: any[]) => {
        calls.push({ method: 'replyStream', args: args.slice(1) });
        return Promise.resolve({});
      },
      sendMessage: (...args: any[]) => {
        calls.push({ method: 'sendMessage', args });
        return Promise.resolve({});
      },
      _calls: calls,
    };
    updater = new WecomStreamUpdater(mockSdk, { throttleMs: 100 });
  });

  it('replyStream 失败时调 msgFallback 走 sendMessage 兜底', async () => {
    // 先 startProcessing (用默认 mock 让它走通)
    await updater.startProcessing('user-1', mockInboundFrame());
    // 之后才覆盖 replyStream 让 complete 失败
    mockSdk.replyStream = (..._args: any[]) => {
      return Promise.reject(new Error('fake replyStream network error'));
    };

    let fallbackCalled = false;
    let fallbackText = '';
    await updater.complete(
      'reply text', 100, 200, 3000, 5,
      async (text: string) => {
        fallbackCalled = true;
        fallbackText = text;
        await mockSdk.sendMessage('user-1', { msgtype: 'markdown', markdown: { content: text } });
      },
    );

    // 验证: fallback 被调了, 且 sendMessage 被调了
    expect(fallbackCalled).toBe(true);
    expect(fallbackText).toContain('❌ 流式回复失败');
    expect(fallbackText).toContain('fake replyStream network error');
    const sendCall = mockSdk._calls.find((c: any) => c.method === 'sendMessage');
    expect(sendCall).toBeDefined();
  });

  it('replyStream 成功时 msgFallback 不被调', async () => {
    // 默认 mock replyStream resolve, fallback 不该被调
    await updater.startProcessing('user-1', mockInboundFrame());

    let fallbackCalled = false;
    await updater.complete(
      'reply text', 100, 200, 3000, 5,
      async (_text: string) => { fallbackCalled = true; },
    );

    expect(fallbackCalled).toBe(false);
  });

  it('不传 msgFallback 时, replyStream 失败只 log 不 throw', async () => {
    // 不传 fallback → 跟原行为一致: 只 log error, 不 throw
    await updater.startProcessing('user-1', mockInboundFrame());
    // 覆盖 replyStream 让 complete 失败
    mockSdk.replyStream = (..._args: any[]) => {
      return Promise.reject(new Error('fake network error'));
    };

    // 不传 msgFallback
    await updater.complete('reply text', 100, 200, 3000, 5);

    // 不 throw, state 已 clear (后续 complete 无效)
    const secondComplete = await updater.complete('again', 0, 0, 0, 0);
    expect(secondComplete).toBeUndefined();
  });

  it('replyStream + fallback 都失败时不 throw (双层兜底防御)', async () => {
    // replyStream 失败 + fallback 也失败 → complete 不 throw (避免拖垮 dispatch loop)
    await updater.startProcessing('user-1', mockInboundFrame());
    // 覆盖 replyStream + sendMessage 都失败
    mockSdk.replyStream = (..._args: any[]) => {
      return Promise.reject(new Error('replyStream fail'));
    };
    mockSdk.sendMessage = (..._args: any[]) => {
      return Promise.reject(new Error('sendMessage also fail'));
    };

    // 不应当 throw
    let threw = false;
    try {
      await updater.complete(
        'reply text', 100, 200, 3000, 5,
        async (text: string) => { await mockSdk.sendMessage('user-1', { markdown: { content: text } }); },
      );
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
