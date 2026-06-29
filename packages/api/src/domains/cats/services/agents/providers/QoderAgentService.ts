/**
 * Qoder Agent Service
 * Qoder CLI (qodercli) subprocess via print mode + stream-json.
 *
 * CLI invocation:
 *   qodercli -p "prompt" -f stream-json [-r <sessionId>] [--model <level>]
 *
 * Qoder stream-json events:
 *   system/init       → session_init
 *   assistant/message → text + reasoning (thinking)
 *   result/success    → done (emitted twice by Qoder — deduplicated by transformer)
 *   result/error      → error
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import type { RawArchiveSink } from '../providers/codex-audit-hooks.js';
import { sanitizeRawEvent } from '../providers/codex-audit-hooks.js';
import { appendLocalImagePathHints } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import {
  createQoderTransformState,
  transformQoderEvent,
} from './qoder-event-transform.js';

const log = createModuleLogger('qoder-agent');

// ────────── MCP Server Injection ──────────

/**
 * Cat-cafe split MCP server entries (same set as CodexAgentService).
 * Qoder CLI receives these via --mcp-config inline JSON.
 */
const CAT_CAFE_MCP_SERVER_ENTRIES = [
  ['cat-cafe-collab', 'collab.js'],
  ['cat-cafe-memory', 'memory.js'],
  ['cat-cafe-signals', 'signals.js'],
  ['cat-cafe-limb', 'limb.js'],
  ['cat-cafe-audio', 'audio.js'],
  ['cat-cafe-finance', 'finance.js'],
] as const;

const CAT_CAFE_MCP_CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_THREAD_ID',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_SIGNAL_USER',
] as const;

function resolveAllowedWorkspaceDirsForMcp(workingDirectory?: string): string {
  const explicitAllowed = process.env.ALLOWED_WORKSPACE_DIRS?.trim();
  if (explicitAllowed) return explicitAllowed;
  const threadWorkspace = workingDirectory?.trim();
  if (threadWorkspace) return resolve(threadWorkspace);
  const explicitWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  if (explicitWorkspace) return explicitWorkspace;
  return process.cwd();
}

/**
 * Build cat-cafe MCP server config as --mcp-config inline JSON for Qoder CLI.
 * Qoder CLI 0.1.25+ supports `--mcp-config` flag to load MCP servers from
 * a JSON string (same schema as .mcp.json: { mcpServers: { name: { command, args, env } } }).
 *
 * This mirrors CodexAgentService's `buildCatCafeMcpConfigArgs` but uses Qoder's
 * --mcp-config flag instead of Codex's --config TOML key-value pairs.
 */
function buildCatCafeMcpConfigArgs(workingDirectory?: string, callbackEnv?: Record<string, string>): string[] {
  const fileDir = dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    process.env.CAT_CAFE_RUNTIME_ROOT?.trim(),
    process.cwd(),
    resolve(fileDir, '../../../../../../../..'),
  ].filter((root): root is string => !!root);

  let mcpDistDir: string | undefined;
  for (const root of candidateRoots) {
    const candidate = resolve(root, 'packages/mcp-server/dist');
    if (existsSync(resolve(candidate, 'index.js'))) {
      mcpDistDir = candidate;
      break;
    }
  }
  if (!mcpDistDir) return [];

  const allowedWorkspaceDirs = resolveAllowedWorkspaceDirsForMcp(workingDirectory);
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};

  for (const [serverName, entrypoint] of CAT_CAFE_MCP_SERVER_ENTRIES) {
    const serverPath = resolve(mcpDistDir, entrypoint);
    if (!existsSync(serverPath)) continue;

    const env: Record<string, string> = { ALLOWED_WORKSPACE_DIRS: allowedWorkspaceDirs };
    for (const key of CAT_CAFE_MCP_CALLBACK_ENV_KEYS) {
      const value = callbackEnv?.[key];
      if (value) env[key] = value;
    }

    mcpServers[serverName] = {
      command: 'node',
      args: [serverPath],
      env,
    };
  }

  if (Object.keys(mcpServers).length === 0) return [];

  const mcpConfigJson = JSON.stringify({ mcpServers });
  return ['--mcp-config', mcpConfigJson];
}

/** Well-known qodercli binary locations on Windows. */
const QODER_WIN_PATHS = [
  'C:\\Program Files\\Qoder\\resources\\app\\resources\\bin\\x86_64_windows\\qodercli.exe',
];

interface QoderAgentServiceOptions {
  catId?: CatId;
  spawnFn?: SpawnFn;
  model?: string;
  /** #780: Raw NDJSON archive sink (default: CliRawArchive to disk) */
  rawArchive?: RawArchiveSink;
}

/**
 * Resolve qodercli binary — checks PATH first, then well-known locations.
 */
function resolveQoderCommand(): string | null {
  // Well-known paths FIRST — must check before PATH to avoid picking up
  // qoder.cmd (IDE launcher, like VS Code's `code` cmd) instead of qodercli.exe (agent CLI)
  for (const p of QODER_WIN_PATHS) {
    if (existsSync(p)) return p;
  }

  // PATH fallback — only look for 'qodercli' (not 'qoder' which matches the IDE launcher qoder.cmd)
  return resolveCliCommand('qodercli');
}

