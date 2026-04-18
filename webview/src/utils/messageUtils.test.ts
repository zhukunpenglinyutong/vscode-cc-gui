import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { getContentBlocks, getMessageKey, mergeConsecutiveAssistantMessages } from './messageUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMsg = (
  type: ClaudeMessage['type'],
  content: string,
  extra?: Partial<ClaudeMessage>,
): ClaudeMessage => ({
  type,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

// ---------------------------------------------------------------------------
// getMessageKey — __turnId support
// ---------------------------------------------------------------------------

describe('getMessageKey', () => {
  it('returns uuid when present', () => {
    const msg = makeMsg('assistant', 'hello', { raw: { uuid: 'abc-123' } as any });
    expect(getMessageKey(msg, 0)).toBe('abc-123');
  });

  it('returns uuid even when __turnId is also present', () => {
    const msg = makeMsg('assistant', 'hello', {
      raw: { uuid: 'abc-123' } as any,
      __turnId: 5,
    });
    expect(getMessageKey(msg, 0)).toBe('abc-123');
  });

  it('returns __turnId-based key when uuid is absent', () => {
    const msg = makeMsg('assistant', 'hello', { __turnId: 3 });
    expect(getMessageKey(msg, 0)).toBe('turn-3');
  });

  it('falls back to type-timestamp when both uuid and __turnId are absent', () => {
    const ts = '2024-01-01T00:00:00Z';
    const msg = makeMsg('user', 'hello', { timestamp: ts });
    expect(getMessageKey(msg, 0)).toBe(`user-${ts}`);
  });

  it('falls back to type-index when no uuid, __turnId, or timestamp', () => {
    const msg: ClaudeMessage = { type: 'assistant', content: 'hi' };
    expect(getMessageKey(msg, 7)).toBe('assistant-7');
  });
});

// ---------------------------------------------------------------------------
// getContentBlocks — prefer longer assistant `content` over stale raw text
// ---------------------------------------------------------------------------

describe('getContentBlocks', () => {
  const localize = (s: string) => s;

  const normalizeBlocks = (raw: unknown): any[] | null => {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as any;
    const blocks = r.content ?? r.message?.content;
    return Array.isArray(blocks) ? blocks : null;
  };

  it('uses top-level content when longer than text extracted from raw', () => {
    const full = '我是 **Claude Opus 4.6**, 由 Anthropic 开发。';
    const msg = makeMsg('assistant', full, {
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: '…' },
            { type: 'text', text: '我是 **' },
          ],
        },
      } as any,
    });
    const blocks = getContentBlocks(msg, normalizeBlocks, localize);
    const textBlocks = blocks.filter((b) => b.type === 'text');
    expect(textBlocks).toHaveLength(1);
    expect((textBlocks[0] as any).text).toBe(full);
  });
});

// ---------------------------------------------------------------------------
// mergeConsecutiveAssistantMessages — __turnId preservation
// ---------------------------------------------------------------------------

describe('mergeConsecutiveAssistantMessages', () => {
  const normalizeBlocks = (raw: unknown): any[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as any;
    const blocks = r.content ?? r.message?.content;
    return Array.isArray(blocks) ? blocks : [];
  };

  it('preserves __turnId from first message in merged group', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBe(2);
  });

  it('does not add __turnId when first message has none', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBeUndefined();
  });

  it('does not merge across user messages', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'a1', { __turnId: 1 }),
      makeMsg('user', 'q'),
      makeMsg('assistant', 'a2', { __turnId: 2 }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(3);
    expect(result[0].__turnId).toBe(1);
    expect(result[2].__turnId).toBe(2);
  });
});
