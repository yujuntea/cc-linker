// src/review/model-parser.ts
//
// v2.1.6.1 patch C1: 把 Claude CLI bg session 的 respawnFlags(放进 ~/.claude/jobs/<short>/state.json)
// 解析成 ModelInfo,以让 cli-watch 显示真实的模型名(provider alias 是字节 / glm 之类的,不可读)。
//
// Spec §3.2.1: providerEnv 不可信(2.3.x 起 CLI 不再暴露 ANTHROPIC_MODEL),
// 必须从 respawnFlags 读 — model 由 --settings 文件决定,CLI 自己从 settings 解析写入 respawnFlags。
//
// 我们只展示,不驱动任何阈值 / 控制流,contextHint 仅供报告 / TUI 读数。

import type { JobStateFile } from '../agent-view/job-state';
import type { ModelInfo } from './types';

// re-export so consumers 只需要 `import { ModelInfo } from './model-parser'` 就行
export type { ModelInfo };

/**
 * Parse the `--model` flag from `state.json.respawnFlags[]`.
 * Format: `--model <name>[<hint><k|m>]`  e.g. `glm-5.2[1m]` / `claude-sonnet-4[200k]` / `MiniMax-M3`
 *
 * 行为:
 * - undefined / 空数组 → null(没有 respawnFlags 可读)
 * - 没有 --model 标记 → null
 * - --model 在末尾(没有 value)→ null
 * - value 以 `-` 开头(其它 flag like `--resume` / `--bare`) → null(v2.1.6.1 H2 防御)
 * - 没有 `[hint]` 后缀 → contextHint = null
 * - `[hint]` 后缀:
 *     `[200k]` → 200 * 1000   = 200_000
 *     `[1m]`   → 1 * 1_000_000 = 1_000_000
 *     `[32]`   → 32(单位缺失 = raw number)
 */
export function parseModelFromRespawnFlags(flags: string[] | undefined | null): ModelInfo | null {
  if (!flags || flags.length < 2) return null;
  const idx = flags.indexOf('--model');
  if (idx === -1 || idx === flags.length - 1) return null;
  const raw = flags[idx + 1];
  // v2.1.6.1 H2 defence: the value after `--model` must NOT look like another
  // CLI flag. Without this guard, `['--model','--resume','uuid-abc']` would
  // happily return `{name:'--resume', contextHint:null}` (silent garbage display).
  if (raw.startsWith('-')) return null;
  // match `name` + optional `[<digits><k|m>]` suffix
  const m = raw.match(/^(.+?)(?:\[(\d+)([kKmM]?)\])?$/);
  if (!m) return null;
  let hint: number | null = null;
  if (m[2]) {
    const n = parseInt(m[2], 10);
    if (Number.isFinite(n) && n > 0) {
      const unit = (m[3] || 'm').toLowerCase();
      hint = unit === 'k' ? n * 1000 : unit === 'm' ? n * 1_000_000 : n;
    }
  }
  return { name: m[1], contextHint: hint };
}

/** Sugar: extract from a JobStateFile directly. */
export function modelFromJobState(state: JobStateFile | null | undefined): ModelInfo | null {
  if (!state) return null;
  return parseModelFromRespawnFlags(state.respawnFlags);
}
