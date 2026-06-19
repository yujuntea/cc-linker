/**
 * 平台无关的命令判定 + 解析
 * 不做白名单——所有以 / 开头的消息都解析为命令候选，由下游 executeCommand 决定处理方式
 * 已知 cc-linker 命令（如 list/switch/agent_view_*）由 executeCommand 内部 switch 处理
 * 注: /bridge 已废弃 (历史 cc-connect 命令, 2026-06-20 决定不复活, 详见 spec 修订)
 * 未识别的 /xxx 走 Claude 透传路径（spec 2026-06-18 cc slash passthrough）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.1
 * 参考 src/feishu/bot.ts:326 现有 isCommand 注释
 */

/**
 * Detect if a message is a cc-linker command candidate (e.g. "/list", "/switch uuid").
 * Mirrors feishu/bot.ts:50 — /[^\s]...
 */
export function isCommandMessage(text: string): boolean {
  return text.startsWith('/') && text.length > 1 && !/\s/.test(text[1] ?? '');
}

export type ParsedCommand = { cmd: string; args: string[] };

/**
 * Parse /cmd arg1 arg2 → { cmd: 'cmd', args: ['arg1', 'arg2'] }
 * 任何以 / 开头第二字符非空白的消息都解析（不拒绝未知命令）
 * 返回 null 表示不是命令
 */
export function parseCommand(text: string): ParsedCommand | null {
  if (!isCommandMessage(text)) return null;
  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0];
  return { cmd, args: parts.slice(1) };
}