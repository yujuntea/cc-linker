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
  it('builds button_interaction with 2 buttons per entry + action_menu', () => {
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
    expect(card.button_list.button.length).toBe(4);  // 2 entries × 2 buttons
    expect(card.button_list.button[0].action_tag).toBe('switch');
    expect((card.button_list.button[0] as any).value?.sessionUuid).toBe('uuid-1');
    expect(card.button_list.button[1].action_tag).toBe('resume');
    expect((card.button_list.button[1] as any).value?.sessionUuid).toBe('uuid-1');
    expect(card.button_list.button[2].action_tag).toBe('switch');
    expect((card.button_list.button[2] as any).value?.sessionUuid).toBe('uuid-2');
    expect(card.button_list.button[3].action_tag).toBe('resume');
    expect((card.button_list.button[3] as any).value?.sessionUuid).toBe('uuid-2');
    expect(card.main_title.title).toContain('2/777');
    expect(card.action_menu?.action_list[0].action_tag).toBe('list-refresh');
  });

  it('handles empty entries (0 buttons + 📭 desc)', () => {
    const ctx: ListCardContext = { entries: [], totalActive: 0 };
    const card = buildListCard(ctx);
    expect(card.card_type).toBe('text_notice');
    expect(card.main_title.title).toContain('0/0');
    expect(card.main_title.desc).toContain('📭');
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
    expect(card.button_list.button[1].action_title.text).toContain('当前');
    const clearBtn = card.button_list.button[3];
    expect(clearBtn.action_tag).toBe('clear_model');
    expect(clearBtn.action_title.text).toContain('清除');
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