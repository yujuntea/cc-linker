// tests/unit/scanner/jsonl-parse-tail-preview.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseTailForPreview } from '../../../src/scanner/jsonl';

describe('parseTailForPreview', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parse-tail-preview-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts last user prompt and last assistant text from valid JSONL', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '帮我做 X' }, timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '好的，我来帮你' }] }, timestamp: '2026-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'sleep 50 && echo done' }] }, timestamp: '2026-01-01T00:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', text: '思考中...' }, { type: 'text', text: '执行 sleep 50' }] }, timestamp: '2026-01-01T00:00:03Z' }),
    ];
    writeFileSync(path, lines.join('\n'));

    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('sleep 50 && echo done');
    expect(result.lastAssistant).toBe('执行 sleep 50');
  });

  it('handles user content as string (not array)', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: '纯字符串内容' } }));

    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('纯字符串内容');
  });

  it('returns empty object for empty file', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, '');
    const result = parseTailForPreview(path);
    expect(result).toEqual({});
  });

  it('returns empty object for malformed JSONL lines', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, 'not json\n{broken: json\n');
    const result = parseTailForPreview(path);
    expect(result).toEqual({});
  });

  it('returns only lastUser when only user lines exist', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: '只有一个 user' } }));
    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('只有一个 user');
    expect(result.lastAssistant).toBeUndefined();
  });

  it('returns only lastAssistant when only assistant lines exist', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '只有 assistant' }] } }));
    const result = parseTailForPreview(path);
    expect(result.lastAssistant).toBe('只有 assistant');
    expect(result.lastUser).toBeUndefined();
  });

  it('truncates long text to 100 chars', () => {
    const path = join(tmpDir, 'session.jsonl');
    const longText = 'x'.repeat(500);
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }));
    const result = parseTailForPreview(path);
    expect(result.lastAssistant?.length).toBe(100);
  });
});
