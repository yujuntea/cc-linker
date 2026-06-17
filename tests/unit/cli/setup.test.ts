import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('setup savePermissionMode', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccl-setup-test-'));
    configPath = join(tmpDir, 'config.toml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('with empty config (file does not exist)', () => {
    it('creates config.toml with [claude] and [sdk] sections', async () => {
      const { savePermissionMode } = await import('../../../src/cli/commands/setup');
      savePermissionMode('acceptEdits', configPath);
      expect(existsSync(configPath)).toBe(true);
      const raw = readFileSync(configPath, 'utf8');
      expect(raw).toContain('[claude]');
      expect(raw).toContain('[sdk]');
      expect(raw).toMatch(/permission_mode\s*=\s*"acceptEdits"/);
    });
  });
});
