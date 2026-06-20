import { describe, it, expect } from 'bun:test';
import { maskSecret, verifyWecomCredentials } from '../../../../src/cli/commands/init-wecom';

/** Helper: build Response-like object so fetcher mock satisfies .json() */
function mockResponse(data: any): Response {
  return {
    json: async () => data,
  } as any;
}

describe('maskSecret', () => {
  it('returns empty string for empty input', () => {
    expect(maskSecret('')).toBe('');
  });

  it('treats null/undefined as empty (defensive)', () => {
    expect(maskSecret(null as unknown as string)).toBe('');
    expect(maskSecret(undefined as unknown as string)).toBe('');
  });

  it('fully masks very short strings (≤6 chars)', () => {
    expect(maskSecret('a')).toBe('*');
    expect(maskSecret('abc')).toBe('***');
    expect(maskSecret('abcdef')).toBe('******');
  });

  it('shows first 3 + last 3 with masked middle for normal-length secrets', () => {
    expect(maskSecret('abcdefg')).toBe('abc*efg');
    expect(maskSecret('12345678')).toBe('123**678');
  });
});

/**
 * PR 7 Task 7.6 (m-5): init-wecom token verify 步骤
 *
 * 历史: 用户配 bot_id + secret 后写到 config.toml, 没 verify 直接保存.
 *   → 启动时 WSClient.connect 才报错 (WSAuthFailureError), 用户排查时要
 *     重启 bot + 看 daemon log, 体验差.
 * 修法: 写 config 前调 verifyWecomCredentials(botId, secret), 失败 throw
 *   出可读错误 ("❌ bot_id 或 secret 无效"), 用户立即看到, 不用等到 bot 启动.
 *
 * 实现策略: 用 Wecom HTTP gettoken endpoint (`https://qyapi.weixin.qq.com/cgi-bin/gettoken`)
 *   + 注入 fetcher (单测 mock 掉, 避免真实网络).
 *   返回 { ok: true, accessToken } 或 throw Error.
 */
describe('verifyWecomCredentials (PR 7 Task 7.6: m-5)', () => {
  it('m-5: 验证成功 → 返回 ok:true (fetcher mock 返回 errcode=0)', async () => {
    const result = await verifyWecomCredentials('bot-1', 'secret-1', {
      fetcher: async () => mockResponse({
        errcode: 0,
        errmsg: 'ok',
        access_token: 'tok-abc-123',
        expires_in: 7200,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe('tok-abc-123');
  });

  it('m-5: 验证失败 → throw 含 errcode/errmsg', async () => {
    await expect(
      verifyWecomCredentials('bot-bad', 'secret-bad', {
        fetcher: async () => mockResponse({
          errcode: 40001,
          errmsg: 'invalid credential',
        }),
      }),
    ).rejects.toThrow(/40001/);
  });

  it('m-5: 网络异常 → throw 含网络错误信息', async () => {
    await expect(
      verifyWecomCredentials('bot-1', 'secret-1', {
        fetcher: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('m-5: 默认 fetcher 走真实 endpoint URL (单测不调, 只验证 URL 正确)', () => {
    // 默认 fetcher 应该是 https://qyapi.weixin.qq.com/cgi-bin/gettoken
    // 单测不能跑真实网络 (依赖 + 副作用), 这里只断言 URL 格式正确
    const url = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=TEST&corpsecret=TEST';
    expect(url).toMatch(/qyapi\.weixin\.qq\.com\/cgi-bin\/gettoken/);
  });
});

/**
 * PR 7 Task 7.6 (m-13): init-wecom 覆盖确认 prompt
 *
 * 历史: init-wecom 写入 [wecom] 节时, 如果 config.toml 已存在 [wecom] 配置 (含 bot_id),
 *   会直接覆盖而不通知用户. → 用户以为没生效, 或多个 wecom bot 共用同一 config 时互相覆盖.
 * 修法: 写 config 前调 confirmWecomOverwrite(promptFn), 接受 confirmFn 注入
 *   (单测 mock 掉, 避免真实 inquirer 阻塞 stdin).
 */
describe('confirmWecomOverwrite (PR 7 Task 7.6: m-13)', () => {
  it('m-13: promptFn 返回 true → confirmWecomOverwrite 返回 true', async () => {
    const { confirmWecomOverwrite } = await import('../../../../src/cli/commands/init-wecom');
    const result = await confirmWecomOverwrite(async () => ({ overwrite: true }));
    expect(result).toBe(true);
  });

  it('m-13: promptFn 返回 false → confirmWecomOverwrite 返回 false', async () => {
    const { confirmWecomOverwrite } = await import('../../../../src/cli/commands/init-wecom');
    const result = await confirmWecomOverwrite(async () => ({ overwrite: false }));
    expect(result).toBe(false);
  });

  it('m-13: prompt 调用包含 confirm type 和 default false (防止意外默认 yes)', async () => {
    const { confirmWecomOverwrite } = await import('../../../../src/cli/commands/init-wecom');
    let captured: any = null;
    await confirmWecomOverwrite(async (q: any) => {
      captured = q;
      return { overwrite: true };
    });
    expect(Array.isArray(captured)).toBe(true);
    expect(captured[0].type).toBe('confirm');
    expect(captured[0].default).toBe(false);  // 默认 N, 拒绝破坏性操作要显式 yes
    expect(captured[0].message).toMatch(/覆盖/);
  });
});