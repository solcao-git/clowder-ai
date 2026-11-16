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
import type { AgentMessage, AgentServiceOptions, L0InjectableAgentService, MessageMetadata, PreparedProviderRequestV1 } from '../../types.js';
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

/** Well-known trae-cli binary locations on Windows.
 * TRAE CLI 2.x (traecli, e.g. 0.215.0) installs to Programs\TraeCLI\bin with
 * traex.exe as the real binary; the 1.x installer's trae-cli.exe path is kept
 * for machines that still run the 1.x line.
 */
const TRAE_WIN_PATHS = [
  'C:\\Users\\Administrator\\AppData\\Local\\Programs\\TraeCLI\\bin\\traex.exe',
  'C:\\Users\\Administrator\\AppData\\Local\\trae-cli\\bin\\trae-cli.exe',
];

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
      const args = this.buildArgs(options?.sessionId, effectiveModel, imageAccessDirs, options?.cliConfigArgs);

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

      // F299: provider request recorder fence — must fire before spawnCli.
      // The prompt travels via stdin (exec reads instructions from stdin),
      // so the recorder body IS the effective prompt; no argv slot to rewrite.
      const preparedRequest: PreparedProviderRequestV1 = Object.freeze({
        v: 1,
        message: Object.freeze({ body: effectivePrompt }),
        nativeInstructions: Object.freeze([]),
        runtime: Object.freeze({
          provider: 'trae',
          carrier: 'exec_stdin',
          ...(effectiveModel ? { model: effectiveModel } : {}),
          protocol: 'jsonl',
        }),
        tools: Object.freeze({ finalSurface: 'unknown' as const }),
        providerNativeVisibility: 'unknown',
      });
      await options?.beforeProviderLaunch?.(preparedRequest);
      if (!('body' in preparedRequest.message)) throw new Error('trae_prepared_message_not_exact');
      const promptBody: string = preparedRequest.message.body;

      const cliOpts = {
        command: traeCommand,
        args,
        // Prompt via stdin: `exec -` reads instructions from stdin (2.x).
        // This retires the 1.x argv-only mode and its 28K truncation.
        stdinInput: promptBody,
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
    sessionId: string | undefined,
    model: string | undefined,
    imageAccessDirs: readonly string[] | undefined,
    cliConfigArgs: readonly string[] | undefined,
  ): string[] {
    const args: string[] = [];

    // TRAE CLI 2.x (traecli exec): non-interactive mode is the `exec`
    // subcommand and `--json` emits codex-style thread/item/turn JSONL
    // events (mapped in trae-event-transform). The 1.x invocation shape
    // (--output-format stream-json + -p <prompt>) is gone — 2.x parses
    // `-p` as --profile.
    args.push('exec', '--json');

    // Session resume: DISABLED (same policy as the 1.x era). 2.x offers
    // `exec resume`, but our continuity model is a fresh session plus
    // L0/thread-context injection; revisit if sessionChain needs change.
    void sessionId;

    // Model selection: 2.x has a proper -m/--model flag (the 1.x --model was
    // broken and required the -c model.name workaround).
    const effectiveModel = model ?? this.model;
    if (effectiveModel) {
      args.push('-m', effectiveModel);
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

    // Prompt travels via stdin: `exec -` reads instructions from stdin, which
    // retires the 1.x argv-only limitation and its 28K truncation entirely.
    args.push('-');

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

