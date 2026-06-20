import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CONFIG_PATH } from '../../utils/paths';
import { loadExistingConfig, saveConfig } from './init-feishu';

/**
 * Mask a secret for terminal display: show first 3 + last 3 chars, middle as '*'.
 * Returns '' for empty input and fully masks very short strings (≤6 chars).
 * Mirrors init-feishu's maskSecret so behaviour is consistent across wizards.
 */
export function maskSecret(secret: string): string {
  const s = secret ?? '';
  if (s.length === 0) return '';
  if (s.length <= 6) return '*'.repeat(s.length);
  const middle = '*'.repeat(s.length - 6);
  return `${s.slice(0, 3)}${middle}${s.slice(-3)}`;
}

/**
 * PR 7 m-5: 企微 token 校验结果 (验证 bot_id + secret 组合有效).
 */
export type WecomVerifyResult = {
  ok: boolean;
  accessToken?: string;
  expiresIn?: number;
};

/**
 * PR 7 m-5: 企微 bot_id + secret verify 工具.
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
export async function verifyWecomCredentials(
  botId: string,
  secret: string,
  opts: { fetcher?: typeof fetch } = {},
): Promise<WecomVerifyResult> {
  const doFetch = opts.fetcher ?? fetch;
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(botId)}&corpsecret=${encodeURIComponent(secret)}`;
  const resp = await doFetch(url);
  const data = (await resp.json()) as {
    errcode: number;
    errmsg: string;
    access_token?: string;
    expires_in?: number;
  };
  if (data.errcode !== 0) {
    throw new Error(`❌ bot_id 或 secret 无效 (errcode=${data.errcode}, errmsg=${data.errmsg})`);
  }
  return {
    ok: true,
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * PR 7 m-13: overwrite 确认 prompt.
 *
 * 历史: init-wecom 写入 [wecom] 节时, 如果 config.toml 已存在 [wecom] 配置 (含 bot_id),
 *   会直接覆盖而不通知用户. → 用户以为没生效, 或多个 wecom bot 共用同一 config 时互相覆盖.
 * 修法: 写 config 前检测 wecom 节是否已存在, 弹 "config 已存在, 覆盖? (y/N)" 确认.
 *   默认 N (跟 rm -i / mv -i 一致: 拒绝破坏性操作要显式 yes).
 *
 * @returns true = 继续覆盖, false = 取消写入 (initWecom 中止, 不抛错)
 */
export async function confirmWecomOverwrite(
  promptFn: typeof inquirer.prompt = inquirer.prompt,
): Promise<boolean> {
  // PR 7 m-13: 用 type: 'confirm' + default: false, 跟 init-feishu / git 类似 UX
  const { overwrite } = await promptFn([{
    type: 'confirm',
    name: 'overwrite',
    message: 'config 已存在 wecom 节, 是否覆盖? (y/N)',
    default: false,
  }]);
  return overwrite;
}

/**
 * 交互式配置企业微信集成（bot_id + secret + owner_external_user_id）
 * 写入 [wecom] 节到 config.toml。后续手动 `cc-linker start --platform=wecom` 启动。
 *
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.5 (PR 3.5 简化版)
 */
export async function initWecom(): Promise<void> {
  console.log(chalk.blue('=== cc-linker 企业微信配置向导 ===\n'));

  console.log(chalk.cyan('前置步骤（参考 spec §2.2）:'));
  console.log(chalk.gray('  1. 企业微信客户端 → 工作台 → 智能机器人 → 创建机器人'));
  console.log(chalk.gray('  2. 选择 API 模式创建 + 长连接方式'));
  console.log(chalk.gray('  3. 拿到 Bot ID 和 Secret'));
  console.log(chalk.gray('  4. 拿到 Owner 外部 userid（管理员后台 → 我的企业 → 成员 → 详情）'));
  console.log();

  const existing = loadExistingConfig();
  const wecom = existing.wecom ?? {};

  // PR 7 m-13: 检测 [wecom] 节是否已存在, 存在则先确认是否覆盖 (默认 N)
  const hasExistingWecom = !!(wecom.bot_id || wecom.secret);
  if (hasExistingWecom) {
    console.log(chalk.yellow(`⚠️  检测到现有 wecom 配置 (bot_id=${wecom.bot_id})`));
    const overwrite = await confirmWecomOverwrite();
    if (!overwrite) {
      console.log(chalk.gray('\n已取消, 未修改配置。'));
      return;
    }
  }

  // Step 1: bot_id
  const { botId } = await inquirer.prompt([{
    type: 'input',
    name: 'botId',
    message: 'Bot ID:',
    default: wecom.bot_id || undefined,
    validate: (v: string) => v.trim() ? true : 'Bot ID 不能为空',
  }]);

  // Step 2: secret（inquirer password — default 行为与 init-feishu 一致）
  const { secret } = await inquirer.prompt([{
    type: 'password',
    name: 'secret',
    message: wecom.secret
      ? 'Secret（留空保持原值，或粘贴新值）:'
      : 'Secret:',
    mask: '*',
    validate: (v: string) =>
      v.trim() || wecom.secret ? true : 'Secret 不能为空',
  }]);
  const resolvedSecret = secret.trim() || wecom.secret?.trim() || '';

  // Step 3: owner_external_user_id（可选，留空允许所有用户）
  const { ownerExternalUserId } = await inquirer.prompt([{
    type: 'input',
    name: 'ownerExternalUserId',
    message: 'Owner external_user_id（留空允许所有用户）:',
    default: wecom.owner_external_user_id || '',
  }]);

  // PR 7 m-5: 写 config 前 verify bot_id + secret, 避免配置错误要等启动才看到
  // 失败 throw (含 errcode), 用户立即看到, 不写脏 config
  try {
    console.log(chalk.cyan('\n验证 bot_id + secret ...'));
    await verifyWecomCredentials(botId.trim(), resolvedSecret);
    console.log(chalk.green('✅ 验证通过'));
  } catch (verifyErr) {
    const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    console.log(chalk.red(`\n${msg}\n`));
    throw verifyErr;
  }

  // Save to existing config (preserves other sections)
  const existingOwner = typeof wecom.owner_external_user_id === 'string' ? wecom.owner_external_user_id : '';
  existing.wecom = {
    bot_id: botId.trim(),
    secret: resolvedSecret,
    ...(ownerExternalUserId.trim() || existingOwner
      ? { owner_external_user_id: ownerExternalUserId.trim() || existingOwner }
      : {}),
  };

  if (!existing.general) {
    existing.general = { log_level: 'info' };
  }

  saveConfig(existing);

  console.log(chalk.green(`\n✅ 配置已保存到 ${CONFIG_PATH}`));
  console.log(chalk.cyan('\n配置内容:'));
  console.log(chalk.gray(`  bot_id:                ${botId.trim()}`));
  console.log(chalk.gray(`  secret:                ${maskSecret(resolvedSecret)}`));
  if (ownerExternalUserId.trim() || existingOwner) {
    console.log(chalk.gray(`  owner_external_user_id: ${ownerExternalUserId.trim() || existingOwner}`));
  }

  console.log(chalk.cyan('\n下一步:'));
  console.log(chalk.white('  cc-linker start --platform=wecom   — 仅启动企微 Bot'));
  console.log(chalk.white('  cc-linker start                    — 启动所有平台（feishu + wecom）'));
  console.log(chalk.white('  cc-linker list                     — 查看会话'));
}