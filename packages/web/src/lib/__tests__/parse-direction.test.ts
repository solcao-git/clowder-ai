import { describe, expect, it } from 'vitest';
import { parseDirection } from '../parse-direction';

// Minimal mock: alias (lowercase, no @) → catId
const mockToCat: Record<string, string> = {
  nahida: 'nahida',
  纳西妲: 'nahida',
  zhongli: 'zhongli',
  钟离: 'zhongli',
  gpt52: 'gpt52',
};

// Mock regex matching the same aliases (case-insensitive, boundary-aware)
const aliases = Object.keys(mockToCat).sort((a, b) => b.length - a.length);
const mockRe = new RegExp(`@(${aliases.join('|')})(?=$|\\s|[,.:;!?])`, 'gi');

const getMocks = () => ({ toCat: mockToCat, re: mockRe });

describe('parseDirection', () => {
  it('returns null for stream origin messages', () => {
    const msg = { origin: 'stream' as const, content: '@zhongli hi' };
    expect(parseDirection(msg, getMocks)).toBeNull();
  });

  it('parses single @mention from callback content', () => {
    const msg = { origin: 'callback' as const, content: 'R2 修复确认\n\n@zhongli' };
    expect(parseDirection(msg, getMocks)).toEqual({
      type: 'mention',
      targets: ['zhongli'],
      arrow: '→',
    });
  });

  it('parses multiple distinct @mentions', () => {
    const msg = { origin: 'callback' as const, content: '通知\n@zhongli\n@gpt52' };
    const result = parseDirection(msg, getMocks);
    expect(result?.type).toBe('mention');
    expect(result?.targets).toContain('zhongli');
    expect(result?.targets).toContain('gpt52');
    expect(result?.targets).toHaveLength(2);
  });

  it('deduplicates same cat from different aliases', () => {
    const msg = { origin: 'callback' as const, content: '@zhongli @钟离' };
    expect(parseDirection(msg, getMocks)).toEqual({
      type: 'mention',
      targets: ['zhongli'],
      arrow: '→',
    });
  });

  it('parses crossPost direction from extra metadata', () => {
    const msg = {
      origin: 'callback' as const,
      content: 'cross post content',
      extra: { crossPost: { sourceThreadId: 'thread_abc12345xyz' } },
    };
    expect(parseDirection(msg, getMocks)).toEqual({
      type: 'crossPost',
      targets: ['abc12345'],
      arrow: '↗',
    });
  });

  it('parses whisper direction from whisperTo (highest priority)', () => {
    const msg = {
      visibility: 'whisper' as const,
      whisperTo: ['zhongli', 'gpt52'],
      content: '@nahida secret',
    };
    expect(parseDirection(msg, getMocks)).toEqual({
      type: 'whisper',
      targets: ['zhongli', 'gpt52'],
      arrow: '→',
    });
  });

  it('returns null for callback with no recognized @mention', () => {
    const msg = { origin: 'callback' as const, content: 'general broadcast to all' };
    expect(parseDirection(msg, getMocks)).toBeNull();
  });

  it('returns null for messages with no origin and no whisper', () => {
    const msg = { content: 'hello world' };
    expect(parseDirection(msg, getMocks)).toBeNull();
  });

  it('parses targets from connector source.meta (F098-C2 multi_mention)', () => {
    const msg = {
      content: '## Multi-Mention 结果汇总',
      source: {
        connector: 'multi-mention-result',
        meta: { initiator: 'nahida', targets: ['zhongli', 'gpt52', 'mavuika'] },
      },
    };
    const result = parseDirection(msg, getMocks);
    expect(result).toEqual({
      type: 'mention',
      targets: ['zhongli', 'gpt52', 'mavuika'],
      arrow: '→',
    });
  });

  it('connector source.meta.targets takes priority over content @mention parsing', () => {
    const msg = {
      origin: 'callback' as const,
      content: '@zhongli some content',
      source: {
        connector: 'multi-mention-result',
        meta: { targets: ['zhongli', 'gpt52'] },
      },
    };
    const result = parseDirection(msg, getMocks);
    // Should use meta.targets, not content parsing
    expect(result?.targets).toEqual(['zhongli', 'gpt52']);
  });

  it('uses extra.targetCats when present (F098-C1)', () => {
    const msg = {
      origin: 'callback' as const,
      content: 'Review done',
      extra: { targetCats: ['zhongli', 'gpt52'] },
    };
    const result = parseDirection(msg, getMocks);
    expect(result).toEqual({
      type: 'mention',
      targets: ['zhongli', 'gpt52'],
      arrow: '→',
    });
  });

  it('extra.targetCats takes priority over content @mention parsing (F098-C1)', () => {
    const msg = {
      origin: 'callback' as const,
      content: '@zhongli some content',
      extra: { targetCats: ['gpt52'] },
    };
    const result = parseDirection(msg, getMocks);
    expect(result?.targets).toEqual(['gpt52']);
  });

  it('filters out __co-creator__ pseudo-cat from @mention results (P1-2)', () => {
    // getMentionToCat maps @co-creator/@co-creator to __co-creator__ — must not leak into UI
    const ownerToCat: Record<string, string> = {
      ...mockToCat,
      landy: '__co-creator__',
      'co-creator': '__co-creator__',
    };
    const ownerAliases = Object.keys(ownerToCat).sort((a, b) => b.length - a.length);
    const ownerRe = new RegExp(`@(${ownerAliases.join('|')})(?=$|\\s|[,.:;!?])`, 'gi');
    const getOwnerMocks = () => ({ toCat: ownerToCat, re: ownerRe });

    // Only @co-creator → should return null (owner filtered out)
    const msg1 = { origin: 'callback' as const, content: '通知co-creator\n@co-creator' };
    expect(parseDirection(msg1, getOwnerMocks)).toBeNull();

    // @co-creator + @zhongli → only zhongli in targets
    const msg2 = { origin: 'callback' as const, content: '@co-creator @zhongli' };
    const result = parseDirection(msg2, getOwnerMocks);
    expect(result?.targets).toEqual(['zhongli']);
  });
});
