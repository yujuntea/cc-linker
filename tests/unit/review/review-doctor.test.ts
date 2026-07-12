// tests/unit/review/review-doctor.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { checkCleanTree, checkMonorepo } from '../../../src/review/review-doctor';

describe('review doctor checks', () => {
  it('checkCleanTree returns true when git status --porcelain empty', async () => {
    const execGit = mock(() => '');  // empty = clean
    expect(await checkCleanTree('/tmp', execGit)).toBe(true);
  });

  it('checkCleanTree returns false when git status has output', async () => {
    const execGit = mock(() => ' M file.ts\n');
    expect(await checkCleanTree('/tmp', execGit)).toBe(false);
  });

  it('checkMonorepo returns false when cwd == git toplevel', async () => {
    const execGit = mock(() => '/tmp');  // toplevel == cwd
    expect(await checkMonorepo('/tmp', execGit)).toBe(false);
  });

  it('checkMonorepo returns true when cwd != toplevel (monorepo subdir)', async () => {
    const execGit = mock(() => '/monorepo-root');
    expect(await checkMonorepo('/monorepo-root/packages/foo', execGit)).toBe(true);
  });
});