// tests/integration/review/pipeline-e2e.test.ts
//
// v2.1.6.1.1: real end-to-end test of ReviewEngine.runPipeline through the full
// happy path PRODUCING → SELF_REVIEW_R1 → EXTERNAL_REVIEW → DONE.
//
// Uses a ClaudeBGAdapter mocked at both `readJobStateFn` and `spawnFn` boundaries,
// so the engine drives a fake bg session whose output is canned JSON. This
// proves the engine's state-machine + per-state dispatch + writeReport +
// history push (Bug #1 fix) all work end-to-end without spawning a real
// `claude --bg` session.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { PipelineStore } from '../../../src/review/pipeline-store';
import { ClaudeBGAdapter } from '../../../src/review/adapter';
import { ReviewEngine, renderReport } from '../../../src/review/engine';
import type { PipelineRecord, ResolvedProfile } from '../../../src/review/profile';

interface MockState {
  shortId: string;
  output: string;
  sessionId: string;
  modelName: string;
}

describe('pipeline e2e (mock adapter, real engine)', () => {
  let cwdRoot: string;
  let store: PipelineStore;
  /** Mutable index of the response to return next; advances per bg round. */
  let roundIndex: number;
  let responses: MockState[];

  beforeEach(() => {
    cwdRoot = mkdtempSync(join(tmpdir(), 'cc-pipeline-e2e-'));
    store = new PipelineStore(cwdRoot);
    roundIndex = 0;
    responses = [];
  });

  afterEach(() => {
    rmSync(cwdRoot, { recursive: true, force: true });
  });

  function pushResponse(r: Partial<MockState>): void {
    // adapter's regex `backgrounded · [0-9a-f]{8}` requires shortId to be exactly
    // 8 lowercase hex chars. Use a deterministic counter-encoded hex.
    const hex = (n: number) => n.toString(16).padStart(8, '0').slice(0, 8);
    responses.push({
      shortId: r.shortId ?? hex(responses.length + 1),
      output: r.output ?? '{"issues":[]}',
      sessionId: r.sessionId ?? '00000000-0000-0000-0000-000000000001',
      modelName: r.modelName ?? 'mock-model[1m]',
    });
  }

  function buildAdapter(): ClaudeBGAdapter {
    return new ClaudeBGAdapter({
      readJobStateFn: async (short) => {
        // Match response by shortId (each bg round has its own shortId).
        const matched = responses.find((x) => x.shortId === short);
        if (!matched) {
          throw new Error(`poll() called with unmocked shortId=${short} — did you forget pushResponse()?`);
        }
        return {
          short, path: '', readAt: 0, mtimeMs: 0,
          state: {
            state: 'done', tempo: 'idle', detail: null, needs: null,
            output: { result: matched.output },
            sessionId: matched.sessionId,
            respawnFlags: ['--settings', '/mock/settings.json', '--model', matched.modelName],
          },
        };
      },
      spawnFn: (_args, _opts) => {
        // Each spawn (startSession or resumeWorkSession) consumes the next
        // canned shortId from the queue.
        const r = responses[roundIndex];
        if (!r) {
          throw new Error(`spawnFn called but no more responses queued (roundIndex=${roundIndex})`);
        }
        roundIndex++;
        return { stdout: `backgrounded · ${r.shortId}`, stderr: '', shortId: r.shortId };
      },
    });
  }

  function minimalProfile(): ResolvedProfile {
    return {
      meta: { name: 'e2e-test' },
      work: { provider: 'mock-work' },
      review: { provider: 'mock-review' },
      guards: { maxRounds: 1, maxConcurrentPipelines: 1, parseRetryTimeoutMs: 15000 },
      prompts: {
        work: {
          produce: { system: { template: 'produce {task}' } },
          self_review: { system: { template: 'review {task} ; {r1_or_r2_instruction}' } },
          fixing: { system: { template: 'fix {task} ; {input_issues}' } },
        },
        review: {
          spec: { system: { template: 'spec {task}' } },
          plan: { system: { template: 'plan {task}' } },
          code: { system: { template: 'code {task}' } },
        },
      },
      workSettingsPath: '/mock/work.json',
      reviewSettingsPath: '/mock/review.json',
    } as ResolvedProfile;
  }

  async function seedRunningPipeline(pipelineId: string): Promise<void> {
    const now = new Date().toISOString();
    const rec: PipelineRecord = {
      pipelineId,
      createdAt: now,
      updatedAt: now,
      state: { kind: 'PRODUCING', pipelineId, round: 0 },
      input: { rawInput: 'mock task — verify clean output', phase: 'code', profile: 'default', maxRounds: 1, cwd: cwdRoot },
      panes: {},
      history: [],
    };
    await store.create(rec, 'running');
  }

  it('runs PRODUCING -> R1 -> EXTERNAL_REVIEW -> DONE when every stage is clean', async () => {
    const pipelineId = 'pipe-e2e-1';
    await seedRunningPipeline(pipelineId);

    // Stage responses (consumed in order via spawnFn / retryRegen):
    //   1: produce bg (startSession) — spawn marker
    //   2: R1 bg (resumeWorkSession) — clean R1
    //   3: EXTERNAL_REVIEW bg (startSession, fresh pane) — clean review
    pushResponse({ sessionId: '00000000-0000-0000-0000-0000000000a1' });
    pushResponse({ output: '{"issues":[]}', sessionId: '00000000-0000-0000-0000-0000000000a1' });
    pushResponse({ output: '{"issues":[],"per_issue":[],"reasoning":"all clean"}' });

    const engine = new ReviewEngine(store, buildAdapter());
    await engine.runPipeline(pipelineId, 'mock task', 'code', minimalProfile());

    const final = await store.read(pipelineId);
    expect(final, 'pipeline record should still exist').toBeTruthy();
    expect(final!.state.kind).toBe('DONE');
    expect(final!.state.round).toBe(1);

    // Bug #1 fix: history should now have entries for every transition.
    expect(final!.history.length).toBeGreaterThanOrEqual(3);
    const historyKinds = final!.history.map((h) => `${h.fromState}->${h.toState}`);
    expect(historyKinds).toContain('PRODUCING->SELF_REVIEW_R1');
    expect(historyKinds).toContain('SELF_REVIEW_R1->EXTERNAL_REVIEW');
    expect(historyKinds).toContain('EXTERNAL_REVIEW->DONE');

    for (const h of final!.history) {
      expect(['work', 'review']).toContain(h.role);
    }

    // Report file written
    const reportPath = join(cwdRoot, '.claude', 'reviews', `${pipelineId}.md`);
    expect(existsSync(reportPath)).toBe(true);
    const md = readFileSync(reportPath, 'utf8');
    expect(md).toContain(`# Review Report — ${pipelineId}`);
    expect(md).toContain('Final state: **DONE**');
    expect(md).toContain('## Timeline');
    expect(md).toContain('## Issues');
    expect(md).toContain('_No issues recorded._');
    // Bug #1 fix: timeline should now have multiple entries (not just the
    // cancel/abort entry written by cancelOrAbort).
    expect(md).toContain('PRODUCING → SELF_REVIEW_R1');
    expect(md).toContain('SELF_REVIEW_R1 → EXTERNAL_REVIEW');
    expect(md).toContain('EXTERNAL_REVIEW → DONE');

    // Pipeline should have been moved from running/ to done/.
    expect(await store.findBucketPublic(pipelineId)).toBe('done');

    // renderReport also works on the final record.
    const md2 = await renderReport(final!);
    expect(md2).toContain('Final state: **DONE**');
  }, 30_000);

  it('runs PRODUCING -> R1 -> FIXING -> R2 -> EXTERNAL_REVIEW -> DONE when R1 finds one P1 issue', async () => {
    const pipelineId = 'pipe-e2e-2';
    await seedRunningPipeline(pipelineId);

    pushResponse({ sessionId: 'uuid-w' });
    pushResponse({
      output: JSON.stringify({
        issues: [{ severity: 'P1', location: 'trivial.txt:1', description: 'mock defect' }],
      }),
      sessionId: 'uuid-w',
    });
    pushResponse({
      output: JSON.stringify({
        per_issue: [{ issue_id: 'fp1', verdict: 'real', verdict_reason: 'real defect', fix_applied: true, fix_summary: 'patched it' }],
        all_real_fixed: true,
        remaining_real_unfixed_count: 0,
      }),
      sessionId: 'uuid-w',
    });
    pushResponse({
      output: '{"issues":[]}',
      sessionId: 'uuid-w',
    });
    pushResponse({
      output: '{"issues":[],"per_issue":[],"reasoning":"all clean"}',
    });

    const engine = new ReviewEngine(store, buildAdapter());
    await engine.runPipeline(pipelineId, 'mock', 'code', minimalProfile());

    const final = await store.read(pipelineId);
    expect(final).toBeTruthy();
    expect(final!.state.kind).toBe('DONE');
    expect(final!.history.length).toBeGreaterThanOrEqual(5);
    const kinds = final!.history.map((h) => `${h.fromState}->${h.toState}`);
    expect(kinds).toContain('SELF_REVIEW_R1->FIXING');
    expect(kinds).toContain('FIXING->SELF_REVIEW_R2');
    expect(kinds).toContain('SELF_REVIEW_R2->EXTERNAL_REVIEW');

    // R1 -> FIXING event should record the parsed issues (Bug #1 fix).
    const r1Event = final!.history.find((h) => h.fromState === 'SELF_REVIEW_R1' && h.toState === 'FIXING');
    expect(r1Event).toBeDefined();
    expect(r1Event!.issues?.length).toBe(1);
    expect(r1Event!.issues![0]!.severity).toBe('P1');
  }, 30_000);

  it('runs to ABORTED r1_parse_degraded when R1 returns invalid JSON twice', async () => {
    const pipelineId = 'pipe-e2e-3';
    await seedRunningPipeline(pipelineId);

    // Engine retry logic: parseBgOutputWithRetry calls retryRegen which calls
    // resumeWorkSession → returns a new shortId. Then poll on the new shortId.
    pushResponse({ sessionId: 'uuid-w' });
    pushResponse({ output: 'not valid json at all' });
    pushResponse({ output: 'still nothing parseable' });

    const engine = new ReviewEngine(store, buildAdapter());
    await engine.runPipeline(pipelineId, 'mock', 'code', minimalProfile());

    const final = await store.read(pipelineId);
    expect(final!.state.kind).toBe('ABORTED');
    expect((final!.state as { reason: string }).reason).toBe('r1_parse_degraded');
    const abortedEvents = final!.history.filter((h) => h.toState === 'ABORTED');
    expect(abortedEvents.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('runs to ABORTED review_parse_degraded when EXTERNAL_REVIEW returns plain text', async () => {
    const pipelineId = 'pipe-e2e-4';
    await seedRunningPipeline(pipelineId);

    pushResponse({ sessionId: 'uuid-w' });
    pushResponse({ output: '{"issues":[]}', sessionId: 'uuid-w' });
    pushResponse({ output: 'plain text not json' });

    const engine = new ReviewEngine(store, buildAdapter());
    await engine.runPipeline(pipelineId, 'mock', 'code', minimalProfile());

    const final = await store.read(pipelineId);
    expect(final!.state.kind).toBe('ABORTED');
    expect((final!.state as { reason: string }).reason).toBe('review_parse_degraded');
  }, 30_000);

  it('runs to ABORTED max_rounds_exceeded when maxRounds=0', async () => {
    const pipelineId = 'pipe-e2e-5';
    await seedRunningPipeline(pipelineId);
    const profile = minimalProfile();
    profile.guards.maxRounds = 0;

    pushResponse({ sessionId: 'uuid-w' });
    pushResponse({ output: '{"issues":[]}' });

    const engine = new ReviewEngine(store, buildAdapter());
    await engine.runPipeline(pipelineId, 'mock', 'code', profile);

    const final = await store.read(pipelineId);
    expect(final!.state.kind).toBe('ABORTED');
    expect((final!.state as { reason: string }).reason).toBe('max_rounds_exceeded');
  }, 30_000);
});
