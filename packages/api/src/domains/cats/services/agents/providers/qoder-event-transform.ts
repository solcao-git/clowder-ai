/**
 * Qoder CLI Event Transformer
 * Qoder stream-json NDJSON -> Clowder AI AgentMessage mapping
 *
 * Supports both legacy (v1.6.0-quest) and modern (v1.0.40+) event formats.
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata, TokenUsage } from '../../types.js';

interface QoderContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  reason?: string;
  time?: number;
  citations?: unknown;
  [key: string]: unknown;
}

interface QoderMessage {
  id?: string;
  role?: string;
  session_id?: string;
  type?: string;
  model?: string;
  stop_reason?: string;
  content?: QoderContentBlock[];
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    [key: string]: unknown;
  };
  provider?: string;
  agent_id?: string;
  parent_id?: string;
  [key: string]: unknown;
}

interface QoderEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  done?: boolean;
  uuid?: string;
  tools?: string[];
  provider?: string;
  permission_mode?: string;
  working_dir?: string;
  model?: string;
  qodercli_version?: string;
  protocol_version?: string;
  message?: QoderMessage;
  parent_tool_use_id?: string;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  stop_reason?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    [key: string]: unknown;
  };
  modelUsage?: Record<string, unknown>;
  error?: string | Record<string, unknown>;
  error_code?: number;
  [key: string]: unknown;
}

function isQoderEvent(event: unknown): event is QoderEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return typeof e.type === 'string';
}

export function transformQoderEvent(
  event: unknown,
  catId: CatId | string,
  state: QoderTransformState,
): AgentMessage | null {
  if (!isQoderEvent(event)) return null;

  const ts = Date.now();

  switch (event.type) {
    case 'system': {
      if (event.subtype === 'init') {
        state.sessionId = event.session_id;
        state.model = event.model ?? 'Auto';
        state.qoderVersion = event.qodercli_version;
        return {
          type: 'session_init',
          catId: catId as CatId,
          sessionId: event.session_id,
          timestamp: ts,
          metadata: {
            provider: 'qoder',
            model: state.model,
          },
        };
      }
      return null;
    }

    case 'assistant': {
      const msg = event.message;
      if (!msg) return null;

      const isModernFormat = !event.subtype && msg.id?.startsWith('chatcmpl-');
      const isLegacyFormat = event.subtype === 'message' || (!isModernFormat && msg.content);

      if (!isModernFormat && !isLegacyFormat) return null;

      if (msg.status === 'tool_calling' && msg.id && state.seenMessageIds.has(msg.id)) {
        return null;
      }
      if (msg.id) {
        state.seenMessageIds.add(msg.id);
      }

      if (msg.usage) {
        state.usage = {
          inputTokens: msg.usage.input_tokens ?? 0,
          outputTokens: msg.usage.output_tokens ?? 0,
          cacheReadTokens: (msg.usage.cache_read_input_tokens ?? msg.usage.cache_read_tokens ?? 0) as number,
          cacheCreationTokens: (msg.usage.cache_creation_input_tokens ?? msg.usage.cache_creation_tokens ?? 0) as number,
        };
      }

      if (msg.stop_reason === 'error') {
        const errorBlock = msg.content?.find((b) => b.type === 'text');
        const errorText = errorBlock?.text ?? 'Qoder CLI error';
        return {
          type: 'error',
          catId: catId as CatId,
          error: errorText,
          timestamp: ts,
        };
      }

      const results: AgentMessage[] = [];

      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'reasoning' && (block.thinking || block.text)) {
            results.push({
              type: 'system_info',
              catId: catId as CatId,
              content: JSON.stringify({ type: 'thinking', text: block.thinking ?? block.text ?? '' }),
              timestamp: ts,
            });
          } else if (block.type === 'text' && block.text) {
            results.push({
              type: 'text',
              catId: catId as CatId,
              content: block.text,
              timestamp: ts,
            });
          }
        }
      }

      if (results.length === 0) return null;
      if (results.length === 1) return results[0];
      state.pendingMessages.push(...results.slice(1));
      return results[0];
    }

    case 'result': {
      if (event.subtype === 'success') {
        if (state.emittedDone) return null;
        state.emittedDone = true;

        let finalText: string | undefined;
        if (typeof event.result === 'string') {
          finalText = event.result;
        } else if (event.message?.content) {
          finalText = event.message.content.find((c) => c.type === 'text')?.text;
        }

        if (event.usage) {
          state.usage = {
            inputTokens: event.usage.input_tokens ?? 0,
            outputTokens: event.usage.output_tokens ?? 0,
            cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: event.usage.cache_creation_input_tokens ?? 0,
          };
        }

        return {
          type: 'done',
          catId: catId as CatId,
          content: finalText,
          timestamp: ts,
          metadata: {
            provider: 'qoder',
            model: state.model ?? 'Auto',
            sessionId: state.sessionId,
            usage: state.usage,
          },
        };
      }
      if (event.subtype === 'error') {
        let errorMsg = 'Qoder CLI error';
        if (typeof event.error === 'string') {
          errorMsg = event.error;
        } else if (event.message?.content) {
          errorMsg = (event.message.content.find((c) => c.type === 'text')?.text as string) ?? errorMsg;
        }
        return {
          type: 'error',
          catId: catId as CatId,
          error: errorMsg,
          timestamp: ts,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

export interface QoderTransformState {
  sessionId?: string;
  model?: string;
  qoderVersion?: string;
  usage?: TokenUsage;
  emittedDone: boolean;
  pendingMessages: AgentMessage[];
  seenMessageIds: Set<string>;
}

export function createQoderTransformState(): QoderTransformState {
  return { emittedDone: false, pendingMessages: [], seenMessageIds: new Set() };
}
