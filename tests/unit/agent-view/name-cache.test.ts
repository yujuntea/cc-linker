// tests/unit/agent-view/name-cache.test.ts
//
// v2.2.6 name-cache 单测:capture/lookup/prune 三个核心 path 全覆盖。
// 用 tmp 路径注入,不碰真实 ~/.cc-linker/agent-names-cache.json。

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureNames, lookupName } from '../../../src/agent-view/name-cache';

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cc-linker-name-cache-'));
  cachePath = join(tmpDir, 'agent-names-cache.json');
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe('captureNames', () => {
  test('writes shortId → name entries to disk on first call', () => {
    captureNames(
      [
        { sessionId: '92664deb-f4b6-48d3-9cdd-85cf8eea6dfc', name: 'Design AI tool' },
        { sessionId: 'd78c8339-18b0-4f53-8452-d4228d30f51f', name: 'Print date' },
      ],
      Date.now(),
      cachePath,
    );

    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cache['92664deb'].name).toBe('Design AI tool');
    expect(cache['d78c8339'].name).toBe('Print date');
    expect(cache['92664deb'].sessionId).toBe('92664deb-f4b6-48d3-9cdd-85cf8eea6dfc');
  });

  test('overwrites stale entry when a new fetch sees the same short', () => {
    captureNames(
      [{ sessionId: 'abcd1234-old', name: 'first dispatch' }],
      1000,
      cachePath,
    );
    captureNames(
      [{ sessionId: 'abcd1234-new', name: 'second dispatch' }],
      2000,
      cachePath,
    );

    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cache['abcd1234'].name).toBe('second dispatch');
    expect(cache['abcd1234'].capturedAt).toBe(2000);
  });

  test("skips sessions without a name or with the 'unnamed' sentinel", () => {
    captureNames(
      [
        { sessionId: 'aaaa1111-...', name: '' }, // empty name
        { sessionId: 'bbbb2222-...', name: 'unnamed' }, // parseAgentsJson fallback
        { sessionId: 'cccc3333-...', name: 'real one' },
      ],
      Date.now(),
      cachePath,
    );

    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cache['aaaa1111']).toBeUndefined();
    expect(cache['bbbb2222']).toBeUndefined();
    expect(cache['cccc3333'].name).toBe('real one');
  });

  test('prunes entries older than 48h on every write', () => {
    const now = 100_000_000_000;
    // seed an old + a fresh entry directly
    writeFileSync(
      cachePath,
      JSON.stringify({
        oldddddd: { name: 'expired', sessionId: 'old-uuid', capturedAt: now - 49 * 3600_000 },
        fresh000: { name: 'still valid', sessionId: 'fresh-uuid', capturedAt: now - 1 * 3600_000 },
      }),
    );

    captureNames([{ sessionId: 'new00000-uuid', name: 'just captured' }], now, cachePath);

    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cache['oldddddd']).toBeUndefined(); // pruned
    expect(cache['fresh000']).toBeDefined();
    expect(cache['new00000']).toBeDefined();
  });

  test('no-op when input list has nothing cacheable and cache file does not exist', () => {
    captureNames([], Date.now(), cachePath);
    // 完全没写入条目时不创建空文件,避免无意义磁盘动作
    expect(existsSync(cachePath)).toBe(false);
  });
});

describe('lookupName', () => {
  test('returns the cached name when shortId is present', () => {
    captureNames(
      [{ sessionId: 'timer001-some-uuid', name: 'timer command response' }],
      Date.now(),
      cachePath,
    );

    expect(lookupName('timer001', cachePath)).toBe('timer command response');
  });

  test('returns undefined when shortId is not in cache', () => {
    expect(lookupName('missing0', cachePath)).toBeUndefined();
  });

  test('returns undefined when cache file is missing or corrupt', () => {
    // missing
    expect(lookupName('anyhash0', cachePath)).toBeUndefined();
    // corrupt
    writeFileSync(cachePath, '{ this is not valid json');
    expect(lookupName('anyhash0', cachePath)).toBeUndefined();
  });
});
