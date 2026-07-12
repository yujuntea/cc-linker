// src/review/review-doctor.ts
// v2.1.6: Review doctor health check — CLI version / daemon / profile / clean tree / monorepo / pipeline dir.
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { VersionGuard } from '../agent-view/version-guard';
import { DaemonProbe } from '../agent-view/daemon-probe';
import { loadProfile } from './profile';
import { REVIEW_PIPELINES_DIR } from './paths';
import { existsSync, mkdirSync, accessSync, constants } from 'fs';
import { join } from 'path';

const MIN_CLI_VERSION = '2.1.139';

export type GitExec = (args: string[], cwd: string) => string;

function defaultGitExec(args: string[], cwd: string): string {
  try {
    return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Returns true if `git status --porcelain` is empty (clean tree). P1-3 requirement. */
export async function checkCleanTree(cwd: string, gitExec: GitExec = defaultGitExec): Promise<boolean> {
  const out = gitExec(['status', '--porcelain'], cwd);
  return out.trim() === '';
}

/** Returns true if cwd is a monorepo subdir (toplevel != cwd). */
export async function checkMonorepo(cwd: string, gitExec: GitExec = defaultGitExec): Promise<boolean> {
  const toplevel = gitExec(['rev-parse', '--show-toplevel'], cwd);
  return toplevel !== '' && toplevel !== cwd;
}

export async function runDoctor(opts: { cwd?: string; profileName?: string; gitExec?: GitExec } = {}): Promise<boolean> {
  const cwd = opts.cwd ?? process.cwd();
  const profileName = opts.profileName ?? 'default';
  const gitExec = opts.gitExec ?? defaultGitExec;
  let allPass = true;

  // 1. CLI version (VersionGuard.check takes no args, hardcodes MIN_VERSION=2.1.139)
  const versionCheck = await VersionGuard.check();
  console.log(versionCheck.ok ? chalk.green(`✓ Claude CLI: ${versionCheck.version} (≥ ${MIN_CLI_VERSION})`) : chalk.red(`✗ Claude CLI: ${versionCheck.version ?? versionCheck.reason} (< ${MIN_CLI_VERSION})`));
  if (!versionCheck.ok) allPass = false;

  // 2. Daemon healthy
  const daemonOk = DaemonProbe.check();
  console.log(daemonOk ? chalk.green('✓ Daemon: healthy') : chalk.red('✗ Daemon: not running'));
  if (!daemonOk) allPass = false;

  // 3. Profile + providers
  try {
    const profile = await loadProfile(profileName, 'code');
    console.log(chalk.green(`✓ Profile '${profileName}' loaded`));
    console.log(chalk.green(`✓ Provider '${profile.work.provider}' (work): exists`));
    console.log(chalk.green(`✓ Provider '${profile.review.provider}' (review): exists`));
  } catch (e) {
    console.log(chalk.red(`✗ Profile/provider: ${e}`));
    allPass = false;
  }

  // 4. Clean tree (P1-3)
  const clean = await checkCleanTree(cwd, gitExec);
  console.log(clean ? chalk.green('✓ Working tree: clean') : chalk.red('✗ Working tree: NOT clean (commit or stash first)'));
  if (!clean) allPass = false;

  // 5. Monorepo subdir warning
  const isMonorepoSub = await checkMonorepo(cwd, gitExec);
  if (isMonorepoSub) {
    console.log(chalk.yellow('⚠️ cwd is monorepo subdir, git ops affect whole monorepo'));
    // warn, not fail
  }

  // 6. Pipeline dir writable
  try {
    if (!existsSync(REVIEW_PIPELINES_DIR)) mkdirSync(REVIEW_PIPELINES_DIR, { recursive: true });
    accessSync(REVIEW_PIPELINES_DIR, constants.W_OK);
    console.log(chalk.green('✓ Pipeline dir: writable'));
  } catch (e) {
    console.log(chalk.red(`✗ Pipeline dir: not writable`));
    allPass = false;
  }

  return allPass;
}