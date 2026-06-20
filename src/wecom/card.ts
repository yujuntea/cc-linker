/**
 * 企微模板卡片 builder
 * 5 种类型：text_notice / news_notice / button_interaction / vote_interaction / multiple_interaction
 * 仅 button_interaction / multiple_interaction / vote_interaction + action_menu 文本通知型可更新
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2
 *
 * **PR 2 v1.2.1 (M6 修复)**: 用 Zod schema 验证 5 种 card type
 * 历史: TemplateCard = Record<string, any>，写错字段名（如 main_title.titel）编译通过、运行崩
 * 现在: parseOpts 用 Zod 严格验证 opts，验证失败 throw 含具体字段错误
 */

import { z } from 'zod';

// === Zod schemas (单一来源) ===

const ActionMenuItemSchema = z.object({
  tag: z.string().min(1),
  text: z.string().min(1),
});

const ButtonSchema = ActionMenuItemSchema.extend({
  type: z.enum(['primary', 'danger', 'default']).optional(),
});

const OptionSchema = ActionMenuItemSchema;

const TextNoticeOptsSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  actionMenu: z.array(ActionMenuItemSchema).optional(),
});

const NewsNoticeOptsSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.object({ desc: z.string().min(1), url: z.string().url() }).optional(),
});

const ButtonInteractionOptsSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  buttons: z.array(ButtonSchema).min(1),
});

const VoteInteractionOptsSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  options: z.array(OptionSchema).min(1),
});

const MultipleInteractionOptsSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  options: z.array(OptionSchema).min(1),
  submitButton: ActionMenuItemSchema.optional(),
});

export type TextNoticeOpts = z.infer<typeof TextNoticeOptsSchema>;
export type NewsNoticeOpts = z.infer<typeof NewsNoticeOptsSchema>;
export type ButtonInteractionOpts = z.infer<typeof ButtonInteractionOptsSchema>;
export type VoteInteractionOpts = z.infer<typeof VoteInteractionOptsSchema>;
export type MultipleInteractionOpts = z.infer<typeof MultipleInteractionOptsSchema>;

/** 严格类型 TemplateCard (替代 Record<string, any>) — PR 2 v1.2.1 final (F8 修复) */
const ActionTitleSchema = z.object({ tag: z.string().min(1), text: z.string().min(1) });
const ActionListItemSchema = z.object({ action_tag: z.string(), action_title: ActionTitleSchema });
const ActionMenuSchema = z.object({ desc: z.string(), action_list: z.array(ActionListItemSchema) });
const ButtonItemSchema = z.object({ action_tag: z.string(), action_title: ActionTitleSchema, button_type: z.enum(['primary', 'danger', 'default']).optional() });
const CardSourceSchema = z.object({ desc: z.string().min(1), url: z.string().url() });
const OptionListItemSchema = z.object({ action_tag: z.string(), action_title: ActionTitleSchema });
const SubmitButtonSchema = z.object({ action_tag: z.string(), action_title: ActionTitleSchema });

const TextNoticeCardSchema = z.object({
  card_type: z.literal('text_notice'),
  main_title: z.object({ title: z.string().min(1), desc: z.string().min(1) }),
  action_menu: ActionMenuSchema.optional(),
});
const NewsNoticeCardSchema = z.object({
  card_type: z.literal('news_notice'),
  main_title: z.object({ title: z.string().min(1), desc: z.string().min(1) }),
  card_source: CardSourceSchema.optional(),
});
const ButtonInteractionCardSchema = z.object({
  card_type: z.literal('button_interaction'),
  main_title: z.object({ title: z.string().min(1), desc: z.string() }),
  button_list: z.object({ button: z.array(ButtonItemSchema) }),
});
const VoteInteractionCardSchema = z.object({
  card_type: z.literal('vote_interaction'),
  main_title: z.object({ title: z.string().min(1), desc: z.string() }),
  checkbox_list: z.object({ question: z.string(), option_list: z.array(OptionListItemSchema) }),
});
const MultipleInteractionCardSchema = z.object({
  card_type: z.literal('multiple_interaction'),
  main_title: z.object({ title: z.string().min(1), desc: z.string() }),
  checkbox_list: z.object({ question: z.string(), option: z.array(OptionListItemSchema) }),
  submit_button: SubmitButtonSchema,
});

