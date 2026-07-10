import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { generateWrapperBlock } from '../../src/img-proxy/wrapper';

let tmpDir: string;
let rcFile: string;
let fakeClaudeLog: string;

// Stub `cc-linker`: 只处理 `img-proxy cc-switch-settings` 子命令
// FAKE_SETTINGS_FILE env var 非空 -> stdout 输出该路径 (成功)
// FAKE_SETTINGS_FILE 空 -> stdout 空 + stderr 提示 (失败)
const STUB_CCLINKER = `#!/bin/bash
if [ "$1 $2" = "img-proxy cc-switch-settings" ]; then
  if [ -n "$FAKE_SETTINGS_FILE" ]; then
    echo "$FAKE_SETTINGS_FILE"
  else
    echo "cc-linker-proxy: 未检测到 CC Switch" >&2
    echo "  hint: 装 CC Switch" >&2
    exit 2
  fi
fi
`;

// Stub `claude`: 捕获 --settings 参数 + 原始 args
const STUB_CLAUDE = `#!/bin/bash
{
  echo "ARGS:$@"
  echo "---"
} >> "$FAKE_CLAUDE_LOG"
`;

function runWrapper(env: Record<string, string>, fakeSettingsFile: string, wrapperArgs: string = '--version'): { stdout: string; stderr: string; exitCode: number; claudeLog: string } {
  const result = spawnSync('bash', ['-c', `source ${rcFile} && cc-linker-proxy ${wrapperArgs}`], {
    env: {
      ...process.env,
      ...env,
      FAKE_SETTINGS_FILE: fakeSettingsFile,
      FAKE_CLAUDE_LOG: fakeClaudeLog,
      PATH: `${tmpDir}:${process.env.PATH}`,
    },
    encoding: 'utf-8',
  });
  let claudeLog = '';
  try {
    claudeLog = readFileSync(fakeClaudeLog, 'utf-8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    claudeLog,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wrapper-int-'));
  rcFile = join(tmpDir, '.zshrc');
  fakeClaudeLog = join(tmpDir, 'claude.log');

  writeFileSync(join(tmpDir, 'cc-linker'), STUB_CCLINKER);
  chmodSync(join(tmpDir, 'cc-linker'), 0o755);
  writeFileSync(join(tmpDir, 'claude'), STUB_CLAUDE);
  chmodSync(join(tmpDir, 'claude'), 0o755);

  writeFileSync(rcFile, generateWrapperBlock());
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('cc-linker-proxy integration (cc-switch-settings 路径)', () => {
  test('成功: cc-switch-settings 返 path -> claude 收到 --settings <path> + args', () => {
    const fakeFile = join(tmpDir, 'provider.json');
    writeFileSync(fakeFile, '{}');
    const { exitCode, claudeLog } = runWrapper({}, fakeFile);
    expect(exitCode).toBe(0);
    expect(claudeLog).toContain(`--settings ${fakeFile}`);
    expect(claudeLog).toContain('--version');
  });

  test('失败: cc-switch-settings 返空 -> claude 不被调用, stderr 透传提示, exit 1', () => {
    const { exitCode, stderr, claudeLog } = runWrapper({}, '');
    expect(exitCode).toBe(1);
    expect(claudeLog).toBe('');
    expect(stderr).toContain('未检测到 CC Switch');
  });

  test('claude args 透传 (-p "reply OK")', () => {
    const fakeFile = join(tmpDir, 'provider.json');
    writeFileSync(fakeFile, '{}');
    const { claudeLog } = runWrapper({}, fakeFile, '-p "reply OK"');
    expect(claudeLog).toContain('--settings');
    expect(claudeLog).toContain('-p');
    expect(claudeLog).toContain('reply OK');
  });

  test('回归: wrapper 不读 ANTHROPIC_BASE_URL (设了也忽略, 走 cc-switch-settings)', () => {
    const fakeFile = join(tmpDir, 'provider.json');
    writeFileSync(fakeFile, '{}');
    const { exitCode, claudeLog } = runWrapper({ ANTHROPIC_BASE_URL: 'https://stale.com' }, fakeFile);
    expect(exitCode).toBe(0);
    expect(claudeLog).toContain(`--settings ${fakeFile}`);
  });
});