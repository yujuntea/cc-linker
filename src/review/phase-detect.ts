// src/review/phase-detect.ts
// T3 (plan v2.1.6, lines 582-693): pure heuristic phase detector.
// Priority: gitRef > file:line > filePath suffix > CN keywords > EN keywords > throw.
import { CCLinkerError } from '../utils/errors';

export class PhaseUnknownError extends CCLinkerError {}

export function detect(input: {
  rawInput: string;
  filePath?: string;
  gitRef?: string;
}): 'spec' | 'plan' | 'code' {
  // priority 1: git ref -> code
  if (input.gitRef) return 'code';

  // priority 2: file:line -> code
  if (/\.\w+:\d+/.test(input.rawInput)) return 'code';

  // priority 3: file path suffix / dir
  if (input.filePath) {
    if (/docs\/.*\.md$|\.spec\.md$/.test(input.filePath)) return 'spec';
    if (/plans\/.*\.md$|\.plan\.md$/.test(input.filePath)) return 'plan';
    if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|swift|kt)$/.test(input.filePath)) return 'code';
  }

  // priority 4: keywords (Chinese first for 飞书 users, then English)
  if (/(需求|规格|PRD|规格说明书)/.test(input.rawInput)) return 'spec';
  if (/(设计|架构|方案|实现方案|技术方案)/.test(input.rawInput)) return 'plan';
  if (/(修|修复|改|重构|实现|优化|bug|崩溃|报错|异常)/.test(input.rawInput)) return 'code';
  if (/\b(spec|specification|requirements|PRD)\b/i.test(input.rawInput)) return 'spec';
  if (/\b(plan|design|architecture|implementation\s+plan)\b/i.test(input.rawInput)) return 'plan';
  if (/\b(fix|bug|refactor|implement|code|NPE|crash|error)\b/i.test(input.rawInput)) return 'code';

  throw new PhaseUnknownError('PHASE_UNKNOWN', `cannot detect phase for: ${input.rawInput}`);
}