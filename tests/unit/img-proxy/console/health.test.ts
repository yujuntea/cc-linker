import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getCacheBytes, resetHealthCache } from '../../../../src/img-proxy/console/api';

describe('getCacheBytes', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-cache-'));
    resetHealthCache();
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('空目录返 0', () => {
    expect(getCacheBytes(tmpDir)).toBe(0);
  });

  it('计算所有文件 size 之和', () => {
    writeFileSync(join(tmpDir, 'a.png'), Buffer.alloc(100));
    writeFileSync(join(tmpDir, 'b.png'), Buffer.alloc(200));
    expect(getCacheBytes(tmpDir)).toBe(300);
  });

  it('5s 内复用 cache（修改文件不影响 cache）', () => {
    writeFileSync(join(tmpDir, 'a.png'), Buffer.alloc(100));
    expect(getCacheBytes(tmpDir)).toBe(100);
    writeFileSync(join(tmpDir, 'b.png'), Buffer.alloc(200));
    expect(getCacheBytes(tmpDir)).toBe(100);  // 还在 TTL 内
    resetHealthCache();
    expect(getCacheBytes(tmpDir)).toBe(300);  // reset 后重算
  });
});