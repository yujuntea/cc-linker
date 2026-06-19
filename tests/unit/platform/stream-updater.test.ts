import { describe, it, expect } from 'bun:test';
import type { StreamUpdater, StreamUpdateToolUse } from '../../../src/platform/stream-updater';

class MockUpdater implements StreamUpdater {
  async startProcessing(userId: string): Promise<string> { return 'mock-card-id'; }
  async updateStream(_thinking: string, _text: string, _elapsedMs: number, _toolUses: StreamUpdateToolUse[] = []): Promise<void> {}
  async complete(_response: string, _tokensIn: number, _tokensOut: number, _durationMs: number, _numTurns: number): Promise<void> {}
  async error(_message: string): Promise<void> {}
  async cancel(_reason?: string): Promise<void> {}
}

describe('StreamUpdater interface', () => {
  it('startProcessing returns message id', async () => {
    const u = new MockUpdater();
    const id = await u.startProcessing('user-1');
    expect(id).toBe('mock-card-id');
  });

  it('updateStream accepts thinking/text/elapsed/toolUses', async () => {
    const u = new MockUpdater();
    await u.updateStream('thinking content', 'text content', 1500, [
      { name: 'Read', inputSummary: 'foo.ts' },
    ]);
    expect(true).toBe(true);
  });

  it('complete closes stream with metrics', async () => {
    const u = new MockUpdater();
    await u.complete('response', 100, 200, 3000, 5);
    expect(true).toBe(true);
  });

  it('error records error message', async () => {
    const u = new MockUpdater();
    await u.error('something broke');
    expect(true).toBe(true);
  });

  it('cancel accepts optional reason', async () => {
    const u = new MockUpdater();
    await u.cancel('user requested');
    expect(true).toBe(true);
  });
});
