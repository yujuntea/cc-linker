// src/review/engine.ts
// v2.1.6 + v2.1.6.1 patch C4 (renderReport / writeReport) + M4 (prompt builders).

import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { Issue, PipelineRecord, ReviewFixOutput, ReviewState } from './types';
import { isTerminal } from './types';
import type { ResolvedProfile } from './profile';
import type { ClaudeBGAdapter } from './adapter';
import type { PipelineStore } from './pipeline-store';
import {
  parseBgOutputWithRetry,
  SelfReviewOutputSchema,
  FixingOutputSchema,
  ReviewOutputSchema,
  assignIssueFingerprints,
} from './output-contract';
import { reviewReportPath } from './paths';

// ----- Pure helpers -----

/** clean = no P0/P1/P2 (P3 doesn't block). */
export function isClean(issues: Issue[]): boolean {
  return issues.filter((i) => i.severity === 'P0' || i.severity === 'P1' || i.severity === 'P2').length === 0;
}

/** EXTERNAL_REVIEW converges = 0 real P0/P1/P2 in per_issue (spec §5.4.2: use embedded severity). */
export function externalReviewConverges(output: ReviewFixOutput): boolean {
  const realBlocking = output.perIssue.filter(
    (p) => p.verdict === 'real' && (p.severity === 'P0' || p.severity === 'P1' || p.severity === 'P2'),
  );
  return realBlocking.length === 0;
}

// ----- Engine event union -----

export type EngineEvent =
  | { type: 'work_done'; clean: boolean; issues?: Issue[] }
  | { type: 'review_done'; clean: boolean; issues: Issue[] }
  | { type: 'fix_done' }
  | { type: 'external_done'; converges: boolean; output?: ReviewFixOutput }
  | { type: 'blocked'; raw: string }
  | { type: 'cancel' };

/**
 * Pure state transition function. spec §5.3.4 conversion table.
 * Returns next state. Does NOT mutate.
 */
export function computeNextState(state: ReviewState, event: EngineEvent, maxRounds: number): ReviewState {
  const pid = state.pipelineId;
  const round = state.round;

  if (event.type === 'cancel') {
    return { kind: 'ABORTED', pipelineId: pid, round, reason: 'user_cancelled', abortedBefore: state.kind };
  }
  if (event.type === 'blocked') {
    return { kind: 'ABORTED', pipelineId: pid, round, reason: 'unexpected_blocked', abortedBefore: state.kind };
  }

  switch (state.kind) {
    case 'PRODUCING':
      if (event.type === 'work_done') {
        if (1 > maxRounds) return { kind: 'ABORTED', pipelineId: pid, round, reason: 'max_rounds_exceeded', abortedBefore: 'PRODUCING' };
        return { kind: 'SELF_REVIEW_R1', pipelineId: pid, round: 1, cycle: 'initial' };
      }
      break;
    case 'SELF_REVIEW_R1':
      if (event.type === 'review_done') {
        if (event.clean) return { kind: 'EXTERNAL_REVIEW', pipelineId: pid, round };
        return { kind: 'FIXING', pipelineId: pid, round, source: 'SELF_REVIEW_R1', inputIssues: event.issues };
      }
      break;
    case 'SELF_REVIEW_R2':
      if (event.type === 'review_done') {
        if (event.clean) return { kind: 'EXTERNAL_REVIEW', pipelineId: pid, round };
        return { kind: 'FIXING', pipelineId: pid, round, source: 'SELF_REVIEW_R2', inputIssues: event.issues };
      }
      break;
    case 'FIXING':
      if (event.type === 'fix_done') {
        if (state.source === 'SELF_REVIEW_R1') return { kind: 'SELF_REVIEW_R2', pipelineId: pid, round, cycle: 'initial' };
        return { kind: 'EXTERNAL_REVIEW', pipelineId: pid, round };
      }
      break;
    case 'EXTERNAL_REVIEW':
      if (event.type === 'external_done') {
        if (event.converges) return { kind: 'DONE', pipelineId: pid, round, issueTrail: [] };
        // postfix: round+1, check max (v2.1.5 P2-2: round+1 > max -> abort, no +1)
        if (round + 1 > maxRounds) return { kind: 'ABORTED', pipelineId: pid, round, reason: 'max_rounds_exceeded', abortedBefore: 'EXTERNAL_REVIEW' };
        return { kind: 'SELF_REVIEW_R1', pipelineId: pid, round: round + 1, cycle: 'postfix' };
      }
      break;
  }
  throw new Error(`invalid transition: ${state.kind} + ${event.type}`);
}

