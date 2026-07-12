// src/review/cli-watch.ts
// v2.1.6 + v2.1.6.1 patch C1 step 6:
//   renderLive prefers pane.modelName ?? pane.provider
//   for both work and review pane labels.
import chalk from 'chalk';
import { isTerminal } from './types';
import type { PipelineRecord } from './types';
import { PipelineStore } from './pipeline-store';
import { REVIEW_PIPELINES_DIR } from './paths';

export function renderLive(record: PipelineRecord): string {
  const lines: string[] = [];
  const s = record.state;
  lines.push(chalk.bold.cyan(`╭─ cc-linker Review Engine ──────────────────────╮`));
  lines.push(chalk.cyan(`│ Pipeline: ${record.pipelineId} │ Phase: ${record.input.phase} │ Profile: ${record.input.profile}`));
  lines.push(chalk.cyan(`│ Round: ${(s as any).round ?? 0}/${record.input.maxRounds} │ State: ${s.kind}`));
  lines.push(chalk.cyan(`╰──────────────────────────────────────────────────╯`));
  lines.push('');
  lines.push(chalk.bold('Pane Status:'));
  const panes = record.panes ?? {};
  if (panes.work) {
    const m = panes.work.modelName ?? panes.work.provider;
    lines.push(`  🔧 work     ${panes.work.currentRoundShortId ?? '-'} (${m})`);
  }
  if (panes.review) {
    const m = panes.review.modelName ?? panes.review.provider;
    lines.push(`  👁 review   ${panes.review.shortId} (${m})`);
  }
  const history = record.history ?? [];
  if (history.length > 0) {
    lines.push('');
    lines.push(chalk.bold('Timeline:'));
    for (const h of history.slice(-5)) {
      lines.push(`  [${h.ts.slice(11, 19)}] ${h.toState} (${h.role})`);
    }
  }
  if (isTerminal(s.kind)) {
    lines.push('');
    lines.push(chalk.green(`✓ Pipeline ${s.kind}`));
  }
  return lines.join('\n');
}

export async function watchPipeline(pipelineId: string): Promise<void> {
  const store = new PipelineStore(REVIEW_PIPELINES_DIR);
  while (true) {
    const record = await store.read(pipelineId);
    if (!record) {
      console.log(chalk.red(`pipeline ${pipelineId} not found`));
      return;
    }
    // clear + render
    process.stdout.write('\x1B[2J\x1B[H');
    console.log(renderLive(record));
    if (isTerminal(record.state.kind)) return;
    await Bun.sleep(500);
  }
}