import { logger } from '../utils/logger';

export type StreamChunkType = 'thinking' | 'text' | 'tool_use' | 'result';

export interface ThinkingChunk {
  type: 'thinking';
  content: string;
}

export interface TextChunk {
  type: 'text';
  content: string;
}

/**
 * PR 6.21: tool_use chunk — Claude 工具调用块
 * name = 工具名 (Bash/Read/Grep/Write 等), input = 工具入参 (object)
 * 上层 (appendChunk) 累积成 toolUses 数组传给 stream-updater.renderMarkdown "当前操作：" 段
 */
export interface ToolUseChunk {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ResultChunk {
  type: 'result';
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  stop_reason: string | null;
  subtype?: string;
  is_error?: boolean;
  errors?: string[];
  usage?: TokenUsage;
}

export type StreamChunk = ThinkingChunk | TextChunk | ToolUseChunk | ResultChunk;

export class StreamParser {
  /**
   * PR 6.22: 返回 StreamChunk[] (数组) 而非单 chunk.
   * 历史: 旧版返回单 chunk, 但 Claude extended thinking 模式下 message.content
   *   经常含 [thinking, tool_use, text] 多个 block, 旧版 for-loop return 只 emit
   *   第一个 block, 后续 tool_use + text 都丢失, 用户看不到工具调用.
   * 修法: parseLine 返回数组, 一次 JSON line emit 0/1/N 个 chunks.
   *   caller (session.ts) 用 for-of 循环派发每个 chunk.
   *
   * result 类型始终单 chunk (一个 JSON line 就一个 result).
   */
  parseLine(line: string): StreamChunk[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      logger.debug(`StreamParser: invalid JSON: ${trimmed.slice(0, 100)}`);
      return [];
    }

    const type = obj.type as string | undefined;
    if (type === 'system') return [];
    if (type === 'user') return [];  // tool_result 等用户侧事件忽略
    if (type === 'assistant') return this.parseAssistant(obj);  // PR 6.22: 多 block emit
    if (type === 'result') {
      const result = this.parseResult(obj);
      return [result];
    }

    logger.debug(`StreamParser: unknown type: ${type}`);
    return [];
  }

  private parseAssistant(obj: Record<string, unknown>): StreamChunk[] {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content?.length) return [];

    const chunks: StreamChunk[] = [];
    for (const block of content) {
      const blockType = block.type as string | undefined;
      if (blockType === 'thinking' && typeof block.thinking === 'string') {
        chunks.push({ type: 'thinking', content: block.thinking });
      } else if (blockType === 'text' && typeof block.text === 'string') {
        chunks.push({ type: 'text', content: block.text });
      } else if (blockType === 'tool_use' && typeof block.name === 'string') {
        chunks.push({
          type: 'tool_use',
          id: typeof block.id === 'string' ? block.id : '',
          name: block.name,
          input: (block.input && typeof block.input === 'object') ? block.input as Record<string, unknown> : {},
        });
      }
      // 未知 block type (e.g. tool_result 在 user 类型里) 跳过
    }
    return chunks;
  }

  private parseResult(obj: Record<string, unknown>): ResultChunk {
    return {
      type: 'result',
      result: (obj.result as string) ?? '',
      session_id: (obj.session_id as string) ?? '',
      total_cost_usd: (obj.total_cost_usd as number) ?? 0,
      duration_ms: (obj.duration_ms as number) ?? 0,
      stop_reason: (obj.stop_reason as string | null) ?? null,
      subtype: obj.subtype as string | undefined,
      is_error: obj.is_error as boolean | undefined,
      errors: obj.errors as string[] | undefined,
      usage: obj.usage as TokenUsage | undefined,
    };
  }
}
