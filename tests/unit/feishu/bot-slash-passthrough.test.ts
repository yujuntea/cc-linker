import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import type { SpoolMessage } from '../../../src/queue/spool';
import type { TargetSnapshot } from '../../../src/queue/spool';
import type { SessionEntry } from '../../../src/registry/types';

/**
 * Build a minimal SpoolMessage that the dispatch pipeline can process.
 * Pass an explicit target so we exercise the session-case path when needed.
 */
function buildMsg(
  text: string,
  openId: string,
  messageId: string,
  target: TargetSnapshot,
): SpoolMessage {
  return {
    messageId,
    openId,
    text,
    serialKey: `cmd:${openId}:${messageId}`,
    target,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function noTarget(openId: string): TargetSnapshot {
  return { type: 'no_target', openId, mappingVersion: 0 };
}

function sessionTarget(openId: string, uuid: string, cwd: string): TargetSnapshot {
  return {
    type: 'session',
    sessionUuid: uuid,
    cwd,
    openId,
    mappingVersion: 0,
  };
}

describe('FeishuBot slash command passthrough (v2.5)', () => {
  let env: TestBot;

  beforeEach(() => {
    env = createTestBot({ tmpDirPrefix: 'bot-slash-passthrough-' });
  });

  afterEach(() => {
    env.cleanup();
  });

  // ─── Test 1: /init not in cc-linker command list → fallthrough ───
  test('T1: /init falls through to handleChat (no 未知命令 reply)', async () => {
    // No user-mapping entry → target is no_target → handleChat case 'no_target'
    await env.bot.handleCommand(buildMsg('/init', 'ou_t1', 'msg_t1', noTarget('ou_t1')));

    // Spec §6.1 #1: default 分支不返回 "未知命令"; handleChat no_target 提示
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
    // And the no_target prompt mentions /new
    const hasNewPrompt = env.textReplies.some(r => r.includes('/new'));
    expect(hasNewPrompt).toBe(true);
  });

  // ─── Test 2: /review pr diff reaches handleChat with full text ───
  test('T2: /review pr diff reaches handleChat session case; full text preserved', async () => {
    // Mock sendSDKMessage to capture the prompt text without spawning real claude
    const captured: { text?: string; sessionId?: string | null } = {};
    const sm = new ClaudeSessionManager();
    sm.sendSDKMessage = (async (sessionId: string | null, text: string, ..._rest: any[]) => {
      captured.sessionId = sessionId;
      captured.text = text;
      return {
        result: { response: 'mocked', costUsd: 0, durationMs: 0, sessionId: sessionId ?? '', jsonlPath: null, sessionStatus: 'active' as const },
        handler: {} as any,
      };
    }) as any;

    env.cleanup();
    env = createTestBot({ tmpDirPrefix: 'bot-slash-passthrough-t2-', sessionManager: sm });

    // Set up session in registry + user-mapping so handleChat enters session case
    const sessionUuid = '11111111-1111-1111-1111-111111111111';
    env.registry.upsert(sessionUuid, {
      cwd: '/tmp', project_name: 'test', title: 't2',
      message_count: 0, created_at: new Date().toISOString(),
      last_active: new Date().toISOString(), status: 'active',
      jsonl_path: null,
    } as Partial<SessionEntry> as any);
    await env.userManager.compareAndSwap('ou_t2', null, {
      type: 'session', sessionUuid, cwd: '/tmp',
    });

    await env.bot.handleCommand(
      buildMsg('/review pr diff', 'ou_t2', 'msg_t2', sessionTarget('ou_t2', sessionUuid, '/tmp')),
    );

    // Spec §6.1 #2: handleChat 收到完整文本 `/review pr diff`（含前导斜杠）
    expect(captured.text).toBe('/review pr diff');
    expect(captured.sessionId).toBe(sessionUuid);
  });

  // ─── Test 3: /clear falls through ───
  test('T3: /clear falls through to handleChat (no 未知命令 reply)', async () => {
    await env.bot.handleCommand(buildMsg('/clear', 'ou_t3', 'msg_t3', noTarget('ou_t3')));
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 4: //help double-slash → cmd='help' → cc-linker matches ───
  test('T4: //help is matched by cc-linker (cmd=help after slash strip)', async () => {
    await env.bot.handleCommand(buildMsg('//help', 'ou_t4', 'msg_t4', noTarget('ou_t4')));
    // Should match case 'help' → helpText
    const hasHelpText = env.textReplies.some(r => r.text.includes('可用命令'));
    expect(hasHelpText).toBe(true);
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 5: /HELP uppercase → lowercased → cc-linker matches ───
  test('T5: /HELP is lowercased and matched by cc-linker', async () => {
    await env.bot.handleCommand(buildMsg('/HELP', 'ou_t5', 'msg_t5', noTarget('ou_t5')));
    const hasHelpText = env.textReplies.some(r => r.text.includes('可用命令'));
    expect(hasHelpText).toBe(true);
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 6: no session + /init → no_target prompt ───
  test('T6: no session + /init triggers no_target prompt mentioning /new', async () => {
    await env.bot.handleCommand(buildMsg('/init', 'ou_t6', 'msg_t6', noTarget('ou_t6')));
    const reply = env.textReplies.find(r => r.text.includes('/new'));
    expect(reply).toBeDefined();
    // Same prompt as chat text would produce
    expect(reply!.text).toContain('/list');
    expect(reply!.text).toContain('/switch');
  });

  // ─── Test 7: with session + /init → enters session case ───
  test('T7: with session + /init enters handleChat session case', async () => {
    // Mock sendSDKMessage to avoid real claude spawn (test env may lack binary)
    const sm = new ClaudeSessionManager();
    sm.sendSDKMessage = (async (sessionId: string | null, text: string, ..._rest: any[]) => ({
      result: { response: 'mocked', costUsd: 0, durationMs: 0, sessionId: sessionId ?? '', jsonlPath: null, sessionStatus: 'active' as const },
      handler: {} as any,
    })) as any;

    env.cleanup();
    env = createTestBot({ tmpDirPrefix: 'bot-slash-passthrough-t7-', sessionManager: sm });

    const sessionUuid = '22222222-2222-2222-2222-222222222222';
    env.registry.upsert(sessionUuid, {
      cwd: '/tmp', project_name: 'test', title: 't7',
      message_count: 0, created_at: new Date().toISOString(),
      last_active: new Date().toISOString(), status: 'active',
      jsonl_path: null,
    } as Partial<SessionEntry> as any);

    await env.userManager.compareAndSwap('ou_t7', null, {
      type: 'session', sessionUuid, cwd: '/tmp',
    });

    await env.bot.handleCommand(
      buildMsg('/init', 'ou_t7', 'msg_t7', sessionTarget('ou_t7', sessionUuid, '/tmp')),
    );

    // Spec §6.1 #7: case 'session' 路径, busy check / rendezvous probe 启动
    // 断言: handleChat session case 进入 (非 default), 不返回 未知命令
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 8: //foo → cmd='foo' → fallthrough, text is //foo ───
  test('T8: //foo → cmd=foo → fallthrough; no_target path', async () => {
    await env.bot.handleCommand(buildMsg('//foo', 'ou_t8', 'msg_t8', noTarget('ou_t8')));
    // No session → no_target prompt
    const hasNewPrompt = env.textReplies.some(r => r.text.includes('/new'));
    expect(hasNewPrompt).toBe(true);
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 9: /cancel in Agent View expectedReply state ───
  test('T9: /cancel clears expectedReply at entry AND triggers handleChat /cancel branch', async () => {
    const clearCalls: { openId: string; reason: string }[] = [];
    const cancelCalls: string[] = [];
    const mockAgentView = {
      deps: {} as any,
      handleCancelReply: async (openId: string) => { cancelCalls.push(openId); },
      expectedReply: {
        get: () => ({ sessionUuid: 'x', cwd: '/tmp', prompt: 'test' }),
        clear: async (openId: string, reason: string) => {
          clearCalls.push({ openId, reason });
          return true;
        },
      },
    };
    env.bot.setAgentView(mockAgentView as any);

    await env.bot.handleCommand(buildMsg('/cancel', 'ou_t9', 'msg_t9', noTarget('ou_t9')));

    // Spec §6.1 #9 + §6.2 /cancel 等待中 行:
    // 1. 入口 expectedReply.clear called with reason='overwrite'
    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0].reason).toBe('overwrite');
    // 2. handleChat /cancel branch → handleCancelReply called
    expect(cancelCalls).toEqual(['ou_t9']);
    // 3. No 未知命令 reply (was the old broken behavior)
    const hasUnknown = env.textReplies.some(r => r.text.includes('未知命令'));
    expect(hasUnknown).toBe(false);
  });

  // ─── Test 10: recursion guard (handleCommand called once, not twice) ───
  test('T10: no infinite recursion — handleCommand called exactly once per /xxx', async () => {
    // Spy by replacing handleCommand with a wrapper that counts calls
    const origHandleCommand = env.bot.handleCommand.bind(env.bot);
    let callCount = 0;
    (env.bot as any).handleCommand = async (msg: SpoolMessage) => {
      callCount++;
      return origHandleCommand(msg);
    };

    await env.bot.handleCommand(buildMsg('/init', 'ou_t10', 'msg_t10', noTarget('ou_t10')));

    expect(callCount).toBe(1);
  });

  // ─── Test 11: expectedReply cleared on /xxx (write command) ───
  test('T11: /xxx in expectedReply state triggers entry clear + 等待输入已自动取消 reply', async () => {
    const clearCalls: { openId: string; reason: string }[] = [];
    const mockAgentView = {
      deps: {} as any,
      handleCancelReply: async () => {},
      expectedReply: {
        get: (openId: string) => ({ sessionUuid: 's', cwd: '/tmp', prompt: 'p' }),
        clear: async (openId: string, reason: string) => {
          clearCalls.push({ openId, reason });
          return true;
        },
      },
    };
    env.bot.setAgentView(mockAgentView as any);

    await env.bot.handleCommand(buildMsg('/init', 'ou_t11', 'msg_t11', noTarget('ou_t11')));

    // /init is not in [help, status, whoami], so entry should attempt clear
    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0].reason).toBe('overwrite');
    // And the entry reply mentions "已自动取消"
    const hasCancelReply = env.textReplies.some(r => r.text.includes('等待输入已自动取消'));
    expect(hasCancelReply).toBe(true);
  });

  // ─── Test 12: serialKey preserved as cmd:openId:messageId ───
  test('T12: /xxx uses serialKey=cmd:openId:messageId (independent lock)', async () => {
    const msg = buildMsg('/init', 'ou_t12', 'msg_t12', noTarget('ou_t12'));
    expect(msg.serialKey).toBe('cmd:ou_t12:msg_t12');

    await env.bot.handleCommand(msg);
    // No assertion on internal lock — just that the message is processed without error
    // and the serialKey was preserved through fallthrough (no mutation)
    expect(msg.serialKey).toBe('cmd:ou_t12:msg_t12');
  });
});
