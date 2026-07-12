// tests/unit/review/model-parser.test.ts
// v2.1.6.1 patch C1 — 6 cases covering the parseModelFromRespawnFlags contract.
import { describe, it, expect } from 'bun:test';
import { parseModelFromRespawnFlags } from '../../../src/review/model-parser';

describe('parseModelFromRespawnFlags', () => {
  it('parses --model glm-5.2[1m] -> { name: "glm-5.2", contextHint: 1000000 }', () => {
    expect(parseModelFromRespawnFlags(['--settings', '/x/glm-5.2.json', '--model', 'glm-5.2[1m]']))
      .toEqual({ name: 'glm-5.2', contextHint: 1_000_000 });
  });

  it('parses --model MiniMax-M3 (no hint suffix) -> contextHint: null', () => {
    expect(parseModelFromRespawnFlags(['--model', 'MiniMax-M3']))
      .toEqual({ name: 'MiniMax-M3', contextHint: null });
  });

  it('returns null when no --model flag', () => {
    expect(parseModelFromRespawnFlags(['--settings', '/x/foo.json'])).toBeNull();
  });

  it('returns null for empty/undefined', () => {
    expect(parseModelFromRespawnFlags([])).toBeNull();
    expect(parseModelFromRespawnFlags(undefined)).toBeNull();
  });

  it('handles --model at end (no value)', () => {
    expect(parseModelFromRespawnFlags(['--model'])).toBeNull();
  });

  it('handles k-suffix: claude-sonnet-4[200k] -> 200000', () => {
    expect(parseModelFromRespawnFlags(['--model', 'claude-sonnet-4[200k]']))
      .toEqual({ name: 'claude-sonnet-4', contextHint: 200_000 });
  });
});
