#!/usr/bin/env node
/**
 * postinstall hook — runs after `npm install -g cc-linker`.
 * If the cc-linker daemon is running, automatically restart it to apply the update.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

function log(...args) {
  console.log('  ' + args.join(' '));
}

try {
  const home = process.env.HOME ?? homedir();
  const pidFile = join(home, '.cc-linker', 'cc-linker.pid');

  if (!existsSync(pidFile)) {
    process.exit(0);
  }

  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (isNaN(pid)) {
    process.exit(0);
  }

  // Check if process is alive
  process.kill(pid, 0);

  log('cc-linker update detected, restarting daemon (PID ' + pid + ')...');
  log('');

  // Delegate to cc-linker restart — works for both launchd and pure --daemon modes
  execFileSync('cc-linker', ['restart'], { stdio: 'inherit' });
} catch (e) {
  if (e.code === 'ESRCH') {
    // PID file exists but process is dead — stale lock
    process.exit(0);
  }
  // execFileSync failed — user will see the error output
  process.exit(0);
}
