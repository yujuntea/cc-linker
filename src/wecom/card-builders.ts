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

// === Internal helpers ===

/**
 * PR 7.5.13: SDK 限制 (api.d.ts:166/170/290)
 *   TemplateCardButton.text    "建议不超过 10 个字"
 *   TemplateCardMainTitle.title "建议不超过 26 个字"
 *   TemplateCardMainTitle.desc  "建议不超过 30 个字"
 * 真实根因: server 返 40016 "invalid button size" 是 button TEXT 长度违规 (非 button count).
 *   PR 7.5.12 最小化 (1 button + 0 action_menu) 仍 40016 → 排除 button count.
 *   PR 7.5.12 诊断日志暴露 btn=1[🔄 Review A(11)] → 11 字 > 10.
 *
 * 安全策略: 按 UTF-16 code unit 截断 (JS .length)。emoji 在 .length 中算 1 单位 (BMP 字符)
 *   或 2 单位 (surrogate pair)。server 按 UTF-16/byte 计数，不按 "字" 计数。
 *   用 UTF-16 截断保证不超限。截断后可能切断 surrogate pair → 加 .trim() 移除尾部不完整 emoji。
 */
const MAX_BUTTON_TEXT = 10;
const MAX_TITLE = 26;
const MAX_DESC = 30;

function truncateUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trim();
}

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
 *
 * PR 7.5.12 fix: 6 按钮 + action_menu 真机仍返 40016 "invalid button size".
 *   SDK 文档说 TemplateCardButton[] 最长 6 — 但服务端对 first-reply 卡片可能更严, 或把
 *   action_menu.action_list 内的每一项也算 button.
 *   隔离根因: buildListCard 暂时只生成 1 button + 无 action_menu, 验证最小 wire shape 能否通过.
 *
 * PR 7.5.13 fix: 隔离测试暴露真因 — server '40016 invalid button size' 实际是 button TEXT 长度超限
 *   (非 button count). 诊断日志: btn=1[🔄 Review A(11)] action_menu=0[] title_len=15 desc_len=42
 *   - TemplateCardButton.text 限 ≤10 字 → "🔄 Review A" = 11 字 (emoji 算 1 BMP 单位, 但 server 可能按字节)
 *   - TemplateCardMainTitle.title 限 ≤26 字
 *   - TemplateCardMainTitle.desc 限 ≤30 字 → 当前 desc "💡 显示前 1 个,还有 9 个未显示 (用 /switch <uuid> 切换)" = 42 字
 *
 *   修法: 加 truncateUtf16() 辅助 (按 JS .length = UTF-16 code unit 截断).
 *     - button text: 不加 emoji 前缀 (省 1 单位), 截 title 到 8 字 → "Review A" ≤10
 *     - title: 截到 26
 *     - desc: 简化 + 截到 30
 *   恢复 6 按钮上限 (button count 本身合规, 真正元凶是 text length).
 */
const LIST_CARD_MAX_BUTTONS = 6;

export function buildListCard(ctx: ListCardContext): WecomTemplateCard {
  if (ctx.entries.length === 0) {
    const card = WecomCardBuilder.textNotice({
      title: truncateUtf16(`📋 我的会话 (0/${ctx.totalActive})`, MAX_TITLE),
      content: '📭 当前没有活跃 session',
    });
    return card;
  }

  // PR 7.5.10: 截断到 SDK 允许的 6 按钮上限
  const visibleEntries = ctx.entries.slice(0, LIST_CARD_MAX_BUTTONS);
  const moreCount = ctx.entries.length - visibleEntries.length;

  const buttonValues: Array<{ sessionUuid: string } | undefined> = [];
  const buttons: any[] = [];
  for (const e of visibleEntries) {
    const v = { sessionUuid: e.sessionUuid };
    buttonValues.push(v);
    // PR 7.5.13: 按钮 text 限 ≤10 字 (SDK 限制)
    //   不带 emoji 前缀 (emoji UTF-16 占 1-2 单位), title 截 8 字
    //   例: "Review AI attribution fix plan" → "Review AI" (8 字)
    const btnText = truncateUtf16(e.title, MAX_BUTTON_TEXT);
    buttons.push(makeButton(btnText, 'switch', v));
  }

  // PR 7.5.13: desc 简化 + 截 30 字
  const desc = moreCount > 0
    ? `💡 还有 ${moreCount} 个未显示`
    : '💡 点按钮切换';
  const descTruncated = truncateUtf16(desc, MAX_DESC);

  // PR 7.5.13: title 截 26 字
  const title = truncateUtf16(
    `📋 我的会话 ${visibleEntries.length}/${ctx.totalActive}`,
    MAX_TITLE,
  );

  const card = WecomCardBuilder.buttonInteraction({
    title,
    description: descTruncated,
    buttons,
  });

  // 注入 value (PR 7.5 E2: SDK 类型无声明,运行时 aibot 服务端接受)
  ((card as any).button_list.button as any[]).forEach((btn: any, i: number) => {
    if (buttonValues[i]) btn.value = buttonValues[i];
  });

  return card;
}

