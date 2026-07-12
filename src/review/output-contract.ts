// src/review/output-contract.ts
// v2.1.6 + v2.1.6.1: ParseFailure is non-generic; parseBgOutputWithRetry<T> returns ParseResult<T> = ParseSuccess<T> | ParseFailure.

import { z } from 'zod';
import { createHash } from 'crypto';
import type { Issue, Role, Severity } from './types';

export function extractJsonBlock(output: string): unknown {
  // strategy 1: ```json fenced
  const fence = output.match(/```json\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ }
  }
  // strategy 2: walk forward, collect all top-level balanced {...} candidates, try the rightmost first.
  // v2.1.5 P2-5: returns the LAST balanced top-level JSON object (depth-0 start→depth-0 end pair).
  const candidates: Array<[number, number]> = [];
  let depth = 0;
  let topStart = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') {
      if (depth === 0) topStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && topStart !== -1) {
        candidates.push([topStart, i + 1]);
        topStart = -1;
      } else if (depth < 0) {
        depth = 0;
        topStart = -1;
      }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    const [s, e] = candidates[k];
    try { return JSON.parse(output.slice(s, e)); } catch { /* try earlier */ }
  }
  // strategy 3: direct parse
  try { return JSON.parse(output); } catch { /* fall through to strategy 4 */ }
  // strategy 4 (v2.1.6.1.1): auto-quote unquoted keys (common with qwen/MiniMax)
  // — fix any candidate or the whole output then re-parse.
  for (const [s, e] of candidates) {
    const fixed = autoQuoteJson(output.slice(s, e));
    try { return JSON.parse(fixed); } catch { /* try next */ }
  }
  try { return JSON.parse(autoQuoteJson(output)); } catch { /* fall through to strategy 5 */ }

  // strategy 5 (v2.1.6.1.1): last-resort prose heuristic. Some non-JSON-faithful
  // models emit no JSON at all — just natural-language "no defects, clean repo".
  // If the output unambiguously states "no issues found" AND shows no concrete
  // defect markers (no P0/P1/P2/critical/bugfound), trust it as `{issues: []}`
  // and let engine converge to DONE. This is conservative: any signal of
  // specific problems blocks the heuristic and we fall through to ABORTED.
  if (looksCleanNoIssues(output)) {
    return { issues: [] };
  }
  return null;
}

/** Replace bareword keys (e.g. `{issues:[],}`) with quoted (e.g. `{"issues":[],}`). */
function autoQuoteJson(s: string): string {
  // Match { or , then whitespace then bareword then whitespace then :
  return s.replace(/([{,]\s*)([a-zA-Z_][\w-]*)\s*:/g, '$1"$2":');
}

/**
 * v2.1.6.1.1: detect "no issues" prose from non-JSON models (qwen / GLM / MiniMax).
 * Returns true ONLY when the output mentions clean/no-issues markers AND lacks any
 * defect markers — so the engine's failure mode stays conservative (specific
 * defect mentions still surface as parse_failed -> ABORTED).
 */
function looksCleanNoIssues(text: string): boolean {
  const lower = text.toLowerCase();
  const cleanMarkers = [
    'no defects', 'no issues', 'no problems', 'all clean', 'clean repo',
    'trivial clean', 'nothing to do', 'no issues found', 'looks good',
    'looks clean', 'everything looks', '工作正常', '没有发现问题', '无问题',
    'all good', 'clean and correct', 'no real issues', 'no fixes needed',
    'no changes needed',
  ];
  const hasClean = cleanMarkers.some((m) => lower.includes(m));
  if (!hasClean) return false;
  // Reject if the output ALSO mentions specific defect indicators.
  const defectMarkers = [
    'p0 issue', 'p1 issue', 'p2 issue', 'critical issue', 'bug found',
    'must fix', 'needs to be fixed', 'severe bug', 'severity: p',
    '必须修复', '发现问题', '有缺陷',
  ];
  const hasDefect = defectMarkers.some((m) => lower.includes(m));
  return !hasDefect;
}

const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

export const SelfReviewOutputSchema = z.object({
  issues: z.array(z.object({
    severity: SeveritySchema,
    location: z.string(),
    description: z.string(),
  })),
});

export const FixingOutputSchema = z.object({
  per_issue: z.array(z.object({
    issue_id: z.string(),
    verdict: z.enum(['real', 'hallucination']),
    verdict_reason: z.string(),
    fix_applied: z.boolean(),
    fix_summary: z.string().optional(),
  })),
  all_real_fixed: z.boolean(),
  remaining_real_unfixed_count: z.number(),
});

export const ReviewOutputSchema = z.object({
  issues: z.array(z.object({
    severity: SeveritySchema,
    location: z.string(),
    description: z.string(),
    suggestion: z.string().optional(),
  })),
  // v2.1.6.1.1: per_issue + reasoning are OPTIONAL with sensible defaults so
  // that lower-tier models (qwen3.6 / GLM / minimax-M3) which emit prose
  // summaries without per-issue verdicts still parse cleanly. Engine downstream
  // (externalReviewConverges) treats empty per_issue as "no fixes proposed"
  // and converges — semantically correct for trivial/clean repos.
  per_issue: z.array(z.object({
    issue_id: z.string(),
    severity: SeveritySchema,
    verdict: z.enum(['real', 'hallucination']),
    verdict_reason: z.string(),
    fix_applied: z.boolean(),
    fix_summary: z.string().optional(),
  })).optional().default([]),
  reasoning: z.string().optional().default(''),
});

/** Compute fingerprint = first 8 hex of SHA256(role:severity:location:description). */
export function fingerprintOf(role: Role, severity: Severity, location: string, description: string): string {
  return createHash('sha256').update(`${role}:${severity}:${location}:${description}`).digest('hex').slice(0, 8);
}

/** Assign id + fingerprint to issues parsed from model output (models never output ids). */
export function assignIssueFingerprints(
  issues: Array<{ severity: Severity; location: string; description: string; suggestion?: string }>,
  role: Role,
): Issue[] {
  return issues.map((i) => {
    const fp = fingerprintOf(role, i.severity, i.location, i.description);
    return { ...i, id: fp, role, fingerprint: fp };
  });
}

interface ParseRetryOptions {
  maxRetries?: number;   // default 1
  timeoutMs?: number;    // default 15000
}
interface ParseSuccess<T> { ok: true; data: T; retries: number }
interface ParseFailure { ok: false; parseDegraded: true; reason: string; raw: string }

/**
 * Parse bg output JSON with one retry. On failure, caller (engine) decides
 * degradation (ABORTED for review/R1, conservative-advance for FIXING).
 * The retry callback re-generates via resumeWorkSession.
 */
export async function parseBgOutputWithRetry<T>(
  rawOutput: string,
  schema: z.ZodSchema<T>,
  opts: ParseRetryOptions,
  retryRegenerate: () => Promise<string>,  // returns new rawOutput
): Promise<ParseSuccess<T> | ParseFailure> {
  const maxRetries = opts.maxRetries ?? 1;
  let lastRaw = rawOutput;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const extracted = extractJsonBlock(lastRaw);
    if (extracted !== null) {
      const r = schema.safeParse(extracted);
      if (r.success) {
        return { ok: true, data: r.data, retries: attempt };
      }
    }
    if (attempt < maxRetries) {
      lastRaw = await retryRegenerate();
    }
  }
  return { ok: false, parseDegraded: true, reason: 'parse failed after retry', raw: lastRaw };
}
