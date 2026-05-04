import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

describe('CLI Commands Integration', () => {
  let tmpDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-bridge-integration-'));
    env = {
      ...process.env,
      CC_BRIDGE_DIR: tmpDir,
      HOME: tmpDir,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(args: string): string {
    try {
      return execSync(`bun run src/index.ts ${args}`, {
        cwd: '/Users/wuyujun/Git/cc-bridge',
        env,
        encoding: 'utf8',
      });
    } catch (err: any) {
      return err.stdout || err.stderr || err.message;
    }
  }

  it('init creates registry', () => {
    const output = run('init');
    expect(output).toContain('Created');
    expect(output).toContain('Scanning');
  });

  it('list shows sessions after init', () => {
    run('init');
    const output = run('list');
    expect(output).toContain('会话');
  });

  it('status shows registry info', () => {
    run('init');
    const output = run('status');
    expect(output).toContain('cc-bridge Status');
    expect(output).toContain('Total sessions');
  });

  it('sync updates registry', () => {
    run('init');
    const output = run('sync');
    expect(output).toContain('Sync complete');
  });
});
