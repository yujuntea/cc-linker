import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export type IneligibleReason =
  | 'bg_busy'            // tempo=active OR running/working 无 needs
  | 'no_rendezvous_sock' // roster 缺该字段
  | 'old_cli'            // cliVersion < 2.1.139
  | 'daemon_down'        // state.json 缺失 / sock 物理不存在
  ;

export interface RendezvousEligibility {
  canUse: boolean;
  reason: 'bg_waiting' | IneligibleReason;
  rendezvousSock?: string;
  jsonlPath?: string;
}

export interface EligibilityContext {
  /** Override $HOME for tests; default process.env.HOME */
  ccHomeDir?: string;
}

/** Minimum CLI version that exposes rendezvousSock. */
const MIN_CLI_VERSION = '2.1.139';

/**
 * Read state.json for a session short id. Returns null if missing or malformed.
 */
function readStateJson(short: string, ccHome: string): any | null {
  const path = join(ccHome, 'jobs', short, 'state.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read roster.json from daemon dir. Returns null if missing or malformed.
 */
function readRosterJson(ccHome: string): any | null {
  const path = join(ccHome, 'daemon', 'roster.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Parse "2.1.163" -> [2, 1, 163]. Non-numeric parts default to 0.
 */
function parseVersion(s: string | undefined): number[] {
  if (!s) return [0];
  return s.split('.').map(p => {
    const n = parseInt(p, 10);
    return isNaN(n) ? 0 : n;
  });
}

/**
 * Compare two semver-ish version arrays. Returns -1 / 0 / 1.
 */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Decide whether the rendezvous socket path is usable for a given session.
 *
 * Decision tree:
 *   1. state.json exists & parseable?
 *      - No → daemon_down
 *   2. bg is in waiting state? (tempo=blocked + needs, OR running/working with needs)
 *      - No → bg_busy
 *   3. roster.json has this short with rendezvousSock?
 *      - No → no_rendezvous_sock
 *   4. CLI version >= 2.1.139?
 *      - No → old_cli
 *   5. rendezvousSock file exists on disk?
 *      - No → daemon_down
 *   6. → canUse=true, reason=bg_waiting
 */
export async function checkRendezvousEligibility(
  short: string,
  ctx: EligibilityContext = {},
): Promise<RendezvousEligibility> {
  const ccHome = ctx.ccHomeDir ?? process.env.HOME ?? '';
  if (!ccHome) {
    return { canUse: false, reason: 'daemon_down' };
  }

  // 1. state.json
  const state = readStateJson(short, ccHome);
  if (!state) {
    return { canUse: false, reason: 'daemon_down' };
  }

  // 2. bg waiting check
  const isWaiting = (() => {
    if (state.tempo === 'blocked' && state.needs) return true;
    if ((state.state === 'running' || state.state === 'working') && state.needs) return true;
    if (state.state === 'blocked') return true;
    return false;
  })();
  if (!isWaiting) {
    return { canUse: false, reason: 'bg_busy' };
  }

  // 3. roster
  const roster = readRosterJson(ccHome);
  if (!roster) {
    return { canUse: false, reason: 'daemon_down' };
  }
  if (!roster.workers?.[short]?.rendezvousSock) {
    return { canUse: false, reason: 'no_rendezvous_sock' };
  }
  const worker = roster.workers[short];
  const sock: string = worker.rendezvousSock;

  // 4. CLI version
  const cliVer = parseVersion(worker.cliVersion ?? state.cliVersion);
  const minVer = parseVersion(MIN_CLI_VERSION);
  if (compareVersions(cliVer, minVer) < 0) {
    return { canUse: false, reason: 'old_cli' };
  }

  // 5. sock file exists
  if (!existsSync(sock)) {
    return { canUse: false, reason: 'daemon_down' };
  }
  try {
    if (!statSync(sock).isSocket()) {
      return { canUse: false, reason: 'daemon_down' };
    }
  } catch {
    return { canUse: false, reason: 'daemon_down' };
  }

  return {
    canUse: true,
    reason: 'bg_waiting',
    rendezvousSock: sock,
    jsonlPath: state.linkScanPath ?? undefined,
  };
}
