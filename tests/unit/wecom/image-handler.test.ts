import { describe, it, expect, beforeEach } from 'bun:test';
import { WecomImageHandler } from '../../../src/wecom/image-handler';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('WecomImageHandler', () => {
  let dir: string;
  let handler: WecomImageHandler;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wecom-img-'));
    handler = new WecomImageHandler({ cacheDir: dir });
  });

  it('fetchAsBase64: data: URL 直接返回 base64', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect(await handler.fetchAsBase64(url)).toBeTruthy();
  });

  it('cacheToDisk: 按 messageId 缓存 base64 到文件', () => {
    handler.cacheToDisk('msg-1', 'aGVsbG8=');
    expect(existsSync(join(dir, 'msg-1.bin'))).toBe(true);
    expect(readFileSync(join(dir, 'msg-1.bin'), 'utf8')).toBe('aGVsbG8=');
  });
});