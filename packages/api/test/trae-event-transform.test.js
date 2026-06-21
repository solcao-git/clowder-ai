/**
 * TraeAgentService + trae-event-transform tests
 *
 * Tests event transformation logic and argument building
 * without requiring an actual trae-cli binary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTraeTransformState, transformTraeEvent } from '../dist/domains/cats/services/agents/providers/trae-event-transform.js';

const CAT_ID = 'cat-qxo3csnl';
const METADATA = { provider: 'trae', model: '智谱glm-5.2' };

describe('trae-event-transform', () => {
  it('system/init → session_init', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-123',
        tools: ['Bash(echo:*)', 'Read'],
        model: '智谱glm-5.1',
        permission_mode: 'bypass_permissions',
      },
      CAT_ID,
      METADATA,
      state,
    );
    assert.ok(result);
    assert.equal(result.type, 'session_init');
    assert.equal(result.sessionId, 'test-session-123');
    assert.equal(state.sessionId, 'test-session-123');
    assert.equal(state.model, '智谱glm-5.1');
  });

  it('system/status → null (skipped)', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      { type: 'system', subtype: 'status', session_id: 's1', updates: { cwd: '/tmp' } },
      CAT_ID,
      METADATA,
      state,
    );
    assert.equal(result, null);
  });

  it('assistant with text → text message', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      {
        type: 'assistant',
        session_id: 's1',
        message: {
          role: 'assistant',
          content: 'Hello, world!',
        },
      },
      CAT_ID,
      METADATA,
      state,
    );
    assert.ok(result);
    // assistant events return arrays (text + possible tool_calls)
    const msg = Array.isArray(result) ? result[0] : result;
    assert.equal(msg.type, 'text');
    assert.equal(msg.content, 'Hello, world!');
  });

  it('assistant with tool_calls → tool_use message', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      {
        type: 'assistant',
        session_id: 's1',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'tc-1',
              type: 'function',
              function: { name: 'Bash', arguments: '{"command":"ls"}' },
            },
          ],
        },
      },
      CAT_ID,
      METADATA,
      state,
    );
    assert.ok(result);
    assert.ok(Array.isArray(result));
    assert.equal(result[0].type, 'tool_use');
    assert.equal(result[0].toolUseId, 'tc-1');
    assert.equal(result[0].toolName, 'Bash');
    assert.ok(state.pendingToolCalls.has('tc-1'));
  });

  it('user/tool_result → tool_result message', () => {
    const state = createTraeTransformState();
    // First add a pending tool call
    state.pendingToolCalls.set('tc-1', { name: 'Bash', input: '{}' });
    const result = transformTraeEvent(
      {
        type: 'user',
        subtype: 'tool_result',
        session_id: 's1',
        tool_use_id: 'tc-1',
        tool_name: 'Bash',
        content: { content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }] },
      },
      CAT_ID,
      METADATA,
      state,
    );
    assert.ok(result);
    assert.equal(result.type, 'tool_result');
    assert.equal(result.toolUseId, 'tc-1');
    assert.equal(result.content, 'file1.txt\nfile2.txt');
    // pendingToolCall should be cleaned up
    assert.ok(!state.pendingToolCalls.has('tc-1'));
  });

  it('result/success → done with usage', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      {
        type: 'result',
        subtype: 'success',
        session_id: 's1',
        result: 'hello',
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          cache_read_input_tokens: 800,
        },
        duration_ms: 2000,
      },
      CAT_ID,
      METADATA,
      state,
    );
    assert.ok(result);
    assert.equal(result.type, 'done');
    assert.ok(result.metadata?.usage);
    assert.equal(result.metadata.usage.inputTokens, 1000);
    assert.equal(result.metadata.usage.outputTokens, 50);
    assert.equal(result.metadata.usage.cacheReadTokens, 800);
    assert.equal(state.emittedDone, true);
  });

  it('result/error → error message', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      {
        type: 'result',
        subtype: 'error',
        session_id: 's1',
        error: 'Something went wrong',
      },
      CAT_ID,
      METADATA,
      state,
    );
    assert.ok(result);
    assert.equal(result.type, 'error');
    assert.ok(result.error.includes('Something went wrong'));
    assert.equal(state.emittedDone, true);
  });

  it('assistant with response_meta → usage extracted', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      {
        type: 'assistant',
        session_id: 's1',
        message: {
          role: 'assistant',
          content: 'test',
          response_meta: {
            finish_reason: 'stop',
            usage: {
              prompt_tokens: 500,
              completion_tokens: 10,
              cached_tokens: 400,
            },
          },
        },
      },
      CAT_ID,
      METADATA,
      state,
    );
    assert.ok(result);
    // assistant events return arrays
    const msg = Array.isArray(result) ? result[0] : result;
    assert.equal(msg.type, 'text');
    assert.equal(state.usage?.inputTokens, 500);
    assert.equal(state.usage?.outputTokens, 10);
    assert.equal(state.usage?.cacheReadTokens, 400);
  });

  it('null for unknown event type', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      { type: 'unknown_type', data: 'something' },
      CAT_ID,
      METADATA,
      state,
    );
    assert.equal(result, null);
  });

  it('null for non-object event', () => {
    const state = createTraeTransformState();
    assert.equal(transformTraeEvent(null, CAT_ID, METADATA, state), null);
    assert.equal(transformTraeEvent('string', CAT_ID, METADATA, state), null);
    assert.equal(transformTraeEvent(42, CAT_ID, METADATA, state), null);
  });

  it('text + tool_use from single assistant event → array of messages', () => {
    const state = createTraeTransformState();
    const result = transformTraeEvent(
      {
        type: 'assistant',
        session_id: 's1',
        message: {
          role: 'assistant',
          content: 'Let me check the files',
          tool_calls: [
            {
              id: 'tc-2',
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path":"/tmp/test.txt"}' },
            },
          ],
        },
      },
      CAT_ID,
      METADATA,
      state,
    );
    assert.ok(result);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'text');
    assert.equal(result[0].content, 'Let me check the files');
    assert.equal(result[1].type, 'tool_use');
    assert.equal(result[1].toolName, 'Read');
  });
});

describe('TraeAgentService buildArgs', () => {
  it('builds args with stream-json output format', async () => {
    const { TraeAgentService } = await import('../dist/domains/cats/services/agents/providers/TraeAgentService.js');
    const svc = new TraeAgentService({ catId: 'test-cat', model: 'test-model' });
    // Access private method via bracket notation for testing
    const args = svc['buildArgs']('hello', undefined, 'test-model');
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('hello'));
    assert.ok(args.includes('-y'));
  });

  it('uses -c model.name= for model selection', async () => {
    const { TraeAgentService } = await import('../dist/domains/cats/services/agents/providers/TraeAgentService.js');
    const svc = new TraeAgentService({ catId: 'test-cat', model: '智谱glm-5.2' });
    const args = svc['buildArgs']('test', undefined, '智谱glm-5.2');
    assert.ok(args.includes('-c'));
    const modelIdx = args.indexOf('-c');
    assert.equal(args[modelIdx + 1], 'model.name=智谱glm-5.2');
  });

  it('includes --resume when sessionId provided', async () => {
    const { TraeAgentService } = await import('../dist/domains/cats/services/agents/providers/TraeAgentService.js');
    const svc = new TraeAgentService({ model: 'test-model' });
    const args = svc['buildArgs']('test', 'sess-123', 'model');
    assert.ok(args.includes('--resume'));
    assert.ok(args.includes('sess-123'));
  });

  it('strips = from model name to prevent key=value parsing breakage', async () => {
    const { TraeAgentService } = await import('../dist/domains/cats/services/agents/providers/TraeAgentService.js');
    const svc = new TraeAgentService({ model: 'test-model' });
    const args = svc['buildArgs']('test', undefined, 'model=with=equals');
    const modelIdx = args.indexOf('-c');
    // All = should be stripped from model name
    assert.equal(args[modelIdx + 1], 'model.name=modelwithequals');
  });
});
