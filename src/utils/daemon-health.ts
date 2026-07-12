// src/utils/daemon-health.ts
//
// 安装后健康检查(launchd / 端口 / HTTP)—— 让 setup 不再"静默成功"。
//
// 历史:daemon install 在 launchctl load/start 之后只 print 成功,没有真正验证
// 8765 是否可访问 / launchd 是否进入 running 状态。相对路径 executable 写进
// plist 时,launchd 报 EX_CONFIG 一直重启,setup 仍报"已配置" —— 用户看到
// "完成"但浏览器永远打不开 Web Console。
//
// 设计:把检查抽象成可注入的 HealthCheck 列表,生产代码传 launchctl / curl
// 实测,测试可传 stub。这避免在单测里跑外部命令 + 副作用。
//
// 调用方负责 decide 失败时怎么报错(daemon install 当前是 exit 1 + 打印
// 失败项 + 引导用户看日志)。

export interface HealthCheckResult {
  ok: boolean;
  message?: string;
}

export interface HealthCheck {
  name: string;
  run: () => Promise<HealthCheckResult>;
}

export interface RunResult {
  ok: boolean;
  failed: Array<{ name: string; message: string }>;
}

export interface RetryOptions {
  attempts: number;
  intervalMs: number;
}

/**
 * 在 launchd 拉起后,bun runtime + 路由加载需要几秒,健康检查需要重试窗口。
 * 在 attempts 次内拿到 ok=true 就停;失败的话保留最后一次的 message。
 * check.run 抛错时视为失败并继续重试(launchctl / 网络瞬时错误)。
 */
export async function retryHealthCheck(
  check: HealthCheck,
  opts: RetryOptions,
): Promise<HealthCheckResult> {
  let lastMessage: string | undefined;
  for (let i = 0; i < opts.attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, opts.intervalMs));
    try {
      const res = await check.run();
      if (res.ok) return { ok: true };
      lastMessage = res.message;
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, message: lastMessage ?? 'check returned ok=false' };
}

export async function runPostInstallHealthChecks(checks: HealthCheck[]): Promise<RunResult> {
  const failed: Array<{ name: string; message: string }> = [];
  for (const c of checks) {
    let res: HealthCheckResult;
    try {
      res = await c.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ name: c.name, message });
      continue;
    }
    if (!res.ok) {
      failed.push({ name: c.name, message: res.message ?? 'check returned ok=false' });
    }
  }
  return { ok: failed.length === 0, failed };
}
