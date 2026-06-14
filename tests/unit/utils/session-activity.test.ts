import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// Mock 整个 process-info 模块
mock.module('../../../src/utils/process-info', () => ({
  getClaudeProcessesByCwd: mock(() => []),
  getProcessCPUTimeSeconds: mock(() => Promise.resolve(0)),
  parsePsTimeToSeconds: (s: string) => {
    if (!s) return 0;
    let days = 0;
    let rest = s;
    if (rest.includes('-')) {
      days = parseInt(rest.slice(0, rest.indexOf('-')), 10) || 0;
      rest = rest.slice(rest.indexOf('-') + 1);
    }
    const parts = rest.split(':');
    if (parts.length === 3) return days * 86400 + parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    if (parts.length === 2) return days * 86400 + parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    return parseFloat(rest);
  },
}));

// ESM imports
import {
  writeActivityMarker,
  readLastActivityMarker,
  isSessionActive,
  SessionActivityCache,
  cleanupOldActivityLogs,
  isJSONLWrittenSince,
} from '../../../src/utils/session-activity';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('Activity Marker (sidecar)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = `/tmp/cc-linker-test-${Date.now()}-${Math.random()}`;
    process.env.CC_LINKER_DIR = testDir;
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('write + read 最近的 marker', async () => {
    writeActivityMarker('11111111-1111-1111-1111-111111111111', 'feishu', 'start', 12345);
    writeActivityMarker('11111111-1111-1111-1111-111111111111', 'feishu', 'heartbeat', 12345);
    const marker = readLastActivityMarker('11111111-1111-1111-1111-111111111111');
    expect(marker?.action).toBe('heartbeat');
    expect(marker?.platform).toBe('feishu');
    expect(marker?.pid).toBe(12345);
  });

  test('sidecar 文件不存在 → return null', async () => {
    expect(readLastActivityMarker('nonexistent')).toBeNull();
  });

  test('空 sessionUuid 保护', async () => {
    writeActivityMarker('', 'feishu', 'start');
    expect(readLastActivityMarker('')).toBeNull();
  });
});

describe('isSessionActive (combined)', () => {
  test('direction=cli-detects-feishu + 无 marker → inactive', async () => {
    const cache = new SessionActivityCache();
    const result = await isSessionActive(
      { sessionUuid: '22222222-2222-2222-2222-222222222222', cwd: '/tmp', jsonl_path: null },
      cache,
      'cli-detects-feishu'
    );
    expect(result.isProcessing).toBe(false);
    expect(result.confidence).toBe('medium');
    expect(result.reason).toBe('no_marker');
  });

  test('direction=cli-detects-feishu + no_session_uuid → low confidence', async () => {
    const cache = new SessionActivityCache();
    const result = await isSessionActive(
      { sessionUuid: null, cwd: '/tmp', jsonl_path: null },
      cache,
      'cli-detects-feishu'
    );
    expect(result.isProcessing).toBe(false);
    expect(result.confidence).toBe('low');
  });

  test('缓存命中：第二次调用不重新检测', async () => {
    const cache = new SessionActivityCache();
    const entry = { sessionUuid: '33333333-3333-3333-3333-333333333333', cwd: '/tmp', jsonl_path: null };

    writeActivityMarker('33333333-3333-3333-3333-333333333333', 'feishu', 'start');
    const r1 = await isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r1.source).toBe('marker');

    cleanupOldActivityLogs(0);  // 删除所有
    const r2 = await isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r2).toBe(r1);  // 同一对象引用
  });

  test('缓存失效：invalidate 后重新检测', async () => {
    const cache = new SessionActivityCache();
    const entry = { sessionUuid: '44444444-4444-4444-4444-444444444444', cwd: '/tmp', jsonl_path: null };

    writeActivityMarker('44444444-4444-4444-4444-444444444444', 'feishu', 'end');
    const r1 = await isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r1.isProcessing).toBe(false);

    cache.invalidate('cli-detects-feishu:44444444-4444-4444-4444-444444444444');

    writeActivityMarker('44444444-4444-4444-4444-444444444444', 'feishu', 'heartbeat');
    const r2 = await isSessionActive(entry, cache, 'cli-detects-feishu');
    expect(r2.isProcessing).toBe(true);
  });

  // 回归测试：修复前 feishu-detects-cli 方向不查 marker，SDK 启动的 session
  // 总是被判为 inactive (因为 SDK 不 spawn 子 claude 进程).
  // 修复后 marker 是最权威信号，应返回 isProcessing=true.
  test('feishu-detects-cli + SDK marker (heartbeat) → isProcessing=true', async () => {
    const cache = new SessionActivityCache();
    const entry = {
      sessionUuid: '55555555-5555-5555-5555-555555555555',
      cwd: '/Users/tester/Git/testLinker',
      jsonl_path: null,
    };
    // SDK 在 sendSDKMessage 调 writeActivityMarker(... 'feishu' 'heartbeat' ...)
    writeActivityMarker('55555555-5555-5555-5555-555555555555', 'feishu', 'heartbeat');
    const r = await isSessionActive(entry, cache, 'feishu-detects-cli');
    expect(r.isProcessing).toBe(true);
    expect(r.source).toBe('marker');
  });

  test('feishu-detects-cli + SDK marker (end) → isProcessing=false', async () => {
    const cache = new SessionActivityCache();
    const entry = {
      sessionUuid: '66666666-6666-6666-6666-666666666666',
      cwd: '/Users/tester/Git/testLinker',
      jsonl_path: null,
    };
    writeActivityMarker('66666666-6666-6666-6666-666666666666', 'feishu', 'end');
    const r = await isSessionActive(entry, cache, 'feishu-detects-cli');
    expect(r.isProcessing).toBe(false);
    expect(r.source).toBe('marker');
  });

  test('feishu-detects-cli + 无 marker + 无进程 → isProcessing=false', async () => {
    // 模拟 CLI session 已结束 (无 marker, JSONL mtime 在 setup 时未写)
    const cache = new SessionActivityCache();
    const entry = {
      sessionUuid: '77777777-7777-7777-7777-777777777777',
      cwd: '/Users/tester/Git/testLinker',
      jsonl_path: null,
    };
    const r = await isSessionActive(entry, cache, 'feishu-detects-cli');
    expect(r.isProcessing).toBe(false);
  });
});