export type TemplateCard =
  | z.infer<typeof TextNoticeCardSchema>
  | z.infer<typeof NewsNoticeCardSchema>
  | z.infer<typeof ButtonInteractionCardSchema>
  | z.infer<typeof VoteInteractionCardSchema>
  | z.infer<typeof MultipleInteractionCardSchema>;

/**
 * PR 7 m-4: WecomTemplateCard — public alias for TemplateCard.
 * 让外部调用方 (bot.ts / stream-updater.ts 等) 用 `card: WecomTemplateCard`
 * 替代 `card as any`, 编译期就能 catch 字段名错误 (历史坑: main_title.titel)。
 */
export type WecomTemplateCard = TemplateCard;

/**
 * PR 7 m-9: action_menu 的 desc 默认文案。
 * 历史: textNotice 硬编码 desc: '操作', 单测/i18n/未来 UI 文案调整要 grep 全文,
 *   提常量让定位/改动都集中。
 */
const ACTION_MENU_DESC = '操作';

export const WecomCardBuilder = {
  /**
   * PR 7 m-9: 暴露 ACTION_MENU_DESC, 让单测 / 未来 i18n 集中引用,
   *   替代散落在 textNotice 里的硬编码 '操作'。
   */
  ACTION_MENU_DESC,
  textNotice(opts: TextNoticeOpts): TemplateCard {
    const validated = TextNoticeOptsSchema.parse(opts);
    // PR 7 m-4: 直接构造完整 TextNoticeCard, 不再用 `(card as any).action_menu = ...`
    //   强制类型绕过 — union 类型下 conditional property 加类型守卫更安全
    const hasActionMenu = !!(validated.actionMenu && validated.actionMenu.length > 0);
    return {
      card_type: 'text_notice',
      main_title: { title: validated.title, desc: validated.content },
      ...(hasActionMenu
        ? {
            action_menu: {
              desc: ACTION_MENU_DESC,
              action_list: validated.actionMenu!.map(a => ({
                action_tag: a.tag,
                action_title: { tag: a.tag, text: a.text },
              })),
            },
          }
        : {}),
    };
  },

  newsNotice(opts: NewsNoticeOpts): TemplateCard {
    const validated = NewsNoticeOptsSchema.parse(opts);
    // PR 7 m-4: 直接构造完整 NewsNoticeCard, 不用 `(card as any).card_source = ...`
    return {
      card_type: 'news_notice',
      main_title: { title: validated.title, desc: validated.content },
      ...(validated.source
        ? { card_source: { desc: validated.source.desc, url: validated.source.url } }
        : {}),
    };
  },

  buttonInteraction(opts: ButtonInteractionOpts): TemplateCard {
    const validated = ButtonInteractionOptsSchema.parse(opts);
    return {
      card_type: 'button_interaction',
      main_title: { title: validated.title, desc: validated.description ?? '' },
      button_list: {
        button: validated.buttons.map(b => ({
          action_tag: b.tag,
          action_title: { tag: b.tag, text: b.text },
          button_type: b.type ?? 'default',
        })),
      },
    };
  },

  voteInteraction(opts: VoteInteractionOpts): TemplateCard {
    const validated = VoteInteractionOptsSchema.parse(opts);
    return {
      card_type: 'vote_interaction',
      main_title: { title: validated.title, desc: validated.description ?? '' },
      checkbox_list: {
        question: validated.title,
        option_list: validated.options.map(o => ({
          action_tag: o.tag,
          action_title: { tag: o.tag, text: o.text },
        })),
      },
    };
  },

  multipleInteraction(opts: MultipleInteractionOpts): TemplateCard {
    const validated = MultipleInteractionOptsSchema.parse(opts);
    return {
      card_type: 'multiple_interaction',
      main_title: { title: validated.title, desc: validated.description ?? '' },
      checkbox_list: {
        question: validated.title,
        // 对齐 spec：aibot 文档 checkbox_list.option 字段（不是 option_list）
        option: validated.options.map(o => ({
          action_tag: o.tag,
          action_title: { tag: o.tag, text: o.text },
        })),
      },
      submit_button: validated.submitButton
        ? { action_tag: validated.submitButton.tag, action_title: { tag: validated.submitButton.tag, text: validated.submitButton.text } }
        : { action_tag: 'submit', action_title: { tag: 'submit', text: '提交' } },
    };
  },
};
