/**
 * PR 7.5.14: Systematic 40016 isolation — comprehensive wire shape audit
 *
 * 背景: 前 12 PRs 修了 button count / task_id / action_menu 等所有可疑字段,
 *   server 仍返 40016 "invalid button size". SDK 类型 (api.d.ts) 标记
 *   source/card_action/emphasis_content/sub_title_text 等字段为 OPTIONAL,
 *   但 server 实际可能 REQUIRE 其中的某一个.
 *
 * 目标: dump 多种 card shape 的 wire payload JSON, 对比 SDK 类型定义,
 *   找 server 实际 CHECK 但 SDK 文档未标注的必填字段.
 *
 * 策略: 渐进加字段 (minimal → +source → +card_action → +sub_title_text → +emphasis_content),
 *   每变体单独 capture, 序列化完整 JSON. 让人审 / 后续真机 E2E 跑时知道
 *   "we sent exactly this shape, server still 40016, missing X".
 *
 * @see /Users/wuyujun/.bun/install/cache/@wecom/aibot-node-sdk@1.0.7@@@1/dist/types/api.d.ts
 */
import { describe, it, expect, mock } from 'bun:test';
import { WecomCompleteCardSender } from '../../../src/wecom/complete-card';
import { WecomCardBuilder } from '../../../src/wecom/card';
import { buildListCard, type ListCardContext } from '../../../src/wecom/card-builders';

/**
 * Helper: capture wire payload sent through sender.send()
 */
function makeCapturingSender() {
  const captured: any[] = [];
  const mockSdk = {
    sendMessage: mock(async (_chatid: string, body: any) => {
      captured.push(body);
    }),
  } as any;
  const sender = new WecomCompleteCardSender(mockSdk);
  return { sender, captured, mockSdk };
}

/**
 * Build a minimal button_interaction card matching SDK TemplateCard type
 * (action_tag / action_title / button_type internal shape)
 */
function minimalButtonCard() {
  return WecomCardBuilder.buttonInteraction({
    title: 'Test',
    description: 'd',
    buttons: [{ tag: 'ok', text: 'OK', type: 'default' }],
  });
}

describe('PR 7.5.14: wire shape systematic audit', () => {
  it('A. baseline: minimal button_interaction (no source / no task_id / no action_menu)', async () => {
    const { sender, captured } = makeCapturingSender();
    const card = minimalButtonCard();
    // PR 7.5.11 always injects task_id in transformToWireShape
    await sender.send({ userId: 'u', template_card: card });
    expect(captured).toHaveLength(1);
    const wire = captured[0].template_card;
    console.log('[A.minimal] wire:', JSON.stringify(wire));
    // baseline assertions
    expect(wire.card_type).toBe('button_interaction');
    expect(wire.main_title.title).toBe('Test');
    expect(wire.button_list.button).toHaveLength(1);
    expect(wire.button_list.button[0].key).toBe('ok');
    expect(wire.button_list.button[0].text).toBe('OK');
    expect(wire.button_list.button[0].style).toBe(1);
  });

  it('B. +task_id (current behavior of transformToWireShape)', async () => {
    const { sender, captured } = makeCapturingSender();
    await sender.send({ userId: 'u', template_card: minimalButtonCard() });
    const wire = captured[0].template_card;
    console.log('[B.with_task_id] wire:', JSON.stringify(wire));
    expect(wire.task_id).toBeDefined();
    expect(wire.task_id).toMatch(/^wcli/);
  });

  it('B2. PR 7.5.14: sender auto-injects source field (TemplateCardSource) for first-reply cards', async () => {
    const { sender, captured } = makeCapturingSender();
    // 故意不传 source, 验证 transformToWireShape 帮我们注入
    await sender.send({ userId: 'u', template_card: minimalButtonCard() });
    const wire = captured[0].template_card;
    console.log('[B2.auto_source] wire:', JSON.stringify(wire));
    expect(wire.source).toBeDefined();
    expect(wire.source.desc).toBe('Claude Code');
    expect(wire.source.url).toBe('https://example.com/cc-linker');
  });

  it('B3. PR 7.5.14: caller-provided source takes precedence over auto-injected', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = minimalButtonCard();
    card.source = { desc: 'Custom', url: 'https://custom.example.com' };
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[B3.caller_source] wire:', JSON.stringify(wire));
    expect(wire.source.desc).toBe('Custom');
    expect(wire.source.url).toBe('https://custom.example.com');
  });

  it('C. +source field (TemplateCardSource — desc + url)', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = minimalButtonCard();
    card.source = { desc: 'Claude Code', url: 'https://example.com/cc-linker' };
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[C.with_source] wire:', JSON.stringify(wire));
    expect(wire.source).toBeDefined();
    expect(wire.source.desc).toBe('Claude Code');
  });

  it('D. +source field WITHOUT url (desc only — desc_color not required)', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = minimalButtonCard();
    card.source = { desc: 'Claude Code' };
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[D.source_no_url] wire:', JSON.stringify(wire));
    expect(wire.source.desc).toBe('Claude Code');
    expect(wire.source.url).toBeUndefined();
  });

  it('E. +card_action (TemplateCardAction — type: 0 default no URL)', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = minimalButtonCard();
    card.card_action = { type: 0 };
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[E.with_card_action] wire:', JSON.stringify(wire));
    expect(wire.card_action).toBeDefined();
    expect(wire.card_action.type).toBe(0);
  });

  it('F. +sub_title_text (string, ≤112)', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = minimalButtonCard();
    card.sub_title_text = 'Additional context here';
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[F.with_sub_title] wire:', JSON.stringify(wire));
    expect(wire.sub_title_text).toBe('Additional context here');
  });

  it('G. +emphasis_content (TemplateCardEmphasisContent)', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = minimalButtonCard();
    card.emphasis_content = { title: '3', desc: 'sessions' };
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[G.with_emphasis] wire:', JSON.stringify(wire));
    expect(wire.emphasis_content).toBeDefined();
  });

  it('H. +horizontal_content_list (TemplateCardHorizontalContent[])', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = minimalButtonCard();
    card.horizontal_content_list = [
      { keyname: 'Project', value: 'cc-linker' },
      { keyname: 'Sessions', value: '3' },
    ];
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[H.with_horizontal] wire:', JSON.stringify(wire));
    expect(wire.horizontal_content_list).toHaveLength(2);
  });

  it('I. ALL of source + card_action + sub_title_text + emphasis_content + horizontal', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = minimalButtonCard();
    card.source = { desc: 'Claude Code', url: 'https://example.com/cc-linker' };
    card.card_action = { type: 0 };
    card.sub_title_text = 'Test subtitle';
    card.emphasis_content = { title: '5', desc: 'sessions' };
    card.horizontal_content_list = [{ keyname: 'Status', value: 'active' }];
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[I.all_fields] wire:', JSON.stringify(wire));
    expect(wire.source).toBeDefined();
    expect(wire.card_action).toBeDefined();
    expect(wire.sub_title_text).toBeDefined();
    expect(wire.emphasis_content).toBeDefined();
    expect(wire.horizontal_content_list).toBeDefined();
  });

  it('J. text_notice baseline (different card_type, no button_list)', async () => {
    const { sender, captured } = makeCapturingSender();
    const card = WecomCardBuilder.textNotice({
      title: 'Hello',
      content: 'world',
    });
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[J.text_notice] wire:', JSON.stringify(wire));
    expect(wire.card_type).toBe('text_notice');
    expect(wire.button_list).toBeUndefined();
  });

  it('K. text_notice with source field (test if source helps text_notice too)', async () => {
    const { sender, captured } = makeCapturingSender();
    const card: any = WecomCardBuilder.textNotice({
      title: 'Hello',
      content: 'world',
    });
    card.source = { desc: 'Claude Code', url: 'https://example.com/cc-linker' };
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[K.text_notice_source] wire:', JSON.stringify(wire));
    expect(wire.source).toBeDefined();
  });
});

