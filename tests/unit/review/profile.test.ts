// tests/unit/review/profile.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { loadProfile, ProfileError } from '../../../src/review/profile';
import { providerManager } from '../../../src/utils/providers';

describe('loadProfile', () => {
  it('loads scalars + prompts from TOML', async () => {
    const p = await loadProfile('default', 'spec', { profilesDir: 'tests/fixtures/review' });
    expect(p.work.provider).toBe('qwen3.7');
    expect(p.review.provider).toBe('kimi-coding');
    expect(p.guards.maxRounds).toBe(6);
    expect(p.prompts.work.self_review.system.template).toBe('review {task}');
  });

  it('phase_override scalars win over top-level (code phase)', async () => {
    const p = await loadProfile('default', 'code', { profilesDir: 'tests/fixtures/review' });
    expect(p.guards.maxRounds).toBe(6); // overridden in [phase_overrides.code]
    expect(p.review.provider).toBe('kimi-coding');
  });

  it('phase_override tables deep-merge (prompts not in override preserved)', async () => {
    const p = await loadProfile('default', 'code', { profilesDir: 'tests/fixtures/review' });
    expect(p.prompts.work.self_review.system.template).toBe('review {task}');
  });

  it('throws ProfileError if provider not resolvable', async () => {
    const origScan = providerManager.scan;
    const origResolve = providerManager.resolve;
    providerManager.scan = mock(async () => {}) as any;
    providerManager.resolve = mock(() => null) as any;
    try {
      await expect(
        loadProfile('default', 'code', { profilesDir: 'tests/fixtures/review' }),
      ).rejects.toThrow(ProfileError);
    } finally {
      providerManager.scan = origScan;
      providerManager.resolve = origResolve;
    }
  });

  it('throws ProfileError if profile file missing', async () => {
    await expect(
      loadProfile('nonexistent', 'code', { profilesDir: 'tests/fixtures/review' }),
    ).rejects.toThrow(ProfileError);
  });
});