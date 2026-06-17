import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
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

  describe('with existing [claude] and [sdk] sections', () => {
    beforeEach(() => {
      writeFileSync(configPath, `[claude]
permission_mode = "default"
allowed_tools = ["Read"]

[sdk]
enabled = false
claude_executable = "/custom/path/claude"
`);
    });

    it('updates both permission_mode fields, preserves everything else', async () => {
      const { savePermissionMode } = await import('../../../src/cli/commands/setup');
      savePermissionMode('bypassPermissions', configPath);
      const raw = readFileSync(configPath, 'utf8');
      // [claude].permission_mode updated
      expect(raw).toMatch(/\[claude\][\s\S]*permission_mode\s*=\s*"bypassPermissions"/);
      // [claude].allowed_tools preserved
      expect(raw).toContain('allowed_tools');
      // [sdk].permission_mode updated
      expect(raw).toMatch(/\[sdk\][\s\S]*permission_mode\s*=\s*"bypassPermissions"/);
      // [sdk].enabled preserved (false)
      expect(raw).toMatch(/\[sdk\][\s\S]*enabled\s*=\s*false/);
      // [sdk].claude_executable preserved
      expect(raw).toContain('claude_executable');
    });

    it('does not modify [sdk].enabled', async () => {
      const { savePermissionMode } = await import('../../../src/cli/commands/setup');
      savePermissionMode('acceptEdits', configPath);
      const raw = readFileSync(configPath, 'utf8');
      // Only one "enabled" in [sdk] section, still `false`
      const sdkBlock = raw.match(/\[sdk\][\s\S]*?(?=\n\[|$)/)?.[0] ?? '';
      expect(sdkBlock).toMatch(/enabled\s*=\s*false/);
      expect(sdkBlock).not.toMatch(/enabled\s*=\s*true/);
    });
  });

  describe('with existing config.toml that lacks [claude]/[sdk]', () => {
    beforeEach(() => {
      writeFileSync(configPath, `[feishu_bot]
app_id = "x"
`);
    });

    it('adds [claude] and [sdk] without touching [feishu_bot]', async () => {
      const { savePermissionMode } = await import('../../../src/cli/commands/setup');
      savePermissionMode('plan', configPath);
      const raw = readFileSync(configPath, 'utf8');
      expect(raw).toContain('[feishu_bot]');
      expect(raw).toContain('app_id = "x"');
      expect(raw).toContain('[claude]');
      expect(raw).toContain('[sdk]');
      expect(raw).toMatch(/permission_mode\s*=\s*"plan"/);
    });
  });
});