// ----- v2.1.6.1 patch C4: report rendering + writing -----

/** spec §8.4 structure: Header / Parse Degradation / Timeline / Issues / Summary. */
export async function renderReport(rec: PipelineRecord): Promise<string> {
  const lines: string[] = [];
  // Header
  lines.push(`# Review Report — ${rec.pipelineId}`);
  lines.push('');
  lines.push(`- Created: ${rec.createdAt}`);
  lines.push(`- Phase: ${rec.input.phase}`);
  lines.push(`- Profile: ${rec.input.profile}`);
  lines.push(`- Max rounds: ${rec.input.maxRounds}`);
  lines.push(`- CWD: ${rec.input.cwd}`);
  lines.push(`- Final state: **${rec.state.kind}**`);
  if (rec.state.kind === 'ABORTED') {
    const reason = (rec.state as { reason?: string }).reason;
    lines.push(`- Abort reason: ${reason ?? 'unknown'}`);
  }
  lines.push('');

  // Parse Degradation Events
  if (rec.parseDegraded && rec.parseDegraded.length > 0) {
    lines.push('## Parse Degradation');
    for (const p of rec.parseDegraded) {
      lines.push(`- [${p.ts}] round=${p.round} state=${p.state} reason=${p.reason} recoveredByRetry=${p.recoveredByRetry}`);
    }
    lines.push('');
  }

  // Timeline (history summary)
  lines.push('## Timeline');
  for (const h of rec.history) {
    lines.push(`- [${h.ts}] ${h.fromState ?? '∅'} → ${h.toState} (round=${h.round}, role=${h.role})`);
  }
  lines.push('');

  // Issues — merge from history[*].issues (engine-canonical)
  const allIssues: Issue[] = [];
  for (const h of rec.history) for (const i of h.issues ?? []) allIssues.push(i);
  const dedup = new Map<string, Issue>();
  for (const i of allIssues) if (!dedup.has(i.fingerprint)) dedup.set(i.fingerprint, i);
  const sorted = [...dedup.values()].sort((a, b) => {
    const order: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return (order[a.severity] ?? 99) - (order[b.severity] ?? 99);
  });

  lines.push('## Issues');
  if (sorted.length === 0) lines.push('_No issues recorded._');
  for (const i of sorted) {
    const hint = i.suggestion ? `  hint: ${i.suggestion}` : '';
    lines.push(`- [${i.severity}] \`${i.location}\` (role=${i.role}) — ${i.description}${hint}`);
  }
  lines.push('');

  // Summary
  const fixCount = rec.history.reduce((n, h) => n + (h.issues?.length ?? 0), 0);
  lines.push('## Summary');
  lines.push(`- Total unique issues: ${sorted.length}`);
  lines.push(`- Issue events across rounds: ${fixCount}`);
  lines.push(`- Models used: work=${rec.panes.work?.modelName ?? rec.panes.work?.provider ?? '?'}; review=${rec.panes.review?.modelName ?? rec.panes.review?.provider ?? '?'}`);
  lines.push('');

  // Rollback hint (v2.1.6: engine never took git checkpoint)
  if (sorted.some((i) => i.severity === 'P0' || i.severity === 'P1')) {
    lines.push('> Engine did NOT take git checkpoint. Rollback with `git reset --hard <commit-before-this-pipeline>`.');
    lines.push('');
  }

  return lines.join('\n');
}

/** Write report file to <cwd>/.claude/reviews/<pipelineId>.md. Returns the path. */
export async function writeReport(rec: PipelineRecord): Promise<string> {
  const path = reviewReportPath(rec.input.cwd, rec.pipelineId);
  await mkdir(dirname(path), { recursive: true });
  const md = await renderReport(rec);
  await Bun.write(path, md);
  return path;
}

