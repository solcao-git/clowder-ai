/**
 * DeepSeek Agent Service
 * Direct API integration with DeepSeek (OpenAI-compatible) chat completions.
 *
 * Bypasses the deepcode CLI (which requires TTY) and calls the
 * OpenAI-compatible /v1/chat/completions endpoint directly, reading
 * configuration from ~/.deepcode/settings.json.
 *
 * Stream format: standard OpenAI SSE (data: {...} lines)
 *   chat.completion.chunk delta.content → text
 *   chat.completion.chunk delta.reasoning_content → system_info (JSON {type:'thinking',text})
 *   [DONE] → done
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import type { RawArchiveSink } from './codex-audit-hooks.js';

const log = createModuleLogger('deepseek-agent');

// ────────── Configuration ──────────

interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort: string;
}

const DEEPCODE_SETTINGS_PATHS = [
  () => join(homedir(), '.deepcode', 'settings.json'),
];

function readDeepCodeConfig(): DeepSeekConfig | null {
  for (const getPath of DEEPCODE_SETTINGS_PATHS) {
    const path = getPath();
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      const env = parsed.env ?? parsed;
      const apiKey = env.API_KEY ?? env.apiKey ?? '';
      const baseUrl = (env.BASE_URL ?? env.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
      const model = env.MODEL ?? env.model ?? parsed.model ?? 'deepseek-chat';
      if (!apiKey) {
        log.warn({ path }, 'deepcode settings.json found but missing API_KEY');
        continue;
      }
      return {
        apiKey,
        baseUrl,
        model,
        thinkingEnabled: parsed.thinkingEnabled ?? true,
        reasoningEffort: parsed.reasoningEffort ?? 'high',
      };
    } catch (err) {
      log.warn({ path, err }, 'Failed to read deepcode settings.json');
    }
  }
  return null;
}

// ────────── SSE Stream Parser ──────────

interface OpenAIStreamDelta {
  content?: string;
  reasoning_content?: string;
}

interface OpenAIStreamChunk {
  id?: string;
  object?: string;
  choices?: Array<{
    index?: number;
    delta?: OpenAIStreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAIStreamChunk | '__DONE__'> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // skip empty/comments
        if (trimmed === 'data: [DONE]') {
          yield '__DONE__';
          return;
        }
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          try {
            const chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
            yield chunk;
          } catch {
            // Skip malformed JSON lines
            log.debug({ jsonStr: jsonStr.slice(0, 100) }, 'Malformed SSE data line');
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ────────── Agent Service ──────────

interface DeepSeekAgentServiceOptions {
  catId?: CatId;
  rawArchive?: RawArchiveSink;
}

export class DeepSeekAgentService implements AgentService {
  readonly catId: CatId;
  private readonly rawArchive: RawArchiveSink;

  constructor(options?: DeepSeekAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('raiden');
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const config = readDeepCodeConfig();
    if (!config) {
      yield {
        type: 'error' as const,
        catId: this.catId,
        error:
          'DeepSeek configuration not found. Create ~/.deepcode/settings.json with API_KEY and BASE_URL.',
        metadata: { provider: 'deepseek', model: 'unknown' },
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId: this.catId, metadata: { provider: 'deepseek', model: 'unknown' }, timestamp: Date.now() };
      return;
    }

    const effectiveModel = options?.callbackEnv?.CAT_CAFE_DEEPSEEK_MODEL_OVERRIDE ?? config.model;
    const metadata: MessageMetadata = { provider: 'deepseek', model: effectiveModel };

    // Session management: build messages array
    const sessionId = options?.sessionId ?? crypto.randomUUID();
    metadata.sessionId = sessionId;

    yield {
      type: 'session_init' as const,
      catId: this.catId,
      sessionId,
      metadata,
      timestamp: Date.now(),
    };

    // Build messages payload
    const messages: Array<{ role: string; content: string }> = [
      { role: 'user', content: prompt },
    ];

    // Build request body
    const requestBody: Record<string, unknown> = {
      model: effectiveModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    // Thinking/reasoning parameters — only for native DeepSeek API (not dashscope)
    // dashscope/qwen models reason natively and don't need explicit thinking config
    // DeepSeek native API supports explicit thinking config; dashscope/qwen reason natively
    const isDashScope = config.baseUrl.includes('dashscope');
    if (config.thinkingEnabled && !isDashScope) {
      requestBody.thinking = { type: 'enabled', budget_tokens: 8192 };
    }

    // Build endpoint URL — some BASE_URLs already include /v1 (e.g. dashscope compatible-mode/v1)
    const basePath = config.baseUrl.endsWith('/v1') ? config.baseUrl : `${config.baseUrl}/v1`;
    const url = `${basePath}/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: options?.signal ?? AbortSignal.timeout(300_000),
      });
    } catch (err) {
      yield {
        type: 'error' as const,
        catId: this.catId,
        error: `DeepSeek API connection failed: ${err instanceof Error ? err.message : String(err)}`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      yield {
        type: 'error' as const,
        catId: this.catId,
        error: `DeepSeek API error ${response.status}: ${bodyText.slice(0, 300)}`,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    if (!response.body) {
      yield {
        type: 'error' as const,
        catId: this.catId,
        error: 'DeepSeek API returned empty body',
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    // Parse SSE stream
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let hadContent = false;
    // Accumulate reasoning_content into a running buffer.
    // DashScope/Qwen returns incremental deltas (not cumulative like Claude extended thinking).
    // appendThinkingChunk in route-serial expects cumulative text (next.startsWith(last)),
    // so we must yield the full accumulated text each time.
    let reasoningBuffer = '';

    try {
      for await (const chunk of parseSSEStream(response.body, options?.signal)) {
        if (chunk === '__DONE__') break;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Reasoning/thinking content — accumulate and yield cumulative buffer
        // so route-serial's appendThinkingChunk can merge deltas correctly
        if (delta?.reasoning_content) {
          hadContent = true;
          reasoningBuffer += delta.reasoning_content;
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({ type: 'thinking', text: reasoningBuffer }),
            metadata,
            timestamp: Date.now(),
          };
        }

        // Main text content
        if (delta?.content) {
          hadContent = true;
          yield {
            type: 'text' as const,
            catId: this.catId,
            content: delta.content,
            metadata,
            timestamp: Date.now(),
          };
        }

        // Token usage from stream_options.include_usage
        if (chunk.usage) {
          totalInputTokens = chunk.usage.prompt_tokens ?? 0;
          totalOutputTokens = chunk.usage.completion_tokens ?? 0;
          totalCachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }

        // Finish reason
        if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
          break;
        }
      }
    } catch (err) {
      if (options?.signal?.aborted) {
        // Clean abort, emit done normally
        log.debug({ catId: this.catId }, 'DeepSeek stream aborted by signal');
      } else {
        log.error({ catId: this.catId, err }, 'DeepSeek stream parse error');
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: `DeepSeek stream error: ${err instanceof Error ? err.message : String(err)}`,
          metadata,
          timestamp: Date.now(),
        };
      }
    }

    // Emit done with usage
    yield {
      type: 'done' as const,
      catId: this.catId,
      metadata: {
        ...metadata,
        sessionId,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadTokens: totalCachedTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
        },
      },
      timestamp: Date.now(),
    };
  }
}
