import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCBridgeError } from '../../utils/errors';
import { formatTimeAgo, formatOrigin } from '../output';

interface FeishuCmdOptions {
  caller?: string;
}

export function feishuCmd(
  registry: RegistryManager,
  subcommand: string,
  args: string[],
  opts: FeishuCmdOptions
): void {
  switch (subcommand) {
    case 'list':
      feishuList(registry, opts.caller);
      break;
    case 'switch':
      feishuSwitch(registry, opts.caller, args[0]);
      break;
    case 'resume':
      feishuResume(registry, args[0]);
      break;
    case 'status':
      feishuStatus(registry);
      break;
    default:
      throw new CCBridgeError('E005', `未知子命令: ${subcommand}`);
  }
}

function feishuList(registry: RegistryManager, caller?: string): void {
  if (!caller) {
    throw new CCBridgeError('E019', '缺少调用者身份，请检查 cc-connect [[commands]] 配置');
  }

  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => s.status === 'active');

  if (!caller.startsWith('terminal:')) {
    sessions = sessions.filter(([_, s]) =>
      s.origin === 'cli' ||
      s.owner_user_key === caller ||
      s.owner === normalizeOwner(caller) ||
      s.visibility === 'public' ||
      (s.shared_with ?? []).includes(caller)
    );
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));

  const lines: string[] = [`📋 我的会话（共 ${sessions.length} 个）\n`];

  for (const [uuid, s] of sessions.slice(0, 20)) {
    const ref = uuid.slice(0, 8);
    const icon = s.origin === 'cc-connect' ? '🟢 飞书' : '💻 终端';
    const timeAgo = formatTimeAgo(s.last_active);

    lines.push(`\`${ref}\` ${s.title ?? 'Untitled'}`);
    lines.push(`   💬 ${s.message_count} 条消息 | 🕒 ${timeAgo}`);
    lines.push(`   📂 ${s.project_name ?? '?'} | ${icon}`);
    lines.push(`   最后: "${s.last_message_preview.slice(0, 30)}..."`);
    lines.push('');
  }

  lines.push('回复 /bridge switch <Ref> 切换到此会话');
  lines.push('回复 /bridge resume <Ref> 在终端恢复此会话');

  console.log(lines.join('\n'));
}

function feishuSwitch(registry: RegistryManager, caller: string | undefined, target: string): void {
  if (!target) {
    throw new CCBridgeError('E005', '用法: /bridge switch <UUID或短前缀>');
  }

  const match = registry.findByPrefix(target);
  if (!match) {
    throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
  }

  const [uuid, entry] = match;

  if (entry.cc_connect_session_id) {
    console.log(`✅ 已切换到「${entry.title}」(${entry.message_count} 条消息)`);
    console.log(`💻 此会话来自终端，包含完整的开发历史`);
    console.log(`⚡ 无需重启，已即时生效`);
    return;
  }

  console.log(`⚠️ 此会话来自终端，尚未映射到 cc-connect`);
  console.log(`首次切换需要创建映射并重启 cc-connect，可能中断其他用户的会话。`);
  console.log(`\n请在终端执行以下命令手动映射：`);
  console.log(`\n  cc-bridge resume ${uuid.slice(0, 8)}\n`);
  console.log(`后续版本将支持自动映射。`);
}

function feishuResume(registry: RegistryManager, target: string): void {
  const match = registry.findByPrefix(target);
  if (!match) {
    throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
  }

  const [uuid] = match;
  console.log(`📱 请在终端执行以下命令恢复此会话：\n`);
  console.log(`  cc-bridge resume ${uuid.slice(0, 8)}\n`);
  console.log(`或直接运行：`);
  console.log(`  claude --resume ${uuid}`);
}

function feishuStatus(registry: RegistryManager): void {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => s.status === 'active').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromCcConnect = sessions.filter(s => s.origin === 'cc-connect').length;

  console.log(`🔗 cc-bridge 状态`);
  console.log(`注册会话: ${sessions.length}`);
  console.log(`来源: ${fromCli} 个来自终端，${fromCcConnect} 个来自飞书`);
  console.log(`活跃: ${active}`);
}

function normalizeOwner(caller: string): string {
  const parts = caller.split(':');
  return parts.length >= 3 ? `${parts[0]}:${parts[parts.length - 1]}` : caller;
}
