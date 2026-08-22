import { describe, expect, it } from 'vitest';
import { applyCodexLiveMessage } from './codexLiveInsert';
import type { ClaudeMessage, ClaudeRawMessage } from '../types';

const TURN = 7;

function streamingSlot(content = ''): ClaudeMessage {
  return { type: 'assistant', content, isStreaming: true, __turnId: TURN };
}

function toolUseMsg(id: string, name = 'bash', text = ''): ClaudeRawMessage {
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: 'text', text });
  content.push({ type: 'tool_use', id, name, input: { command: 'ls' } });
  return { type: 'assistant', message: { content } } as ClaudeRawMessage;
}

function toolResultMsg(toolUseId: string): ClaudeRawMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  } as ClaudeRawMessage;
}

function textMsg(text: string): ClaudeRawMessage {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } } as ClaudeRawMessage;
}

/** Read the tool_use id from an assistant message's raw blocks. */
function idOf(msg: ClaudeMessage): string | undefined {
  const raw = msg.raw as ClaudeRawMessage | undefined;
  const blocks = (raw?.message?.content ?? raw?.content) as Array<Record<string, unknown>> | undefined;
  return blocks?.find((b) => b.type === 'tool_use')?.id as string | undefined;
}

describe('applyCodexLiveMessage', () => {
  it('freezes the current text segment and opens a fresh slot when a tool_use arrives', () => {
    const messages: ClaudeMessage[] = [
      { type: 'user', content: 'delete unused files' },
      streamingSlot('I will first re-check the files'),
    ];

    const res = applyCodexLiveMessage(
      messages,
      1,
      toolUseMsg('tool-1'),
      'I will first re-check the files',
      TURN,
    );

    expect(res.changed).toBe(true);
    expect(res.openedFreshSlot).toBe(true);
    // [user, frozen-text, tool_use, fresh-empty-slot]
    expect(res.messages).toHaveLength(4);
    expect(res.messages[1].isStreaming).toBe(false);
    expect(res.messages[1].content).toBe('I will first re-check the files');
    expect(idOf(res.messages[2])).toBe('tool-1');
    expect(res.messages[3].isStreaming).toBe(true);
    expect(res.messages[3].content).toBe('');
    // streaming index now points at the fresh slot
    expect(res.streamingIndex).toBe(3);
  });

  it('inserts a tool_result just before the streaming slot', () => {
    const messages: ClaudeMessage[] = [
      { type: 'assistant', content: 'text', isStreaming: false },
      toolUseAssistant('tool-1'),
      streamingSlot(''),
    ];

    const res = applyCodexLiveMessage(messages, 2, toolResultMsg('tool-1'), '', TURN);

    expect(res.changed).toBe(true);
    expect(res.messages).toHaveLength(4);
    expect(res.messages[2].type).toBe('user');
    expect(res.messages[2].content).toBe('[tool_result]');
    expect(res.messages[3].isStreaming).toBe(true);
    expect(res.streamingIndex).toBe(3);
  });

  it('reuses an empty slot for back-to-back tool_use without freezing', () => {
    const messages: ClaudeMessage[] = [streamingSlot('')];

    const res = applyCodexLiveMessage(messages, 0, toolUseMsg('tool-2'), '', TURN);

    expect(res.changed).toBe(true);
    expect(res.openedFreshSlot).toBe(false);
    // [tool_use, slot] — no frozen empty text message created
    expect(res.messages).toHaveLength(2);
    expect(idOf(res.messages[0])).toBe('tool-2');
    expect(res.messages[1].isStreaming).toBe(true);
    expect(res.streamingIndex).toBe(1);
  });

  it('is idempotent for an already-rendered tool_use', () => {
    // The tool_use is already present in the list (frozen assistant message).
    const messages: ClaudeMessage[] = [toolUseAssistant('tool-1'), streamingSlot('hi')];

    const res = applyCodexLiveMessage(messages, 1, toolUseMsg('tool-1'), 'hi', TURN);

    expect(res.changed).toBe(false);
    expect(res.messages).toBe(messages);
  });

  it('ignores assistant text-only messages (slot already shows them live)', () => {
    const messages: ClaudeMessage[] = [streamingSlot('partial')];
    const res = applyCodexLiveMessage(messages, 0, textMsg('partial'), 'partial', TURN);
    expect(res.changed).toBe(false);
  });

  it('preserves ordering across a full text -> tool -> result -> text round', () => {
    let messages: ClaudeMessage[] = [
      { type: 'user', content: 'q' },
      streamingSlot('step one'),
    ];
    let idx = 1;

    // tool_use for segment 1
    let res = applyCodexLiveMessage(messages, idx, toolUseMsg('t1'), 'step one', TURN);
    messages = res.messages;
    idx = res.streamingIndex;

    // tool_result for t1
    res = applyCodexLiveMessage(messages, idx, toolResultMsg('t1'), '', TURN);
    messages = res.messages;
    idx = res.streamingIndex;

    // second text segment lands in the fresh slot, then a second tool
    messages[idx] = { ...messages[idx], content: 'step two' };
    res = applyCodexLiveMessage(messages, idx, toolUseMsg('t2'), 'step two', TURN);
    messages = res.messages;

    const shape = res.messages.map((m) => `${m.type}:${idOf(m) ?? m.content ?? ''}`);
    expect(shape).toEqual([
      'user:q',
      'assistant:step one',
      'assistant:t1',
      'user:[tool_result]',
      'assistant:step two',
      'assistant:t2',
      'assistant:', // fresh trailing slot
    ]);
  });

  it('returns unchanged when the streaming index is invalid', () => {
    const messages: ClaudeMessage[] = [{ type: 'user', content: 'q' }];
    const res = applyCodexLiveMessage(messages, 5, toolUseMsg('t1'), '', TURN);
    expect(res.changed).toBe(false);
    expect(res.messages).toBe(messages);
  });
});

/** An already-frozen assistant tool_use message (raw carries the tool_use). */
function toolUseAssistant(id: string): ClaudeMessage {
  return { type: 'assistant', content: '', raw: toolUseMsg(id), isStreaming: false };
}
