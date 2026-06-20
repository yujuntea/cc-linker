/**
 * 企微完成卡片 builder + sender
 * PR 7.1: 流式输出完成后, 主动 sendMessage 一张 button_interaction 卡片
 *
 * @see docs/superpowers/specs/2026-06-20-wecom-complete-card-design.md §3.1
 */
import type { WSClient } from '@wecom/aibot-node-sdk';
import { WecomCardBuilder, type WecomTemplateCard } from './card';
import { logger } from '../utils/logger';

export type CompleteCardContext = {
  userId: string;
  sessionTitle?: string;
  sessionUuid?: string;
  cwd?: string;
  /** 流式总耗时（用于主标题 desc 显示） */
  durationMs?: number;
};

/**
 * PR 7.1: 主卡 3 个按钮 (业务名 key, 跟现有 executeCardAction case 对齐)
 * 顺序: continue / switch / listdir — 跟 spec §3.1.1 一致
 */
export const COMPLETE_CARD_MAIN_BUTTONS: ReadonlyArray<{ key: string; text: string }> = [
  { key: 'continue', text: '🔁 继续' },
  { key: 'switch',   text: '📂 切换 session' },
  { key: 'listdir',  text: '📁 选目录' },
];

/**
 * PR 7.1: action_menu 4 项 (复用现有 4 个 executeCardAction case)
 * 顺序: retry / stop / confirm-stop / list-refresh
 */
export const COMPLETE_CARD_ACTION_MENU: ReadonlyArray<{ tag: string; text: string }> = [
  { tag: 'retry',        text: '🔁 重试本次' },
  { tag: 'stop',         text: '🛑 停止' },
  { tag: 'confirm-stop', text: '🛂 硬杀 Claude' },
  { tag: 'list-refresh', text: '🔄 刷新列表' },
];

/**
 * PR 7.1: 生成 task_id (aibot SDK 字段, 用于 updateTemplateCard 关联)
 * 限制: 数字、字母、_-@，最长 128 字节
 * 格式: ccdone-{timestamp}-{counter}-{userId 前 12 字符}
 * counter 避免同毫秒内连续调用生成相同 task_id
 */
let _taskIdCounter = 0;
function genCompleteCardTaskId(userId: string): string {
  _taskIdCounter = (_taskIdCounter + 1) % 100000;
  return `ccdone-${Date.now()}-${_taskIdCounter}-${userId.slice(0, 12)}`;
}

/**
 * PR 7.1: 构造完成卡片
 * - 主卡 button_interaction (3 按钮)
 * - 右上角 action_menu (4 项复用现有 case)
 * - task_id 用于 updateTemplateCard 关联 (本 PR 不调 updateTemplateCard, 留扩展点)
 */
export function buildCompleteCard(ctx: CompleteCardContext): WecomTemplateCard {
  const titleSuffix = ctx.sessionTitle ? `: ${ctx.sessionTitle.slice(0, 18)}` : '';
  const title = `✅ Claude 处理完成${titleSuffix}`;
  const elapsed = ctx.durationMs ? ` (耗时 ${Math.floor(ctx.durationMs / 1000)}s)` : '';
  const desc = `💡 点按下方按钮继续${elapsed}`;

  const card = WecomCardBuilder.buttonInteraction({
    title,
    description: desc,
    buttons: COMPLETE_CARD_MAIN_BUTTONS.map(b => ({
      tag: b.key,
      text: b.text,
      type: 'default' as const,
    })),
  });

  // 注入 action_menu (PR 7 m-9 ACTION_MENU_DESC 默认 '操作')
  // 用 as any 注入是因 card.ts TemplateCard union 类型对 action_menu 在 button_interaction 下 optional
  (card as any).action_menu = {
    desc: WecomCardBuilder.ACTION_MENU_DESC,
    action_list: COMPLETE_CARD_ACTION_MENU.map(a => ({
      action_tag: a.tag,
      action_title: { tag: a.tag, text: a.text },
    })),
  };

  // 注入 task_id (aibot SDK 字段, 用 as any 因 card.ts 类型不含 task_id)
  (card as any).task_id = genCompleteCardTaskId(ctx.userId);

  return card;
}

/**
 * PR 7.1: 完成卡片 sender (stateless, 每次 send 都新建 card)
 * 调用方: WecomStreamUpdater.complete() 末尾
 */
export class WecomCompleteCardSender {
  constructor(private readonly sdk: WSClient) {}

  async send(ctx: CompleteCardContext): Promise<void> {
    const card = buildCompleteCard(ctx);
    // PR 7.1: 用 as any 跨过 SDK 的 TemplateCard 类型 (action_list 限 3 项, 字段名 {text,key} vs 内部 {action_tag,action_title})
    //   运行时 payload 是正确的 (aibot 服务端兼容), 类型层用 any 兜底
    await this.sdk.sendMessage(ctx.userId, {
      msgtype: 'template_card',
      template_card: card as any,
    });
    logger.info(`[wecom-complete-card] sent: userId=${ctx.userId.slice(0, 12)}... taskId=${(card as any).task_id}`);
  }
}
