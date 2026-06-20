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
  parseLine(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      logger.debug(`StreamParser: invalid JSON: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const type = obj.type as string | undefined;
    if (type === 'system') return null;
    if (type === 'user') return null;  // PR 6.21: tool_result 等用户侧事件忽略
    if (type === 'assistant') return this.parseAssistant(obj);
    if (type === 'result') return this.parseResult(obj);

    logger.debug(`StreamParser: unknown type: ${type}`);
    return null;
  }

  private parseAssistant(obj: Record<string, unknown>): StreamChunk | null {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return null;
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content?.length) return null;

    for (const block of content) {
      const blockType = block.type as string | undefined;
      if (blockType === 'thinking' && typeof block.thinking === 'string') {
        return { type: 'thinking', content: block.thinking };
      }
      if (blockType === 'text' && typeof block.text === 'string') {
        return { type: 'text', content: block.text };
      }
      // PR 6.21: tool_use 块单独 emit (跟 thinking/text 不冲突, 一次只 emit 一个 block)
      if (blockType === 'tool_use' && typeof block.name === 'string') {
        return {
          type: 'tool_use',
          id: typeof block.id === 'string' ? block.id : '',
          name: block.name,
          input: (block.input && typeof block.input === 'object') ? block.input as Record<string, unknown> : {},
        };
      }
    }
    return null;
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