describe('SessionActivityCache', () => {
  test('默认 TTL 10 秒', () => {
    const cache = new SessionActivityCache();
    cache.set('key', { isProcessing: true, confidence: 'high', reason: 'test', source: 'marker' });
    expect(cache.get('key')?.isProcessing).toBe(true);
  });

  test('自定义 TTL', async () => {
    const cache = new SessionActivityCache(50);
    cache.set('key', { isProcessing: true, confidence: 'high', reason: 'test', source: 'marker' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(cache.get('key')).toBeNull();
  });
});

describe('isJSONLWrittenSince', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = `/tmp/cc-linker-test-${Date.now()}-${Math.random()}`;
    process.env.CC_LINKER_DIR = testDir;
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('文件不存在 → written=false, ageMs=Infinity', async () => {
    const result = await isJSONLWrittenSince('/nonexistent/path.jsonl');
    expect(result.written).toBe(false);
    expect(result.ageMs).toBe(Infinity);
  });

  test('文件未变化 → written=false, ageMs > 0', async () => {
    const path = join(testDir, 'test.jsonl');
    writeFileSync(path, '{"type":"user"}\n', 'utf8');
    const result = await isJSONLWrittenSince(path, 100);
    expect(result.written).toBe(false);
    expect(result.ageMs).toBeGreaterThanOrEqual(0);
  });

  test('文件在采样期间被追加 → written=true, ageMs=0', async () => {
    const path = join(testDir, 'test.jsonl');
    writeFileSync(path, '{"type":"user"}\n', 'utf8');

    // 在后台延迟追加文件
    setTimeout(() => {
      writeFileSync(path, '{"type":"assistant"}\n', { flag: 'a' });
    }, 50);

    const result = await isJSONLWrittenSince(path, 200);
    expect(result.written).toBe(true);
    expect(result.ageMs).toBe(0);
  });

});

describe('cleanupOldActivityLogs', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = `/tmp/cc-linker-test-${Date.now()}-${Math.random()}`;
    process.env.CC_LINKER_DIR = testDir;
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('清理过期文件并返回数量', async () => {
    const activityDir = join(testDir, 'activity');
    mkdirSync(activityDir, { recursive: true });

    // 写入一个旧文件（mtime 设为 25 小时前）
    const oldPath = join(activityDir, 'old-session.log');
    writeFileSync(oldPath, '{"type":"activity_marker"}\n', 'utf8');
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { utimesSync } = await import('fs');
    utimesSync(oldPath, oldDate, oldDate);

    // 写入一个新文件
    const newPath = join(activityDir, 'new-session.log');
    writeFileSync(newPath, '{"type":"activity_marker"}\n', 'utf8');

    // 传入自定义目录进行测试
    const cleaned = cleanupOldActivityLogs(24, activityDir);
    expect(cleaned).toBe(1);

    const { existsSync } = await import('fs');
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });

  test('activity 目录不存在 → 返回 0', () => {
    const cleaned = cleanupOldActivityLogs(24, '/nonexistent/activity/dir');
    expect(cleaned).toBe(0);
  });
});
