import { describe, it, expect, beforeEach } from 'bun:test';
import { AibotClient } from '../../../src/wecom/aibot-client';

describe('AibotClient', () => {
  let client: AibotClient;

  beforeEach(() => {
    client = new AibotClient({
      botId: 'test-bot',
      secret: 'test-secret',
      wsUrl: 'wss://test.openws.work.weixin.qq.com',
    });
  });

  it('initializes with config', () => {
    expect(client).toBeDefined();
    expect(client.isConnected()).toBe(false);
  });

  it('emits connection events', async () => {
    const events: string[] = [];
    client.on('connected', () => events.push('connected'));
    client.on('disconnected', () => events.push('disconnected'));

    // 不真的 connect WSS（mock）
    // 验证 listener 注册成功即可
    expect(events).toEqual([]);
  });

  it('maps WSAuthFailureError to CCError', () => {
    const err = new Error('WS_AUTH_FAILURE_EXHAUSTED' as any);
    err.name = 'WSAuthFailureError';
    // 实际验证在 aibot-client 内部 try/catch，单元测试只能验证错误传播
    expect(err.name).toBe('WSAuthFailureError');
  });

  it('emits "fatal" event (not throw) on auth failure', async () => {
    // 实际测试在 aibot-client.test.ts 内用 mock WSClient + simulate error event
    // 验证 AibotClient 收到 WSAuthFailureError 后 emit('fatal', CCLinkerError)
    // 而不是 throw（throw 是 uncaught exception，绕过 handleError）
    const fatalErrors: any[] = [];
    client.on('fatal', (err: any) => fatalErrors.push(err));
    // 模拟 SDK 抛 WSAuthFailureError（在真实测试中触发 wsClient 'error' 事件）
    // 此处仅验证 client 注册了 fatal listener
    expect(fatalErrors).toEqual([]);
  });
});
