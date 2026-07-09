/**
 * ACP Event Transformer — maps AcpSessionUpdate → AgentMessage(s).
 *
 * Pure event-by-event; per-session state is passed by caller (砚砚 三审
 * watchpoint: no module-level Map). Used by GeminiAcpAdapter to convert
 * ACP protocol events into the unified AgentMessage stream format.
 *
 * F197: Gemini CLI v0.36 packs final state into single `tool_call` event
 * (status=completed/failed + content). To satisfy the UI/ToolEventLog
 * `tool_use → tool_result` pairing model, this transformer splits such
 * single events into [tool_use, tool_result] arrays. State (`emittedToolUseByCallId`)
 * deduplicates tool_use emission per toolCallId — progress updates do NOT
 * re-emit tool_use (KD-5). Final判定仅认 `status ∈ {completed, failed}` (KD-6).
 */

import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { AcpSessionUpdate } from './types.js';

const log = createModuleLogger('acp-event-xform');

/**
 * Per-session state passed by caller. Created via `createAcpSessionState()`.
 * Caller is responsible for lifecycle (one Set per ACP session).
 */
export interface AcpSessionState {
  /** toolCallIds that have already emitted a `tool_use` AgentMessage. */
  emittedToolUseByCallId: Set<string>;
  /** toolCallIds that have already emitted a final `tool_result`. */
  finalEmittedByCallId: Set<string>;
  /** Accumulated thinking text — flushed as a single event when a non-thinking event arrives. */
  thinkingBuffer: string;
  /**
   * OpenCode compaction scratchpad detection.
   * When the model mimics the compaction template (`## Goal`, `Constraints & Preferences`,
   * etc.) in its regular response text, subsequent chunks are suppressed.
   */
  scratchpadDetected: boolean;
  /** Trailing text window for cross-chunk compaction signature detection. */
  textTail: string;
  /**
   * Trae CLI system_reminders echo suppression.
   * Trae-cli re-sends accumulated `system_reminders` content via `agent_message_chunk`
   * events on every prompt. These are protocol-internal reminders (context window status,
   * thinking budget, etc.) that should NOT appear as model output text.
   * Tracks how many system_reminders chunks have been suppressed this session.
   */
  suppressedSystemReminders: number;
  /**
   * Prompt echo suppression. Some ACP agents (notably trae-cli) echo back the
   * user prompt as the first `agent_message_chunk` text. This stores a fingerprint
   * of the prompt to detect and suppress such echo.
   * Set by caller (AcpAgentService) before promptStream starts.
   */
  promptFingerprint: string;
  /**
   * Trae CLI agent-loop response phase tracking.
   * Trae-cli runs an internal agent loop where the model may generate text,
   * call tools, and generate new text multiple times within a single promptStream
   * call. Without replacement, all turns' text is concatenated, causing visible
   * repetition (e.g., multiple self-introductions). Setting textMode='replace'
   * on the first text chunk after a tool result ensures only the latest response
   * is shown, matching trae-cli's own terminal behavior.
   * The flag is set when a tool result (final status) is emitted and cleared
   * when the first subsequent text chunk is emitted.
   */
  newResponsePhase: boolean;
  /**
   * Session resume replay suppression.
   * When sessionChain=true and the session is resumed, trae-cli replays ALL
   * historical turns as user_message_chunk/agent_message_chunk pairs before
   * generating the new response. These replayed chunks cause text to briefly
   * "flash" in the UI and the previous turn's text to remain visible.
   * When replayPhase=true, all agent_message_chunk text output is suppressed.
   * The phase ends when a user_message_chunk matching our prompt fingerprint
   * is detected, signaling that the replay is over and the real response follows.
   * Set by caller (AcpAgentService) before promptStream starts when isResumedSession=true.
   */
  replayPhase: boolean;
  /**
   * Count of user_message_chunk events seen during replayPhase.
   * Used as a safety valve: if the prompt fingerprint doesn't match any
   * user_message_chunk (e.g. system prompt prep changes the text), we
   * force-end replayPhase after seeing enough chunks to assume replay is over.
   */
  replayUserChunkCount: number;
}