// ----- ReviewEngine class -----

/**
 * Drives a single pipeline. The main loop:
 *   spawn work -> poll -> transition -> spawn next (review/fixing/produce) -> ...
 * On terminal transitions, `writeReport` is invoked and the record is moved to its terminal bucket.
 */
export class ReviewEngine {
  constructor(
    private store: PipelineStore,
    private adapter: ClaudeBGAdapter,
  ) {}

  async runPipeline(
    pipelineId: string,
    task: string,
    phase: 'spec' | 'plan' | 'code',
    profile: ResolvedProfile,
  ): Promise<void> {
    let record = await this.store.read(pipelineId);
    if (!record) throw new Error(`pipeline ${pipelineId} not found`);

    // PRODUCING: spawn work bg
    const { shortId, sessionId } = await this.adapter.startSession({
      prompt: this.buildProducePrompt(task, phase, profile),
      settingsPath: profile.workSettingsPath,
      cwd: record.input.cwd,
    });
    record.panes.work = {
      sessionId,
      currentRoundShortId: shortId,
      provider: profile.work.provider,
      startedAt: new Date().toISOString(),
      roundShortIds: [shortId],
    };
    await this.store.save(record);

    // Main loop
    while (!isTerminal(record.state.kind)) {
      const paneShort = this.currentShortId(record);
      if (!paneShort) {
        record.state = { kind: 'FAILED', pipelineId, round: record.state.round, reason: 'no_active_pane' };
        await this.store.save(record);
        await this.store.move(pipelineId, 'running', 'failed');
        return;
      }

      let pollResult;
      try {
        pollResult = await this.adapter.poll(paneShort, 600_000);
      } catch (_e) {
        // PollTimeout -> PANE_LOST
        record.state = { kind: 'PANE_LOST', pipelineId, round: record.state.round, detectedAt: new Date().toISOString(), retryTarget: record.state.kind };
        await this.store.save(record);
        return;
      }

      // C1: capture model name when present
      if ((pollResult.kind === 'done' || pollResult.kind === 'running') && pollResult.model?.name) {
        const m = pollResult.model.name;
        if (record.state.kind === 'EXTERNAL_REVIEW' && record.panes.review) {
          record.panes.review.modelName = m;
        } else if (record.panes.work) {
          record.panes.work.modelName = m;
        }
      }

      if (pollResult.kind === 'blocked') {
        record.state = computeNextState(record.state, { type: 'blocked', raw: pollResult.blocked.raw }, profile.guards.maxRounds);
        await this.store.save(record);
        if (record.state.kind === 'ABORTED') {
          await this.store.move(pipelineId, 'running', 'aborted');
          await writeReport(record);
        }
        return;
      }
      if (pollResult.kind === 'lost') {
        record.state = { kind: 'PANE_LOST', pipelineId, round: record.state.round, detectedAt: new Date().toISOString(), retryTarget: record.state.kind };
        await this.store.save(record);
        return;
      }
      if (pollResult.kind !== 'done') continue; // running, keep polling

      // done: dispatch per current state
      record = await this.dispatchState(record, task, phase, profile, pollResult.output);
      if (record.state.kind === 'DONE') {
        await this.store.move(pipelineId, 'running', 'done');
        await writeReport(record);
        return;
      }
      if (record.state.kind === 'FAILED') {
        await this.store.move(pipelineId, 'running', 'failed');
        await writeReport(record);
        return;
      }
      if (record.state.kind === 'ABORTED') {
        await this.store.move(pipelineId, 'running', 'aborted');
        await writeReport(record);
        return;
      }
    }
  }

