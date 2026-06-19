import { describe, it, expect } from 'bun:test';
import { maskSecret } from '../../../../src/cli/commands/init-wecom';

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
  });
});