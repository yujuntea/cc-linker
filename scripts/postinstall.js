#!/usr/bin/env node
/**
 * postinstall hook — runs after `npm install -g cc-linker@latest`.
 *
 * Purpose: if a cc-linker daemon is already running, restart it to apply the
 * update. This gives end-users a one-step "upgrade" experience.
 *
 * Safety: idempotent, no-op if daemon not running, no-op on fresh install.
 * The hook does NOT install the launchd plist (that's `cc-linker daemon install`)
 * and does NOT init Feishu credentials (that's `cc-linker init-feishu` or
 * `cc-linker setup`).
 *
 * For developers: `bun run deploy` uses `--ignore-scripts` to skip this,
 * so deploy handles its own restart sequence without competing.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const home = process.env.HOME ?? homedir();
const pidFile = join(home, '.cc-linker', 'cc-linker.pid');

try {
  if (!existsSync(pidFile)) {
    // 没有 daemon 在跑 — 静默, 用户需手动 cc-linker setup + start
    // (继续往下做版本检查)
  } else {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (!isNaN(pid)) {
      try {
        // 检查进程是否还活着
        process.kill(pid, 0);
        // daemon 在跑, 自动 restart
        console.log('cc-linker: 检测到 daemon 运行 (PID ' + pid + '), 自动 restart...');
        execFileSync('cc-linker', ['restart'], { stdio: 'inherit' });
      } catch (innerErr) {
        if (innerErr.code === 'ESRCH') {
          // pid file stale, daemon 已死 — 静默
        }
        // execFileSync 失败 (cc-linker not in PATH?) — 不报错, 用户会手动 restart
      }
    }
  }
} catch {
  // 兜底: 不影响后续版本检查
}

// === 版本检查(非阻塞): 提示用户升级低版本 Claude CLI ===
try {
  const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
  const m = String(out).match(/(\d+\.\d+\.\d+)/);
  if (m) {
    const v = m[1];
    if (compareVersions(v, '2.1.139') < 0) {
      console.log('');
      console.log('⚠️  cc-linker: 检测到 Claude Code CLI v' + v + ' (< 2.1.139)');
      console.log('   部分功能(如飞书 Agent View)需要 >= 2.1.139');
      console.log('   升级命令: npm install -g @anthropic-ai/claude-code@latest');
      console.log('');
    }
  }
} catch {
  // claude 未安装或不可执行 —— 静默,resolver 会用 bundled 或抛 E_SDK_NO_CLAUDE
}

function compareVersions(a, b) {
  const [a1, a2, a3] = a.split('.').map(Number);
  const [b1, b2, b3] = b.split('.').map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}