  /** Per-state dispatch on bg done. Returns updated record. */
  private async dispatchState(
    record: PipelineRecord,
    task: string,
    phase: 'spec' | 'plan' | 'code',
    profile: ResolvedProfile,
    output: string,
  ): Promise<PipelineRecord> {
    const pid = record.pipelineId;
    const maxR = profile.guards.maxRounds;
    const state = record.state;

    if (state.kind === 'PRODUCING') {
      // No JSON parse for produce — output is on disk
      record.state = computeNextState(state, { type: 'work_done', clean: true }, maxR);
      if (record.state.kind === 'SELF_REVIEW_R1') {
        await this.spawnWorkRound(record, this.buildSelfReviewPrompt(task, 'SELF_REVIEW_R1', record.state.cycle, profile), profile);
      }
      await this.store.save(record);
      return record;
    }

    if (state.kind === 'SELF_REVIEW_R1' || state.kind === 'SELF_REVIEW_R2') {
      const cycle = state.cycle;
      const retryRegen = async (): Promise<string> => {
        const regen = await this.adapter.resumeWorkSession({
          sessionId: record.panes.work!.sessionId,
          prompt: this.buildSelfReviewPrompt(task, state.kind, cycle, profile),
          settingsPath: profile.workSettingsPath,
          cwd: record.input.cwd,
        });
        record.panes.work!.currentRoundShortId = regen.shortId;
        record.panes.work!.roundShortIds.push(regen.shortId);
        await this.store.save(record);
        const r = await this.adapter.poll(regen.shortId, 600_000);
        return r.kind === 'done' ? r.output : '';
      };
      const parsed = await parseBgOutputWithRetry(
        output,
        SelfReviewOutputSchema,
        { timeoutMs: profile.guards.parseRetryTimeoutMs },
        retryRegen,
      );
      if (!parsed.ok) {
        const reasonTag = state.kind === 'SELF_REVIEW_R1' ? 'r1_parse_degraded' : 'r2_parse_degraded';
        record.state = { kind: 'ABORTED', pipelineId: pid, round: state.round, reason: reasonTag, abortedBefore: state.kind };
        await this.store.save(record);
        return record;
      }
      const issues = assignIssueFingerprints(parsed.data.issues, 'work');
      const clean = isClean(issues);
      record.state = computeNextState(state, { type: 'review_done', clean, issues }, maxR);
      if (record.state.kind === 'FIXING') {
        await this.spawnWorkRound(record, this.buildFixingPrompt(task, record.state.inputIssues, profile), profile);
      } else if (record.state.kind === 'EXTERNAL_REVIEW') {
        await this.spawnReview(record, task, phase, profile);
      }
      await this.store.save(record);
      return record;
    }

    if (state.kind === 'FIXING') {
      // FIXING parse fail -> conservative advance (R2 comprehensive review catches bad FIXING)
      await parseBgOutputWithRetry(
        output,
        FixingOutputSchema,
        { timeoutMs: profile.guards.parseRetryTimeoutMs },
        async () => '',
      );
      record.state = computeNextState(state, { type: 'fix_done' }, maxR);
      if (record.state.kind === 'SELF_REVIEW_R2') {
        await this.spawnWorkRound(record, this.buildSelfReviewPrompt(task, 'SELF_REVIEW_R2', 'initial', profile), profile);
      } else if (record.state.kind === 'EXTERNAL_REVIEW') {
        await this.spawnReview(record, task, phase, profile);
      }
      await this.store.save(record);
      return record;
    }

    if (state.kind === 'EXTERNAL_REVIEW') {
      const parsed = await parseBgOutputWithRetry(
        output,
        ReviewOutputSchema,
        { timeoutMs: profile.guards.parseRetryTimeoutMs },
        async () => '',
      );
      if (!parsed.ok) {
        record.state = { kind: 'ABORTED', pipelineId: pid, round: state.round, reason: 'review_parse_degraded', abortedBefore: state.kind };
        await this.store.save(record);
        return record;
      }
      const issues = assignIssueFingerprints(parsed.data.issues, 'review');
      const perIssue = parsed.data.per_issue.map((p) => ({
        issueId: p.issue_id,
        severity: p.severity,
        verdict: p.verdict,
        verdictReason: p.verdict_reason,
        fixApplied: p.fix_applied,
        fixSummary: p.fix_summary,
      }));
      const out: ReviewFixOutput = { role: 'review', issues, perIssue, reasoning: parsed.data.reasoning };
      const converges = externalReviewConverges(out);
      record.state = computeNextState(state, { type: 'external_done', converges, output: out }, maxR);
      if (record.state.kind === 'SELF_REVIEW_R1') {
        await this.spawnWorkRound(record, this.buildSelfReviewPrompt(task, 'SELF_REVIEW_R1', 'postfix', profile), profile);
      }
      await this.store.save(record);
      return record;
    }

    // PANE_LOST / terminal: nothing to dispatch
    return record;
  }

