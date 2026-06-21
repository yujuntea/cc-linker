/**
 * 企微命令路径交互式卡片 builders
 * PR 7.5.1: 6 个 command-card builder 公共框架
 * 后续 PR 7.5.2 / 7.5.3 的 src/wecom/bot.ts 命令路径会调这些函数
 *
 * @see docs/superpowers/specs/2026-06-20-wecom-integration-design.md
 */

import { WecomCardBuilder, type WecomTemplateCard } from './card';

// === Context types (test-mandated) ===

export type ListCardContext = {
  entries: Array<{ sessionUuid: string; title: string; messageCount: number; lastActive: string }>;
  totalActive: number;
};

export type DirListCardContext = {
  cwd: string;
  parent: string | null;
  dirs: Array<{ name: string; fullPath: string }>;
  hasMore: boolean;
};

export type ModelCardContext = {
  providers: Array<{ alias: string; name: string }>;
  currentAlias?: string;
};

export type AgentsCardContext = { bgCount: number };
export type ResumeCardContext = { sessionUuid: string };
export type StopCardContext = { shortId: string };

// === Internal helper ===

/**
 * PR 7.5 E2: aibot 服务端运行时接受按钮上的 value 字段 (aibot-client.ts:168 实证),
 *   但 SDK 类型未声明。cast 为 any 注入 {sessionUuid}，便于 callback 路由 (e.g. switch/resume/select_dir/select_model)
 */
function makeButton(text: string, tag: string, value?: { sessionUuid: string }): any {
  const btn: any = { text, tag };
  if (value) btn.value = value;
  return btn;
}

// === Builders ===

/**
 * /list 命令卡片
 * - 空列表 → text_notice (📭 0/N)
 * - 否则 button_interaction (1 按钮/session: switch,限 6 按钮) + action_menu 刷新
 *
 * PR 7.5.10 fix: aibot SDK TemplateCardButton[] 列表长度上限是 6 (api.d.ts:344)
 *   原 PR 7.5.2 设计 10 sessions × 2 buttons = 20 → 超 SDK 限制
 *   server 拒收并返 errcode=42014 "taskid has existed or empty or exceed max len"
 *   (通用 wrong-json-format 错误,task_id 是误导,真根因是 button 数量超限)
 *
 *   修法: 限前 6 sessions × 1 button (切换) = 6 buttons (符合 SDK max)
 *     desc 显示 "还有 N 个未显示" 告知用户被截断
 *     /switch <uuid> 仍可访问剩余 session (listdir-style 分页留作未来 PR)
 */
const LIST_CARD_MAX_BUTTONS = 6;

export function buildListCard(ctx: ListCardContext): WecomTemplateCard {
  if (ctx.entries.length === 0) {
    return WecomCardBuilder.textNotice({
      title: `📋 我的会话 (0/${ctx.totalActive})`,
      content: '📭 当前没有活跃 session',
    });
  }

  // PR 7.5.10: 截断到 SDK 允许的 6 按钮上限
  const visibleEntries = ctx.entries.slice(0, LIST_CARD_MAX_BUTTONS);
  const moreCount = ctx.entries.length - visibleEntries.length;

  const buttonValues: Array<{ sessionUuid: string } | undefined> = [];
  const buttons: any[] = [];
  for (const e of visibleEntries) {
    const v = { sessionUuid: e.sessionUuid };
    buttonValues.push(v);
    // 按钮文本用 title 前 8 字符 (PR 7.5 E2 makeButton cast 接受任意文本)
    buttons.push(makeButton(`🔄 ${e.title.slice(0, 8)}`, 'switch', v));
  }

  const desc = moreCount > 0
    ? `💡 显示前 ${LIST_CARD_MAX_BUTTONS} 个,还有 ${moreCount} 个未显示 (用 /switch <uuid> 切换)`
    : `💡 点按下方按钮切换 session`;

  const card = WecomCardBuilder.buttonInteraction({
    title: `📋 我的会话 (${visibleEntries.length}/${ctx.totalActive})`,
    description: desc,
    buttons,
  });

  // 注入 value (PR 7.5 E2: SDK 类型无声明,运行时 aibot 服务端接受)
  ((card as any).button_list.button as any[]).forEach((btn: any, i: number) => {
    if (buttonValues[i]) btn.value = buttonValues[i];
  });

  // 注入 action_menu (PR 7 m-9 ACTION_MENU_DESC 默认 '操作')
  (card as any).action_menu = {
    desc: WecomCardBuilder.ACTION_MENU_DESC,
    action_list: [
      {
        action_tag: 'list-refresh',
        action_title: { tag: 'list-refresh', text: '🔄 刷新' },
      },
    ],
  };

  return card;
}

