import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { generateWrapperBlock } from '../../src/img-proxy/wrapper';

let tmpDir: string;
let rcFile: string;
let fakeClaudeLog: string;

// Stub `cc-linker`: handles `img-proxy current-url` + `img-proxy resolve <url>`
// Settings URL is passed via FAKE_SETTINGS_URL env var (pre-computed by test) —
// avoids JSON parsing in shell (no node/jq dependency).
// Stub `claude`: captures ANTHROPIC_BASE_URL + args.
const STUB_CCLINKER = `#!/bin/bash
case "$1 $2" in
  "img-proxy current-url")
    echo "$FAKE_SETTINGS_URL"
    ;;
  "img-proxy resolve")
    url="$3"
    case "$url" in
      # idempotent: already proxy URL -> return unchanged
      http://127.0.0.1:*|http://localhost:*)
        echo "$url"
        ;;
      # mock: this upstream is installed as byte-agent-glm
      https://ark.cn-beijing.volces.com/api/plan)
        echo "http://127.0.0.1:8765/byte-agent-glm"
        ;;
      # mock: not installed -> return empty (triggers fall back)
      https://api.minimaxi.com/anthropic)
        ;;
      *) ;;
    esac
    ;;
esac
`;

const STUB_CLAUDE = `#!/bin/bash
{
  echo "ENV:ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
  echo "ARGS:$@"
  echo "---"
} >> "$FAKE_CLAUDE_LOG"
`;

function runWrapper(env: Record<string, string>, settingsUrl: string): { stdout: string; stderr: string; exitCode: number; claudeLog: string } {
  const result = spawnSync('bash', ['-c', `source ${rcFile} && cc-linker-proxy --version`], {
    env: {
      ...process.env,
      ...env,
      FAKE_SETTINGS_URL: settingsUrl,
      FAKE_CLAUDE_LOG: fakeClaudeLog,
      // Hermetic: 只要宿主/测试没显式设 ANTHROPIC_BASE_URL,就清空。
      // 旧 wrapper 短路过 settings.json 时要空串(让 env_url 测试走 fall back 路径),
      // 新 wrapper 需要传测试用例的 stale URL(本次修复场景)。
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? '',
      PATH: `${tmpDir}:${process.env.PATH}`,
    },
    encoding: 'utf-8',
  });
  // claude 没被调时 fakeClaudeLog 不存在,readFileSync 会 ENOENT — 当空串处理
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

describe('cc-linker-proxy integration: BUG FIX (env=stale non-proxy URL)', () => {
  test('env=https://api.minimaxi.com/anthropic + settings.json=ark → fall back + warn + claude sees proxy URL', () => {
    // env=stale inherited non-proxy URL (bug scenario)
    //   |  settings.json configured to ark (a provider img-proxy knows about)
    //   v
    // wrapper should fall back to settings.json (current-url), resolve it
    // through stub cc-linker, and exec claude with the proxy URL — even
    // though env resolved to empty (unrecognised upstream).
    const { stderr, exitCode, claudeLog } = runWrapper(
      { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' },
      'https://ark.cn-beijing.volces.com/api/plan',
    );

    // Exit success (claude called)
    expect(exitCode).toBe(0);

    // Stderr warn mentions fall back
    expect(stderr).toContain('fall back');

    // claude received the proxy URL (NOT the stale minimaxi URL)
    expect(claudeLog).toContain('ENV:ANTHROPIC_BASE_URL=http://127.0.0.1:8765/byte-agent-glm');
    expect(claudeLog).not.toContain('minimaxi');

    // claude called with --version (passed through)
    expect(claudeLog).toContain('ARGS:--version');
  });
});