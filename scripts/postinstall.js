#!/usr/bin/env node
/**
 * postinstall hook — runs after `npm install -g cc-linker`.
 * If the cc-linker daemon is running, gracefully restart it to apply the update.
 *
 * Set CC_LINKER_POSTINSTALL_RESTART=0 to skip auto-restart (prompt only).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const AUTO_RESTART = process.env.CC_LINKER_POSTINSTALL_RESTART !== '0';

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

  if (AUTO_RESTART) {
    log('cc-linker update detected, restarting daemon (PID ' + pid + ')...');
    log('');
    // Send SIGTERM — launchd (KeepAlive: true) will auto-restart with the new binary.
    // If not managed by launchd, the daemon will need manual restart via `cc-linker start`.
    process.kill(pid, 'SIGTERM');
    log('  Daemon restarting with new version...');
  } else {
    log('cc-linker daemon is running (PID ' + pid + ').');
    log('Restart to apply the update:');
    log('');
    log('  cc-linker restart');
    log('');
  }
} catch (e) {
  if (e.code === 'ESRCH') {
    // PID file exists but process is dead — stale lock
    process.exit(0);
  }
  process.exit(0);
}