/**
 * /listdir 命令卡片
 * - 父目录按钮 (若有) + 每子目录 1 按钮
 * - value.sessionUuid = path (路由 select_dir)
 */
export function buildDirListCard(ctx: DirListCardContext): WecomTemplateCard {
  const buttonValues: Array<{ sessionUuid: string } | undefined> = [];
  const buttons: any[] = [];
  if (ctx.parent !== null) {
    const v = { sessionUuid: ctx.parent };
    buttonValues.push(v);
    buttons.push(makeButton('⬆️ 上级目录', 'select_dir', v));
  } else {
    buttonValues.push(undefined);
  }
  for (const d of ctx.dirs) {
    const v = { sessionUuid: d.fullPath };
    buttonValues.push(v);
    buttons.push(makeButton(`📁 ${d.name}`, 'select_dir', v));
  }

  const description = ctx.hasMore
    ? '💡 还有更多子目录未显示'
    : `💡 共 ${ctx.dirs.length} 个子目录`;

  const card = WecomCardBuilder.buttonInteraction({
    title: `📂 ${ctx.cwd}`,
    description,
    buttons,
  });

  // 注入 value (PR 7.5 E2: SDK 类型无声明,运行时 aibot 服务端接受)
  ((card as any).button_list.button as any[]).forEach((btn: any, i: number) => {
    if (buttonValues[i]) btn.value = buttonValues[i];
  });

  return card;
}

/**
 * /model 命令卡片
 * - 每 provider 1 按钮 (select_model, value.sessionUuid = alias)
 * - 当前 provider 标 (当前) + type='default'
 * - 其他 type='primary'
 * - 末尾追加清除按钮 (clear_model, danger, no value)
 */
export function buildModelCard(ctx: ModelCardContext): WecomTemplateCard {
  const buttonValues: Array<{ sessionUuid: string } | undefined> = [];
  const buttons: any[] = ctx.providers.map(p => {
    const isCurrent = p.alias === ctx.currentAlias;
    const v = { sessionUuid: p.alias };
    buttonValues.push(v);
    return {
      text: isCurrent ? `🎯 ${p.name} (当前)` : `🎯 ${p.name}`,
      tag: 'select_model',
      type: isCurrent ? ('default' as const) : ('primary' as const),
    };
  });

  // 清除按钮 — type='danger', no value
  buttonValues.push(undefined);
  buttons.push({
    text: '🧹 清除默认',
    tag: 'clear_model',
    type: 'danger' as const,
  });

  const card = WecomCardBuilder.buttonInteraction({
    title: '🤖 模型选择',
    description: '💡 点按下方按钮设默认模型',
    buttons,
  });

  // 注入 value (PR 7.5 E2: SDK 类型无声明,运行时 aibot 服务端接受)
  ((card as any).button_list.button as any[]).forEach((btn: any, i: number) => {
    if (buttonValues[i]) btn.value = buttonValues[i];
  });

  return card;
}

/**
 * /agents 命令卡片
 * - text_notice + agents-refresh action_menu (value 由 callback 端定义)
 */
export function buildAgentsRefreshCard(ctx: AgentsCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: `📊 BG Sessions (${ctx.bgCount})`,
    content: '💡 点右上角刷新列表',
    actionMenu: [{ tag: 'agents-refresh', text: '🔄 刷新' }],
  });
}

/**
 * /resume 命令卡片
 * - text_notice + switch action_menu (no value → list semantics, PR 7.5 E1)
 */
export function buildResumeCard(ctx: ResumeCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: '✅ Session 已 touch',
    content: `uuid: ${ctx.sessionUuid.slice(0, 8)}...`,
    actionMenu: [{ tag: 'switch', text: '📂 切换别的 session' }],
  });
}

/**
 * /stop 命令卡片
 * - text_notice + switch action_menu (no value → list semantics)
 */
export function buildStopCard(ctx: StopCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: `✅ 已停止: ${ctx.shortId}`,
    content: '💡 点右上角切换 session',
    actionMenu: [{ tag: 'switch', text: '📂 切换 session' }],
  });
}
