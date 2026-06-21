import { describe, it, expect } from 'bun:test';
import {
  buildListCard,
  buildDirListCard,
  buildModelCard,
  buildAgentsRefreshCard,
  buildResumeCard,
  buildStopCard,
  type ListCardContext,
  type DirListCardContext,
  type ModelCardContext,
  type AgentsCardContext,
  type ResumeCardContext,
  type StopCardContext,
} from '../../../src/wecom/card-builders';
import type { WecomTemplateCard } from '../../../src/wecom/card';

describe('buildListCard', () => {
  it('builds button_interaction with up to 6 switch buttons (PR 7.5.13: real fix, button text length not count)', () => {
    const ctx: ListCardContext = {
      entries: [
        { sessionUuid: 'uuid-1', title: 'Analyze AI coding attribution', messageCount: 768, lastActive: '2026-06-21T13:24:00Z' },
        { sessionUuid: 'uuid-2', title: 'Build GLM coding plan', messageCount: 773, lastActive: '2026-06-21T12:59:00Z' },
      ],
      totalActive: 777,
    };
    const card: WecomTemplateCard = buildListCard(ctx);
    expect(card.card_type).toBe('button_interaction');
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    // PR 7.5.13: 恢复 6 按钮上限 (button count 本身合规, 真因是 text length)
    expect(card.button_list.button.length).toBe(2);
    expect(card.button_list.button[0].action_tag).toBe('switch');
    expect((card.button_list.button[0] as any).value?.sessionUuid).toBe('uuid-1');
    // PR 7.5.13: button text = title.slice(0, 10) (无 emoji 前缀, 省单位)
    expect(card.button_list.button[0].action_title.text).toContain('Analyze');
    expect(card.main_title.title).toContain('2/777');
    // 简化 desc (无 action_menu)
    expect((card as any).action_menu).toBeUndefined();
  });

  it('handles empty entries (0 buttons + 📭 desc)', () => {
    const ctx: ListCardContext = { entries: [], totalActive: 0 };
    const card = buildListCard(ctx);
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toContain('0/0');
    expect(card.main_title.desc).toContain('📭');
  });

  it('PR 7.5.13: limits to 6 buttons max + simplified desc', () => {
    const ctx: ListCardContext = {
      entries: Array.from({ length: 10 }, (_, i) => ({
        sessionUuid: `uuid-${i}`,
        title: `Session ${i}`,
        messageCount: 100 + i,
        lastActive: `2026-06-21T13:${String(10 + i).padStart(2, '0')}:00Z`,
      })),
      totalActive: 778,
    };
    const card = buildListCard(ctx);
    expect(card.card_type).toBe('button_interaction');
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    // PR 7.5.13: SDK 允许 6 按钮上限, 10 entries 截前 6
    expect(card.button_list.button.length).toBe(6);
    // desc 提示用户还有未显示的 (简化版, ≤30 字)
    expect(card.main_title.desc).toContain('还有 4 个未显示');
    // title 显示 6/778
    expect(card.main_title.title).toContain('6/778');
  });

  it('PR 7.5.13: button.text length ≤10 (SDK limit, server 40016 prevention)', () => {
    const ctx: ListCardContext = {
      entries: [
        { sessionUuid: 'u1', title: 'Review AI attribution fix plan (very long title)', messageCount: 100, lastActive: '2026-06-21T13:00:00Z' },
        { sessionUuid: 'u2', title: '短标题', messageCount: 50, lastActive: '2026-06-21T13:01:00Z' },
      ],
      totalActive: 10,
    };
    const card = buildListCard(ctx);
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    for (const btn of card.button_list.button) {
      expect((btn.action_title.text ?? '').length).toBeLessThanOrEqual(10);
    }
  });

  it('PR 7.5.13: title ≤26, desc ≤30 (SDK limits)', () => {
    const ctx: ListCardContext = {
      entries: [
        { sessionUuid: 'u1', title: 'test', messageCount: 1, lastActive: '2026-06-21T13:00:00Z' },
      ],
      totalActive: 9999,  // 大数字可能撑大 title
    };
    const card = buildListCard(ctx);
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    expect((card.main_title.title ?? '').length).toBeLessThanOrEqual(26);
    expect((card.main_title.desc ?? '').length).toBeLessThanOrEqual(30);
  });
});

