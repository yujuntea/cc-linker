// tests/unit/review/review-cli.test.ts
// T7 + v2.1.6.1: verify review subcommand group registration + option shape.
// Structural tests only — do NOT invoke `program.parse()` because it runs action handlers
// synchronously and prints help on --help (would process.exit inside a test).
import { describe, it, expect } from 'bun:test';
import { Command } from 'commander';
import { reviewCommand } from '../../../src/cli/commands/review';

describe('review CLI subcommands', () => {
  function makeProgram() {
    const program = new Command();
    program.exitOverride(); // never actually called in these tests
    reviewCommand(program);
    return program;
  }

  function findReviewCmd(program: Command) {
    return program.commands.find((c) => c.name() === 'review');
  }

  function findReviewSub(program: Command, name: string) {
    const review = findReviewCmd(program);
    if (!review) throw new Error('review command not registered');
    return review.commands.find((c) => c.name() === name);
  }

  it('registers review run with --phase/--profile/--max-rounds/--watch/--cwd/--inject-text flags', () => {
    const program = makeProgram();
    const runCmd = findReviewSub(program, 'run');
    expect(runCmd).toBeDefined();
    const longOpts = runCmd!.options.map((o) => o.long);
    expect(longOpts).toContain('--phase');
    expect(longOpts).toContain('--profile');
    expect(longOpts).toContain('--max-rounds');
    expect(longOpts).toContain('--watch');
    expect(longOpts).toContain('--cwd');
    expect(longOpts).toContain('--inject-text');
  });

  it('registers review status, cancel, abort, skip, resume, report, doctor, profiles, _engine-loop', () => {
    const program = makeProgram();
    const review = findReviewCmd(program);
    expect(review).toBeDefined();
    const subs = review!.commands.map((c) => c.name());
    expect(subs).toContain('status');
    expect(subs).toContain('cancel');
    expect(subs).toContain('abort');
    expect(subs).toContain('skip');
    expect(subs).toContain('resume');
    expect(subs).toContain('report');
    expect(subs).toContain('doctor');
    expect(subs).toContain('profiles');
    // v2.1.6.1 M2: hidden internal command
    expect(subs).toContain('_engine-loop');
  });

  it('review report exposes --format/--out/--partial flags', () => {
    const program = makeProgram();
    const reportCmd = findReviewSub(program, 'report');
    expect(reportCmd).toBeDefined();
    const longOpts = reportCmd!.options.map((o) => o.long);
    expect(longOpts).toContain('--format');
    expect(longOpts).toContain('--out');
    expect(longOpts).toContain('--partial');
  });

  it('does NOT register cleanup (v2.1.6 deleted)', () => {
    const program = makeProgram();
    const review = findReviewCmd(program);
    const subs = review!.commands.map((c) => c.name());
    expect(subs).not.toContain('cleanup');
  });

  it('cancel and abort both exist as distinct commands', () => {
    const program = makeProgram();
    const review = findReviewCmd(program)!;
    expect(review.commands.some((c) => c.name() === 'cancel')).toBe(true);
    expect(review.commands.some((c) => c.name() === 'abort')).toBe(true);
  });
});
