import { describe, it, expect } from 'bun:test';
import { isCommandMessage, parseCommand } from '../../../src/platform/command-handler';

describe('isCommandMessage', () => {
  it('detects /list as command', () => {
    expect(isCommandMessage('/list')).toBe(true);
    expect(isCommandMessage('/switch abc')).toBe(true);
  });

  it('rejects plain text', () => {
    expect(isCommandMessage('hello')).toBe(false);
  });

  it('rejects command with whitespace after slash', () => {
    expect(isCommandMessage('/ list')).toBe(false);
  });

  it('detects agent_view prefixed commands (no whitelist)', () => {
    expect(isCommandMessage('/agent_view_peek')).toBe(true);
    expect(isCommandMessage('/agent_view_reply_request abc')).toBe(true);
  });

  it('detects cc builtin slash passthrough commands', () => {
    expect(isCommandMessage('/init')).toBe(true);
    expect(isCommandMessage('/review')).toBe(true);
    expect(isCommandMessage('/cost')).toBe(true);
  });
});

describe('parseCommand', () => {
  it('parses /list with no args', () => {
    expect(parseCommand('/list')).toEqual({ cmd: 'list', args: [] });
  });

  it('parses /switch with single arg', () => {
    expect(parseCommand('/switch uuid-123')).toEqual({ cmd: 'switch', args: ['uuid-123'] });
  });

  it('parses /bridge (deprecated, parseCommand 不拒绝)', () => {
    // /bridge 已废弃 (历史 cc-connect 命令, 2026-06-20 决定不复活)
    // parseCommand 不做白名单, /bridge 仍能被解析, 下游 executeCommand 负责返回 YAGNI 提示
    expect(parseCommand('/bridge new')).toEqual({ cmd: 'bridge', args: ['new'] });
  });

  it('parses agent_view prefixed command (no rejection)', () => {
    expect(parseCommand('/agent_view_peek abc')).toEqual({ cmd: 'agent_view_peek', args: ['abc'] });
  });

  it('parses cc builtin passthrough command', () => {
    expect(parseCommand('/init')).toEqual({ cmd: 'init', args: [] });
    expect(parseCommand('/review src/foo.ts')).toEqual({ cmd: 'review', args: ['src/foo.ts'] });
  });

  it('returns null for non-command text', () => {
    expect(parseCommand('hello world')).toBeNull();
  });
});