export function createAcpSessionState(): AcpSessionState {
  return {
    emittedToolUseByCallId: new Set<string>(),
    finalEmittedByCallId: new Set<string>(),
    thinkingBuffer: '',
    scratchpadDetected: false,
    textTail: '',
    suppressedSystemReminders: 0,
    promptFingerprint: '',
    newResponsePhase: false,
    replayPhase: false,
    replayUserChunkCount: 0,
  };
}

/**
 * Compute a lightweight fingerprint of a prompt string for echo detection.
 * Returns length + first/last N chars. NOT a hash — just enough to detect
 * an agent echoing back the exact prompt as text.
 */
export function computePromptFingerprint(prompt: string): string {
  if (!prompt) return '';
  const len = prompt.length;
  const head = prompt.slice(0, 80);
  const tail = prompt.slice(-80);
  return `${len}:${head}|${tail}`;
}

/**
 * OpenCode compaction signature. `## Goal` alone is normal Markdown, and
 * `## Constraints & Preferences` is a normal planning heading. Suppress only
 * when the companion marker appears as the bare compaction-template line.
 */
const SCRATCHPAD_MARKER = '## Goal';
const SCRATCHPAD_COMPANION_MARKER_RE = /(?:^|\n)(?![ \t]*#{1,6}\s)[ \t]*Constraints & Preferences\b/;
const SCRATCHPAD_TAIL_CHARS = 800;

function findScratchpadSignature(text: string): number {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const markerIdx = text.indexOf(SCRATCHPAD_MARKER, searchFrom);
    if (markerIdx < 0) return -1;
    const afterMarker = text.slice(markerIdx + SCRATCHPAD_MARKER.length);
    if (SCRATCHPAD_COMPANION_MARKER_RE.test(afterMarker)) return markerIdx;
    searchFrom = markerIdx + SCRATCHPAD_MARKER.length;
  }
  return -1;
}

/**
 * Flush any accumulated thinking text as a single system_info event.
 * Call at end-of-stream to emit thinking that was the last content block.
 */
export function flushAcpThinking(state: AcpSessionState, catId: CatId, metadata: MessageMetadata): AgentMessage | null {
  if (!state.thinkingBuffer) return null;
  const text = state.thinkingBuffer;
  state.thinkingBuffer = '';
  return {
    type: 'system_info',
    catId,
    content: JSON.stringify({ type: 'thinking', text }),
    metadata,
    timestamp: Date.now(),
  };
}

/** F197 KD-6: final判定仅认 status ∈ {completed, failed}. no-status content NOT final. */
function isFinalStatus(status: unknown): status is 'completed' | 'failed' {
  return status === 'completed' || status === 'failed';
}

/** Extract tool name from ACP event, tolerating field name variants across CLI versions. */
function resolveToolName(inner: Record<string, unknown>): string | undefined {
  // camelCase (our original expectation)
  if (typeof inner.toolName === 'string') return inner.toolName;
  // plain "name" (observed in some Gemini CLI versions)
  if (typeof inner.name === 'string') return inner.name;
  // snake_case variant
  if (typeof inner.tool_name === 'string') return inner.tool_name;
  // "title" — observed in Gemini CLI v0.36 production payloads
  if (typeof inner.title === 'string') return inner.title;
  return undefined;
}

/** Extract tool input from ACP event, tolerating field name variants. */
function resolveToolInput(inner: Record<string, unknown>): Record<string, unknown> | undefined {
  if (inner.toolInput && typeof inner.toolInput === 'object') return inner.toolInput as Record<string, unknown>;
  if (inner.input && typeof inner.input === 'object') return inner.input as Record<string, unknown>;
  if (inner.tool_input && typeof inner.tool_input === 'object') return inner.tool_input as Record<string, unknown>;
  return undefined;
}

