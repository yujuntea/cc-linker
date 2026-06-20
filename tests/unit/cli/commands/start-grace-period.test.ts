import { describe, it, expect } from 'bun:test';

/**
 * PR 7 Task 7.6 (m-12): 30s grace period 优化
 *
 * 历史: startForeground 在创建共享 SpoolQueue / bot 前 hardcoded `await sleep(30_000)`,
 *   防止老 daemon 残留误判 (spec §3.4 grace period 设计).
 *   30_000 散在 setTimeout 调用里, 调 grace 长度要 grep 全文 + 跟 logger.info('活跃检测 grace period: 30 秒')
 *   文案同步改两处 (容易漏改 → log 文案跟实际值不一致).
 * 修法: 提常量 GRACE_PERIOD_MS = 30_000, logger.info 用同一常量拼文案,
 *   集中定义, 改动只动一处.
 */
describe('startForeground grace period (PR 7 Task 7.6: m-12)', () => {
  it('m-12: exports GRACE_PERIOD_MS = 30000 from start.ts', async () => {
    const mod = await import('../../../../src/cli/commands/start');
    expect((mod as any).GRACE_PERIOD_MS).toBe(30_000);
  });

  it('m-12: start.ts 用 GRACE_PERIOD_MS 常量代替 setTimeout 里的硬编码', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      require('path').resolve(__dirname, '../../../../src/cli/commands/start.ts'),
      'utf8',
    );
    // 期望: GRACE_PERIOD_MS 在 setTimeout 里被引用 (即 setTimeout(_, GRACE_PERIOD_MS))
    //   旧 hardcoded `setTimeout(_, 30_000)` 不应再出现
    expect(src).toMatch(/setTimeout\([^,]+,\s*GRACE_PERIOD_MS/);
    expect(src).not.toMatch(/setTimeout\([^,]+,\s*30_000/);
  });
});
