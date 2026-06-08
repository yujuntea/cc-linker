// tests/unit/feishu/patch.test.ts
//
// v2.2.20 regression test:agent-view 的 patchFn 必须默认 1200ms 延迟(避开飞书
// card action event lock),叠加 Peek 卡 update_multi:true 才能正常渲染新内容。
//
// 实测证据(2026-06-08 22:38 用户 Peek Refresh 测试):
//   - 飞书 API 返回 success(code=0, msg="success")
//   - patch 内容是最新数据(PID/Started/Recent output 都对)
//   - 但飞书客户端不渲染(0ms 延迟下 patch 落在 card action lock 窗口内)
//
// 旧版 start.ts:411-435 写死 1200ms,叠加缺 update_multi:true → 出现
// "内容先刷新后被旧内容覆盖"的 revert bug(单帧新内容,客户端 revert 到原卡)。
// 现在的目标状态:1200ms 延迟 + update_multi:true → 锁外发 patch,客户端正常
// 持久渲染新内容。

import { describe, test, expect, mock } from 'bun:test';
import { createPatchFn } from '../../../src/feishu/patch';

const noopLog = () => {};

describe('createPatchFn (v2.2.20: agent-view default 1200ms delay)', () => {
  test('默认 delayMs=1200:patch 真的延迟 ~1200ms(避开飞书 card action lock)', async () => {
    let patchCalledAt = 0;
    const startedAt = Date.now();
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => {
              patchCalledAt = Date.now();
              return { code: 0, data: {} };
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, noopLog);
    await patchFn('om_test', '{"foo":"bar"}');
    const elapsed = patchCalledAt - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1150);
    expect(elapsed).toBeLessThan(1400);
  });

  test('forceImmediate=true 跳过延迟(测试模式加速用)', async () => {
    let patchCalledAt = 0;
    const startedAt = Date.now();
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => {
              patchCalledAt = Date.now();
              return { code: 0, data: {} };
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, noopLog, { forceImmediate: true });
    await patchFn('om_test', '{"foo":"bar"}');
    const elapsed = patchCalledAt - startedAt;
    expect(elapsed).toBeLessThan(50);
  });

  test('显式传 delayMs=300:自定义延迟生效', async () => {
    let patchCalledAt = 0;
    const startedAt = Date.now();
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => {
              patchCalledAt = Date.now();
              return { code: 0, data: {} };
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, noopLog, { delayMs: 300 });
    await patchFn('om_test', '{"foo":"bar"}');
    const elapsed = patchCalledAt - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(400);
  });

  test('feishu 返回非 0 code:记 WARN,返回 null,不发异常', async () => {
    const logMessages: string[] = [];
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => ({
              code: 230020,
              msg: 'card not found',
            })),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, (level, msg) => {
      logMessages.push(`${level}:${msg}`);
    });
    const result = await patchFn('om_gone', '{}');
    expect(result).toBeNull();
    expect(logMessages.some(m => m.startsWith('WARN'))).toBe(true);
  });

  test('feishu 抛异常:记 WARN,返回 null,不冒泡', async () => {
    const logMessages: string[] = [];
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (_payload: any) => {
              throw new Error('network down');
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, (level, msg) => {
      logMessages.push(`${level}:${msg}`);
    });
    const result = await patchFn('om_x', '{}');
    expect(result).toBeNull();
    expect(logMessages.some(m => m.includes('network down'))).toBe(true);
  });

  test('payload 正确传给 feishu client(包含 message_id 和 content)', async () => {
    let captured: any = null;
    const client = {
      im: {
        v1: {
          message: {
            patch: mock(async (payload: any) => {
              captured = payload;
              return { code: 0, data: {} };
            }),
          },
        },
      },
    };
    const patchFn = createPatchFn(client, noopLog, { forceImmediate: true });
    await patchFn('om_xyz', '{"config":{"wide_screen_mode":true}}');
    expect(captured.path.message_id).toBe('om_xyz');
    expect(captured.data.content).toBe('{"config":{"wide_screen_mode":true}}');
  });
});
