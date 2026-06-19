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