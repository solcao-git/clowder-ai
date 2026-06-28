/**
 * Trae Agent Service
 * Trae CLI 子进程调用（headless stream-json 模式）
 *
 * CLI 调用方式:
 *   trae-cli -p "prompt" --output-format stream-json [--resume <sessionId>] [-y] [-c model.name=<name>]
 *
 * NOTE: trae-cli v0.120.40's --model flag is broken (exit 1, no output).
 * Model is set via -c model.name=<name> config override instead.
 *
 * 认证方式（官方推荐）:
 *   环境变量 TRAECLI_PERSONAL_ACCESS_TOKEN="trae-lt-<hex>"
 *   可选 TRAECLI_HOST="https://example.com"（企业专属域名）
 *   参考: https://docs.trae.cn/enterprise/cli-login-token
 *
 * NDJSON 事件格式 (trae-cli --output-format stream-json):
 *   system/init       → session_init (session_id, tools, model)
 *   system/status     → 内部状态 (跳过)
 *   assistant         → text (message.content) + tool_use (message.tool_calls)
 *   user/tool_result  → tool_result
 *   result/success    → done (usage)
 *   result/error      → error
 *
 * 参考 QoderAgentService.ts 架构，与 OpenCode/Codex 平级的原生 CLI Agent。
 * 解决 ACP 模式下缺少 MCP 工具、L0 注入、事件转换不精确等问题。
 */

