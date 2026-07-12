// tests/integration/review/pipeline-e2e.test.ts
//
// v2.1.6 T10: Gated mini pipeline E2E (placeholder). Skipped by default —
// opt in with:
//
//   RUN_REVIEW_E2E=1 bun test tests/integration/review/pipeline-e2e.test.ts
//
// Full implementation requires a real provider profile AND a clean git repo
// under /tmp with two providers configured. The plan keeps this as a
// `expect(true).toBe(true)` placeholder; real wiring lands when the env is
// ready.

import { describe, it, expect } from 'bun:test';

const E2E = process.env.RUN_REVIEW_E2E === '1';
const skip = E2E ? describe : describe.skip;

skip('mini pipeline E2E', () => {
  it('runs a 1-round code pipeline to DONE', async () => {
    // setup: clean git repo in /tmp, profile with 2 providers
    // run: cc-linker review run "add DONE to a.txt" --phase code --max-rounds 1
    // assert: pipeline reaches DONE, a.txt has DONE
    // cleanup: stop bg, rm -rf tmp repo
    expect(true).toBe(true); // placeholder — implement against real env
  }, 300_000);
});