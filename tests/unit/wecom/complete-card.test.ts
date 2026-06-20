import { describe, it, expect } from 'bun:test';
import { buildCompleteCard, COMPLETE_CARD_MAIN_BUTTONS, COMPLETE_CARD_ACTION_MENU } from '../../../src/wecom/complete-card';
import type { WecomTemplateCard } from '../../../src/wecom/card';

describe('buildCompleteCard', () => {
  it('builds button_interaction card with 3 main buttons + action_menu (4 items)', () => {
    const card: WecomTemplateCard = buildCompleteCard({
      userId: 'wmu_test_user_123',
      sessionTitle: '分析代码',
      durationMs: 12340,
    });

    expect(card.card_type).toBe('button_interaction');
    // 主卡 3 按钮
    expect(card.button_list.button.length).toBe(3);
    expect(card.button_list.button[0].action_tag).toBe('continue');
    expect(card.button_list.button[1].action_tag).toBe('switch');
    expect(card.button_list.button[2].action_tag).toBe('listdir');
    // 主标题含 sessionTitle
    expect(card.main_title.title).toContain('Claude 处理完成');
    expect(card.main_title.title).toContain('分析代码');
    expect(card.main_title.desc).toContain('耗时 12s');
    // action_menu 4 项
    expect(card.action_menu?.desc).toBe('操作');
    expect(card.action_menu?.action_list.length).toBe(4);
    expect(card.action_menu?.action_list[0].action_tag).toBe('retry');
    expect(card.action_menu?.action_list[3].action_tag).toBe('list-refresh');
  });

  it('omits sessionTitle suffix when not provided', () => {
    const card = buildCompleteCard({ userId: 'wmu_no_title' });
    expect(card.main_title.title).toBe('✅ Claude 处理完成');
    expect(card.main_title.desc).toBe('💡 点按下方按钮继续');
  });

  it('generates unique task_id each call (ccdone- prefix + userId slice)', () => {
    const c1 = buildCompleteCard({ userId: 'wmu_user_abc' }) as any;
    const c2 = buildCompleteCard({ userId: 'wmu_user_abc' }) as any;
    // task_id 不同 (Date.now() 不同)
    expect(c1.task_id).not.toBe(c2.task_id);
    // 都是 ccdone- 开头, 含 userId 前 12 字符
    expect(c1.task_id.startsWith('ccdone-')).toBe(true);
    expect(c1.task_id).toContain('wmu_user_abc');
  });

  it('truncates task_id to <=128 bytes for userId safety', () => {
    const longUserId = 'wmu_' + 'a'.repeat(200);
    const card = buildCompleteCard({ userId: longUserId }) as any;
    // userId slice(0, 12) 限制 → task_id 必 ≤ "ccdone-" + 13digits + "-" + 12chars = ~31 字符
    expect(card.task_id.length).toBeLessThanOrEqual(128);
  });

  it('exposes COMPLETE_CARD_MAIN_BUTTONS constant with expected keys', () => {
    expect(COMPLETE_CARD_MAIN_BUTTONS.map(b => b.key)).toEqual(['continue', 'switch', 'listdir']);
  });

  it('exposes COMPLETE_CARD_ACTION_MENU constant with expected tags', () => {
    expect(COMPLETE_CARD_ACTION_MENU.map(a => a.tag)).toEqual(['retry', 'stop', 'confirm-stop', 'list-refresh']);
  });
});
