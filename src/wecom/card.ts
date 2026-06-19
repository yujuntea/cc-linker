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

/** 严格类型 TemplateCard (替代 Record<string, any>) */
export type TemplateCard =
  | { card_type: 'text_notice'; main_title: { title: string; desc: string }; action_menu?: { desc: string; action_list: any[] } }
  | { card_type: 'news_notice'; main_title: { title: string; desc: string }; card_source?: { desc: string; url: string } }
  | { card_type: 'button_interaction'; main_title: { title: string; desc: string }; button_list: { button: any[] } }
  | { card_type: 'vote_interaction'; main_title: { title: string; desc: string }; checkbox_list: { question: string; option_list: any[] } }
  | { card_type: 'multiple_interaction'; main_title: { title: string; desc: string }; checkbox_list: { question: string; option: any[] }; submit_button: { action_tag: string; action_title: { tag: string; text: string } } };

export const WecomCardBuilder = {
  textNotice(opts: TextNoticeOpts): TemplateCard {
    const validated = TextNoticeOptsSchema.parse(opts);
    const card: TemplateCard = {
      card_type: 'text_notice',
      main_title: { title: validated.title, desc: validated.content },
    };
    if (validated.actionMenu && validated.actionMenu.length > 0) {
      (card as any).action_menu = {
        desc: '操作',
        action_list: validated.actionMenu.map(a => ({
          action_tag: a.tag,
          action_title: { tag: a.tag, text: a.text },
        })),
      };
    }
    return card;
  },

  newsNotice(opts: NewsNoticeOpts): TemplateCard {
    const validated = NewsNoticeOptsSchema.parse(opts);
    const card: TemplateCard = {
      card_type: 'news_notice',
      main_title: { title: validated.title, desc: validated.content },
    };
    if (validated.source) {
      (card as any).card_source = { desc: validated.source.desc, url: validated.source.url };
    }
    return card;
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
