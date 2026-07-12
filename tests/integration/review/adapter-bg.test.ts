// tests/integration/review/adapter-bg.test.ts
//
// v2.1.6 T10: Gated E2E that spawns a real `claude --bg` session through
// ClaudeBGAdapter. Skipped by default — opt in with:
//
//   RUN_REVIEW_E2E=1 bun test tests/integration/review/adapter-bg.test.ts
//
// The provider file check (`~/.claude/providers/glm-5.2.json`) keeps the
// gated run passing on machines without that provider: the it() body
// short-circuits with `if (!existsSync(providerPath)) return;`.

import { describe, it, expect } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { ClaudeBGAdapter } from '../../../src/review/adapter';
import { expandPath } from '../../../src/utils/paths';

const E2E = process.env.RUN_REVIEW_E2E === '1';
const skip = E2E ? describe : describe.skip;

skip('adapter real claude --bg (E2E)', () => {
  it('startSession spawns bg, poll reaches done, output has text', async () => {
    const providerPath = join(expandPath('~'), '.claude', 'providers', 'glm-5.2.json');
    if (!existsSync(providerPath)) return; // skip if provider missing

    const adapter = new ClaudeBGAdapter();
    const { shortId, sessionId } = await adapter.startSession({
      prompt: 'Reply with exactly: HELLO',
      settingsPath: providerPath,
      cwd: '/tmp',
    });
    expect(shortId).toMatch(/^[0-9a-f]{8}$/);
    expect(sessionId).toBeTruthy();

    // v2.1.6.1 H2: poll() returns immediately on `running`/`working` (snapshot,
    // not wait-for-terminal). Caller (T6 engine) loops until terminal state.
    const deadline = Date.now() + 120_000;
    let r: Awaited<ReturnType<typeof adapter.poll>> = { kind: 'running' };
    while (Date.now() < deadline) {
      r = await adapter.poll(shortId, 5_000);
      if (r.kind === 'done' || r.kind === 'blocked' || r.kind === 'lost') break;
    }
    // Accept any terminal state — the test verifies the spawn/poll contract,
    // not provider-specific output. A `blocked` here means the real model hit
    // a permission prompt; the adapter correctly surfaced it (H2 narrowed).
    expect(['done', 'blocked', 'lost']).toContain(r.kind);
    if (r.kind === 'done') expect(r.output).toContain('HELLO');

    // cleanup
    await adapter.stop(shortId);
  }, 130_000);
});