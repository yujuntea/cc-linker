import { describe, it, expect } from 'bun:test';
import { WecomCardBuilder, type WecomTemplateCard } from '../../../src/wecom/card';

describe('WecomCardBuilder', () => {
  it('builds text_notice card', () => {
    const card = WecomCardBuilder.textNotice({
      title: '测试标题',
      content: '测试内容',
    });
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toBe('测试标题');
  });

  it('builds button_interaction card with action buttons', () => {
    const card = WecomCardBuilder.buttonInteraction({
      title: '操作',
      buttons: [
        { tag: 'retry', text: '重试', type: 'primary' },
        { tag: 'cancel', text: '取消', type: 'danger' },
      ],
    });
    expect(card.card_type).toBe('button_interaction');
    expect(card.button_list.button.length).toBe(2);
    expect(card.button_list.button[0].action_tag).toBe('retry');
  });

  it('builds multiple_interaction card (selectable list)', () => {
    const card = WecomCardBuilder.multipleInteraction({
      title: '选择 session',
      options: [
        { tag: 's1', text: 'Session 1' },
        { tag: 's2', text: 'Session 2' },
      ],
    });
    expect(card.card_type).toBe('multiple_interaction');
    expect(card.checkbox_list?.option.length).toBe(2);
  });

  it('builds news_notice card', () => {
    const card = WecomCardBuilder.newsNotice({
      title: '公告',
      content: '内容',
    });
    expect(card.card_type).toBe('news_notice');
  });

  it('builds vote_interaction card', () => {
    const card = WecomCardBuilder.voteInteraction({
      title: '投票',
      options: [{ tag: 'opt1', text: '选项 1' }],
    });
    expect(card.card_type).toBe('vote_interaction');
  });

  it('m-4: textNotice with actionMenu sets action_menu without `as any` escape hatch', () => {
    // PR 7 m-4 修法: 内部实现不再用 `(card as any).action_menu = ...`,
    //   直接构造 TextNoticeCard 完整对象让 union 类型自然 narrow
    const card = WecomCardBuilder.textNotice({
      title: 't',
      content: 'c',
      actionMenu: [{ tag: 'retry', text: '重试' }],
    });
    // typecheck 验证: 这条赋值在没有 `as any` 的情况下也能编译
    const _typed: WecomTemplateCard = card;
    expect(_typed.card_type).toBe('text_notice');
    if (_typed.card_type === 'text_notice') {
      expect(_typed.action_menu?.desc).toBeTruthy();
      expect(_typed.action_menu?.action_list.length).toBe(1);
    }
  });

  it('m-4: newsNotice with source sets card_source without `as any` escape hatch', () => {
    const card = WecomCardBuilder.newsNotice({
      title: 't',
      content: 'c',
      source: { desc: 'src', url: 'https://example.com' },
    });
    const _typed: WecomTemplateCard = card;
    expect(_typed.card_type).toBe('news_notice');
    if (_typed.card_type === 'news_notice') {
      expect(_typed.card_source?.url).toBe('https://example.com');
    }
  });

  it('m-9: action_menu uses ACTION_MENU_DESC constant (no hardcoded "操作" string)', () => {
    // PR 7 m-9 修法: textNotice 的 action_menu.desc 硬编码 '操作',
    //   单测/i18n/未来 UI 文案调整都要 grep 全文, 提常量让定位 / 改动都集中
    const card = WecomCardBuilder.textNotice({
      title: 't',
      content: 'c',
      actionMenu: [{ tag: 'retry', text: '重试' }],
    });
    if (card.card_type !== 'text_notice' || !card.action_menu) {
      throw new Error('expected text_notice with action_menu');
    }
    // 验证 desc 跟常量一致 (而非另一个魔法字符串)
    expect((WecomCardBuilder as any).ACTION_MENU_DESC).toBeDefined();
    expect(card.action_menu.desc).toBe((WecomCardBuilder as any).ACTION_MENU_DESC);
  });
});
