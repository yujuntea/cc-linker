/**
 * 企微完成卡片 builder + sender
 * PR 7.1: 流式输出完成后, 主动 sendMessage 一张 button_interaction 卡片
 *
 * @see docs/superpowers/specs/2026-06-20-wecom-complete-card-design.md §3.1
 */
import type { WSClient, TemplateCard } from '@wecom/aibot-node-sdk';
import { WecomCardBuilder, type WecomTemplateCard } from './card';
import { logger } from '../utils/logger';

export type CompleteCardContext = {
  userId: string;
  /** PR 7 final cleanup: 群聊 chatId, 优先于 userId。
   * 单聊 chatId === userId, 群聊 chatId !== userId — 群聊场景必须用 chatId 否则用户收不到卡片。*/
  chatId?: string;
  sessionTitle?: string;
  sessionUuid?: string;
  cwd?: string;
  /** 流式总耗时（用于主标题 desc 显示） */
  durationMs?: number;
  /**
   * PR 7.5.2: 预构造好的 template_card — 走 buildListCard / buildDirListCard / buildModelCard 的路径
   * 设置后, buildCompleteCard 不被调, 直接用传入的 card. 让命令路径复用 sender 类而不用重写 wire 格式
   */
  template_card?: WecomTemplateCard;
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
 * 格式: ccdone-{timestamp}-{rand}-{userId 前 12 字符}
 * PR 7.1 I-1: 用 Math.random() 替代 module-level counter — stateless,
 *   避免多实例 / 多 daemon 并发不安全 + 测试间状态泄露
 */
function genCompleteCardTaskId(userId: string): string {
  // 6 字符随机后缀 (base36), 保证唯一性 + stateless
  const rand = Math.random().toString(36).slice(2, 8);
  return `ccdone-${Date.now()}-${rand}-${userId.slice(0, 12)}`;
}

/**
 * PR 7.1: 构造完成卡片
 * - 主卡 button_interaction (3 按钮)
 * - 右上角 action_menu (4 项复用现有 case)
 * - task_id 用于 updateTemplateCard 关联 (本 PR 不调 updateTemplateCard, 留扩展点)
 */
export function buildCompleteCard(ctx: CompleteCardContext): WecomTemplateCard {
  // 18 字符是主标题留 8 字符 'Claude 处理完成:' 前缀 + 18 字符 session 名（共 26 字符, 跟 SDK main_title.title 26 字上限对齐）
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
 * PR 7.1 I-3: wire-shape payload — 用 SDK 导出的 TemplateCard 作为 wire target,
 *   消除 buildCompleteCard → sendMessage 路径上的 as any。
 *   运行时 aibot 服务端接受我们 button_list[].{action_tag, action_title} 格式
 *   (对齐 WecomCardBuilder.buttonInteraction), SDK 类型用更宽松的 {text, key} 是 API 文档差异,
 *   服务端以 builder 实际发送格式为准 (aibot SDK 自身 buttonInteraction 也用 action_tag/action_title)。
 */
type CompleteCardPayload = TemplateCard;

/**
 * PR 7.1: 完成卡片 sender (stateless, 每次 send 都新建 card)
 * 调用方: WecomStreamUpdater.complete() 末尾
 */
export class WecomCompleteCardSender {
  constructor(private readonly sdk: WSClient) {}

  /**
   * 发送完成卡片到用户/群。
   *
   * @param ctx 卡片上下文,字段说明:
   *   - userId: 必填。用户 ID,日志用 + 单聊场景 sendMessage 接收方。
   *   - chatId: 可选,优先于 userId。群聊 chatId,群聊场景必须传 (单聊 chatId === userId,可不传)。
   *   - sessionTitle: 可选。主标题 ": {title}" 后缀,见 §3.1.1。
   *   - sessionUuid: 可选。卡片 button 后续 callback 用,目前未消费 (PR 7 留扩展点)。
   *   - cwd: 可选。卡片 button 后续 callback 用,目前未消费 (PR 7 留扩展点)。
   *   - durationMs: 可选。desc "耗时 Xs" 段。
   */
  async send(ctx: CompleteCardContext): Promise<void> {
    // PR 7.5.2: ctx.template_card 优先 — 命令路径推 buildListCard / buildDirListCard / buildModelCard
    // 走 sender 共用 sendMessage 通道, 不重写 wire 格式 (msgtype=template_card + payload 结构)
    const card = ctx.template_card ?? buildCompleteCard(ctx);
    // PR 7.1 I-3: 单次 cast 到 SDK wire-shape (WecomTemplateCard → TemplateCard),
    //   buildCompleteCard 内部的 (card as any).action_menu / task_id 注入保留 —
    //   这两字段在 WecomTemplateCard union 下 optional, 需要 mutable 注入, 留 cast。
    const payload = {
      msgtype: 'template_card' as const,
      template_card: card as unknown as CompleteCardPayload,
    };
    // PR 7 final cleanup: 群聊场景下 chatId 优先 — 单聊 chatId === userId 无影响
    const receiveId = ctx.chatId ?? ctx.userId;
    await this.sdk.sendMessage(receiveId, payload);
    const taskId = (card as unknown as CompleteCardPayload).task_id;
    logger.info(`[wecom-complete-card] sent: receiveId=${receiveId.slice(0, 12)}... taskId=${taskId ?? '(none)'}`);
  }

  /**
   * PR 7.5.5 hotfix: 用 replyTemplateCard 推卡片 (不走 sendMessage 的 5s ack 路径)
   *
   * 背景: 命令路径 (/list /listdir /model) 是用户消息的 FIRST reply, 此时 SDK 的
   *   5s replyWelcome 窗口需要用原始消息 event 的 inboundFrame (含 req_id) 才能 ack.
   *   sendMessage 走 WsCmd.SEND_MSG 协议, 等的 ack 路径不同 → 5s 超时.
   *
   * 修法: 用 SDK 的 replyTemplateCard(frame, card) — 它走 WsCmd.RESPONSE_WELCOME 路径,
   *   复用原始消息的 req_id, 不需要新 ack.
   *
   * @param frame 原始消息 event 的 WebSocket frame (msg.metadata.inboundFrame)
   * @param ctx 卡片上下文, 必填 userId / chatId (跟 send 一致), sessionTitle 等其他字段忽略
   * @param card 可选 — 预构造好的 template_card (跟 send 的 template_card 字段同语义)
   */
  async sendViaReply(
    frame: any,
    ctx: CompleteCardContext,
    card?: WecomTemplateCard,
  ): Promise<void> {
    const finalCard = card ?? ctx.template_card ?? buildCompleteCard(ctx);
    // replyTemplateCard(frame, templateCard, feedback) — frame 必传, 第二参是 template_card 对象 (不是 wrapped body)
    await this.sdk.replyTemplateCard(frame, finalCard as unknown as CompleteCardPayload);
    const taskId = (finalCard as unknown as CompleteCardPayload).task_id;
    const receiveId = ctx.chatId ?? ctx.userId;
    logger.info(`[wecom-complete-card] sent via reply: receiveId=${receiveId.slice(0, 12)}... taskId=${taskId ?? '(none)'}`);
  }
}