describe('buildDirListCard', () => {
  it('builds button_interaction with parent + dir buttons + value.sessionUuid = path', () => {
    const ctx: DirListCardContext = {
      cwd: '/tmp',
      parent: '/',
      dirs: [
        { name: 'activity-test-project', fullPath: '/tmp/activity-test-project' },
        { name: 'aibot-poc', fullPath: '/tmp/aibot-poc' },
      ],
      hasMore: false,
    };
    const card = buildDirListCard(ctx);
    expect(card.card_type).toBe('button_interaction');
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    expect(card.button_list.button.length).toBe(3);
    expect(card.button_list.button[0].action_tag).toBe('select_dir');
    expect((card.button_list.button[0] as any).value?.sessionUuid).toBe('/');
    expect(card.button_list.button[0].action_title.text).toContain('上级');
    expect((card.button_list.button[1] as any).value?.sessionUuid).toBe('/tmp/activity-test-project');
    expect((card.button_list.button[2] as any).value?.sessionUuid).toBe('/tmp/aibot-poc');
  });

  it('handles no parent (root dir) - no parent button', () => {
    const ctx: DirListCardContext = {
      cwd: '/',
      parent: null,
      dirs: [{ name: 'tmp', fullPath: '/tmp' }],
      hasMore: false,
    };
    const card = buildDirListCard(ctx);
    expect(card.card_type).toBe('button_interaction');
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    expect(card.button_list.button.length).toBe(1);
    expect(card.button_list.button[0].action_tag).toBe('select_dir');
  });

  it('shows hasMore indicator when truncated', () => {
    const ctx: DirListCardContext = { cwd: '/tmp', parent: '/', dirs: [], hasMore: true };
    const card = buildDirListCard(ctx);
    expect(card.main_title.desc).toContain('还有更多');
  });

  it('PR 7.5.13: button.text ≤10 + title ≤26 + desc ≤30 (defensive)', () => {
    const ctx: DirListCardContext = {
      cwd: '/Users/wuyujun/Git/some-very-long-path-name',  // > 26
      parent: '/',
      dirs: [
        { name: 'a-very-long-directory-name-here', fullPath: '/Users/.../a-very-long-directory-name-here' },
        { name: 'short', fullPath: '/Users/.../short' },
      ],
      hasMore: true,
    };
    const card = buildDirListCard(ctx);
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    for (const btn of card.button_list.button) {
      expect((btn.action_title.text ?? '').length).toBeLessThanOrEqual(10);
    }
    expect((card.main_title.title ?? '').length).toBeLessThanOrEqual(26);
    expect((card.main_title.desc ?? '').length).toBeLessThanOrEqual(30);
  });
});

describe('buildModelCard', () => {
  it('builds button_interaction with provider buttons + clear button + value.sessionUuid = alias', () => {
    const ctx: ModelCardContext = {
      providers: [
        { alias: 'opus', name: 'Opus' },
        { alias: 'sonnet', name: 'Sonnet' },
        { alias: 'haiku', name: 'Haiku' },
      ],
      currentAlias: 'sonnet',
    };
    const card = buildModelCard(ctx);
    expect(card.card_type).toBe('button_interaction');
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    expect(card.button_list.button.length).toBe(4);  // 3 providers + 1 clear
    expect(card.button_list.button[0].action_tag).toBe('select_model');
    expect((card.button_list.button[0] as any).value?.sessionUuid).toBe('opus');
    expect(card.button_list.button[0].action_title.text).toContain('Opus');
    expect(card.button_list.button[0].action_title.text).not.toContain('当前');
    expect(card.button_list.button[1].action_tag).toBe('select_model');
    expect((card.button_list.button[1] as any).value?.sessionUuid).toBe('sonnet');
    // PR 7.5.13: '🎯 Sonnet (当前)' = 13 字 > 10 SDK 限制
    //   修法: 截到 ≤10, 牺牲 '(当前)' 文本 → 用 type='default' 视觉传达
    expect(card.button_list.button[1].action_title.text.length).toBeLessThanOrEqual(10);
    expect(card.button_list.button[1].action_title.text).toContain('Sonnet');
    // type='default' 仍是当前标识 (aibot 客户端会用不同样式)
    expect((card.button_list.button[1] as any).button_type).toBe('default');
    const clearBtn = card.button_list.button[3];
    expect(clearBtn.action_tag).toBe('clear_model');
    expect(clearBtn.action_title.text).toContain('清除');
  });

  it('PR 7.5.13: button.text ≤10 even with long provider name (defensive)', () => {
    const ctx: ModelCardContext = {
      providers: [
        { alias: 'long', name: 'Very-Long-Provider-Name-Here' },
        { alias: 'opus', name: 'Opus' },
      ],
      currentAlias: 'long',
    };
    const card = buildModelCard(ctx);
    if (card.card_type !== 'button_interaction') throw new Error('unreachable');
    for (const btn of card.button_list.button) {
      expect((btn.action_title.text ?? '').length).toBeLessThanOrEqual(10);
    }
  });
});

describe('buildAgentsRefreshCard', () => {
  it('builds text_notice with agents-refresh action_menu', () => {
    const ctx: AgentsCardContext = { bgCount: 3 };
    const card = buildAgentsRefreshCard(ctx);
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toContain('BG Sessions (3)');
    expect(card.action_menu?.action_list[0].action_tag).toBe('agents-refresh');
  });
});

describe('buildResumeCard', () => {
  it('builds text_notice with switch action_menu (no value → list semantics)', () => {
    const ctx: ResumeCardContext = { sessionUuid: 'uuid-resumed' };
    const card = buildResumeCard(ctx);
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toContain('Session 已 touch');
    expect(card.action_menu?.action_list[0].action_tag).toBe('switch');
    // switch value must be empty → list sessions semantics
    expect((card.action_menu?.action_list[0] as any).value).toBeUndefined();
  });
});

describe('buildStopCard', () => {
  it('builds text_notice with switch action_menu (no value → list semantics)', () => {
    const ctx: StopCardContext = { shortId: 'abc123' };
    const card = buildStopCard(ctx);
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toContain('已停止');
    expect(card.action_menu?.action_list[0].action_tag).toBe('switch');
    expect((card.action_menu?.action_list[0] as any).value).toBeUndefined();
  });
});