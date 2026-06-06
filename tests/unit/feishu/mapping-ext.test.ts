import { describe, expect, test } from 'bun:test';
import type { MappingEntry, MappingEntryType } from '../../../src/feishu/mapping';

describe('MappingEntryType extension (Agent View)', () => {
  test('supports pending_agent_reply and last_agent_list_card', () => {
    const types: MappingEntryType[] = [
      'session',
      'pending_new_session',
      'pending_new_session_claimed',
      'pending_agent_reply',
      'last_agent_list_card',
    ];
    expect(types).toHaveLength(5);
  });

  test('pending_agent_reply entry has required Agent View fields', () => {
    const entry: MappingEntry = {
      type: 'pending_agent_reply',
      sessionUuid: '92664deb-f4b6-48d3-9cdd-85cf8eea6dfc',
      createdAt: '2026-06-06T00:00:00.000Z',
      cwd: '/Users/wuyujun/Git/cc-linker',
      shortId: '92664deb',
      startedAt: '2026-06-06T00:00:00.000Z',
      timeoutMs: 300000,
      casToken: 'test-token',
    };
    expect(entry.type).toBe('pending_agent_reply');
    expect(entry.shortId).toBe('92664deb');
    expect(entry.timeoutMs).toBe(300000);
  });

  test('last_agent_list_card entry has sessionUuid=null', () => {
    const entry: MappingEntry = {
      type: 'last_agent_list_card',
      sessionUuid: null,
      createdAt: '2026-06-06T00:00:00.000Z',
      cardMessageId: 'om_xxxxx',
      updatedAt: '2026-06-06T00:00:00.000Z',
      casToken: 'test-token',
    };
    expect(entry.sessionUuid).toBeNull();
    expect(entry.cardMessageId).toBe('om_xxxxx');
  });
});