describe('PR 7.5.14: buildListCard integration dump', () => {
  it('L. current buildListCard wire (after PR 7.5.13 truncation)', async () => {
    const { sender, captured } = makeCapturingSender();
    const ctx: ListCardContext = {
      entries: [
        { sessionUuid: 'uuid-1', title: 'My session', messageCount: 5, lastActive: '2026-06-21' },
      ],
      totalActive: 1,
    };
    const card = buildListCard(ctx);
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[L.buildListCard] wire:', JSON.stringify(wire));
    expect(wire.card_type).toBe('button_interaction');
    expect(wire.button_list.button).toHaveLength(1);
    // PR 7.5.13 truncation checks
    expect(wire.main_title.title.length).toBeLessThanOrEqual(26);
    expect(wire.main_title.desc.length).toBeLessThanOrEqual(30);
    expect(wire.button_list.button[0].text.length).toBeLessThanOrEqual(10);
  });

  it('M. buildListCard with 6 entries (the SDK max button count)', async () => {
    const { sender, captured } = makeCapturingSender();
    const ctx: ListCardContext = {
      entries: Array.from({ length: 6 }, (_, i) => ({
        sessionUuid: `uuid-${i}`,
        title: `Session ${i} long title test`,
        messageCount: i,
        lastActive: '2026-06-21',
      })),
      totalActive: 6,
    };
    const card = buildListCard(ctx);
    await sender.send({ userId: 'u', template_card: card });
    const wire = captured[0].template_card;
    console.log('[M.buildListCard_6btns] wire:', JSON.stringify(wire));
    expect(wire.button_list.button).toHaveLength(6);
  });
});

describe('PR 7.5.14: full WS frame (the actual bytes over the wire)', () => {
  it('N. captures entire SDK sendMessage body (chatid + msgtype + template_card)', async () => {
    const captured: any[] = [];
    const mockSdk = {
      sendMessage: mock(async (chatid: string, body: any) => {
        captured.push({ chatid, body });
      }),
    } as any;
    const sender = new WecomCompleteCardSender(mockSdk);
    await sender.send({ userId: 'wmu_test_user', template_card: minimalButtonCard() });
    // This is the EXACT shape SDK wraps into WsCmd.SEND_MSG body
    console.log('[N.full_frame] body:', JSON.stringify(captured[0]));
    expect(captured[0].chatid).toBe('wmu_test_user');
    expect(captured[0].body.msgtype).toBe('template_card');
    expect(captured[0].body.template_card.card_type).toBe('button_interaction');
  });
});
