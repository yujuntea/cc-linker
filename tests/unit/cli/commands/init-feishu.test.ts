import { describe, it, expect } from 'bun:test';
import { maskSecret } from '../../../../src/cli/commands/init-feishu';

describe('maskSecret', () => {
  it('returns empty string for empty input', () => {
    expect(maskSecret('')).toBe('');
  });

  it('treats null/undefined as empty (defensive)', () => {
    expect(maskSecret(null as unknown as string)).toBe('');
    expect(maskSecret(undefined as unknown as string)).toBe('');
  });

  it('fully masks very short strings (≤6 chars)', () => {
    expect(maskSecret('a')).toBe('*');
    expect(maskSecret('abc')).toBe('***');
    expect(maskSecret('abcdef')).toBe('******');
  });

  it('shows first 3 + last 3 with masked middle for normal-length secrets', () => {
    expect(maskSecret('abcdefg')).toBe('abc*efg');
    expect(maskSecret('12345678')).toBe('123**678');
    // Real Feishu app secret shape (32 ASCII chars): first3 + 26 stars + last3
    const realSecret = 'vDbk0ZYy33IwyHXgl9dsNc6Fmuz3TqFB';
    const expected = `vDb${'*'.repeat(26)}qFB`;
    expect(maskSecret(realSecret)).toBe(expected);
  });

  it('does not corrupt multibyte strings (slice aligns on UTF-16 code units)', () => {
    // 锁 = 1 char (1 code unit), 🔑 = 1 char (2 code units, surrogate pair).
    // length-based slicing still aligns because mask is itself 1 code unit.
    expect(maskSecret('🔑secret🔑')).toBe('🔑s****t🔑');
  });
});