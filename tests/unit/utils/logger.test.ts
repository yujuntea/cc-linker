import { describe, it, expect } from 'bun:test';
import { sanitizeStackSecrets } from '../../../src/utils/logger';

describe('logger sanitizeStackSecrets (PR 7 Task 7.6: m-10 secrets sanitizer)', () => {
  it('masks secret=xxx → secret=***', () => {
    const stack = 'Error: bad token\n    at func (secret=abc123xyz)\n    at other';
    const out = sanitizeStackSecrets(stack);
    expect(out).not.toContain('abc123xyz');
    expect(out).toContain('secret=***');
  });

  it('masks bot_secret, password, token, app_secret keys', () => {
    const stack = `
      bot_secret=BOTSECRET_HERE_12345
      app_secret=APPSECRET_HERE_67890
      password=MyP@ssw0rd!2026
      token=tok_abcdef123456
    `;
    const out = sanitizeStackSecrets(stack);
    expect(out).not.toContain('BOTSECRET_HERE_12345');
    expect(out).not.toContain('APPSECRET_HERE_67890');
    expect(out).not.toContain('MyP@ssw0rd!2026');
    expect(out).not.toContain('tok_abcdef123456');
    expect(out).toContain('bot_secret=***');
    expect(out).toContain('app_secret=***');
    expect(out).toContain('password=***');
    expect(out).toContain('token=***');
  });

  it('does not change stack when no secret-shaped token present', () => {
    const stack = 'Error: regular error\n    at func (/some/path/file.ts:10)';
    const out = sanitizeStackSecrets(stack);
    expect(out).toBe(stack);
  });

  it('handles empty string gracefully', () => {
    expect(sanitizeStackSecrets('')).toBe('');
  });
});
