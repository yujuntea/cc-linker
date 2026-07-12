// src/review/engine-process.ts
// STUB created by T7 (so `import` resolves at typecheck); T9b OVERWRITES this file
// with the real implementation (forkEngine / killEngine / isEngineAlive / runEngineLoop +
// writeEnginePid / readEnginePidWithCheck).
//
// Real implementation lands in batch 6. Until then, the stub keeps typecheck happy
// and unblocks T7. Runtime callers will see "not yet implemented" errors.

export async function forkEngine(_pipelineId: string): Promise<void> {
  throw new Error('engine-process: forkEngine pending T9b (batch 6)');
}
export async function killEngine(_pipelineId: string): Promise<void> {
  throw new Error('engine-process: killEngine pending T9b (batch 6)');
}
export async function isEngineAlive(_pipelineId: string): Promise<boolean> {
  return false;
}
export async function runEngineLoop(_pipelineId: string): Promise<void> {
  throw new Error('engine-process: runEngineLoop pending T9b (batch 6)');
}
export function writeEnginePid(_pidFile: string, _pid: number, _startTime: number): void {
  // T9b will replace.
}
export function readEnginePidWithCheck(_pidFile: string): number | null {
  return null;
}