/**
 * /listdir 命令卡片
 * - 父目录按钮 (若有) + 每子目录 1 按钮
 * - value.sessionUuid = path (路由 select_dir)
 *
 * PR 7.5.13: 防御性截断 button text (≤10), title (≤26), desc (≤30) — cwd/path 可能很长.
 */
export function buildDirListCard(ctx: DirListCardContext): WecomTemplateCard {
  const buttonValues: Array<{ sessionUuid: string } | undefined> = [];
  const buttons: any[] = [];
  if (ctx.parent !== null) {
    const v = { sessionUuid: ctx.parent };
    buttonValues.push(v);
    // '⬆️ 上级目录' = 5 单位 (BMP) → 远 ≤10
    buttons.push(makeButton('⬆️ 上级目录', 'select_dir', v));
  } else {
    buttonValues.push(undefined);
  }
  for (const d of ctx.dirs) {
    const v = { sessionUuid: d.fullPath };
    buttonValues.push(v);
    // PR 7.5.13: 📁 emoji (2 UTF-16 单位) + d.name 限 8 字 → 严格 ≤10
    const btnText = truncateUtf16(`📁 ${d.name}`, MAX_BUTTON_TEXT);
    buttons.push(makeButton(btnText, 'select_dir', v));
  }

  const description = ctx.hasMore
    ? '💡 还有更多子目录未显示'
    : `💡 共 ${ctx.dirs.length} 个子目录`;
  const descTruncated = truncateUtf16(description, MAX_DESC);

  // PR 7.5.13: cwd 可能很长, 截到 26
  const title = truncateUtf16(`📂 ${ctx.cwd}`, MAX_TITLE);

  const card = WecomCardBuilder.buttonInteraction({
    title,
    description: descTruncated,
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
 *
 * PR 7.5.13: 防御性截断 — provider.name 可能很长, 当前标识 "(当前)" = 4 单位 (BMP).
 *   "🎯 Opus" = 5 单位 ✓; "🎯 Long Provider Name" → 截 10
 */
export function buildModelCard(ctx: ModelCardContext): WecomTemplateCard {
  const buttonValues: Array<{ sessionUuid: string } | undefined> = [];
  const buttons: any[] = ctx.providers.map(p => {
    const isCurrent = p.alias === ctx.currentAlias;
    const v = { sessionUuid: p.alias };
    buttonValues.push(v);
    // PR 7.5.13: 🎯 (1) + 空格 (1) + p.name (≤8) → 严格 ≤10
    const baseText = `🎯 ${p.name}`;
    const text = isCurrent ? `${baseText} (当前)` : baseText;
    return {
      text: truncateUtf16(text, MAX_BUTTON_TEXT),
      tag: 'select_model',
      type: isCurrent ? ('default' as const) : ('primary' as const),
    };
  });

  // 清除按钮 — type='danger', no value
  // PR 7.5.13: '🧹 清除默认' = 6 单位 → 远 ≤10
  buttonValues.push(undefined);
  buttons.push({
    text: '🧹 清除默认',
    tag: 'clear_model',
    type: 'danger' as const,
  });

  // PR 7.5.13: '🤖 模型选择' = 6 单位, 截到 26 (冗余但防御)
  const card = WecomCardBuilder.buttonInteraction({
    title: truncateUtf16('🤖 模型选择', MAX_TITLE),
    description: truncateUtf16('💡 点按下方按钮设默认模型', MAX_DESC),
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
 *
 * PR 7.5.13: 防御性截断 title (≤26), action_menu text (≤10)
 */
export function buildAgentsRefreshCard(ctx: AgentsCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: truncateUtf16(`📊 BG Sessions (${ctx.bgCount})`, MAX_TITLE),
    content: truncateUtf16('💡 点右上角刷新列表', MAX_DESC),
    actionMenu: [{ tag: 'agents-refresh', text: truncateUtf16('🔄 刷新', MAX_BUTTON_TEXT) }],
  });
}

/**
 * /resume 命令卡片
 * - text_notice + switch action_menu (no value → list semantics, PR 7.5 E1)
 *
 * PR 7.5.13: 防御性截断
 */
export function buildResumeCard(ctx: ResumeCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: truncateUtf16('✅ Session 已 touch', MAX_TITLE),
    content: truncateUtf16(`uuid: ${ctx.sessionUuid.slice(0, 8)}...`, MAX_DESC),
    actionMenu: [{ tag: 'switch', text: truncateUtf16('📂 切换别的 session', MAX_BUTTON_TEXT) }],
  });
}

/**
 * /stop 命令卡片
 * - text_notice + switch action_menu (no value → list semantics)
 *
 * PR 7.5.13: 防御性截断
 */
export function buildStopCard(ctx: StopCardContext): WecomTemplateCard {
  return WecomCardBuilder.textNotice({
    title: truncateUtf16(`✅ 已停止: ${ctx.shortId}`, MAX_TITLE),
    content: truncateUtf16('💡 点右上角切换 session', MAX_DESC),
    actionMenu: [{ tag: 'switch', text: truncateUtf16('📂 切换 session', MAX_BUTTON_TEXT) }],
  });
}
