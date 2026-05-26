import { logger } from '../utils/logger';
import type { StreamChunk } from './stream-parser';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface PermissionRequestChunk {
  type: 'permission_request';
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions: Array<{ destination: string; rule: string }>;
}

export type SDKStreamChunk = StreamChunk | PermissionRequestChunk;

export class StreamAdapter {
  adapt(
    message: SDKMessage,
    onChunk: (chunk: SDKStreamChunk) => void,
  ): void {
    // SDK system messages (including permission_denied notifications) are handled
    // internally by the canUseTool callback and do not need to be forwarded.
    if (message.type === 'system') return;
    if (message.type === 'assistant') return;

    if (message.type === 'stream_event') {
      const event = message.event;
      if (!event) return;

      if (event.type === 'content_block_delta') {
        const delta = event.delta as any;
        if (!delta) return;

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          onChunk({ type: 'text', content: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          onChunk({ type: 'thinking', content: delta.thinking });
        }
      }
      return;
    }

    if (message.type === 'result') {
      const msg = message as any;
      onChunk({
        type: 'result',
        result: msg.result ?? '',
        session_id: msg.session_id ?? '',
        total_cost_usd: msg.total_cost_usd ?? 0,
        duration_ms: msg.duration_ms ?? 0,
        stop_reason: msg.stop_reason ?? null,
        subtype: msg.subtype,
        is_error: msg.is_error,
        errors: msg.errors,
        usage: msg.usage,
      });
      return;
    }

    logger.debug(`StreamAdapter: unknown message type: ${(message as any).type}`);
  }
}
