import { describe, it, expect } from 'bun:test';
import { WecomCardBuilder } from '../../../src/wecom/card';

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
});