export class QoderAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;
  /** #780: Raw NDJSON archive for post-mortem diagnostics */
  private readonly rawArchive: RawArchiveSink;

  constructor(options?: QoderAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('qoder');
    this.spawnFn = options?.spawnFn;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_QODER_MODEL_OVERRIDE ?? this.model;
    const metadata: MessageMetadata = { provider: 'qoder', model: effectiveModel };

    // Image support: extract paths and build --attachment args for native multimodal passing.
    // qodercli --attachment attaches files to the message, letting the model see images natively.
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageArgs = imagePaths.flatMap((path: string) => ['--attachment', path]);
    // Also append path hints as textual fallback reference
    const effectivePrompt = appendLocalImagePathHints(prompt, imagePaths);

    const qoderCommand = resolveQoderCommand();
    if (!qoderCommand) {
      yield {
        type: 'error' as const,
        catId: this.catId,
        error: formatCliNotFoundError('qodercli'),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    const args: string[] = ['-f', 'stream-json'];

    // Session resume
    if (options?.sessionId) {
      args.push('-r', options.sessionId);
      metadata.sessionId = options.sessionId;
      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: options.sessionId,
        metadata,
        timestamp: Date.now(),
      };
    }

    // Model selection
    if (effectiveModel && effectiveModel !== 'Auto') {
      args.push('--model', effectiveModel);
    }

    // Working directory
    if (options?.workingDirectory) {
      args.push('-w', options.workingDirectory);
    }

    // Image file attachments (--attachment flag: native multimodal passing)
    if (imageArgs.length > 0) {
      args.push(...imageArgs);
    }

    // Cat-cafe MCP server injection via --mcp-config (Qoder CLI 0.1.25+).
    // Provides cat_cafe_* tool access (collab, memory, signals, limb, audio, finance)
    // to Qoder-served cats (e.g. 雷电将军, 七七).
    const catCafeMcpArgs = buildCatCafeMcpConfigArgs(options?.workingDirectory, options?.callbackEnv);
    if (catCafeMcpArgs.length > 0) {
      args.push(...catCafeMcpArgs);
    }

    // Enable experimental MCP tool loading so the agent can discover and use MCP tools
    args.push('--experimental-mcp-load');

    // Print mode + prompt (must be last)
    args.push('-p', effectivePrompt);

    // User-defined CLI args from the member editor (#567).
    const userParts: string[] = [];
    for (const arg of options?.cliConfigArgs ?? []) {
      userParts.push(...arg.trim().split(/\s+/));
    }
    if (userParts.length > 0) {
      args.push(...userParts);
    }

    try {
      let emittedSessionInit = Boolean(options?.sessionId);
      let hadCliError = false;
      const transformState = createQoderTransformState();

      const cliOpts = {
        command: qoderCommand,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options?.callbackEnv || options?.accountEnv
          ? { env: { ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) } }
          : {}),
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

      for await (const event of events) {
        // #780: Archive raw event for post-mortem diagnostics
        if (options?.invocationId) {
          this.rawArchive.append(options.invocationId, sanitizeRawEvent(event)).catch((err) => {
            log.warn({ catId: this.catId, invocationId: options.invocationId, err }, 'Raw archive write failed');
          });
        }

        if (isCliTimeout(event)) {
          hadCliError = true;
          yield {
            type: 'error' as const,
            catId: this.catId,
            error: `Qoder CLI timeout: no output for ${event.silenceDurationMs}ms`,
            metadata: {
              ...metadata,
              sessionId: transformState.sessionId ?? metadata.sessionId,
              cliDiagnostics: event.cliDiagnostics,
            },
            timestamp: Date.now(),
          };
          break;
        }

        if (isCliError(event)) {
          hadCliError = true;
          yield {
            type: 'error' as const,
            catId: this.catId,
            error: formatCliExitError('Qoder CLI', event),
            metadata: {
              ...metadata,
              sessionId: transformState.sessionId ?? metadata.sessionId,
              cliDiagnostics: event.cliDiagnostics,
            },
            timestamp: Date.now(),
          };
          break;
        }

        if (isLivenessWarning(event)) {
          yield {
            type: 'liveness_signal' as const,
            catId: this.catId,
            content: `Qoder CLI liveness: ${event.level} (${event.state}, ${event.silenceDurationMs}ms silent)`,
            timestamp: Date.now(),
          };
          continue;
        }

        // Transform Qoder event → AgentMessage
        const msg = transformQoderEvent(event, this.catId, transformState);
        if (msg) {
          // Attach metadata to session_init and done events
          if (msg.type === 'session_init') {
            emittedSessionInit = true;
            msg.metadata = { ...metadata, ...msg.metadata, sessionId: msg.sessionId ?? transformState.sessionId };
          }
          if (msg.type === 'done') {
            msg.metadata = {
              ...metadata,
              ...msg.metadata,
              sessionId: transformState.sessionId ?? metadata.sessionId,
              usage: transformState.usage,
            };
          }
          yield msg;
        }

        // Drain pending overflow messages from multi-block assistant events
        while (transformState.pendingMessages.length > 0) {
          yield transformState.pendingMessages.shift()!;
        }
      }

      // If no session_init was emitted from the stream, emit one from transform state
      if (!emittedSessionInit && transformState.sessionId) {
        yield {
          type: 'session_init',
          catId: this.catId,
          sessionId: transformState.sessionId,
          metadata: { ...metadata, sessionId: transformState.sessionId },
          timestamp: Date.now(),
        };
      }

      // If CLI exited cleanly but no done event was emitted (e.g. truncated stream)
      if (!transformState.emittedDone && !hadCliError) {
        log.debug({ catId: this.catId }, 'Qoder silent completion — emitting synthetic done');
        yield {
          type: 'done' as const,
          catId: this.catId,
          metadata: {
            ...metadata,
            sessionId: transformState.sessionId ?? metadata.sessionId,
            usage: transformState.usage,
          },
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      log.error({ catId: this.catId, err }, 'Qoder invocation failed');
      yield {
        type: 'error' as const,
        catId: this.catId,
        error: err instanceof Error ? err.message : String(err),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
    }
  }
}