export function transformAcpEvent(
  update: AcpSessionUpdate,
  catId: CatId,
  metadata: MessageMetadata,
  state?: AcpSessionState,
): AgentMessage | AgentMessage[] | null {
  // Gemini CLI may send update fields nested under `update.update` (ACP spec)
  // or flat at the top level of notification params (observed in Gemini CLI v0.35.3).
  const inner = (update.update ?? update) as Record<string, unknown>;
  const sessionUpdate = inner.sessionUpdate as string | undefined;
  const content = inner.content as { type: string; text?: string } | undefined;
  if (!sessionUpdate) return null;
  const now = Date.now();

  // Raw event diagnostic: log non-text event types and any event with unexpected content structure.
  // Helps diagnose thread-specific failures where Gemini outputs metadata instead of real content.
  if (sessionUpdate !== 'agent_message_chunk' && sessionUpdate !== 'user_message_chunk') {
    log.debug(
      {
        catId,
        sessionUpdate,
        contentType: content?.type,
        contentTextLen: content?.text?.length,
        keys: Object.keys(inner),
      },
      'ACP event received',
    );
  }

  // Flush accumulated thinking before any non-thinking event.
  // Mirrors claude-ndjson-parser's thinkingBuffer → content_block_stop pattern.
  const flushPending =
    state && state.thinkingBuffer && sessionUpdate !== 'agent_thought_chunk'
      ? flushAcpThinking(state, catId, metadata)
      : null;

  /** Wrap result with flushed thinking (if any) — returns array when both exist. */
  function withFlush(msg: AgentMessage | AgentMessage[] | null): AgentMessage | AgentMessage[] | null {
    if (!flushPending) return msg;
    if (!msg) return flushPending;
    if (Array.isArray(msg)) return [flushPending, ...msg];
    return [flushPending, msg];
  }

  switch (sessionUpdate) {
    case 'agent_message_chunk': {
      // Trae-cli sends `system_reminders` as agent_message_chunk events with
      // content.type = 'system_reminders'. These are protocol-internal context
      // updates (context window status, thinking budget, etc.) that must NOT be
      // emitted as model output text. Only emit when content.type is 'text' or
      // unset (backwards compat for providers that don't set type).
      // See: zcode root-cause analysis of raiden trae-cli dialog repetition.
      if (content?.type && content.type !== 'text') {
        if (state) {
          state.suppressedSystemReminders++;
          if (state.suppressedSystemReminders <= 3) {
            log.info(
              { catId, contentType: content.type, textLen: content?.text?.length },
              'Suppressing non-text agent_message_chunk (system_reminders echo)',
            );
          }
        }
        return withFlush(null);
      }
      const text = content?.text ?? '';
      if (state) {
        // Session resume replay suppression: when replayPhase is active, all
        // agent_message_chunk text is historical replay from a resumed session.
        // Suppress it entirely to prevent "flash" of old content in the UI.
        // The replayPhase flag is cleared when the user_message_chunk matching
        // our actual prompt is detected (see user_message_chunk case below).
        if (state.replayPhase) {
          // Still update textTail so scratchpad detection works after replay ends
          state.textTail = (state.textTail + text).slice(-SCRATCHPAD_TAIL_CHARS);
          return withFlush(null);
        }
        // Once scratchpad is detected, suppress all subsequent text chunks.
        if (state.scratchpadDetected) return withFlush(null);

        // Prompt echo detection: trae-cli echoes the user prompt back as
        // agent_message_chunk text. If this chunk's text matches the start of
        // the prompt fingerprint, suppress it. The fingerprint encodes
        // "length:head80|tail80" — check head match for echo detection.
        if (state.promptFingerprint && text.length > 20) {
          const colonIdx = state.promptFingerprint.indexOf(':');
          if (colonIdx > 0) {
            const promptLen = parseInt(state.promptFingerprint.slice(0, colonIdx), 10);
            const headEnd = state.promptFingerprint.indexOf('|', colonIdx);
            const promptHead = headEnd > colonIdx ? state.promptFingerprint.slice(colonIdx + 1, headEnd) : '';
            // If text starts with the prompt head (80 chars), it's an echo
            if (promptHead && text.startsWith(promptHead)) {
              log.info(
                { catId, textLen: text.length, promptLen },
                'Suppressing prompt echo in agent_message_chunk',
              );
              // After detecting echo, clear fingerprint so subsequent non-echo
              // chunks are emitted normally
              state.promptFingerprint = '';
              return withFlush(null);
            }
            // If text is shorter but still matches the prompt start, accumulate
            // and wait for more chunks. Use textTail to track across chunks.
            if (promptHead.startsWith(text) && text.length < promptHead.length) {
              // Could be partial echo — let textTail accumulate and check next chunk
            }
          }
        }

        // Cross-chunk detection: combine trailing window with current chunk.
        const combined = state.textTail + text;
        const markerIdx = findScratchpadSignature(combined);
        if (markerIdx >= 0) {
          state.scratchpadDetected = true;
          log.info({ catId }, 'Suppressing OpenCode compaction scratchpad from ACP text stream');
          // Emit only the portion of the current chunk before the marker.
          const cleanEnd = markerIdx - state.textTail.length;
          if (cleanEnd <= 0) return withFlush(null);
          // Trim trailing whitespace that precedes the scratchpad header.
          const clean = text.slice(0, cleanEnd).replace(/[\s\n]+$/, '');
          if (!clean) return withFlush(null);
          return withFlush({ type: 'text', catId, content: clean, metadata, timestamp: now });
        }
        // Keep trailing window bounded for cross-chunk detection.
        state.textTail = combined.length > SCRATCHPAD_TAIL_CHARS ? combined.slice(-SCRATCHPAD_TAIL_CHARS) : combined;
      }

      // Trae-cli agent-loop text replacement: when a tool result was emitted
      // earlier in this session, the model has started a new response phase.
      // The new text replaces (not appends to) the previous response's text,
      // matching trae-cli's own terminal behavior. Only the FIRST chunk after
      // a tool result gets textMode='replace'; subsequent chunks are streaming
      // deltas that should append normally.
      const isFirstInNewPhase = state?.newResponsePhase === true;
      if (isFirstInNewPhase) {
        state.newResponsePhase = false;
        log.info({ catId, textLen: text.length }, 'ACP textMode=replace: new response phase after tool result');
      }
      return withFlush({
        type: 'text',
        catId,
        content: text,
        ...(isFirstInNewPhase ? { textMode: 'replace' as const } : {}),
        metadata,
        timestamp: now,
      });
    }

    case 'agent_thought_chunk':
      // Suppress during replay — historical thinking from resumed session.
      if (state?.replayPhase) return null;
      // Accumulate — emit nothing until a non-thinking event flushes the buffer.
      if (state) {
        state.thinkingBuffer += content?.text ?? '';
        return null;
      }
      // No state (shouldn't happen) — fall back to immediate emit.
      return {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'thinking', text: content?.text ?? '' }),
        metadata,
        timestamp: now,
      };

    case 'tool_call': {
      // Suppress tool_call/tool_result during replay — these are historical events
      // from the resumed session, not current tool invocations.
      if (state?.replayPhase) return withFlush(null);
      const toolName = resolveToolName(inner);
      const toolInput = resolveToolInput(inner);
      const toolCallId = typeof inner.toolCallId === 'string' ? inner.toolCallId : undefined;
      const status = inner.status;
      if (!toolName) {
        log.warn(
          { sessionUpdate, keys: Object.keys(inner), toolCallId, kind: inner.kind },
          'tool_call: could not resolve toolName',
        );
      }
      // F197 KD-5 / 砚砚 PR review P1: dedup duplicate final replay.
      // ACP stream replay / re-deliver can produce same (toolCallId, completed)
      // event multiple times — second+ occurrences must be dropped to honor
      // "仅一次 final tool_result" invariant.
      if (state && toolCallId && state.finalEmittedByCallId.has(toolCallId)) {
        return withFlush(null);
      }
      const toolUse: AgentMessage = {
        type: 'tool_use',
        catId,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(toolInput !== undefined ? { toolInput } : {}),
        metadata,
        timestamp: now,
      };
      // F197 AC-A1 / KD-5 / cloud-1 P1×2: final status (completed/failed) must
      // produce a tool_result even when content.text is missing/non-text/empty
      // — Recall pairing model needs the pair to complete; content '' is the
      // canonical "no payload" marker. Pre-fix the missing-content branch
      // fell through to tool_use only and left the tool permanently pending.
      if (isFinalStatus(status)) {
        const resultMsg: AgentMessage = {
          type: 'tool_result',
          catId,
          ...(toolName !== undefined ? { toolName } : {}),
          content: content?.text ?? '',
          metadata,
          timestamp: now,
        };
        // cloud-1 P1: if same toolCallId already had pending tool_use (e.g.
        // earlier tool_call(in_progress)), DO NOT re-emit tool_use — only
        // emit the result to complete the existing pair. Otherwise (first
        // observation) split into [tool_use, tool_result].
        const hasPendingToolUse = state && toolCallId ? state.emittedToolUseByCallId.has(toolCallId) : false;
        if (state && toolCallId) {
          state.emittedToolUseByCallId.add(toolCallId);
          state.finalEmittedByCallId.add(toolCallId);
        }
        // Tool result emitted — next text chunk starts a new response phase.
        // Use textMode='replace' to avoid concatenating multiple turns' text
        // (e.g., trae-cli agent loop generating repeated self-introductions).
        if (state) state.newResponsePhase = true;
        return withFlush(hasPendingToolUse ? resultMsg : [toolUse, resultMsg]);
      }
      // Pending/in_progress/no-status → tool_use only.
      // Register state AFTER non-final branch so duplicate plain tool_call is
      // tolerated (transformer is event-by-event; dedup only blocks final replay).
      if (state && toolCallId) state.emittedToolUseByCallId.add(toolCallId);
      return withFlush(toolUse);
    }

    case 'tool_call_update': {
      // Suppress during replay — same as tool_call above.
      if (state?.replayPhase) return withFlush(null);
      const toolName = resolveToolName(inner);
      const toolCallId = typeof inner.toolCallId === 'string' ? inner.toolCallId : undefined;
      const status = inner.status;
      const final = isFinalStatus(status);
      const alreadyHasToolUse = state && toolCallId ? state.emittedToolUseByCallId.has(toolCallId) : false;
      // F197 AC-A4 / KD-6: only status ∈ {completed, failed} is final. No-status
      // fallback removed — progress content is NOT promoted to result.
      if (!final) {
        // F197 AC-A2 / KD-5: progress update for known toolCallId → drop (don't
        // re-emit tool_use to avoid double-pending in Recall sidebar).
        // For unknown toolCallId without state tracking, fall back to legacy
        // tool_use emission so we don't silently lose first observation of a tool.
        if (alreadyHasToolUse) return withFlush(null);
        if (state && toolCallId) {
          // First observation with no final status — emit tool_use, register state
          state.emittedToolUseByCallId.add(toolCallId);
        }
        return withFlush({
          type: 'tool_use',
          catId,
          ...(toolName !== undefined ? { toolName } : {}),
          metadata,
          timestamp: now,
        });
      }
      // F197 KD-5 / 砚砚 PR review P1: dedup duplicate final replay (same as
      // tool_call branch above — ACP can re-deliver same final event).
      if (state && toolCallId && state.finalEmittedByCallId.has(toolCallId)) {
        return withFlush(null);
      }
      // Final status (completed/failed)
      const resultMsg: AgentMessage = {
        type: 'tool_result',
        catId,
        ...(toolName !== undefined ? { toolName } : {}),
        content: content?.text ?? '',
        metadata,
        timestamp: now,
      };
      if (alreadyHasToolUse) {
        // Pair completes — pending tool_use was emitted earlier.
        // cloud-2 P2 note: duplicate final guard for cross-event replay (e.g.
        // final `tool_call` → final `tool_call_update` for same toolCallId) is
        // handled by the upstream `finalEmittedByCallId.has()` check ~20 lines
        // above (before this `if (alreadyHasToolUse)` branch). Second final
        // for same toolCallId returns null before reaching this point.
        if (state && toolCallId) state.finalEmittedByCallId.add(toolCallId);
        // Tool result emitted — next text chunk starts a new response phase.
        if (state) state.newResponsePhase = true;
        return withFlush(resultMsg);
      }
      // F197 AC-A3 boundary: toolCallId first appears as final update with no prior
      // tool_call. Split to [tool_use, tool_result] so the pair is never orphaned.
      if (state && toolCallId) {
        state.emittedToolUseByCallId.add(toolCallId);
        state.finalEmittedByCallId.add(toolCallId);
      }
      // Tool result emitted — next text chunk starts a new response phase.
      if (state) state.newResponsePhase = true;
      return withFlush([
        {
          type: 'tool_use',
          catId,
          ...(toolName !== undefined ? { toolName } : {}),
          metadata,
          timestamp: now,
        },
        resultMsg,
      ]);
    }

    case 'plan':
      return withFlush({
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'plan', text: content?.text ?? '' }),
        metadata,
        timestamp: now,
      });

    case 'user_message_chunk': {
      // Trae-cli agent loop: user_message_chunk signals a new turn boundary.
      // The model receives the full conversation history as user_message_chunk,
      // then generates a fresh response. Without textMode='replace', all turns'
      // text is concatenated. Setting newResponsePhase here ensures the next
      // agent_message_chunk replaces (not appends to) the previous response.
      if (state) {
        state.newResponsePhase = true;

        // Session resume replay detection: during replay, trae-cli sends
        // historical user_message_chunks that do NOT match our prompt. When
        // we find a user_message_chunk whose text matches our prompt fingerprint,
        // the replay is over and the real response is about to follow.
        if (state.replayPhase) {
          state.replayUserChunkCount++;
          const chunkText = content?.text ?? '';
          let fingerprintMatched = false;
          if (state.promptFingerprint && chunkText.length > 20) {
            const colonIdx = state.promptFingerprint.indexOf(':');
            if (colonIdx > 0) {
              const headEnd = state.promptFingerprint.indexOf('|', colonIdx);
              const promptHead = headEnd > colonIdx ? state.promptFingerprint.slice(colonIdx + 1, headEnd) : '';
              // If chunk text starts with the prompt head (80 chars), this is our actual prompt
              if (promptHead && chunkText.startsWith(promptHead)) {
                fingerprintMatched = true;
              }
            }
          }
          if (fingerprintMatched) {
            state.replayPhase = false;
            log.info({ catId, textLen: chunkText.length, chunksSeen: state.replayUserChunkCount }, 'ACP replayPhase ended: prompt fingerprint matched in user_message_chunk');
          } else if (state.replayUserChunkCount >= 20) {
            // Safety valve: if we've seen 20+ user_message_chunks without matching
            // the fingerprint, assume replay is over. This handles edge cases where
            // the system prompt prep changes the text enough to break fingerprint match.
            state.replayPhase = false;
            log.info({ catId, chunksSeen: state.replayUserChunkCount }, 'ACP replayPhase ended: safety valve (max user_message_chunks reached)');
          }
        }
      }
      return withFlush(null);
    }

    default:
      return withFlush(null);
  }
}
