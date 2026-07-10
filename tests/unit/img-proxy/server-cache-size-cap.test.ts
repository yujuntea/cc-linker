// tests/unit/img-proxy/server-cache-size-cap.test.ts
//
// 2026-07-10 配套 P2-3:测 cleanupOldCache 的 size-based cap。
// 覆盖:mtime 7 天 TTL 仍工作 / size cap 触发时从最旧删 / 删到 cap 以内停。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { cleanupOldCache } from '../../../src/img-proxy/server';

describe('cleanupOldCache (P2-3 size cap)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccl-cache-cap-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper:造一个指定 size + mtime 的文件
  function makeFile(name: string, sizeBytes: number, mtime: Date): void {
    const path = join(tmpDir, name);
    const buf = Buffer.alloc(sizeBytes, 'x');
    writeFileSync(path, buf);
    utimesSync(path, mtime, mtime);
  }

  it('respects mtime 7-day TTL (existing behavior preserved)', () => {
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);  // 8 天前
    const fresh = new Date(Date.now() - 1 * 3600 * 1000);     // 1 小时前
    makeFile('old.png', 100, old);
    makeFile('fresh.png', 100, fresh);
    const cleaned = cleanupOldCache(tmpDir, 24 * 7, 1024 * 1024 * 1024);  // 7 天, 1GB cap
    expect(cleaned).toBe(1);
    expect(readdirSync(tmpDir)).toEqual(['fresh.png']);
  });

  it('triggers size cap: deletes oldest files until under cap', () => {
    // cap = 300 bytes, 4 files × 100 bytes each = 400 bytes → 删 1 个最旧的
    const oldest = new Date(Date.now() - 4 * 3600 * 1000);    // 4 小时前(最旧)
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    const recent = new Date(Date.now() - 2 * 3600 * 1000);
    const newest = new Date(Date.now() - 1 * 3600 * 1000);     // 1 小时前(最新)
    makeFile('oldest.png', 100, oldest);
    makeFile('old.png', 100, old);
    makeFile('recent.png', 100, recent);
    makeFile('newest.png', 100, newest);
    // 4 files × 100 bytes = 400,cap 300 → 删 oldest (剩 300)
    const cleaned = cleanupOldCache(tmpDir, 24 * 7, 300);
    expect(cleaned).toBe(1);
    const remaining = readdirSync(tmpDir).sort();
    expect(remaining).toEqual(['newest.png', 'old.png', 'recent.png']);
  });

  it('size cap stops deleting once under threshold', () => {
    // cap = 1000 bytes, files 100+200+300 = 600 < 1000 → 不删
    const now = new Date();
    makeFile('a.png', 100, now);
    makeFile('b.png', 200, now);
    makeFile('c.png', 300, now);
    const cleaned = cleanupOldCache(tmpDir, 24 * 7, 1000);
    expect(cleaned).toBe(0);
    expect(readdirSync(tmpDir).sort()).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('combines mtime + size cleanup in one pass', () => {
    // 一个文件超 TTL(8 天前),一个文件超 size cap(超 1KB),一个正常
    const oldMtime = new Date(Date.now() - 8 * 24 * 3600 * 1000);  // 8 天前
    const now = new Date();
    makeFile('old.png', 100, oldMtime);     // 会被 mtime 删
    makeFile('big.png', 2000, now);          // 会被 size 删
    makeFile('normal.png', 50, now);         // 保留
    // cap = 500:normal 50 + big 2000 = 2050 > 500 → 删一个最旧的
    // 但 old 已经被 mtime 删了,所以 size 路径只剩 big 2000 + normal 50 = 2050 > 500 → 删 big
    const cleaned = cleanupOldCache(tmpDir, 24 * 7, 500);
    expect(cleaned).toBe(2);  // old (mtime) + big (size)
    expect(readdirSync(tmpDir)).toEqual(['normal.png']);
  });

  it('returns 0 on empty / non-existent dir', () => {
    expect(cleanupOldCache(tmpDir, 24 * 7, 1024 * 1024 * 1024)).toBe(0);
    const nonExistent = join(tmpDir, 'does-not-exist');
    expect(cleanupOldCache(nonExistent, 24 * 7, 1024 * 1024 * 1024)).toBe(0);
  });

  it('skips subdirectories (only cleans files)', () => {
    // 制造一个子目录 + 一个文件
    const now = new Date();
    writeFileSync(join(tmpDir, 'a.png'), Buffer.alloc(100, 'x'));
    // 建子目录
    const subdir = join(tmpDir, 'subdir');
    require('fs').mkdirSync(subdir);
    writeFileSync(join(subdir, 'nested.png'), Buffer.alloc(100, 'x'));
    // cap 50 → a.png 删 (subdir 不计入)
    const cleaned = cleanupOldCache(tmpDir, 24 * 7, 50);
    expect(cleaned).toBe(1);
    expect(readdirSync(tmpDir).sort()).toEqual(['subdir']);
  });

  // 2026-07-10 回归:cache dir 在 existsSync 检查之后被删除 (用户手动 rm / install
  // hook race / 另一个 daemon 的 cleanup 竞争) → readdirSync 抛 ENOENT。修前会让
  // startup 路径 daemon 进程直接 crash。修后 readdirSync 包 try/catch,dir 消失返
  // 0,与 existsSync=false 等价(都是"没东西可清"语义)。
  it('returns 0 (does not throw) when cacheDir is removed mid-call', () => {
    const cacheDir = join(tmpDir, 'racey');
    require('fs').mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, 'a.png'), Buffer.alloc(100, 'x'));
    // 直接删 cacheDir,模拟 race;cleanupOldCache 应 silent 返 0 不 throw
    rmSync(cacheDir, { recursive: true, force: true });
    let thrown: unknown = null;
    let cleaned = -1;
    try {
      cleaned = cleanupOldCache(cacheDir, 24 * 7, 1024 * 1024);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();
    expect(cleaned).toBe(0);
  });
});
