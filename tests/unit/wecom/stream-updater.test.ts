import { describe, it, expect, beforeEach } from 'bun:test';
import { WecomStreamUpdater } from '../../../src/wecom/stream-updater';
import { WecomCompleteCardSender } from '../../../src/wecom/complete-card';

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

  it('PR 6.12: renderMarkdown 输出 "思考过程：" / "回复：" 标签对齐飞书 (集成测通过 replyStream content)', async () => {
    // 仿飞书 CardUpdater.buildStreamingCard 结构 (思考过程 / 当前操作 / 回复 + ⏱ 已用时)
    await updater.startProcessing('user-1', mockInboundFrame());
    mockSdk._calls.length = 0;
    await updater.updateStream('思考中: 用户说 hi', '你好!', 5000);
    // 强制 throttle 窗口 flush (这里 throttleMs=100, 实际 flush 已经发生)
    await new Promise(r => setTimeout(r, 150));
    const lastCall = mockSdk._calls[mockSdk._calls.length - 1];
    const content = lastCall.args[1] as string;
    expect(content).toContain('**思考过程：**');
    expect(content).toContain('思考中: 用户说 hi');
    expect(content).toContain('**回复：**');
    expect(content).toContain('你好!');
    expect(content).toContain('⏱ 已用时');
  });

  it('PR 6.12: toolUses 渲染为 "当前操作：" 列表 (对齐飞书)', async () => {
    await updater.startProcessing('user-1', mockInboundFrame());
    mockSdk._calls.length = 0;
    await updater.updateStream('读文件', '', 100, [
      { name: 'Read', inputSummary: '/tmp/x.ts' },
      { name: 'Grep', inputSummary: 'pattern: foo' },
    ]);
    await new Promise(r => setTimeout(r, 150));
    const lastCall = mockSdk._calls[mockSdk._calls.length - 1];
    const content = lastCall.args[1] as string;
    expect(content).toContain('**当前操作：**');
    expect(content).toContain('`Read`: /tmp/x.ts');
    expect(content).toContain('`Grep`: pattern: foo');
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

describe('PR 7.2: complete() 触发 completeCardSender.send', () => {
  let mockSdk: any;
  let mockSender: any;
  let updater: WecomStreamUpdater;

  beforeEach(() => {
    mockSdk = {
      replyStream: (...args: any[]) => Promise.resolve({}),
    };
    mockSender = {
      sendCalls: [] as any[],
      send: (ctx: any) => {
        mockSender.sendCalls.push(ctx);
        return Promise.resolve();
      },
    };
    updater = new WecomStreamUpdater(mockSdk, { throttleMs: 100 });
    updater.setCompleteCardSender(mockSender as any);
  });

  it('does NOT call sender.send when not injected', async () => {
    // 验证默认行为: 不注入 sender → 不发卡片 (向后兼容)
    const sendCallsBefore = mockSender.sendCalls.length;
    const updater2 = new WecomStreamUpdater(mockSdk, { throttleMs: 100 });
    await updater2.startProcessing('user-1', mockInboundFrame());
    await updater2.complete('完成内容', 100, 200, 5000, 1);
    // 验证: mockSender.sendCalls 数量没增加 (updater2 没注入 sender, 不应该调用)
    expect(mockSender.sendCalls.length).toBe(sendCallsBefore);
  });

  it('calls sender.send with userId/duration after complete() success', async () => {
    await updater.startProcessing('user_42', mockInboundFrame());
    await updater.complete('完成内容', 100, 200, 5500, 1, undefined, '思考内容', [], {
      sessionTitle: '测试 session',
      sessionUuid: 'uuid-abc',
      cwd: '/tmp',
    });
    expect(mockSender.sendCalls.length).toBe(1);
    const sent = mockSender.sendCalls[0];
    expect(sent.userId).toBe('user_42');
    expect(sent.durationMs).toBe(5500);
    expect(sent.sessionTitle).toBe('测试 session');
    expect(sent.sessionUuid).toBe('uuid-abc');
    expect(sent.cwd).toBe('/tmp');
  });

  it('PR 7.2 review: sender.send failure does NOT break complete()', async () => {
    // sender.send 抛错 → complete() 不应 reject (流式输出已成功, 不能让卡片失败冒泡)
    mockSender.send = () => Promise.reject(new Error('mock sendMessage fail'));
    await updater.startProcessing('user_x', mockInboundFrame());
    // 不应 reject
    await updater.complete('done', 1, 2, 3000, 1);
    // 验证: 没有 propagate error
    expect(true).toBe(true);
  });

  it('PR 7.2 review: sender.send is called AFTER replyStream(finish=true) completes', async () => {
    const replyStreamFinishTrueAt: number[] = [];
    const senderSendAt: number[] = [];
    let callSeq = 0;
    mockSdk.replyStream = (...args: any[]) => {
      if (args[3] === true) replyStreamFinishTrueAt.push(++callSeq);
      return Promise.resolve({});
    };
    mockSender.send = (ctx: any) => {
      senderSendAt.push(++callSeq);
      return Promise.resolve();
    };
    await updater.startProcessing('user_y', mockInboundFrame());
    await updater.complete('done', 1, 2, 3000, 1);
    // 断言: replyStream(finish=true) 被调一次 + sender.send 被调一次
    expect(replyStreamFinishTrueAt.length).toBe(1);
    expect(senderSendAt.length).toBe(1);
    // 断言: sender.send 在 replyStream(finish=true) 之后 (调用序号更大)
    expect(senderSendAt[0]).toBeGreaterThan(replyStreamFinishTrueAt[0]);
  });
});
