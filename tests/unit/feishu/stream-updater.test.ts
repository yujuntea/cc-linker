import { describe, it, expect, mock } from 'bun:test';
import { FeishuStreamUpdater } from '../../../src/feishu/stream-updater';

// Mock CardUpdater
function makeMockCardUpdater() {
  return {
    cardMessageId: 'mock-card-id',
    startProcessing: mock(async (openId: string) => {
      return 'mock-card-id';
    }),
    updateStream: mock(async (thinking: string, text: string, elapsedMs: number, toolUses: any[]) => {
      // 记录调用
    }),
    complete: mock(async (response: string, tIn: number, tOut: number, dur: number, turns: number) => {
      // 记录调用
    }),
    error: mock(async (message: string) => {}),
    cancel: mock(async (reason?: string) => {}),
    // 4 个接口外方法（v1.2 修正）
    shouldFallbackToText: mock(() => false),
    truncateContent: mock((s: string) => s),
    getCardMessageId: mock(() => 'mock-card-id'),
    dispose: mock(() => {}),
  };
}

describe('FeishuStreamUpdater', () => {
  it('startProcessing delegates to CardUpdater.startProcessing', async () => {
    const mockCU = makeMockCardUpdater() as any;
    const updater = new FeishuStreamUpdater(mockCU);
    const id = await updater.startProcessing('open_123');
    expect(id).toBe('mock-card-id');
    expect(mockCU.startProcessing).toHaveBeenCalledWith('open_123');
  });

  it('updateStream delegates with same params', async () => {
    const mockCU = makeMockCardUpdater() as any;
    const updater = new FeishuStreamUpdater(mockCU);
    await updater.updateStream('thinking', 'text', 1500, [{ name: 'Read', inputSummary: 'foo.ts' }]);
    expect(mockCU.updateStream).toHaveBeenCalledWith('thinking', 'text', 1500, [{ name: 'Read', inputSummary: 'foo.ts' }]);
  });

  it('complete delegates with metrics', async () => {
    const mockCU = makeMockCardUpdater() as any;
    const updater = new FeishuStreamUpdater(mockCU);
    await updater.complete('response', 100, 200, 3000, 5);
    expect(mockCU.complete).toHaveBeenCalledWith('response', 100, 200, 3000, 5);
  });

  it('error delegates', async () => {
    const mockCU = makeMockCardUpdater() as any;
    const updater = new FeishuStreamUpdater(mockCU);
    await updater.error('boom');
    expect(mockCU.error).toHaveBeenCalledWith('boom');
  });

  it('cancel delegates with optional reason', async () => {
    const mockCU = makeMockCardUpdater() as any;
    const updater = new FeishuStreamUpdater(mockCU);
    await updater.cancel('user requested');
    expect(mockCU.cancel).toHaveBeenCalledWith('user requested');
  });

  it('getCardUpdater returns underlying instance for interface-external methods', () => {
    const mockCU = makeMockCardUpdater() as any;
    const updater = new FeishuStreamUpdater(mockCU);
    // handleChatStreaming 需要调 cardUpdater.shouldFallbackToText / truncateContent / getCardMessageId / dispose
    // 这些不在 StreamUpdater 接口里，通过 getCardUpdater() 直接访问
    expect(updater.getCardUpdater()).toBe(mockCU);
  });
});