  private async spawnWorkRound(record: PipelineRecord, prompt: string, profile: ResolvedProfile): Promise<void> {
    const { shortId } = await this.adapter.resumeWorkSession({
      sessionId: record.panes.work!.sessionId,
      prompt,
      settingsPath: profile.workSettingsPath,
      cwd: record.input.cwd,
    });
    record.panes.work!.currentRoundShortId = shortId;
    record.panes.work!.roundShortIds.push(shortId);
  }

  private async spawnReview(record: PipelineRecord, task: string, phase: 'spec' | 'plan' | 'code', profile: ResolvedProfile): Promise<void> {
    const prompt = this.buildReviewPrompt(task, phase, profile);
    const { shortId, sessionId } = await this.adapter.startSession({
      prompt,
      settingsPath: profile.reviewSettingsPath,
      cwd: record.input.cwd,
    });
    record.panes.review = {
      role: 'review',
      shortId,
      sessionId,
      provider: profile.review.provider,
      round: record.state.round,
    };
  }

  private currentShortId(record: PipelineRecord): string | undefined {
    if (record.state.kind === 'EXTERNAL_REVIEW' && record.panes.review?.shortId) return record.panes.review.shortId;
    return record.panes.work?.currentRoundShortId;
  }

  // ----- Prompt builders (M4 implementer task — spec §7.2 + spec §7.5.4) -----

  private buildProducePrompt(task: string, phase: string, profile: ResolvedProfile): string {
    return profile.prompts.work.produce.system.template
      .replace(/\{task\}/g, task)
      .replace(/\{phase\}/g, phase);
  }

  private buildSelfReviewPrompt(task: string, stateKind: 'SELF_REVIEW_R1' | 'SELF_REVIEW_R2', cycle: 'initial' | 'postfix', profile: ResolvedProfile): string {
    return profile.prompts.work.self_review.system.template
      .replace(/\{task\}/g, task)
      .replace(/\{r1_or_r2_instruction\}/g, resolveSelfReviewHint(stateKind, cycle));
  }

  private buildFixingPrompt(task: string, inputIssues: Issue[], profile: ResolvedProfile): string {
    return profile.prompts.work.fixing.system.template
      .replace(/\{task\}/g, task)
      .replace(/\{input_issues\}/g, JSON.stringify(inputIssues));
  }

  private buildReviewPrompt(task: string, phase: 'spec' | 'plan' | 'code', profile: ResolvedProfile): string {
    const tmpl = profile.prompts.review[phase].system.template;
    return tmpl.replace(/\{task\}/g, task);
  }
}

/**
 * v2.1.6 helper: choose one of 4 substitution phrases from spec §7.2.
 * If `stateKind` is given, select by (stateKind, cycle); otherwise by cycle only.
 */
function resolveSelfReviewHint(stateKind: 'SELF_REVIEW_R1' | 'SELF_REVIEW_R2' | undefined, cycle: 'initial' | 'postfix'): string {
  if (stateKind === 'SELF_REVIEW_R2' && cycle === 'initial') return '审查修复后的整体状态是否符合需求、有无新问题';
  if (stateKind === 'SELF_REVIEW_R2' && cycle === 'postfix') return '审查 postfix 修复后的整体状态';
  if (stateKind === 'SELF_REVIEW_R1' && cycle === 'postfix') return 'postfix 循环：全面复查上一轮 external review 修复后的整体状态';
  // SELF_REVIEW_R1 initial (default)
  return '第一次自查，全面审查产出是否符合需求';
}
