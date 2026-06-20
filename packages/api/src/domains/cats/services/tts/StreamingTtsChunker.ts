import type { TtsSynthesizeRequest, VoiceChunkEvent, VoiceConfig } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { TtsRegistry } from './TtsRegistry.js';

const log = createModuleLogger('streaming-tts');

interface Broadcaster {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

const HARD_BREAKS = new Set(['。', '？', '！', '.', '?', '!']);
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':', '；', ';']);

const BOOST_COUNT = 2;
const NORMAL_THRESHOLD = 4;
const BOOST_THRESHOLD = 2;

// Dashscope CosyVoice API rate limit: max concurrent synthesis requests
const MAX_CONCURRENT_TTS = 2;
const RATE_LIMIT_RETRY_DELAY_MS = 1_000;
const RATE_LIMIT_MAX_RETRIES = 2;

export interface StreamingTtsChunkerConfig {
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly voiceConfig: VoiceConfig;
  readonly broadcaster: Broadcaster;
  readonly ttsRegistry: TtsRegistry;
  readonly signal?: AbortSignal;
}

export class StreamingTtsChunker {
  private buffer = '';
  private chunkIndex = 0;
  private readonly pendingSyntheses: Promise<void>[] = [];
  private aborted = false;
  private startBroadcasted = false;
  private readonly config: StreamingTtsChunkerConfig;

  // Semaphore: limits concurrent TTS API calls to avoid rate limiting (Dashscope 429)
  private activeSyntheses = 0;
  private readonly queue: Array<() => void> = [];

  constructor(config: StreamingTtsChunkerConfig) {
    this.config = config;
    config.signal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  feed(token: string): void {
    if (this.aborted) return;

    for (const ch of token) {
      if (ch === '\n') {
        this.flushBuffer();
        continue;
      }

      this.buffer += ch;

      if (HARD_BREAKS.has(ch)) {
        this.flushBuffer();
      } else if (SOFT_BREAKS.has(ch)) {
        const threshold = this.chunkIndex < BOOST_COUNT ? BOOST_THRESHOLD : NORMAL_THRESHOLD;
        if (this.buffer.length >= threshold) {
          this.flushBuffer();
        }
      }
    }
  }

  private flushBuffer(): void {
    const text = this.buffer.trim();
    this.buffer = '';
    if (!text || this.aborted) return;

    const index = this.chunkIndex++;
    const promise = this.acquireAndSynthesize(text, index);
    this.pendingSyntheses.push(promise);
  }

  /** Acquire semaphore slot, synthesize, then release. */
  private async acquireAndSynthesize(text: string, index: number): Promise<void> {
    // Wait for a slot
    if (this.activeSyntheses >= MAX_CONCURRENT_TTS) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeSyntheses++;
    try {
      await this.synthesizeAndBroadcast(text, index);
    } finally {
      this.activeSyntheses--;
      // Release next waiter
      const next = this.queue.shift();
      if (next) next();
    }
  }

  private async synthesizeAndBroadcast(text: string, index: number): Promise<void> {
    if (this.aborted) return;

    const { catId, invocationId, threadId, voiceConfig, broadcaster, ttsRegistry } = this.config;

    let provider;
    try {
      provider = ttsRegistry.getDefault();
    } catch {
      log.error('[StreamingTtsChunker] No TTS provider available');
      return;
    }

    const synthRequest: TtsSynthesizeRequest = {
      text,
      // F103: Prefer CosyVoice voice_id when available (pre-registered on 百炼平台)
      voice: voiceConfig.cosyvoiceVoice ?? voiceConfig.voice,
      langCode: voiceConfig.langCode,
      speed: voiceConfig.speed ?? 1.0,
      format: 'wav',
      ...(voiceConfig.refAudio ? { refAudio: voiceConfig.refAudio } : {}),
      ...(voiceConfig.refText ? { refText: voiceConfig.refText } : {}),
      ...(voiceConfig.instruct ? { instruct: voiceConfig.instruct } : {}),
      ...(voiceConfig.temperature != null ? { temperature: voiceConfig.temperature } : {}),
    };

    try {
      let result;
      for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
        try {
          result = await provider.synthesize(synthRequest);
          break;
        } catch (synthErr) {
          const msg = synthErr instanceof Error ? synthErr.message : String(synthErr);
          const isRateLimit = msg.includes('429') || msg.includes('RateQuota');
          if (isRateLimit && attempt < RATE_LIMIT_MAX_RETRIES) {
            const delay = RATE_LIMIT_RETRY_DELAY_MS * (attempt + 1);
            log.warn({ index, attempt, delay }, 'Rate limited, retrying');
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw synthErr;
        }
      }
      if (!result || this.aborted) return;

      const audioBase64 = Buffer.from(result.audio).toString('base64');

      const event: VoiceChunkEvent = {
        type: 'voice_chunk',
        catId,
        invocationId,
        threadId,
        index,
        audioBase64,
        text,
        format: result.format,
        durationSec: result.durationSec,
      };

      if (!this.startBroadcasted) {
        this.startBroadcasted = true;
        broadcaster.broadcastToRoom(`thread:${threadId}`, 'voice_stream_start', {
          type: 'voice_stream_start',
          catId,
          invocationId,
          threadId,
        });
        log.info({ catId, invocationId }, 'First chunk sent');
      }

      broadcaster.broadcastToRoom(`thread:${threadId}`, 'voice_chunk', event);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ index, error: errMsg }, 'Synthesis failed for chunk');
    }
  }

  async flush(): Promise<number> {
    this.flushBuffer();
    await Promise.allSettled(this.pendingSyntheses);
    return this.chunkIndex;
  }

  abort(): void {
    this.aborted = true;
  }

  getChunkCount(): number {
    return this.chunkIndex;
  }

  hasStarted(): boolean {
    return this.startBroadcasted;
  }
}

let ttsRegistryInstance: TtsRegistry | null = null;

export function initStreamingTtsRegistry(registry: TtsRegistry): void {
  ttsRegistryInstance = registry;
}

export function getStreamingTtsRegistry(): TtsRegistry | null {
  return ttsRegistryInstance;
}
