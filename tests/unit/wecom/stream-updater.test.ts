import { describe, it, expect, beforeEach } from 'bun:test';
import { WecomStreamUpdater } from '../../../src/wecom/stream-updater';

const mockInboundFrame = (id = 'inbound_1') => ({ headers: { req_id: id } });

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
    const id = await updater.startProcessing('user-1', mockInboundFrame());
    expect(id).toMatch(/^stream_/);
    expect(mockSdk._calls[0].method).toBe('replyStream');
    expect(mockSdk._calls[0].args[0]).toBe(id);
    expect(mockSdk._calls[0].args[1]).toContain('🤔');
  });

  it('PR 2 v1.2.1 (M4): throws when inboundFrame is missing', async () => {
    // M-7 final: inboundFrame 必传，不传 throw fail fast
    expect(updater.startProcessing('user-1', undefined as any)).rejects.toThrow(/inboundFrame is required/);
  });

  it('PR 2 v1.2.1 (M4): accepts inboundFrame as required second arg', async () => {
    const id = await updater.startProcessing('user-1', mockInboundFrame('compat'));
    expect(id).toMatch(/^stream_/);
  });

  it('updateStream throttles to throttleMs window', async () => {
    await updater.startProcessing('user-1', mockInboundFrame());
    mockSdk._calls.length = 0;
    await updater.updateStream('thinking1', 'text1', 100);
    await updater.updateStream('thinking2', 'text2', 50);
    expect(mockSdk._calls.length).toBeLessThanOrEqual(1);
  });

  it('updateStream flushes after throttle window', async () => {
    await updater.startProcessing('user-1', mockInboundFrame());
    mockSdk._calls.length = 0;
    await updater.updateStream('thinking1', 'text1', 100);
    await new Promise(r => setTimeout(r, 150));
    await updater.updateStream('thinking2', 'text2', 200);
    await new Promise(r => setTimeout(r, 150));
    expect(mockSdk._calls.length).toBeGreaterThanOrEqual(2);
  });

  it('updateStream truncates content over 20480 bytes', async () => {
    await updater.startProcessing('user-1', mockInboundFrame());
    const tooLongThinking = 'x'.repeat(15000);
    const tooLongText = 'y'.repeat(10000);
    await updater.updateStream(tooLongThinking, tooLongText, 100);
    await updater.complete('final', 100, 200, 3000, 5);
    for (const call of mockSdk._calls) {
      if (call.method === 'replyStream' || call.method === 'replyStreamWithCard') {
        expect((call.args[1] as string).length).toBeLessThanOrEqual(20480);
      }
    }
  });

  it('complete uses replyStream with finish=true', async () => {
    await updater.startProcessing('user-1', mockInboundFrame());
    await updater.complete('response', 100, 200, 3000, 5);
    const lastCall = mockSdk._calls[mockSdk._calls.length - 1];
    expect(lastCall.method).toBe('replyStream');
    expect(lastCall.args[1]).toBe('response');
    expect(lastCall.args[2]).toBe(true);
  });

  it('error emits error message with finish=true', async () => {
    await updater.startProcessing('user-1', mockInboundFrame());
    await updater.error('something broke');
    const lastCall = mockSdk._calls[mockSdk._calls.length - 1];
    expect(lastCall.method).toBe('replyStream');
    expect(lastCall.args[1]).toContain('❌');
    expect(lastCall.args[2]).toBe(true);
  });

  it('cancel emits cancel notice', async () => {
    await updater.startProcessing('user-1', mockInboundFrame());
    await updater.cancel('user requested');
    const lastCall = mockSdk._calls[mockSdk._calls.length - 1];
    expect(lastCall.args[1]).toContain('已取消');
  });

  it('terminal methods are idempotent (safe to call twice or before start)', async () => {
    await updater.complete('noop', 0, 0, 0, 0);
    await updater.error('noop');
    await updater.cancel();
    await updater.startProcessing('user-1', mockInboundFrame('inbound_idem'));
    await updater.complete('done', 1, 2, 3, 4);
    const callCountAfterFirstComplete = mockSdk._calls.length;
    await updater.complete('again', 1, 2, 3, 4);
    await updater.error('again');
    await updater.cancel();
    expect(mockSdk._calls.length).toBe(callCountAfterFirstComplete);
  });

  it('terminal methods clear pending flushTimer (no post-terminal flush)', async () => {
    await updater.startProcessing('user-1', mockInboundFrame());
    await updater.updateStream('t', 'x', 50);
    await updater.complete('done', 1, 2, 3, 4);
    const callCount = mockSdk._calls.length;
    await new Promise(r => setTimeout(r, 150));
    expect(mockSdk._calls.length).toBe(callCount);
  });

  it('m-3: exposes THROTTLE_MS class constant (was hardcoded 2000, then aligned to 1500)', () => {
    // PR 7 m-3 fix: 限频窗口 2000ms 提常量 THROTTLE_MS, 跟 DEFAULT_THROTTLE_MS 同源
    // 历史: setTimeout(_, 2000) 在 stream-updater 写死, 调 throttleMs=100 不影响 hardcoded 路径
    // 修法: 改用 this.throttleMs (per-instance) 替代 hardcoded 2000
    // PR 6.10: 2000 → 1500, 跟飞书侧 CardUpdater throttle_ms=1500 对齐, 流式增量刷新更快
    expect((WecomStreamUpdater as any).THROTTLE_MS).toBe(1500);
  });
});
