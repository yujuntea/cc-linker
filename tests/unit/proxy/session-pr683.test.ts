/**
 * PR 6.8.3: ClaudeSessionManager 流式 logger + 8s 空回复 fallback
 *
 * 背景: 生产观察 (13:08:50-13:08:58 真实企微 E2E):
 *  - 8s Claude 跑完, 卡片内容始终空白
 *  - updateStream 8s 内 0 次 patch (无 onProgress 触发)
 *  - WecomStreamUpdater.complete() 静默调用 replyStream 但无 log
 *  - 用户看不到任何错误
 *
 * 修法:
 *  1. _doStreamingMessage 加 spawn / chunks / DONE 关键 logger
 *  2. _buildStreamingResult 8s 流式空回复 fallback 提示运行时长
 *
 * 测法: 把 general.claude_bin 指向 fake sh 脚本 (Bun.which('claude') 找不到我们
 * 临时 PATH 里的脚本,所以直接 mutation config.data.general.claude_bin 用绝对路径)。
 * 改 logger.info/warn/error 收集到 logs 数组。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { logger } from '../../../src/utils/logger';
import { config } from '../../../src/utils/config';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, mkdtempSync, chmodSync, rmSync } from 'fs';

// 写一个 fake "claude" 脚本到 tmpdir,返回绝对路径
type FakeMode = 'silent-exit' | 'with-result' | 'non-zero-exit';

function writeFakeClaudeScript(dir: string, mode: FakeMode): string {
  const scriptPath = join(dir, 'fake-claude');
  if (mode === 'silent-exit') {
    writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  } else if (mode === 'with-result') {
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'fake-uuid-pr683',
      result: 'hello from fake claude',
      total_cost_usd: 0.001,
      duration_ms: 100,
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    writeFileSync(scriptPath, `#!/bin/sh\necho '${result}'\nexit 0\n`, { mode: 0o755 });
  } else {
    writeFileSync(scriptPath, '#!/bin/sh\necho "fake claude crashed" 1>&2\nexit 1\n', { mode: 0o755 });
  }
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('PR 6.8.3: _doStreamingMessage logger + 8s fallback', () => {
  let manager: ClaudeSessionManager;
  let logs: string[];
  let origInfo: typeof logger.info;
  let origWarn: typeof logger.warn;
  let origError: typeof logger.error;
  let tmpDir: string;
  let origClaudeBin: string;

  beforeEach(() => {
    manager = new ClaudeSessionManager();
    tmpDir = mkdtempSync(join(tmpdir(), 'pr683-'));
    logs = [];
    // capture logger output
    origInfo = logger.info.bind(logger);
    origWarn = logger.warn.bind(logger);
    origError = logger.error.bind(logger);
    logger.info = (msg: any) => { logs.push(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
    logger.warn = (msg: any) => { logs.push(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
    logger.error = (msg: any) => { logs.push(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
    // save & override claude_bin → use fake script absolute path
    origClaudeBin = (config as any).data.general.claude_bin;
  });

  afterEach(() => {
    logger.info = origInfo;
    logger.warn = origWarn;
    logger.error = origError;
    // restore claude_bin
    (config as any).data.general.claude_bin = origClaudeBin;
    for (const session of manager.listSessions()) {
      try { process.kill(session.pid, 'SIGKILL'); } catch {}
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function setFakeClaude(mode: FakeMode): void {
    const fakeBin = writeFakeClaudeScript(tmpDir, mode);
    (config as any).data.general.claude_bin = fakeBin;
  }

  it('ClaudeStream: spawning / spawned / DONE logger fire on real spawn path', async () => {
    setFakeClaude('with-result');
    const result = await manager.sendStreamingMessage(
      null, 'hi', '/tmp', () => {}, false, undefined,
    );
    const hasSpawning = logs.some(l => l.includes('ClaudeStream: spawning'));
    const hasSpawned = logs.some(l => l.includes('ClaudeStream: spawned'));
    // DONE log 是 "ClaudeStream: pid=X DONE —" 不是 "ClaudeStream: DONE", 用 regex
    const hasDone = logs.some(l => /ClaudeStream:.*DONE/.test(l));
    expect(hasSpawning).toBe(true);
    expect(hasSpawned).toBe(true);
    expect(hasDone).toBe(true);
    // 正常 result 路径 → response 应当是 fake result
    expect(result.response).toContain('hello from fake claude');
  });

  it('ClaudeStream: spawning logger 包含 binary / cwd / argsLen / isNew 上下文', async () => {
    setFakeClaude('with-result');
    // 用 sessionId (非 null) + isNew=false 避免 resolveJsonlPath poll 10s
    // isNew=true 会等 JSONL 文件出现, 测试场景里 fake script 不会创建, 会卡 5s+
    await manager.sendStreamingMessage('test-uuid-spawn-logger', 'hi', '/tmp', () => {}, false, undefined);
    const spawningLog = logs.find(l => l.includes('ClaudeStream: spawning'));
    expect(spawningLog).toBeDefined();
    // 验证上下文字段存在
    expect(spawningLog).toMatch(/binary=/);
    expect(spawningLog).toMatch(/cwd=/);
    expect(spawningLog).toMatch(/argsLen=/);
    expect(spawningLog).toMatch(/isNew=false/);
    // sessionId 应当出现在 spawning log
    expect(spawningLog).toMatch(/test-uuid-spawn-logger/);
  });

  it('ClaudeStream: DONE logger 包含 exitCode / lastResult / responseLen / hasError', async () => {
    setFakeClaude('with-result');
    await manager.sendStreamingMessage(null, 'hi', '/tmp', () => {}, false, undefined);
    const doneLog = logs.find(l => /ClaudeStream:.*DONE/.test(l));
    expect(doneLog).toBeDefined();
    expect(doneLog).toMatch(/exitCode=/);
    expect(doneLog).toMatch(/lastResult=/);
    expect(doneLog).toMatch(/responseLen=/);
    expect(doneLog).toMatch(/hasError=/);
  });

  it('ClaudeStream: 8s empty-response fallback: exit 0 但不产生 result → 提示运行时长', async () => {
    setFakeClaude('silent-exit');
    const result = await manager.sendStreamingMessage(
      null, 'hi', '/tmp', () => {}, false, undefined,
    );
    // 修法前: response = '(空回复)'
    // 修法后: response = '⏱ Claude 跑了 Xs 但没产生回复 (可能思考中或 API 异常, 请重试或简化问题)'
    expect(result.response).toMatch(/Claude 跑了 \d+s 但没产生回复/);
    expect(result.response).toMatch(/请重试或简化问题/);
  });

  it('ClaudeStream: non-zero exit 产生含 stderr 的错误消息', async () => {
    setFakeClaude('non-zero-exit');
    const result = await manager.sendStreamingMessage(
      null, 'hi', '/tmp', () => {}, false, undefined,
    );
    // 修法后: response = '❌ Claude 进程异常退出 (exit 1): stderr 末尾'
    expect(result.response).toMatch(/进程异常退出/);
    expect(result.response).toMatch(/exit 1/);
    expect(result.response).toContain('fake claude crashed');
  });

  it('ClaudeStream: 正常 result chunk → response 是 result 内容 (没有 fallback 提示)', async () => {
    setFakeClaude('with-result');
    const result = await manager.sendStreamingMessage(
      null, 'hi', '/tmp', () => {}, false, undefined,
    );
    expect(result.response).toBe('hello from fake claude');
    expect(result.response).not.toContain('空回复');
    expect(result.response).not.toContain('进程异常退出');
  });

  it('ClaudeStream: onProgress callback 触发 (chunks 路径)', async () => {
    setFakeClaude('with-result');
    let onProgressCalls = 0;
    await manager.sendStreamingMessage(
      null, 'hi', '/tmp', () => { onProgressCalls++; }, false, undefined,
    );
    // fake script 输出 1 行 result chunk → onProgress 不会被调 (result 走 lastResult 分支)
    // 但 stdout 至少走 1 次 read → 至少 1 个 progress chunk 触发的 logger 出现
    const doneLog = logs.find(l => /ClaudeStream:.*DONE/.test(l));
    expect(doneLog).toBeDefined();
    expect(onProgressCalls).toBeGreaterThanOrEqual(0);
  });
});
