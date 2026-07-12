import { describe, it, expect } from 'bun:test';
import { detect, PhaseUnknownError } from '../../../src/review/phase-detect';

describe('detect', () => {
  it('gitRef -> code (priority 1)', () => {
    expect(detect({ rawInput: 'update docs', gitRef: 'abc123' })).toBe('code');
  });

  it('file:line -> code (priority 2)', () => {
    expect(detect({ rawInput: 'fix auth.ts:42' })).toBe('code');
  });

  it('filePath docs/*.md -> spec (priority 3)', () => {
    expect(detect({ rawInput: 'review', filePath: 'docs/spec.md' })).toBe('spec');
    expect(detect({ rawInput: 'review', filePath: 'foo.spec.md' })).toBe('spec');
  });

  it('filePath plans/*.md -> plan', () => {
    expect(detect({ rawInput: 'review', filePath: 'plans/arch.md' })).toBe('plan');
    expect(detect({ rawInput: 'review', filePath: 'foo.plan.md' })).toBe('plan');
  });

  it('filePath *.ts -> code', () => {
    expect(detect({ rawInput: 'review', filePath: 'src/auth.ts' })).toBe('code');
  });

  it('Chinese keywords (v2.1.5 P2-3): fix -> code, design -> plan, spec -> spec', () => {
    expect(detect({ rawInput: '修复登录bug' })).toBe('code');
    expect(detect({ rawInput: '设计鉴权架构' })).toBe('plan');
    expect(detect({ rawInput: '写需求文档' })).toBe('spec');
  });

  it('English keywords: fix -> code, design -> plan, spec -> spec', () => {
    expect(detect({ rawInput: 'fix the NPE' })).toBe('code');
    expect(detect({ rawInput: 'design the auth flow' })).toBe('plan');
    expect(detect({ rawInput: 'write the spec' })).toBe('spec');
  });

  it('no match -> throws PhaseUnknownError', () => {
    expect(() => detect({ rawInput: 'hello world' })).toThrow(PhaseUnknownError);
  });
});