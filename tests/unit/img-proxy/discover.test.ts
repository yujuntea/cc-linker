import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverCandidates } from '../../../src/img-proxy/discover';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'discover-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('discoverCandidates', () => {
  test('manual provider file 出现', () => {
    const manualDir = join(tmpDir, 'providers');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'glm-5.2.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_MODEL: 'glm-5.2' }
    }));
    const result = discoverCandidates({ manualDir, autoDir: join(tmpDir, 'auto'), aliasRcFiles: [] });
    expect(result).toHaveLength(1);
    expect(result[0]!.alias).toBe('glm-5.2');
    expect(result[0]!.source).toBe('manual');
    expect(result[0]!.kind).toBe('text-only');
  });

  test('空 baseUrl 被过滤(🔴 fix #4)', () => {
    const manualDir = join(tmpDir, 'providers');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'empty.json'), JSON.stringify({
      env: { ANTHROPIC_MODEL: 'glm-5.2' }
    }));
    const result = discoverCandidates({ manualDir, autoDir: join(tmpDir, 'auto'), aliasRcFiles: [] });
    expect(result).toHaveLength(0);
  });

  test('multimodal model kind=multimodal', () => {
    const manualDir = join(tmpDir, 'providers');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'kimi.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn', ANTHROPIC_MODEL: 'kimi-for-coding[256k]' }
    }));
    const result = discoverCandidates({ manualDir, autoDir: join(tmpDir, 'auto'), aliasRcFiles: [] });
    expect(result[0]!.kind).toBe('multimodal');
  });

  test('manual + alias 同 alias 时 source=manual(file 是 source of truth)', () => {
    const manualDir = join(tmpDir, 'providers');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'glm-5.2.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_MODEL: 'glm-5.2' }
    }));
    const rc = join(tmpDir, '.zshrc');
    writeFileSync(rc, `alias cc-glm='claude --settings ${join(manualDir, 'glm-5.2.json')}'`);
    const result = discoverCandidates({ manualDir, autoDir: join(tmpDir, 'auto'), aliasRcFiles: [rc] });
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe('manual');
  });

  test('排序:manual 先于 auto', () => {
    const manualDir = join(tmpDir, 'providers');
    const autoDir = join(tmpDir, 'auto');
    mkdirSync(manualDir, { recursive: true });
    mkdirSync(autoDir, { recursive: true });
    writeFileSync(join(manualDir, 'a-manual.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'x' } }));
    writeFileSync(join(autoDir, 'z-auto.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'x' } }));
    const result = discoverCandidates({ manualDir, autoDir, aliasRcFiles: [] });
    expect(result.map(r => r.alias)).toEqual(['a-manual', 'z-auto']);
  });
});
