import { describe, it, expect, mock } from 'bun:test';
import { buildCompleteCard, WecomCompleteCardSender, COMPLETE_CARD_MAIN_BUTTONS, COMPLETE_CARD_ACTION_MENU } from '../../../src/wecom/complete-card';
import { WecomCardBuilder, type WecomTemplateCard } from '../../../src/wecom/card';

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

  it('PR 7.5.7: does NOT set task_id on card (avoids server 42014)', () => {
    const card = buildCompleteCard({ userId: 'wmu_user_abc' }) as any;
    expect(card.task_id).toBeUndefined();
  });

  it('exposes COMPLETE_CARD_MAIN_BUTTONS constant with expected keys', () => {
    expect(COMPLETE_CARD_MAIN_BUTTONS.map(b => b.key)).toEqual(['continue', 'switch', 'listdir']);
  });

  it('exposes COMPLETE_CARD_ACTION_MENU constant with expected tags', () => {
    expect(COMPLETE_CARD_ACTION_MENU.map(a => a.tag)).toEqual(['retry', 'stop', 'confirm-stop', 'list-refresh']);
  });
});

describe('WecomCompleteCardSender', () => {
  it('send() calls sdk.sendMessage with template_card msgtype + correct userId', async () => {
    const sent: any[] = [];
    const mockSdk = {
      sendMessage: async (uid: string, body: any) => {
        sent.push({ uid, body });
      },
    };
    const sender = new WecomCompleteCardSender(mockSdk as any);
    await sender.send({
      userId: 'wmu_user_test',
      sessionTitle: '测试 session',
      durationMs: 12340,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].uid).toBe('wmu_user_test');
    expect(sent[0].body.msgtype).toBe('template_card');
    expect(sent[0].body.template_card.card_type).toBe('button_interaction');
  });

  it('send() propagates sdk.sendMessage errors', async () => {
    const mockSdk = {
      sendMessage: async () => {
        throw new Error('mock network error');
      },
    };
    const sender = new WecomCompleteCardSender(mockSdk as any);
    await expect(sender.send({ userId: 'wmu_test' })).rejects.toThrow('mock network error');
  });
});

describe('PR 7.5.6: wire shape transformation', () => {
  it('send() converts button_list[].{action_tag, action_title, button_type} → {key, text, style}', async () => {
    const card = WecomCardBuilder.buttonInteraction({
      title: '测试',
      description: 'desc',
      buttons: [
        { tag: 'switch', text: '切换', type: 'primary' },
        { tag: 'stop', text: '停止', type: 'danger' },
        { tag: 'listdir', text: '列表', type: 'default' },
      ],
    });
    const capturedPayload: any[] = [];
    const mockSdk = {
      sendMessage: mock(async (_chatid: string, body: any) => {
        capturedPayload.push(body);
      }),
    } as any;
    const sender = new WecomCompleteCardSender(mockSdk);
    await sender.send({
      userId: 'test-user',
      template_card: card,
    });
    expect(capturedPayload.length).toBe(1);
    const wire = capturedPayload[0].template_card;
    expect(wire.button_list.button.length).toBe(3);
    // shape: { text, key, style? }
    expect(wire.button_list.button[0]).toEqual({ text: '切换', key: 'switch', style: 2 });
    expect(wire.button_list.button[1]).toEqual({ text: '停止', key: 'stop', style: 4 });
    expect(wire.button_list.button[2]).toEqual({ text: '列表', key: 'listdir', style: 1 });
    // 必须没有遗留 action_tag/action_title
    expect(wire.button_list.button[0].action_tag).toBeUndefined();
    expect(wire.button_list.button[0].action_title).toBeUndefined();
  });

  it('send() converts action_menu.action_list[].{action_tag, action_title} → {text, key}', async () => {
    const card = WecomCardBuilder.textNotice({
      title: 'BG Sessions',
      content: 'content',
      actionMenu: [{ tag: 'agents-refresh', text: '🔄 刷新' }],
    });
    const capturedPayload: any[] = [];
    const mockSdk = {
      sendMessage: mock(async (_chatid: string, body: any) => {
        capturedPayload.push(body);
      }),
    } as any;
    const sender = new WecomCompleteCardSender(mockSdk);
    await sender.send({
      userId: 'test-user',
      template_card: card,
    });
    const wire = capturedPayload[0].template_card;
    expect(wire.action_menu.action_list.length).toBe(1);
    expect(wire.action_menu.action_list[0]).toEqual({ text: '🔄 刷新', key: 'agents-refresh' });
    expect(wire.action_menu.action_list[0].action_tag).toBeUndefined();
  });

  it('sendViaReply() also applies wire transformation', async () => {
    const card = WecomCardBuilder.buttonInteraction({
      title: 't',
      description: 'd',
      buttons: [{ tag: 'switch', text: '切换', type: 'primary' }],
    });
    const capturedPayload: any[] = [];
    const mockSdk = {
      replyTemplateCard: mock(async (_frame: any, card: any) => {
        capturedPayload.push(card);
      }),
    } as any;
    const sender = new WecomCompleteCardSender(mockSdk);
    const fakeFrame = { headers: { req_id: 'fake_req' } };
    await sender.sendViaReply(fakeFrame, { userId: 'u', chatId: 'u' }, card);
    const wire = capturedPayload[0];
    expect(wire.button_list.button[0]).toEqual({ text: '切换', key: 'switch', style: 2 });
  });
});

