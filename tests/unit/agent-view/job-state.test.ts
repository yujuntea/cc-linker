import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { jobStateToSession, listJobShorts, readAllJobStates, readJobState } from '../../../src/agent-view/job-state';

const FIX = join(import.meta.dir, '../../fixtures/job-state');

describe('readJobState', () => {
  test('parses blocked fixture into envelope', () => {
    const env = readJobState('01-blocked-timer', FIX);
    expect(env).not.toBeNull();
    expect(env!.short).toBe('01-blocked-timer');
    expect(env!.state.state).toBe('blocked');
    expect(env!.state.needs).toBe('是否继续？');
    expect(env!.state.name).toBe('timer command response');
    expect(env!.state.linkScanPath).toContain('.jsonl');
    expect(env!.mtimeMs).toBeGreaterThan(0);
  });

  test('returns null for missing file', () => {
    expect(readJobState('does-not-exist', FIX)).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    expect(readJobState('neg-bad-json', FIX)).toBeNull();
  });

  test('returns null for wrong shape (missing state field)', () => {
    expect(readJobState('neg-wrong-shape', FIX)).toBeNull();
  });

  test('accepts unknown state value (forward compat)', () => {
    const env = readJobState('neg-unknown-state', FIX);
    expect(env).not.toBeNull();
    expect(env!.state.state).toBe('hypothetical_future_state');
  });
});

describe('listJobShorts', () => {
  test('lists all fixture filenames (without .json extension)', () => {
    const shorts = listJobShorts(FIX);
    // 应该包含 01..15 + neg-*,不包含 README.md
    expect(shorts).toContain('01-blocked-timer');
    expect(shorts).toContain('15-stopped-unnamed');
    expect(shorts).toContain('neg-bad-json');
    expect(shorts).not.toContain('README');
    expect(shorts.length).toBeGreaterThanOrEqual(18);
  });

  test('returns [] when jobs dir does not exist', () => {
    expect(listJobShorts('/tmp/definitely-not-a-dir-xyz-12345')).toEqual([]);
  });
});

describe('readAllJobStates', () => {
  test('parses all fixtures, drops malformed ones silently', () => {
    const envs = readAllJobStates(FIX);
    // 15 个 happy + 1 个 neg-unknown-state(unknown state 是 valid shape)
    // = 16 个 envelope;neg-bad-json + neg-wrong-shape 被丢
    expect(envs.length).toBe(16);
    const states = envs.map(e => e.state.state).sort();
    expect(states).toContain('blocked');
    expect(states).toContain('running');
    expect(states).toContain('working');
    expect(states.filter(s => s === 'done').length).toBe(10);
    expect(states.filter(s => s === 'stopped').length).toBe(2);
  });
});

describe('jobStateToSession mapping', () => {
  function makeEnv(stateOverride: any): any {
    return {
      short: 'abcdef12',
      path: '/x',
      mtimeMs: 1234,
      readAt: 5678,
      state: {
        state: 'running',
        detail: null, needs: null, inFlight: null,
        linkScanPath: null, linkScanOffset: 0,
        name: 'test session', nameSource: 'auto',
        intent: 'do something', resumeSessionId: 'abcdef12-1234-1234-1234-123456789012',
        daemonShort: 'abcdef12', template: 'bg',
        respawnFlags: [], cliVersion: '2.1.163', cwd: '/tmp/x',
        ...stateOverride,
      },
    };
  }

  test('running → busy', () => {
    const s = jobStateToSession(makeEnv({ state: 'running' }));
    expect(s!.status).toBe('busy');
    expect(s!.completed).toBeUndefined();
  });

  test('working → busy', () => {
    expect(jobStateToSession(makeEnv({ state: 'working' }))!.status).toBe('busy');
  });

  test('blocked → waiting + waitingFor = needs', () => {
    const s = jobStateToSession(makeEnv({ state: 'blocked', needs: '是否继续？' }));
    expect(s!.status).toBe('waiting');
    expect(s!.waitingFor).toBe('是否继续？');
  });

  test('done → idle + completed=true', () => {
    const s = jobStateToSession(makeEnv({ state: 'done' }));
    expect(s!.status).toBe('idle');
    expect(s!.completed).toBe(true);
  });

  test('stopped → idle + completed=true (visible in Completed group)', () => {
    const s = jobStateToSession(makeEnv({ state: 'stopped' }));
    expect(s!.status).toBe('idle');
    expect(s!.completed).toBe(true);
    // 名字前缀 🛑 在 card.ts / snapshot-fetcher 渲染时加,这里只确保 mapping 不丢 session
  });

  test('unknown state → unknown', () => {
    const s = jobStateToSession(makeEnv({ state: 'hypothetical_future' }));
    expect(s!.status).toBe('unknown');
  });

  test('passes linkScanPath / detail / intent / cwd / name through', () => {
    const s = jobStateToSession(makeEnv({
      state: 'blocked',
      detail: '当前活动',
      needs: 'continue?',
      linkScanPath: '/abs/path.jsonl',
      intent: '原始命令',
      name: '权威名',
      cwd: '/work/dir',
    }));
    expect(s!.detail).toBe('当前活动');
    expect(s!.linkScanPath).toBe('/abs/path.jsonl');
    expect(s!.intent).toBe('原始命令');
    expect(s!.name).toBe('权威名');
    expect(s!.cwd).toBe('/work/dir');
  });

  test('falls back to short for name when state.json.name is null', () => {
    const s = jobStateToSession(makeEnv({ state: 'done', name: null }));
    expect(s!.name).toBe('abcdef12');
  });
});
