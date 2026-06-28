/**
 * Qoder CLI Event Transformer
 * Qoder stream-json NDJSON → Clowder AI AgentMessage 映射
 *
 * Qoder `qodercli -p "prompt" -f stream-json` 事件格式:
 *   system/init      → session_init (tools, provider, model, session_id)
 *   assistant/message → text (content[].type:"text") + thinking (content[].type:"reasoning")
 *   result/success   → done (dedup: Qoder emits this twice)
 *   result/error     → error
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata, TokenUsage } from '../../types.js';

interface QoderEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  done?: boolean;
  // system/init fields
  tools?: string[];
  provider?: string;
  permission_mode?: string;
  working_dir?: string;
  model?: string;
  // assistant/message fields
  message?: {
    id?: string;
    role?: string;
    session_id?: string;
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      reason?: string;
      time?: number;
      [key: string]: unknown;
    }>;
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_tokens?: number;
      cache_read_tokens?: number;
    };
    provider?: string;
    agent_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function isQoderEvent(event: unknown): event is QoderEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return typeof e.type === 'string';
}

/**
 * Transform a Qoder CLI stream-json event into an AgentMessage.
 * Returns null for events that should be skipped.
 *
 * @param event Raw NDJSON event from Qoder CLI stdout
 * @param catId The cat ID this invocation belongs to
 * @param state Mutable state tracker for dedup (caller must persist across events)
 */
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
      // Other system subtypes → skip
      return null;
    }

    case 'assistant': {
      if (event.subtype !== 'message') return null;
      const msg = event.message;
      if (!msg?.content || !Array.isArray(msg.content)) return null;

      // Dedup: Qoder CLI re-emits the same assistant/message (same msg.id) with
      // different statuses each time the model calls a tool:
      //   1. status=finished   — the canonical complete message (always first)
      //   2. status=tool_calling — re-emitted per tool invocation (duplicate)
      // Skip tool_calling re-emissions to prevent repeated paragraphs.
      // We prefer status=finished because it's the authoritative version; if the
      // Qoder CLI ever changes emission order (tool_calling before finished), this
      // guard still works correctly.
      if (msg.status === 'tool_calling' && msg.id && state.seenMessageIds.has(msg.id)) {
        return null;
      }
      if (msg.id) {
        state.seenMessageIds.add(msg.id);
      }

      // Extract usage if present
      if (msg.usage) {
        state.usage = {
          inputTokens: msg.usage.input_tokens ?? 0,
          outputTokens: msg.usage.output_tokens ?? 0,
          cacheReadTokens: msg.usage.cache_read_tokens ?? 0,
          cacheCreationTokens: msg.usage.cache_creation_tokens ?? 0,
        };
      }

      // Process content blocks — emit thinking first, then text
      const results: AgentMessage[] = [];

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
        // block.type === 'finish' → skip (metadata only)
      }

      // Return first result; stash rest for caller to drain
      if (results.length === 0) return null;
      if (results.length === 1) return results[0];
      // Multiple results: stash extras, return first
      state.pendingMessages.push(...results.slice(1));
      return results[0];
    }

    case 'result': {
      if (event.subtype === 'success') {
        // Qoder emits result/success TWICE — deduplicate
        if (state.emittedDone) return null;
        state.emittedDone = true;

        const finalText =
          event.message?.content?.find((c: { type: string }) => c.type === 'text')?.text ?? undefined;

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
        const errorMsg =
          (event.message?.content?.find((c: { type: string }) => c.type === 'text')?.text as string) ??
          'Qoder CLI error';
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

/** Mutable state for the Qoder event transformer — caller creates one per invocation. */
export interface QoderTransformState {
  sessionId?: string;
  model?: string;
  usage?: TokenUsage;
  emittedDone: boolean;
  /** Overflow messages from multi-block assistant events. Caller drains after each transform call. */
  pendingMessages: AgentMessage[];
  /** Dedup: message IDs already emitted — Qoder re-emits assistant/message with the
   * same msg.id on each status change (finished → tool_calling), causing text duplication. */
  seenMessageIds: Set<string>;
}

export function createQoderTransformState(): QoderTransformState {
  return { emittedDone: false, pendingMessages: [], seenMessageIds: new Set() };
}
