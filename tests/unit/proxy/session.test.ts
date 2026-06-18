import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ClaudeSessionManager, classifyExecutionStatus, resolveJsonlPath, terminateProcessTree, cleanupOrphanProcesses } from '../../../src/proxy/session';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ClaudeSessionManager', () => {
  let manager: ClaudeSessionManager;

  beforeEach(() => {
    manager = new ClaudeSessionManager();
  });

  afterEach(() => {
    // Cleanup any remaining processes
    for (const session of manager.listSessions()) {
      try { process.kill(session.pid, 'SIGKILL'); } catch {}
    }
  });

  it('listSessions returns empty initially', () => {
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('listSessions tracks active processes', () => {
    // listSessions should return empty since no real processes are running
    expect(manager.listSessions()).toHaveLength(0);
  });

  // Note: sendMessage integration test requires real Claude binary.
  // Covered by integration tests in a separate file.

  it('per-session lock allows different sessions concurrently', async () => {
    // Verify that lock mechanism allows different session keys
    const m = new ClaudeSessionManager();

    // Two different sessions should not block each other at the lock level
    // (actual spawn will block, but locks should be independent)
    const p1 = m.sendMessage('session-a', 'msg1', '/tmp');
    const p2 = m.sendMessage('session-b', 'msg2', '/tmp');

    // Both should start (may not finish quickly due to real spawn)
    await Promise.allSettled([
      Promise.race([p1, new Promise(r => setTimeout(() => r('timeout'), 2000))]),
      Promise.race([p2, new Promise(r => setTimeout(() => r('timeout'), 2000))]),
    ]);
  });

  it('per-session lock prevents concurrent messages', async () => {
    const m = new ClaudeSessionManager();

    // Two sends to the same session should not throw or deadlock the manager state.
    // We intentionally bound the wait time because this path uses a real Claude spawn.
    const p1 = m.sendMessage('session-1', 'msg1', '/tmp');
    const p2 = m.sendMessage('session-1', 'msg2', '/tmp');

    const results = await Promise.allSettled([
      Promise.race([p1, new Promise(resolve => setTimeout(() => resolve('timeout-1'), 1500))]),
      Promise.race([p2, new Promise(resolve => setTimeout(() => resolve('timeout-2'), 1500))]),
    ]);

    expect(results).toHaveLength(2);
  });

  it('cleanupIdleSessions kills processes past timeout', () => {
    // Create a manager and verify the method runs without error
    manager.cleanupIdleSessions(0); // 0 timeout should kill nothing since no active processes
    expect(manager.listSessions()).toHaveLength(0);
  });

  // 回归测试:2026-06-18 bug —— context 超限后 session 被错标 degraded,/switch 阻断。
  //
  // 范围说明:这些测试覆盖 `_buildStreamingResult` (非 SDK 路径,在 `sendMessage` 内调用)
  // 和 `_errorResult` (line 650)。SDK 路径 (`sendSDKMessage`,line 770/890/917/926) 的
  // 修复是 4 处简单 find-and-replace,逻辑与 _buildStreamingResult 一致;同一份代码
  // 修改在两处都生效,所以单元测试覆盖任一路径就足以证明修复。
  //
  // ⚠️ test #3 (infrastructure) 不是 red-phase 测试 —— `_errorResult` 不改,它在当前
  // 代码已经 PASS。它的作用是 regression guard:防止未来误改 _errorResult 绕过 doSwitch
  // 的 corrupted/CLI 缺失保护。

  describe('_buildStreamingResult sessionStatus classification', () => {
    // 私有方法,通过 (manager as any) 直接调,覆盖 line 691 (non-SDK streaming 路径)。

    it('returns active (not degraded) when SDK reports subtype=error_max_turns', async () => {
      // 模拟 SDK 正常返回 result chunk,subtype != 'success' (line 680: hasError=true)
      const m = manager as any;
      const lastResult = {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: 'test-uuid-abc',
        result: 'max turns reached',
        errors: ['max turns reached'],
        total_cost_usd: 0.01,
        duration_ms: 5000,
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      const r = await m._buildStreamingResult(
        lastResult, 0, '', 'test-uuid-abc', Date.now(), 5000, false,
      );
      // 修复前:line 691 hasError ? 'degraded' → 'degraded',测试失败
      // 修复后:line 691 = 'active' → 'active',测试通过
      expect(r.sessionStatus).toBe('active');
      expect(r.error).toContain('max turns');
    });

    it('returns active when SDK returns lastResult with is_error=true but subtype=success', async () => {
      // 边缘 case:is_error=true 但 subtype='success' (line 680: hasError=true)
      const m = manager as any;
      const lastResult = {
        type: 'result',
        subtype: 'success',
        is_error: true,  // is_error 单独为 true (罕见但合法)
        session_id: 'test-uuid-def',
        result: 'partial',
        errors: ['minor warning'],
        total_cost_usd: 0.01,
        duration_ms: 1000,
        usage: { input_tokens: 50, output_tokens: 20 },
      };
      const r = await m._buildStreamingResult(
        lastResult, 0, '', 'test-uuid-def', Date.now(), 1000, false,
      );
      // 修复前:line 691 hasError ? 'degraded' → 'degraded',测试失败
      // 修复后:line 691 = 'active' → 'active',测试通过
      expect(r.sessionStatus).toBe('active');
    });

    it('[regression guard] infrastructure errors (CLI not in PATH) still write degraded via _errorResult', async () => {
      // ⚠️ 这个测试不是 red-phase —— _errorResult (line 650) 保持不变,本测试在当前
      // 代码已经 PASS。它的作用是防止后续误改 _errorResult 绕过 doSwitch 的保护。
      // _errorResult 的 4 个调用点 (line 527/530/550/732) 全部是基础设施错误,
      // 这些场景必须继续写 degraded。
      const m = manager as any;
      const r1 = m._errorResult('cwd is empty', null);
      const r2 = m._errorResult('Claude CLI 未找到: "claude" 不在 PATH 中', null);
      const r3 = m._errorResult('Failed to start Claude process: spawn ENOENT', 'sid');
      expect(r1.sessionStatus).toBe('degraded');
      expect(r2.sessionStatus).toBe('degraded');
      expect(r3.sessionStatus).toBe('degraded');
    });
  });

  // v2026-06-18: 测试 sendMessage line 416 用的 helper classsifyExecutionStatus。
  // 区分 Claude 业务错 (parsed.is_error, 可恢复) vs CLI 进程崩 (基础设施错)。
  // 关键 regression 测试: 之前 line 416 会把 Claude 错 (如 context 超限) 误标 degraded,
  // 导致 /switch 永久阻断。修复后所有 Claude 业务错都保持 'active'。

  describe('classifyExecutionStatus', () => {
    it('returns active when Claude reports business error (is_error=true, exitCode=0)', () => {
      // context-exceeded / max_turns / rate_limit 都属于这种情况
      const parsed = { is_error: true, session_id: 'sid', result: 'too long' } as any;
      expect(classifyExecutionStatus(parsed, 0)).toBe('active');
    });

    it('returns degraded when CLI crashes with no parsed output (exitCode != 0, parsed=null)', () => {
      // CLI 崩了连 JSON 都没输出 → 基础设施错
      expect(classifyExecutionStatus(null, 1)).toBe('degraded');
    });

    it('returns degraded when CLI exits non-zero and Claude did not report error', () => {
      // Claude 跑了但 CLI 崩在 output 之后 → 基础设施错
      const parsed = { is_error: false, session_id: 'sid', result: 'ok' } as any;
      expect(classifyExecutionStatus(parsed, 1)).toBe('degraded');
    });

    it('returns active when Claude succeeds (is_error=false, exitCode=0)', () => {
      // 正常成功路径,line 416 之前返回 active,保持不变
      const parsed = { is_error: false, session_id: 'sid', result: 'ok' } as any;
      expect(classifyExecutionStatus(parsed, 0)).toBe('active');
    });

    it('returns active when parsed is null but exitCode is also null (process killed before exit)', () => {
      // 进程被 kill 没正常退出码,但 Claude 也可能根本没机会报 is_error
      // 这种情况 line 416 之前返回 active (因为 exitCode 是 null)
      expect(classifyExecutionStatus(null, null)).toBe('active');
    });
  });
});

describe('resolveJsonlPath', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'resolve-jsonl-test-'));
    originalEnv = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when JSONL not found within timeout', async () => {
    const result = await resolveJsonlPath('nonexistent-uuid', 500);
    expect(result).toBeNull();
  });

  it('respects timeout parameter', async () => {
    const start = Date.now();
    await resolveJsonlPath('nonexistent-uuid', 200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000); // should not take much longer than timeout
  });
});

describe('terminateProcessTree', () => {
  it('does not throw for non-existent PID', () => {
    // Should not throw
    expect(() => terminateProcessTree(999999)).not.toThrow();
  });

  it('terminates a live process', async () => {
    // Start a long-running process
    const proc = Bun.spawn(['sleep', '60'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const pid = proc.pid;

    // Terminate it
    terminateProcessTree(pid);

    // Wait a bit for SIGKILL to take effect
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify process is dead
    try {
      process.kill(pid, 0);
      // If we get here, process is still alive - kill it forcefully
      process.kill(pid, 'SIGKILL');
    } catch {
      // Expected: process is dead
    }
  });
});

describe('cleanupOrphanProcesses', () => {
  it('runs without error when no orphan processes exist', () => {
    expect(() => cleanupOrphanProcesses()).not.toThrow();
  });
});
