/**
 * Voice intent detection integration tests.
 *
 * Tests the auto-wrap logic added to route-serial.ts:
 * When Voice Mode is OFF + no existing audio block + co-creator message
 * contains voice intent keywords → CLI text response is auto-wrapped
 * into an audio rich block for TTS synthesis.
 *
 * Multi-cat coverage: tests with different catId/CLI combos to verify
 * the logic is CLI-agnostic (codex/gemini/opencode/etc.).
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const REPO_TEMPLATE_PATH = fileURLToPath(new URL('../../../cat-template.json', import.meta.url));

function createCapturingService(catId, text, extraEvents = []) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      for (const ev of extraEvents) yield ev;
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createServiceWithAudioBlock(catId, text) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({
          type: 'rich_block',
          block: {
            id: `cli-audio-${Date.now()}`,
            kind: 'audio',
            v: 1,
            url: '',
            text: 'CLI 主动生成的语音',
          },
        }),
        timestamp: Date.now(),
      };
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, { threadVoiceMode = false } = {}) {
  let counter = 0;
  const storedMessages = [];
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => ({ voiceMode: threadVoiceMode }),
        consumeMentionRoutingFeedback: async () => null,
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        counter++;
        const stored = {
          id: `msg-${counter}`,
          userId: msg.userId ?? '',
          catId: msg.catId ?? null,
          content: msg.content ?? '',
          mentions: msg.mentions ?? [],
          timestamp: msg.timestamp ?? 0,
          richBlocks: msg.extra?.rich?.blocks ?? [],
        };
        storedMessages.push(stored);
        return stored;
      },
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    _storedMessages: storedMessages,
  };
}

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig(REPO_TEMPLATE_PATH));
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

async function collectEvents(deps, catId, userMessage, threadId) {
  const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
  const events = [];
  for await (const msg of routeSerial(deps, [catId], userMessage, 'user1', threadId, {
    thinkingMode: 'play',
  })) {
    events.push(msg);
  }
  return events;
}

function findRichBlocks(deps, events) {
  const blocks = [];
  if (deps._storedMessages) {
    for (const msg of deps._storedMessages) {
      if (msg.richBlocks) blocks.push(...msg.richBlocks);
    }
  }
  for (const e of events) {
    if (e.richBlocks) blocks.push(...e.richBlocks);
  }
  return blocks;
}

function findAudioBlocks(blocks) {
  return blocks.filter((b) => b.kind === 'audio');
}

describe('Voice intent auto-wrap', { concurrency: false }, () => {
  test('用语音 → auto-wrap audio block (codex/钟离)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const codexService = createCapturingService('codex', '你好，我是钟离。');
      const deps = createMockDeps({ codex: codexService });
      const events = await collectEvents(deps, 'codex', '用语音跟我打个招呼', 'thread-voice-1');
      const blocks = findRichBlocks(deps, events);
      const audioBlocks = findAudioBlocks(blocks);
      assert.ok(audioBlocks.length > 0, 'must auto-wrap audio block when voice intent detected');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('说给我听 → auto-wrap audio block (gemini/玛薇卡)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const geminiService = createCapturingService('gemini', '我是玛薇卡，火之神。');
      const deps = createMockDeps({ gemini: geminiService });
      const events = await collectEvents(deps, 'gemini', '说给我听', 'thread-voice-2');
      const blocks = findRichBlocks(deps, events);
      const audioBlocks = findAudioBlocks(blocks);
      assert.ok(audioBlocks.length > 0, 'must auto-wrap for 说给我听 pattern');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('讲两句 → auto-wrap audio block (opencode/温迪)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const opencodeService = createCapturingService('opencode', '我是温迪，风神。');
      const deps = createMockDeps({ opencode: opencodeService });
      const events = await collectEvents(deps, 'opencode', '讲两句', 'thread-voice-3');
      const blocks = findRichBlocks(deps, events);
      const audioBlocks = findAudioBlocks(blocks);
      assert.ok(audioBlocks.length > 0, 'must auto-wrap for 讲两句 pattern');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('voice (English) → auto-wrap audio block', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const claudeService = createCapturingService('opus', 'Hello, I am Nahida.');
      const deps = createMockDeps({ opus: claudeService });
      const events = await collectEvents(deps, 'opus', 'please use voice to say hello', 'thread-voice-4');
      const blocks = findRichBlocks(deps, events);
      const audioBlocks = findAudioBlocks(blocks);
      assert.ok(audioBlocks.length > 0, 'must auto-wrap for English "voice" pattern');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
});

describe('Voice intent — negative cases (no false positive)', { concurrency: false }, () => {
  test('普通消息 (no voice intent) → NO audio block', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const codexService = createCapturingService('codex', '代码已提交。');
      const deps = createMockDeps({ codex: codexService });
      const events = await collectEvents(deps, 'codex', '提交一下代码', 'thread-voice-neg-1');
      const blocks = findRichBlocks(deps, events);
      const audioBlocks = findAudioBlocks(blocks);
      assert.strictEqual(audioBlocks.length, 0, 'must NOT auto-wrap when no voice intent');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('Voice Mode ON → NO auto-wrap (streaming TTS handles it)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const codexService = createCapturingService('codex', '你好。');
      const deps = createMockDeps({ codex: codexService }, { threadVoiceMode: true });
      const events = await collectEvents(deps, 'codex', '用语音打个招呼', 'thread-voice-vm-on');
      const blocks = findRichBlocks(deps, events);
      const autoBlocks = blocks.filter((b) => b.kind === 'audio' && b.id?.startsWith('auto-voice-'));
      assert.strictEqual(autoBlocks.length, 0, 'must NOT auto-wrap when Voice Mode is ON');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('CLI already produced audio block → NO double-wrap', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const codexService = createServiceWithAudioBlock('codex', '你好。');
      const deps = createMockDeps({ codex: codexService });
      const events = await collectEvents(deps, 'codex', '用语音打个招呼', 'thread-voice-existing');
      const blocks = findRichBlocks(deps, events);
      const audioBlocks = findAudioBlocks(blocks);
      const autoBlocks = audioBlocks.filter((b) => b.id?.startsWith('auto-voice-'));
      assert.strictEqual(autoBlocks.length, 0, 'must NOT add auto-voice block when CLI already produced audio');
      assert.ok(audioBlocks.length >= 1, 'original CLI audio block should still be present');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
});
