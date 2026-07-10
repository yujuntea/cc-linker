// tests/unit/utils/img-proxy-daemon-health.test.ts
//
// Regression: imgProxyDaemonInstall 之前在 launchctl load/start 之后立即打印
// "✅ img-proxy 开机自启已配置",不验证 launchd 真的进入 running 状态。
// 历史上 plist 写错(相对路径 executable)时,launchd 一直 EX_CONFIG 重启,
// 8765 永远不可访问,但 setup 仍报成功 —— 误导用户"配置完成"实际服务挂掉。
//
// 本测试覆盖新的 runPostInstallHealthChecks():
//   - 全部检查通过 → result.ok = true
//   - 任何检查失败 → result.ok = false 并列出失败项
//   - 检查函数可以注入(避免在 CI 里跑 launchctl / curl 真实外部命令)
//
// 生产代码 daemon install 会在 load/start 后调用它,失败时显式报错 + exit 1,
// 不再"静默成功"。

import { describe, test, expect, mock } from 'bun:test';

import { runPostInstallHealthChecks, retryHealthCheck, type HealthCheck, type HealthCheckResult } from '../../../src/utils/daemon-health';

describe('runPostInstallHealthChecks', () => {
  test('所有检查都通过 → ok=true 且无 failed', async () => {
    const checks: HealthCheck[] = [
      { name: 'plist-loaded', run: async () => ({ ok: true }) },
      { name: 'port-listening', run: async () => ({ ok: true }) },
    ];
    const result = await runPostInstallHealthChecks(checks);
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
  });

  test('任意检查失败 → ok=false 且 failed 列出未通过项', async () => {
    const checks: HealthCheck[] = [
      { name: 'plist-loaded', run: async () => ({ ok: true }) },
      { name: 'port-listening', run: async () => ({ ok: false, message: 'port 8765 not listening' }) },
      { name: 'http-root', run: async () => ({ ok: false, message: 'curl HTTP 502' }) },
    ];
    const result = await runPostInstallHealthChecks(checks);
    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.map(f => f.name)).toEqual(['port-listening', 'http-root']);
    expect(result.failed[0].message).toContain('8765');
    expect(result.failed[1].message).toContain('502');
  });

  test('check.run 抛错 → 捕获并视为失败,带抛错信息', async () => {
    const checks: HealthCheck[] = [
      { name: 'plist-loaded', run: async () => ({ ok: true }) },
      { name: 'launchctl-print', run: async () => { throw new Error('launchctl not found'); } },
    ];
    const result = await runPostInstallHealthChecks(checks);
    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('launchctl-print');
    expect(result.failed[0].message).toContain('launchctl not found');
  });

  test('空检查列表 → 视为通过', async () => {
    const result = await runPostInstallHealthChecks([]);
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
  });
});

describe('retryHealthCheck (launchd 拉起后冷启动窗口)', () => {
  test('重试 N 次期间从失败变成功 → 最终 ok=true', async () => {
    let attempts = 0;
    const flaky: HealthCheck = {
      name: 'http-root',
      run: async () => {
        attempts++;
        return attempts >= 3 ? { ok: true } : { ok: false, message: 'cold start not ready' };
      },
    };
    const result = await retryHealthCheck(flaky, { attempts: 5, intervalMs: 10 });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  test('所有重试用完仍失败 → 失败,message 保留最后一次原因', async () => {
    const alwaysFail: HealthCheck = {
      name: 'port-listening',
      run: async () => ({ ok: false, message: 'port never opens' }),
    };
    const result = await retryHealthCheck(alwaysFail, { attempts: 3, intervalMs: 5 });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('port never opens');
  });

  test('check.run 抛错 → 视为失败,但继续重试', async () => {
    let attempts = 0;
    const flaky: HealthCheck = {
      name: 'plist-loaded',
      run: async () => {
        attempts++;
        if (attempts < 2) throw new Error('launchctl not found');
        return { ok: true };
      },
    };
    const result = await retryHealthCheck(flaky, { attempts: 3, intervalMs: 5 });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });
});