import { existsSync } from 'node:fs';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { buildCliDiagnostics, buildSilentCompletionDiagnostic } from '../../../../../utils/cli-diagnostics.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type { AgentMessage, AgentServiceOptions, L0InjectableAgentService, MessageMetadata } from '../../types.js';
import type { RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';
import {
  createTraeTransformState,
  transformTraeEvent,
} from './trae-event-transform.js';

const log = createModuleLogger('trae-agent');

/** Well-known trae-cli binary locations on Windows. */
const TRAE_WIN_PATHS = [
  'C:\\Users\\Administrator\\AppData\\Local\\trae-cli\\bin\\trae-cli.exe',
];

/**
 * Windows CreateProcess command-line limit is 32,767 UTF-16 code units.
 * We use ~28K chars as the safe threshold (leaving room for the command itself,
 * flags like --output-format, -c model.name=..., -y, etc.).
 *
 * Plan C: trae-cli v0.120.40 doesn't support stdin prompt (`-p -` treats `-`
 * as a literal string, not stdin). It also has no prompt-file option. So when
 * the effective prompt exceeds this threshold, we truncate the L0/system prompt
 * portion while preserving the user message intact. The L0 is advisory context
 * (the model still has its base training), but the user message is the actual
 * task that must not be lost.
 *
 * Future: if trae-cli adds `-p @file` or proper stdin support, switch to
 * stdinInput like ClaudeAgentService does.
 */
const PROMPT_ARGV_SAFE_LENGTH = 28_000;

interface TraeAgentServiceOptions {
  catId?: CatId;
  model?: string;
  /** Inject a custom spawn function (for testing) */
  spawnFn?: SpawnFn;
  /** Raw NDJSON archive sink */
  rawArchive?: RawArchiveSink;
  /** L0 compiler function (test seam) */
  l0CompilerFn?: typeof compileL0ViaSubprocess;
}

/**
 * Resolve trae-cli binary — checks well-known locations first, then PATH.
 */
function resolveTraeCommand(): string | null {
  // Well-known paths first (avoids picking up trae.cmd IDE launcher)
  for (const p of TRAE_WIN_PATHS) {
    if (existsSync(p)) return p;
  }
  return resolveCliCommand('trae-cli');
}

export class TraeAgentService implements L0InjectableAgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly rawArchive: RawArchiveSink;
  readonly l0CompilerFn: import('../../types.js').L0CompilerFn | undefined;

  constructor(options?: TraeAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('trae');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.spawnFn = options?.spawnFn;
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
  }

  /**
   * trae-cli v0.120.40: `-c developer_instructions=<long_L0>` is fragile —
   * the `-c` parser doesn't reliably handle long/multiline/unicode values.
   * Return false so invoke-single-cat prepends L0 to the prompt string
   * (the universal injection method that works for all CLIs).
   * Model name and API token are still passed via `-c` (short, stable values).
   */
  injectsL0Natively(): boolean {
    return false;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_TRAE_MODEL_OVERRIDE ?? this.model;
    let effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    // Image support: trae-cli has no native image/attachment flag, so we use
    // path hints (textual reference) + --add-dir (directory sandbox access)
    // so the model can read image files via its tools if it supports file reading.
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageAccessDirs = collectImageAccessDirectories(imagePaths);
    effectivePrompt = appendLocalImagePathHints(effectivePrompt, imagePaths);
    const metadata: MessageMetadata = { provider: 'trae', model: effectiveModel };
    let sessionInitEmitted = false;
    let textEventCount = 0;
    let toolUseEmitted = false;
    let errorAlreadyYielded = false;
    const uniqueEventTypes = new Set<string>();

    // Plan C: Truncate L0 when effectivePrompt exceeds Windows argv limit.
    // trae-cli doesn't support stdin prompt or prompt-file, so we must keep
    // the prompt under ~28K chars. Preserve user message intact; trim L0.
    if (effectivePrompt.length > PROMPT_ARGV_SAFE_LENGTH) {
      const userMsgLen = prompt.length;
      const maxL0Len = PROMPT_ARGV_SAFE_LENGTH - userMsgLen - 4; // 4 for "\n\n" separator
      if (maxL0Len > 500 && options?.systemPrompt) {
        // Trim L0 to fit, keeping the most important beginning
        const trimmedL0 = options.systemPrompt.slice(0, maxL0Len);
        effectivePrompt = `${trimmedL0}\n\n[L0 truncated: ${options.systemPrompt.length - maxL0Len} chars omitted]\n\n${prompt}`;
        log.warn(
          { catId: this.catId, originalLen: options.systemPrompt.length + userMsgLen, truncatedLen: effectivePrompt.length },
          'Trae prompt exceeds argv limit, truncated L0 to preserve user message',
        );
      } else {
        // Even user message alone exceeds limit — truncate it too (last resort)
        effectivePrompt = effectivePrompt.slice(0, PROMPT_ARGV_SAFE_LENGTH - 100) + '\n\n[... prompt truncated at argv limit]';
        log.warn(
          { catId: this.catId, originalLen: effectivePrompt.length },
          'Trae prompt severely exceeds argv limit, truncated entire prompt',
        );
      }
    }

    try {
      const traeCommand = resolveTraeCommand();
      if (!traeCommand) {
        yield {
          type: 'error' as const,
          catId: this.catId,
          error: formatCliNotFoundError('trae-cli'),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      // Build args (L0 is now injected via prompt prepend by invoke-single-cat,
      // since injectsL0Natively() returns false. This is more reliable than
      // passing long L0 content through -c developer_instructions=...)
      const args = this.buildArgs(effectivePrompt, options?.sessionId, effectiveModel, imageAccessDirs, options?.cliConfigArgs);

      // Authentication: TRAE CLI natively reads TRAECLI_PERSONAL_ACCESS_TOKEN
      // from environment (official method for headless/CICD scenarios).
      // The token flows through accounts.json envVars → accountEnv → buildEnv().
      // Optional TRAECLI_HOST for enterprise custom domains.
      // Previously used `-c api_key=<token>` workaround; retired in favor of
      // the native env var approach (more reliable, avoids -c parser fragility).

      // Build env
      const childEnv = this.buildEnv(options?.callbackEnv, options?.accountEnv);

      log.info(
        {
          catId: this.catId,
          command: traeCommand,
          model: effectiveModel,
          sessionId: options?.sessionId,
          invocationId: options?.invocationId,
          cwd: options?.workingDirectory,
          argCount: args.length,
          hasLoginToken: !!(childEnv.TRAECLI_PERSONAL_ACCESS_TOKEN),
        },
        'Invoking Trae CLI',
      );

      const cliOpts = {
        command: traeCommand,
        args,
        // Trae CLI's `-p -` (stdin) mode doesn't reliably consume stdin content.
        // Use argv mode instead (same as QoderAgentService). Prompt goes via -p flag.
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        env: childEnv,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
        ...(options?.invocationId && this.rawArchive.getPath
          ? { rawArchivePath: this.rawArchive.getPath(options.invocationId) }
          : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      const transformState = createTraeTransformState();
      let eventCount = 0;

      for await (const event of events) {
        eventCount++;
        // Archive raw event
        if (options?.invocationId) {
          this.rawArchive.append(options.invocationId, sanitizeRawEvent(event)).catch((err) => {
            log.warn({ catId: this.catId, invocationId: options.invocationId, err }, 'Raw archive write failed');
          });
        }

        const evtType =
          typeof event === 'object' && event !== null && 'type' in event
            ? String((event as Record<string, unknown>).type)
            : '__unknown';
        uniqueEventTypes.add(evtType);

        // Timeout handling
        if (isCliTimeout(event)) {
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({
              type: 'timeout_diagnostics',
              silenceDurationMs: event.silenceDurationMs,
              processAlive: event.processAlive,
              lastEventType: event.lastEventType,
              invocationId: options?.invocationId,
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'error',
            catId: this.catId,
            error: `Trae CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
            timestamp: Date.now(),
          };
          errorAlreadyYielded = true;
          continue;
        }

        // Liveness warning
        if (isLivenessWarning(event)) {
          log.warn({ catId: this.catId, invocationId: options?.invocationId }, 'Trae CLI liveness warning');
          yield {
            type: 'system_info' as const,
            catId: this.catId,
            content: JSON.stringify({ type: 'liveness_warning', ...event }),
            timestamp: Date.now(),
          };
          continue;
        }

        // CLI error
        if (isCliError(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Trae CLI', event),
            metadata: event.cliDiagnostics ? { ...metadata, cliDiagnostics: event.cliDiagnostics } : metadata,
            timestamp: Date.now(),
          };
          errorAlreadyYielded = true;
          continue;
        }

        // Transform event
        const result = transformTraeEvent(event, this.catId, metadata, transformState);
        if (result !== null) {
          if (Array.isArray(result)) {
            for (const msg of result) {
              if (msg.type === 'text') textEventCount++;
              if (msg.type === 'tool_use') toolUseEmitted = true;
              if (msg.type === 'session_init') {
                if (sessionInitEmitted) continue;
                sessionInitEmitted = true;
                if (msg.sessionId) metadata.sessionId = msg.sessionId;
              }
              yield { ...msg, metadata: { ...metadata, ...msg.metadata } };
            }
          } else {
            if (result.type === 'text') textEventCount++;
            if (result.type === 'tool_use') toolUseEmitted = true;
            if (result.type === 'session_init') {
              if (sessionInitEmitted) continue;
              sessionInitEmitted = true;
              if (result.sessionId) metadata.sessionId = result.sessionId;
            }
            if (result.type === 'error') errorAlreadyYielded = true;
            yield { ...result, metadata: { ...metadata, ...result.metadata } };
          }
        }
      }

      log.info(
        { catId: this.catId, totalEvents: eventCount, textEvents: textEventCount, sessionId: metadata.sessionId },
        'Trae CLI invocation completed',
      );

      // Silent completion diagnostic
      if (eventCount > 0 && textEventCount === 0 && !errorAlreadyYielded && !toolUseEmitted) {
        const silentDiag = buildSilentCompletionDiagnostic({
          command: 'trae-cli',
          ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
          eventCount,
          eventTypes: Array.from(uniqueEventTypes),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
          stderrPresent: false,
        });
        yield {
          type: 'system_info',
          catId: this.catId,
          content: JSON.stringify({
            type: 'silent_completion',
            detail: 'Trae CLI 完成但无文字输出',
          }),
          metadata: { ...metadata, cliDiagnostics: silentDiag },
          timestamp: Date.now(),
        };
      }

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: err instanceof Error ? err.message : String(err),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }

  private buildArgs(
    prompt: string,
    sessionId?: string,
    model?: string,
    imageAccessDirs?: readonly string[],
    cliConfigArgs?: readonly string[],
  ): string[] {
    const args: string[] = [];

    // Output format
    args.push('--output-format', 'stream-json');

    // Session resume: DISABLED for Trae CLI v0.120.40.
    // Bug: `--resume <sessionId> -p "prompt"` causes the model to receive the
    // session ID as the user message instead of the `-p` prompt content.
    // The `-p` prompt is silently discarded when `--resume` is active.
    // This was confirmed by manual testing (2026-06-28):
    //   trae-cli --resume 7cd54245... -p "请说你好" --output-format stream-json -y
    // → model sees user message "7cd54245..." instead of "请说你好".
    // Workaround: start a fresh session every time; L0 + thread context
    // provide sufficient continuity without CLI-level session resume.
    // TODO: Re-enable if trae-cli fixes the --resume + -p interaction.
    // if (sessionId) {
    //   args.push('--resume', sessionId);
    // }

    // Model selection — trae-cli v0.120.40's --model flag is broken (exit 1, no output, no stderr).
    // Use -c model.name=<model> config override instead, which works correctly.
    // Guard against '=' in model name (would break key=value parsing).
    const effectiveModel = model ?? this.model;
    if (effectiveModel) {
      const safeModel = effectiveModel.replace(/=/g, '');
      args.push('-c', `model.name=${safeModel}`);
    }

    // YOLO mode (bypass tool permission checks — our route layer handles safety)
    args.push('-y');

    // Image directory access (--add-dir: sandbox directory for image file reading)
    if (imageAccessDirs && imageAccessDirs.length > 0) {
      for (const dir of imageAccessDirs) {
        args.push('--add-dir', dir);
      }
    }

    // User-defined CLI args
    const userParts: string[] = [];
    for (const arg of cliConfigArgs ?? []) {
      userParts.push(...arg.trim().split(/\s+/));
    }
    args.push(...userParts);

    // Print mode + prompt.
    // Per TRAE CLI docs: `-p / --print` prints response and exits (pipe mode).
    // Prompt follows -p as a positional argument: `traecli -p "prompt text"`
    // Example from docs: `traecli --allowed-tool Bash,Edit -p "update the README"`
    args.push('-p', prompt);

    return args;
  }

  private buildEnv(
    callbackEnv?: Record<string, string>,
    accountEnv?: Record<string, string>,
  ): Record<string, string | null> {
    const env: Record<string, string | null> = { ...(callbackEnv ?? {}) };

    // Account env vars override (F171: user overrides provider-injected values)
    if (accountEnv) {
      for (const [k, v] of Object.entries(accountEnv)) {
        env[k] = v;
      }
    }

    return env;
  }
}

