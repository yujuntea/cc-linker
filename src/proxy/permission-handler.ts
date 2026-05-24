import { logger } from '../utils/logger';

export interface PermissionPrompt {
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions: Array<{ destination: string; rule: string }>;
  index: number;
  isResolved: boolean;
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface PermissionHandlerConfig {
  allowedTools: string[];
  disallowedTools: string[];
  timeoutMs?: number;
}

export class PermissionHandler {
  private pendingPrompts = new Map<number, PermissionPrompt>();
  private resolveFns = new Map<number, (result: PermissionResult) => void>();
  private nextIndex = 0;
  private readonly allowedTools: Set<string>;
  private readonly disallowedTools: Set<string>;
  private readonly timeoutMs: number;

  onPermissionRequest: (prompt: PermissionPrompt) => void = () => {};

  constructor(config: PermissionHandlerConfig) {
    this.allowedTools = new Set(config.allowedTools);
    this.disallowedTools = new Set(config.disallowedTools);
    this.timeoutMs = config.timeoutMs ?? 600_000;
  }

  async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<PermissionResult> {
    // Auto-approve AskUserQuestion (clarifying questions)
    if (toolName === 'AskUserQuestion') {
      return { behavior: 'allow', updatedInput: input };
    }

    // Auto-approve explicitly allowed tools
    if (this.allowedTools.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // Deny explicitly disallowed tools
    if (this.disallowedTools.has(toolName)) {
      return { behavior: 'deny', message: `工具 ${toolName} 已被拒绝` };
    }

    // Request user permission
    const index = this.nextIndex++;
    const prompt: PermissionPrompt = {
      toolName,
      toolInput: input,
      suggestions: [],
      index,
      isResolved: false,
    };

    this.pendingPrompts.set(index, prompt);

    const result = new Promise<PermissionResult>((resolve) => {
      this.resolveFns.set(index, resolve);

      // Timeout: auto-deny after timeoutMs
      const timer = setTimeout(() => {
        if (!prompt.isResolved) {
          logger.warn(`Permission prompt #${index} (${toolName}) timed out after ${this.timeoutMs}ms, auto-denying`);
          prompt.isResolved = true;
          this.resolveFns.delete(index);
          resolve({ behavior: 'deny', message: '权限确认超时，已自动拒绝' });
        }
      }, this.timeoutMs);

      // Abort signal: deny on abort
      options.signal.addEventListener('abort', () => {
        if (!prompt.isResolved) {
          prompt.isResolved = true;
          this.resolveFns.delete(index);
          clearTimeout(timer);
          resolve({ behavior: 'deny', message: '会话已中止' });
        }
      }, { once: true });
    });

    // Notify external handler (Feishu bot) to show card
    try {
      this.onPermissionRequest(prompt);
    } catch (err) {
      logger.error(`PermissionHandler: onPermissionRequest failed: ${err}`);
      if (!prompt.isResolved) {
        prompt.isResolved = true;
        this.resolveFns.delete(index);
        return { behavior: 'deny', message: '权限通知发送失败' };
      }
    }

    return result;
  }

  /** Called by Feishu bot when user clicks Allow/Deny button */
  resolveUserDecision(index: number, approved: boolean): void {
    const prompt = this.pendingPrompts.get(index);
    const resolve = this.resolveFns.get(index);

    if (!prompt || !resolve) {
      logger.warn(`PermissionHandler: no pending prompt for index ${index}`);
      return;
    }

    if (approved) {
      resolve({ behavior: 'allow', updatedInput: prompt.toolInput });
    } else {
      resolve({ behavior: 'deny', message: '用户在飞书中拒绝了此操作' });
    }

    prompt.isResolved = true;
    this.resolveFns.delete(index);
  }

  /** Get pending permission by index (for card interaction lookup) */
  getPendingPermission(index: number): PermissionPrompt | undefined {
    return this.pendingPrompts.get(index);
  }
}
