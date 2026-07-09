import { describe, it, expect } from 'bun:test';
import { escapePlistString } from '../../../src/utils/plist';

describe('utils/plist', () => {
  describe('escapePlistString', () => {
    it('escapes & (must be first to avoid double-escaping)', () => {
      expect(escapePlistString('a & b')).toBe('a &amp; b');
    });

    it('escapes < and >', () => {
      expect(escapePlistString('<tag>')).toBe('&lt;tag&gt;');
    });

    it('escapes " and \'', () => {
      expect(escapePlistString('"hi" \'ok\'')).toBe('&quot;hi&quot; &apos;ok&apos;');
    });

    it('does NOT double-escape entities in input', () => {
      // 如果 & 先转,后续 lt/gt/quot/apos 不会被破坏
      expect(escapePlistString('a&lt;b')).toBe('a&amp;lt;b');
    });

    it('leaves clean paths alone', () => {
      expect(escapePlistString('/usr/local/bin:/opt/homebrew/bin:/usr/bin')).toBe(
        '/usr/local/bin:/opt/homebrew/bin:/usr/bin',
      );
    });

    it('handles realistic PATH with & (e.g. user-defined prefix)', () => {
      const path = '/opt/my work/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/Users/me/code && tools';
      const escaped = escapePlistString(path);
      expect(escaped).not.toContain('&&');  // & 被转义
      expect(escaped).toContain('&amp;');
      expect(escaped).toContain('/opt/my work/bin');  // 空格不转
    });
  });
});