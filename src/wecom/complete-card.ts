/**
 * 企微完成卡片 builder + sender
 * PR 7.1: 流式输出完成后, 主动 sendMessage 一张 button_interaction 卡片
 *
 * @see docs/superpowers/specs/2026-06-20-wecom-complete-card-design.md §3.1
 */
import type { WSClient, TemplateCard } from '@wecom/aibot-node-sdk';
import { WecomCardBuilder, type WecomTemplateCard } from './card';
import { logger } from '../utils/logger';

/**
 * PR 7.5.6 hotfix: 把内部 card shape (action_tag/action_title/button_type) 转换成
 *   aibot 服务端 wire format (key/text/style)
 *
 * 背景: src/wecom/card.ts WecomCardBuilder 用 Feishu 风格的 {action_tag, action_title, button_type}
 *   字段命名 (历史遗留, PR 2 v1.2.1+ 一直这样写). 但 aibot 服务端 (1.0.7) 期望
 *   {key, text, style: 1|2|3/4} (官方 SDK 类型 TemplateCardButton / TemplateCardActionMenu).
 *
 *   服务端校验严格: action_menu.action_list[].text missing → 拒收 + 5s 后 fallback.
 *   PR 7.5.5 部署后真机 E2E 仍 fallback → 修复在 wire 边界统一转 shape.
 *
 * 修法: 在 WecomCompleteCardSender.send/sendViaReply wire 边界统一转 shape, 不动 WecomCardBuilder
 *   (避免破坏 9 个 builder 单测 + 未来 PR 7.x 兼容性).
 *
 * @see /Users/wuyujun/.bun/install/cache/@wecom/aibot-node-sdk@1.0.7@@@1/dist/types/api.d.ts
 *   TemplateCardButton: { text, style?: 1|2|3|4, key }
 *   TemplateCardActionMenu.action_list[]: { text, key } (length 1-3)
 *   task_id: 数字+字母+_-@, 最长 128 字节
 */
type WireButton = { text: string; style?: number; key: string };
type WireActionMenuItem = { text: string; key: string };

function mapButtonTypeToStyle(t: string | undefined): number {
  // aibot style: 1=default, 2=primary, 3=something, 4=danger (Feishu 推测对齐)
  // PR 7.5.6 验证: primary → 2, danger → 4, default/undefined → 1
  if (t === 'primary') return 2;
  if (t === 'danger') return 4;
  return 1;
}

function transformButtonToWire(btn: any): WireButton {
  return {
    text: btn.action_title?.text ?? btn.text ?? '',
    key: btn.action_tag ?? btn.key ?? '',
    ...(btn.button_type !== undefined ? { style: mapButtonTypeToStyle(btn.button_type) } : {}),
  };
}

function transformActionMenuItemToWire(item: any): WireActionMenuItem {
  return {
    text: item.action_title?.text ?? item.text ?? '',
    key: item.action_tag ?? item.key ?? '',
  };
}

function transformToWireShape(card: WecomTemplateCard): WecomTemplateCard {
  const wire: any = { ...card };

  // 1. button_list.button[]
  if (card.card_type === 'button_interaction' && card.button_list?.button) {
    wire.button_list = {
      button: card.button_list.button.map(transformButtonToWire),
    };
  }

  // 2. action_menu.action_list[]
  if ((card as any).action_menu?.action_list) {
    wire.action_menu = {
      desc: (card as any).action_menu.desc ?? '操作',
      action_list: (card as any).action_menu.action_list.map(transformActionMenuItemToWire),
    };
  }

  // PR 7.5.7: 移除 task_id sanitize — first-reply 模板卡不应带 task_id
  //   PR 7 完成卡也错 (server errcode=42014), 只是 PR 7 没真机测过

  return wire as WecomTemplateCard;
}

/**
 * PR 7.5.7: 标准化 SDK 错误为 Error 实例
 *
 * 背景: aibot SDK 的 WsManager.sendReply 在 server 返回 errcode!=0 时
 *   reject 原始 frame 对象 ({errcode, errmsg, hint}), 不是 Error 实例.
 *   上游 logger.error 用 `err instanceof Error ? err.message : String(err)`
 *   只能看到 "[object Object]" — 失去诊断信息.
 *
 * 修法: 把 frame-style err 包成 Error, errcode/errmsg 拼到 message.
 */
