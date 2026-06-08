// tests/unit/agent-view/attached-card-watcher.test.ts
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
 AttachedCardWatcher,
 AttachedWatchers,
 DEFAULT_ATTACHED_WATCH_CONFIG,
} from '../../../src/agent-view/attached-card-watcher';

describe('DEFAULT_ATTACHED_WATCH_CONFIG', () => {
 test('default values match spec', () => {
 expect(DEFAULT_ATTACHED_WATCH_CONFIG.intervalMs).toBe(10_000);
 expect(DEFAULT_ATTACHED_WATCH_CONFIG.maxTicks).toBe(800);
 expect(DEFAULT_ATTACHED_WATCH_CONFIG.maxPatchFailures).toBe(3);
 });
});

describe('AttachedCardWatcher lifecycle', () => {
 let patchFn: ReturnType<typeof mock>;
 let onStop: ReturnType<typeof mock>;
 let resolveContent: ReturnType<typeof mock>;

 beforeEach(() => {
 patchFn = mock(async () => ({}));
 onStop = mock();
 resolveContent = mock(async () => ({ text: 'output', format: 'markdown' as const }));
 });

 afterEach(() => {
 // noop
 });

 test('start() initiates setInterval; stop() clears it', () => {
 const watcher = new AttachedCardWatcher({
 openId: 'ou_test',
 sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
 shortId: 'abc12345',
 name: 'test',
 cwd: '/tmp',
 cardMessageId: 'om_test',
 patchFn,
 config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs:50 },
 resolveContent,
 onStop,
 });
 watcher.start();
 expect(onStop).not.toHaveBeenCalled();
 watcher.stop('test');
 expect(onStop).toHaveBeenCalledWith('ou_test', 'test', watcher);
 });

 test('stop() is idempotent', () => {
 const watcher = new AttachedCardWatcher({
 openId: 'ou_test',
 sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
 shortId: 'abc12345',
 name: 'test',
 cwd: '/tmp',
 cardMessageId: 'om_test',
 patchFn,
 config: { ...DEFAULT_ATTACHED_WATCH_CONFIG, intervalMs:50 },
 resolveContent,
 onStop,
 });
 watcher.start();
 watcher.stop('first');
 watcher.stop('second');
 // onStop 只调一次
 expect(onStop).toHaveBeenCalledTimes(1);
 });
});