describe('PR 7.5.7: no task_id + error normalization', () => {
  it('send() does NOT include task_id in wire payload (avoids server 42014)', async () => {
    const card = WecomCardBuilder.buttonInteraction({
      title: 't', description: 'd',
      buttons: [{ tag: 'k', text: 't' }],
    });
    const capturedPayload: any[] = [];
    const mockSdk = {
      sendMessage: mock(async (_chatid: string, body: any) => {
        capturedPayload.push(body);
      }),
    } as any;
    const sender = new WecomCompleteCardSender(mockSdk);
    await sender.send({ userId: 'test-user', template_card: card });
    const wire = capturedPayload[0].template_card;
    expect(wire.task_id).toBeUndefined();
  });

  it('send() normalizes SDK frame error to Error instance (shows errcode/errmsg)', async () => {
    const card = WecomCardBuilder.buttonInteraction({
      title: 't', description: 'd',
      buttons: [{ tag: 'k', text: 't' }],
    });
    const mockSdk = {
      sendMessage: mock(async () => {
        // SDK 行为: server 拒收时 reject 原始 frame 对象
        throw { errcode: 42014, errmsg: 'taskid has existed', hint: '1234567890' };
      }),
    } as any;
    const sender = new WecomCompleteCardSender(mockSdk);
    let thrownErr: any;
    try {
      await sender.send({ userId: 'test-user', template_card: card });
    } catch (err) {
      thrownErr = err;
    }
    expect(thrownErr).toBeInstanceOf(Error);
    expect(thrownErr.message).toContain('errcode=42014');
    expect(thrownErr.message).toContain('taskid has existed');
    expect(thrownErr.message).not.toContain('[object Object]');
  });

  it('sendViaReply() normalizes SDK frame error to Error instance (shows errcode/errmsg)', async () => {
    const card = WecomCardBuilder.buttonInteraction({
      title: 't', description: 'd',
      buttons: [{ tag: 'k', text: 't' }],
    });
    const mockSdk = {
      replyTemplateCard: mock(async () => {
        throw { errcode: 42014, errmsg: 'taskid has existed', hint: '1234567890' };
      }),
    } as any;
    const sender = new WecomCompleteCardSender(mockSdk);
    const fakeFrame = { headers: { req_id: 'fake_req' } };
    let thrownErr: any;
    try {
      await sender.sendViaReply(fakeFrame, { userId: 'u', chatId: 'u' }, card);
    } catch (err) {
      thrownErr = err;
    }
    expect(thrownErr).toBeInstanceOf(Error);
    expect(thrownErr.message).toContain('replyTemplateCard');
    expect(thrownErr.message).toContain('errcode=42014');
    expect(thrownErr.message).not.toContain('[object Object]');
  });
});
