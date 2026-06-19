/**
 * 企微模板卡片 builder
 * 5 种类型：text_notice / news_notice / button_interaction / vote_interaction / multiple_interaction
 * 仅 button_interaction / multiple_interaction / vote_interaction + action_menu 文本通知型可更新
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.2
 */

export type TemplateCard = Record<string, any>;

type TextNoticeOpts = {
  title: string;
  content: string;
  actionMenu?: Array<{ tag: string; text: string }>;
};

type ButtonInteractionOpts = {
  title: string;
  description?: string;
  buttons: Array<{ tag: string; text: string; type?: 'primary' | 'danger' | 'default' }>;
};

type VoteInteractionOpts = {
  title: string;
  description?: string;
  options: Array<{ tag: string; text: string }>;
};

type MultipleInteractionOpts = {
  title: string;
  description?: string;
  options: Array<{ tag: string; text: string }>;
  submitButton?: { tag: string; text: string };
};

type NewsNoticeOpts = {
  title: string;
  content: string;
  source?: { desc: string; url: string };
};

export const WecomCardBuilder = {
  textNotice(opts: TextNoticeOpts): TemplateCard {
    const card: TemplateCard = {
      card_type: 'text_notice',
      main_title: { title: opts.title, desc: opts.content },
    };
    if (opts.actionMenu && opts.actionMenu.length > 0) {
      card.action_menu = {
        desc: '操作',
        action_list: opts.actionMenu.map(a => ({
          action_tag: a.tag,
          action_title: { tag: a.tag, text: a.text },
        })),
      };
    }
    return card;
  },

  newsNotice(opts: NewsNoticeOpts): TemplateCard {
    const card: TemplateCard = {
      card_type: 'news_notice',
      main_title: { title: opts.title, desc: opts.content },
    };
    if (opts.source) {
      card.card_source = { desc: opts.source.desc, url: opts.source.url };
    }
    return card;
  },

  buttonInteraction(opts: ButtonInteractionOpts): TemplateCard {
    return {
      card_type: 'button_interaction',
      main_title: { title: opts.title, desc: opts.description ?? '' },
      button_list: {
        button: opts.buttons.map(b => ({
          action_tag: b.tag,
          action_title: { tag: b.tag, text: b.text },
          button_type: b.type ?? 'default',
        })),
      },
    };
  },

  voteInteraction(opts: VoteInteractionOpts): TemplateCard {
    return {
      card_type: 'vote_interaction',
      main_title: { title: opts.title, desc: opts.description ?? '' },
      checkbox_list: {
        question: opts.title,
        option_list: opts.options.map(o => ({
          action_tag: o.tag,
          action_title: { tag: o.tag, text: o.text },
        })),
      },
    };
  },

  multipleInteraction(opts: MultipleInteractionOpts): TemplateCard {
    const card: TemplateCard = {
      card_type: 'multiple_interaction',
      main_title: { title: opts.title, desc: opts.description ?? '' },
      checkbox_list: {
        question: opts.title,
        // 对齐 spec：aibot 文档 checkbox_list.option 字段（不是 option_list）
        option: opts.options.map(o => ({
          action_tag: o.tag,
          action_title: { tag: o.tag, text: o.text },
        })),
      },
      submit_button: opts.submitButton
        ? { action_tag: opts.submitButton.tag, action_title: { tag: opts.submitButton.tag, text: opts.submitButton.text } }
        : { action_tag: 'submit', action_title: { tag: 'submit', text: '提交' } },
    };
    return card;
  },
};
