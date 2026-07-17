/**
 * CodeBuddy Agent Service
 * CodeBuddy CLI (codebuddy/cbc) subprocess via print mode + stream-json.
 *
 * CLI invocation:
 *   codebuddy -p "prompt" --output-format stream-json [-r <sessionId>] [--model <model>]
 *
 * CodeBuddy stream-json events (identical to Qoder CLI format):
 *   system/init       → session_init (tools, provider, model, session_id)
 *   system/status     → internal status (skip)
 *   assistant         → text (content[].type:"text") + thinking (content[].type:"thinking")
 *   file-history-snapshot → internal (skip)
 *   result/success    → done (deduplicated)
 *   result/error      → error
 *
 * Architecture: mirrors QoderAgentService since both CLIs share the same
 * stream-json event format. Key differences:
 *   - CodeBuddy binary: codebuddy / cbc (not qodercli)
 *   - Session resume: -r flag (same as Qoder)
 *   - MCP injection: --mcp-config <fileOrString> (same as Qoder)
 *   - System prompt: --system-prompt <text> (CodeBuddy has this, Qoder too)
 *   - Permission mode: -y / --dangerously-skip-permissions
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
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

const log = createModuleLogger('codebuddy-agent');

// ────────── MCP Server Injection ──────────

/**
 * Cat-cafe split MCP server entries (same set as QoderAgentService).
 * CodeBuddy CLI receives these via --mcp-config inline JSON.
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
 * Build cat-cafe MCP server config as --mcp-config inline JSON for CodeBuddy CLI.
 * CodeBuddy supports `--mcp-config <fileOrString>` (same as Qoder).
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

interface CodeBuddyAgentServiceOptions {
  catId?: CatId;
  spawnFn?: SpawnFn;
  model?: string;
  /** #780: Raw NDJSON archive sink (default: CliRawArchive to disk) */
  rawArchive?: RawArchiveSink;
}

export class CodeBuddyAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;
  /** #780: Raw NDJSON archive for post-mortem diagnostics */
  private readonly rawArchive: RawArchiveSink;

  constructor(options?: CodeBuddyAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('codebuddy');
    this.spawnFn = options?.spawnFn;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.rawArchive = options?.rawArchive ?? new CliRawArchive();
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const effectiveModel = options?.callbackEnv?.CAT_CAFE_CODEBUDDY_MODEL_OVERRIDE ?? this.model;
    const metadata: MessageMetadata = { provider: 'codebuddy', model: effectiveModel };

    // Image support
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const imageArgs = imagePaths.flatMap((path: string) => ['--attachment', path]);
    const effectivePrompt = appendLocalImagePathHints(prompt, imagePaths);

    const codebuddyCommand = resolveCliCommand('codebuddy') ?? resolveCliCommand('cbc');
    if (!codebuddyCommand) {
      yield {
        type: 'error' as const,
        catId: this.catId,
        error: formatCliNotFoundError('codebuddy'),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done' as const, catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    const args: string[] = ['--print', '--output-format', 'stream-json'];

    // Session resume: validate session file exists before passing -r.
    // CodeBuddy stores sessions similarly to Qoder.
    let validSessionId = options?.sessionId;
    // CodeBuddy session resume with -r is simpler than Qoder — it loads from
    // internal storage. Skip file validation for now; let CodeBuddy handle it.
    if (validSessionId) {
      args.push('-r', validSessionId);
      metadata.sessionId = validSessionId;
      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: validSessionId,
        metadata,
        timestamp: Date.now(),
      };
    }

    // Model selection
    if (effectiveModel && effectiveModel !== 'Auto') {
      args.push('--model', effectiveModel);
    }

    // Working directory: use cwd (child process option) instead of -w flag.
    // CodeBuddy v2.123+ creates a git worktree when -w is passed, which crashes
    // in print mode ("✳ Creating worktree…" → exit 1). Setting cwd achieves the
    // same effect without triggering the worktree codepath.
    // Note: -w is still needed for interactive/session mode (CodeBuddy uses it to
    // locate its project config), but print mode (-p) doesn't need it.

    // System prompt separation (CodeBuddy supports --system-prompt)
    // This reduces argv pressure by moving L0 out of the prompt arg.
    const systemPrompt = options?.systemPrompt;
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    // Permission mode: bypass all checks (our route layer handles safety)
    args.push('-y');

    // Image file attachments
    if (imageArgs.length > 0) {
      args.push(...imageArgs);
    }

    // Cat-cafe MCP server injection via --mcp-config
    const catCafeMcpArgs = buildCatCafeMcpConfigArgs(options?.workingDirectory, options?.callbackEnv);
    if (catCafeMcpArgs.length > 0) {
      args.push(...catCafeMcpArgs);
    }

    // Print mode prompt (must be last positional arg)
    // When --system-prompt is used, the prompt is just the user message (no L0 prepend needed)
    args.push('-p', systemPrompt ? prompt : effectivePrompt);

    // User-defined CLI args
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
      // Reuse Qoder transform state since event formats are identical
      const transformState = createQoderTransformState();

      const cliOpts = {
        command: codebuddyCommand,
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
        // Archive raw event
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
            error: `CodeBuddy CLI timeout: no output for ${event.silenceDurationMs}ms`,
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
            error: formatCliExitError('CodeBuddy CLI', event),
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
            content: `CodeBuddy CLI liveness: ${event.level} (${event.state}, ${event.silenceDurationMs}ms silent)`,
            timestamp: Date.now(),
          };
          continue;
        }

        // Transform event — reuse Qoder transformer since formats are identical
        const msg = transformQoderEvent(event, this.catId, transformState);
        if (msg) {
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

      // If CLI exited cleanly but no done event was emitted
      if (!transformState.emittedDone && !hadCliError) {
        log.debug({ catId: this.catId }, 'CodeBuddy silent completion — emitting synthetic done');
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
      log.error({ catId: this.catId, err }, 'CodeBuddy invocation failed');
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
