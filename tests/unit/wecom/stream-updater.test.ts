import { describe, it, expect, beforeEach } from 'bun:test';
import { WecomStreamUpdater } from '../../../src/wecom/stream-updater';

describe('WecomStreamUpdater', () => {
  let mockSdk: any;
  let updater: WecomStreamUpdater;

  beforeEach(() => {
    let calls: any[] = [];
    mockSdk = {
      replyStream: (...args: any[]) => {
        calls.push({ method: 'replyStream', args: args.slice(1) });
        return Promise.resolve({});
      },
      replyStreamWithCard: (...args: any[]) => {
        calls.push({ method: 'replyStreamWithCard', args: args.slice(1) });
        return Promise.resolve({});
      },
      _calls: calls,
    };
    updater = new WecomStreamUpdater(mockSdk, { throttleMs: 100 });
  });

  it('startProcessing returns stream id and emits first replyStream', async () => {
    const id = await updater.startProcessing('user-1');
    expect(id).toMatch(/^stream_/);
    expect(mockSdk._calls[0].method).toBe('replyStream');
    expect(mockSdk._calls[0].args[0]).toBe(id);
    expect(mockSdk._calls[0].args[1]).toContain('🤔');  // 默认首条消息含思考 emoji
  });

  it('updateStream throttles to throttleMs window', async () => {
    const id = await updater.startProcessing('user-1');
    mockSdk._calls.length = 0;
    await updater.updateStream('thinking1', 'text1', 100);
    await updater.updateStream('thinking2', 'text2', 50);  // < 100ms throttle
    // 应该合并到 1 次 SDK call
    expect(mockSdk._calls.length).toBeLessThanOrEqual(1);
  });

  it('updateStream flushes after throttle window', async () => {
    const id = await updater.startProcessing('user-1');
    mockSdk._calls.length = 0;
    await updater.updateStream('thinking1', 'text1', 100);
    await new Promise(r => setTimeout(r, 150));  // 超过 100ms → timer fire 第 1 次 flush
    await updater.updateStream('thinking2', 'text2', 200);
    await new Promise(r => setTimeout(r, 150));  // 再等一轮 throttle → 第 2 次 flush
    // 至少 2 次 SDK call（两次 throttle 周期各触发一次 flush）
    expect(mockSdk._calls.length).toBeGreaterThanOrEqual(2);
  });

  it('updateStream truncates content over 20480 bytes', async () => {
    const id = await updater.startProcessing('user-1');
    const tooLongThinking = 'x'.repeat(15000);
    const tooLongText = 'y'.repeat(10000);  // 合计 > 20480
    await updater.updateStream(tooLongThinking, tooLongText, 100);
    await updater.complete('final', 100, 200, 3000, 5);
    // 验证：传给 SDK 的 content 长度 <= 20480
    for (const call of mockSdk._calls) {
      if (call.method === 'replyStream' || call.method === 'replyStreamWithCard') {
        expect((call.args[1] as string).length).toBeLessThanOrEqual(20480);
      }
    }
  });

  it('complete uses replyStream with finish=true', async () => {
    const id = await updater.startProcessing('user-1');
    await updater.complete('response', 100, 200, 3000, 5);
    const lastCall = mockSdk._calls[mockSdk._calls.length - 1];
    expect(lastCall.method).toBe('replyStream');
    expect(lastCall.args[1]).toBe('response');
    expect(lastCall.args[2]).toBe(true);  // finish=true
  });

  it('error emits error message with finish=true', async () => {
    const id = await updater.startProcessing('user-1');
    await updater.error('something broke');
    const lastCall = mockSdk._calls[mockSdk._calls.length - 1];
    expect(lastCall.method).toBe('replyStream');
    expect(lastCall.args[1]).toContain('❌');
    expect(lastCall.args[2]).toBe(true);  // finish=true
  });

  it('cancel emits cancel notice', async () => {
    const id = await updater.startProcessing('user-1');
    await updater.cancel('user requested');
    const lastCall = mockSdk._calls[mockSdk._calls.length - 1];
    expect(lastCall.args[1]).toContain('已取消');
  });

  it('terminal methods are idempotent (safe to call twice or before start)', async () => {
    // Before start: should not throw
    await updater.complete('noop', 0, 0, 0, 0);
    await updater.error('noop');
    await updater.cancel();
    // After terminal: second call is no-op
    const id = await updater.startProcessing('user-1');
    await updater.complete('done', 1, 2, 3, 4);
    const callCountAfterFirstComplete = mockSdk._calls.length;
    await updater.complete('again', 1, 2, 3, 4);  // should be no-op
    await updater.error('again');                   // should be no-op
    await updater.cancel();                          // should be no-op
    expect(mockSdk._calls.length).toBe(callCountAfterFirstComplete);
  });

  it('terminal methods clear pending flushTimer (no post-terminal flush)', async () => {
    const id = await updater.startProcessing('user-1');
    await updater.updateStream('t', 'x', 50);  // schedules flushTimer (100ms throttle)
    // Immediately complete — should clear timer, not leave pending flush
    await updater.complete('done', 1, 2, 3, 4);
    const callCount = mockSdk._calls.length;
    // Wait longer than throttle window
    await new Promise(r => setTimeout(r, 150));
    // No additional SDK calls should have happened (timer was cleared)
    expect(mockSdk._calls.length).toBe(callCount);
  });
});
