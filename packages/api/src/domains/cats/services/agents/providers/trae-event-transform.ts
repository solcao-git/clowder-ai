/**
 * Trae CLI Event Transformer
 * Trae CLI stream-json NDJSON → Clowder AI AgentMessage 映射
 *
 * Trae `trae-cli -p "prompt" --output-format stream-json` 事件格式:
 *   system/init       → session_init (session_id, tools, model, permission_mode)
 *   system/status     → 内部状态更新 (跳过)
 *   user              → 用户消息 (跳过)
 *   assistant         → text (content) + tool_use (tool_calls)
 *   user/tool_result  → tool_result (tool_use_id, content)
 *   result/success    → done (usage, duration_ms)
 *   result/error      → error
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata, TokenUsage } from '../../types.js';

export interface TraeTransformState {
  sessionId: string | null;
  model: string | null;
  emittedDone: boolean;
  usage: TokenUsage | null;
  /** Track in-flight tool calls for tool_use → tool_result pairing */
  pendingToolCalls: Map<string, { name: string; input: string }>;
}

export function createTraeTransformState(): TraeTransformState {
  return {
    sessionId: null,
    model: null,
    emittedDone: false,
    usage: null,
    pendingToolCalls: new Map(),
  };
}

/**
 * Transform a raw Trae CLI stream-json event into AgentMessage(s).
 * Returns null for events that should be silently consumed (system/status, user input).
 * Returns an array for events that produce multiple AgentMessages (e.g., text + tool_use).
 */
export function transformTraeEvent(
  event: unknown,
  catId: CatId,
  metadata: MessageMetadata,
  state: TraeTransformState,
): AgentMessage | AgentMessage[] | null {
  if (typeof event !== 'object' || event === null) return null;

  const e = event as Record<string, unknown>;
  const type = e.type as string | undefined;
  const ts = Date.now();

  // system/init → session_init
  if (type === 'system') {
    const subtype = e.subtype as string | undefined;
    if (subtype === 'init') {
      const sessionId = e.session_id as string | undefined;
      if (sessionId) {
        state.sessionId = sessionId;
        metadata.sessionId = sessionId;
      }
      const model = e.model as string | undefined;
      if (model) state.model = model;
      return {
        type: 'session_init',
        catId,
        sessionId: sessionId ?? undefined,
        ephemeralSession: false,
        metadata,
        timestamp: ts,
      };
    }
    // system/status → skip (internal state updates, not user-visible)
    return null;
  }

  // user messages → skip (we already have the prompt)
  if (type === 'user') {
    // user/tool_result → tool_result
    const subtype = e.subtype as string | undefined;
    if (subtype === 'tool_result') {
      const toolUseId = e.tool_use_id as string | undefined;
      const toolName = e.tool_name as string | undefined;
      const content = e.content as Record<string, unknown> | undefined;
      // Extract text from content
      let resultText = '';
      if (typeof content === 'object' && content !== null) {
        const contentArr = content.content as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(contentArr)) {
          resultText = contentArr
            .filter((c) => c.type === 'text')
            .map((c) => c.text as string)
            .join('\n');
        } else if (typeof content.content === 'string') {
          resultText = content.content;
        }
      }
      if (toolUseId) {
        state.pendingToolCalls.delete(toolUseId);
      }
      return {
        type: 'tool_result',
        catId,
        toolUseId: toolUseId ?? '',
        toolName: toolName ?? '',
        content: resultText,
        metadata,
        timestamp: ts,
      };
    }
    return null;
  }

  // assistant → text + tool_use
  if (type === 'assistant') {
    const message = e.message as Record<string, unknown> | undefined;
    if (!message) return null;

    const results: AgentMessage[] = [];

    // Extract text content
    const content = message.content as string | undefined;
    if (typeof content === 'string' && content.trim()) {
      results.push({
        type: 'text',
        catId,
        content,
        metadata,
        timestamp: ts,
      });
    }

    // Extract tool calls
    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const tcId = tc.id as string | undefined;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (!fn) continue;
        const toolName = fn.name as string | undefined;
        const toolInput = fn.arguments as string | undefined;
        if (tcId && toolName) {
          state.pendingToolCalls.set(tcId, { name: toolName, input: toolInput ?? '{}' });
          results.push({
            type: 'tool_use',
            catId,
            toolUseId: tcId,
            toolName,
            content: toolInput ?? '{}',
            metadata,
            timestamp: ts,
          });
        }
      }
    }

    // Extract usage from response_meta if present
    const responseMeta = message.response_meta as Record<string, unknown> | undefined;
    if (responseMeta) {
      const rawUsage = responseMeta.usage as Record<string, unknown> | undefined;
      if (rawUsage) {
        const usage: TokenUsage = {};
        if (typeof rawUsage.prompt_tokens === 'number') usage.inputTokens = rawUsage.prompt_tokens;
        if (typeof rawUsage.completion_tokens === 'number') usage.outputTokens = rawUsage.completion_tokens;
        // cached_tokens may be at top-level or nested in prompt_token_details
        const rawCached = rawUsage.cached_tokens ?? (rawUsage.prompt_token_details as Record<string, unknown> | undefined)?.cached_tokens;
        if (typeof rawCached === 'number') usage.cacheReadTokens = rawCached;
        state.usage = usage;
      }
    }

    return results.length > 0 ? results : null;
  }

  // result/success → done
  if (type === 'result') {
    const subtype = e.subtype as string | undefined;
    state.emittedDone = true;

    // Extract usage from result event
    const rawUsage = e.usage as Record<string, unknown> | undefined;
    const usage: TokenUsage = { ...(state.usage ?? {}) };
    if (rawUsage) {
      if (typeof rawUsage.input_tokens === 'number') usage.inputTokens = rawUsage.input_tokens;
      if (typeof rawUsage.output_tokens === 'number') usage.outputTokens = rawUsage.output_tokens;
      if (typeof rawUsage.cache_read_input_tokens === 'number') usage.cacheReadTokens = rawUsage.cache_read_input_tokens;
    }
    state.usage = usage;

    if (subtype === 'error') {
      const errorMsg = e.error as string | undefined ?? e.message as string | undefined ?? 'Unknown Trae CLI error';
      return {
        type: 'error',
        catId,
        error: errorMsg,
        metadata: { ...metadata, usage: Object.keys(usage).length > 0 ? usage : undefined },
        timestamp: ts,
      };
    }

    // result/success → done
    return {
      type: 'done',
      catId,
      metadata: { ...metadata, usage: Object.keys(usage).length > 0 ? usage : undefined },
      timestamp: ts,
    };
  }

  return null;
}
