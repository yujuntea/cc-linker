import { describe, test, expect } from 'bun:test';
import { PermissionHandler } from '../../../src/proxy/permission-handler';

describe('PermissionHandler', () => {
  test('auto-approves allowed tools', async () => {
    const handler = new PermissionHandler({ allowedTools: ['Read', 'Grep'] });
    const prompts: any[] = [];
    handler.onPermissionRequest = (p) => prompts.push(p);

    const result = await handler.canUseTool('Read', { file_path: '/tmp/test' }, {
      signal: new AbortController().signal,
    });

    expect(result.behavior).toBe('allow');
    expect(prompts).toEqual([]);
  });

  test('requests permission for non-allowed tools', async () => {
    const handler = new PermissionHandler({ allowedTools: ['Read'] });
    handler.onPermissionRequest = () => {};

    const resultPromise = handler.canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
    });

    // Handler should be waiting (not yet resolved)
    const pending = handler.getPendingPermission(0);
    expect(pending).not.toBeNull();
    expect(pending!.toolName).toBe('Bash');

    // Trigger resolution
    handler.resolveUserDecision(0, true);
    const result = await resultPromise;
    expect(result.behavior).toBe('allow');
  });

  test('denies when user rejects', async () => {
    const handler = new PermissionHandler({ allowedTools: [] });
    handler.onPermissionRequest = () => {};

    const resultPromise = handler.canUseTool('Bash', { command: 'rm -rf /' }, {
      signal: new AbortController().signal,
    });

    handler.resolveUserDecision(0, false);
    const result = await resultPromise;
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('用户在飞书中拒绝了此操作');
  });

  test('handles AskUserQuestion by auto-approving', async () => {
    const handler = new PermissionHandler({ allowedTools: [] });
    handler.onPermissionRequest = () => {};

    const questions = [
      { question: 'How?', header: 'Method', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
    ];

    // AskUserQuestion should be auto-approved immediately, no pending entry
    const resultPromise = handler.canUseTool('AskUserQuestion', { questions }, {
      signal: new AbortController().signal,
    });

    const result = await resultPromise;
    expect(result.behavior).toBe('allow');
  });

  test('respects disallowed tools', async () => {
    const handler = new PermissionHandler({
      allowedTools: ['Read'],
      disallowedTools: ['WebFetch'],
    });

    const result = await handler.canUseTool('WebFetch', { url: 'https://evil.com' }, {
      signal: new AbortController().signal,
    });

    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('拒绝');
  });

  test('cleanPending removes resolved entries', async () => {
    const handler = new PermissionHandler({ allowedTools: [] });
    handler.onPermissionRequest = () => {};

    handler.canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
    });

    expect(handler.getPendingPermission(0)).not.toBeNull();
    expect(handler.getUnresolvedCount()).toBe(1);

    handler.resolveUserDecision(0, true);

    // After resolution, entry is cleaned up
    const pending = handler.getPendingPermission(0);
    expect(pending).toBeUndefined();
    expect(handler.getUnresolvedCount()).toBe(0);
  });
});