function normalizeSdkError(err: unknown, op: string): Error {
  if (err instanceof Error) return err;
  if (typeof err === 'object' && err !== null) {
    const frame = err as any;
    return new Error(
      `[wecom-complete-card] ${op} failed: errcode=${frame.errcode ?? '?'}, errmsg=${frame.errmsg ?? '?'}, hint=${frame.hint ?? '?'}`,
    );
  }
  return new Error(`[wecom-complete-card] ${op} failed: ${String(err)}`);
}

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
 * PR 7.1: 构造完成卡片
 * - 主卡 button_interaction (3 按钮)
 * - 右上角 action_menu (4 项复用现有 case)
 *
 * PR 7.5.7: 移除了 task_id 注入 (留扩展点注释也移除)
 *   — first-reply 模板卡不应带 task_id
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

  // PR 7.5.7: 不再注入 task_id — first-reply 模板卡不应带 task_id
  //   task_id 是 updateTemplateCard 关联已存在卡片用的, 不是 first reply 必填
  //   真机 /list 测试发现带 task_id 触发 server errcode=42014
  //   "taskid has existed or empty or exceed max len" (PR 7 完成卡也错, 只是 PR 7 没真机测过)

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
    // PR 7.5.6: 转换内部 shape (action_tag/action_title/button_type) → wire (key/text/style)
    //   + 验证 task_id 长度/字符 (防 server 40058/42014 拒收 + 5s fallback)
    const wireCard = transformToWireShape(card);
    // PR 7.1 I-3: 单次 cast 到 SDK wire-shape (WecomTemplateCard → TemplateCard),
    //   buildCompleteCard 内部的 (card as any).action_menu / task_id 注入保留 —
    //   这两字段在 WecomTemplateCard union 下 optional, 需要 mutable 注入, 留 cast。
    const payload = {
      msgtype: 'template_card' as const,
      template_card: wireCard as unknown as CompleteCardPayload,
    };
    // PR 7.5.9: 诊断日志从 info 降为 debug — 避免 log 噪音 (每次 /list 都打 2000 字符)
    logger.debug(`[wecom-complete-card] send wire payload: ${JSON.stringify(wireCard).slice(0, 500)}`);
    // PR 7 final cleanup: 群聊场景下 chatId 优先 — 单聊 chatId === userId 无影响
    const receiveId = ctx.chatId ?? ctx.userId;
    try {
      await this.sdk.sendMessage(receiveId, payload);
    } catch (err) {
      // PR 7.5.7: SDK 的 sendReply 在 server 拒收时 reject 原始 frame 对象 (errcode/errmsg 字段),
      //   不是 Error 实例. 标准化为 Error 让上层 instanceof Error 检查正常工作.
      throw normalizeSdkError(err, 'sendMessage');
    }
    const taskId = (wireCard as unknown as CompleteCardPayload).task_id;
    logger.info(`[wecom-complete-card] sent: receiveId=${receiveId.slice(0, 12)}... taskId=${taskId ?? '(none)'}`);
  }

  /**
   * PR 7.5.9 fallback chain: replyWelcome (优先, fresh req_id 场景) → sendMessage (fallback).
   *
   * 历史: PR 7.5.5/7.5.8 只调 replyWelcome, 真机部署后 /list 仍 fallback 到 markdown,
   *   daemon log 暴露真根因 errcode=846605 "Warning: wrong json format. invalid req_id".
   *
   * 真根因: aibot server 用 rendezvous 协议 — inbound event 的 req_id 5s 后过期.
   *   cc-linker SpoolQueue dispatch loop 1-3s + handleCommand 处理时间,
   *   到 sendViaReply 时 req_id 已失效 → server 拒收.
   *   PR 7.5.5/8 选 replyWelcome (用 inbound req_id) 是错的协议 — 命令路径下必然超时.
   *
   * markdown 兜底一直能用 sendMessage 是因为 sendMessage 走 WsCmd.SEND_MSG 协议,
   *   server 自己生成 req_id (不依赖 inbound). PR 7.5.6 修了 wire shape 后
   *   sendMessage 应该能正常推卡片.
   *
   * 修法: fallback chain — 先试 replyWelcome (fresh req_id 场景, 比如 button callback),
   *   失败时若是 846605 → fallback 到 sendMessage (主动推送, 自己生成 req_id).
   *   其他错误 (40058 wire shape 错 等) 不 fallback, 抛给上层走 markdown 兜底.
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
    // PR 7.5.6: wire shape 转换 (同 send) — action_tag→key, action_title.text→text, button_type→style
    const wireCard = transformToWireShape(finalCard);
    const payload = {
      msgtype: 'template_card' as const,
      template_card: wireCard as unknown as CompleteCardPayload,
    };
    // PR 7.5.9: 诊断日志从 info 降为 debug — 避免 log 噪音 (每次 /list 都打 2000 字符)
    logger.debug(`[wecom-complete-card] sendViaReply wire payload: ${JSON.stringify(wireCard).slice(0, 500)}`);

    // 1. 优先 replyWelcome (fresh req_id 场景: button callback 等能用)
    try {
      await this.sdk.replyWelcome(frame, payload);
      logger.info(`[wecom-complete-card] sent via replyWelcome`);
      return;
    } catch (err) {
      // PR 7.5.9: 846605 invalid req_id → fallback 到 sendMessage (主动推送, 自己生成 req_id)
      const wrappedErr = normalizeSdkError(err, 'replyWelcome');
      const errMsg = wrappedErr.message;
      if (errMsg.includes('846605') || errMsg.toLowerCase().includes('invalid req_id')) {
        logger.warn(`[wecom-complete-card] replyWelcome failed with 846605 (req_id expired), fallback to sendMessage`);
      } else {
        // 其他错误 (40058/42014 等) 不 fallback, 直接抛给上层
        throw wrappedErr;
      }
    }

    // 2. fallback: sendMessage (主动推送, 自己生成 req_id, 不依赖 inbound)
    const receiveId = ctx.chatId ?? ctx.userId;
    try {
      await this.sdk.sendMessage(receiveId, payload);
    } catch (err) {
      throw normalizeSdkError(err, 'sendMessage (fallback)');
    }
    logger.info(`[wecom-complete-card] sent via sendMessage (fallback): receiveId=${receiveId.slice(0, 12)}...`);
  }
}
