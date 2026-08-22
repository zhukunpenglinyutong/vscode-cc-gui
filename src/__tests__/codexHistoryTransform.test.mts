import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformCodexHistoryRows } from '../bridge/services/codexHistoryTransform.ts';

const imageLoader = {
  imageBlockFromLocalPath(filePath: string) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: `data-for:${filePath}`,
      },
    };
  },
};

describe('transformCodexHistoryRows', () => {
  it('attaches user input_image rows that arrive before the event_msg user text', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-13T10:00:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', path: '/tmp/before.png' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-07-13T10:00:01.000Z',
        payload: {
          type: 'user_message',
          message: 'what is this?',
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'what is this?');
    assert.deepEqual(messages[0].raw.message.content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data-for:/tmp/before.png' } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('attaches user input_image rows that arrive after the event_msg user text', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'event_msg',
        timestamp: '2026-07-13T10:00:00.000Z',
        payload: {
          type: 'user_message',
          message: 'what is this?',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-13T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', path: '/tmp/after.png' }],
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'what is this?');
    assert.deepEqual(messages[0].raw.message.content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data-for:/tmp/after.png' } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('attaches response_item images to the matching next event_msg instead of the previous user turn', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'event_msg',
        timestamp: '2026-07-13T10:00:00.000Z',
        payload: {
          type: 'user_message',
          message: 'previous text',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-13T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', path: '/tmp/current.png' },
            { type: 'input_text', text: 'current text' },
          ],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-07-13T10:00:01.000Z',
        payload: {
          type: 'user_message',
          message: 'current text',
          local_images: ['/tmp/current.png'],
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'previous text');
    assert.deepEqual(messages[0].raw.message.content, [
      { type: 'text', text: 'previous text' },
    ]);
    assert.equal(messages[1].content, 'current text');
    assert.deepEqual(messages[1].raw.message.content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data-for:/tmp/current.png' } },
      { type: 'text', text: 'current text' },
    ]);
  });

  it('keeps image blocks before text when history display text is normalized', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-13T10:00:01.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', path: '/tmp/current.png' },
            { type: 'input_text', text: '图是什么?\n\n## Agent Role and Instructions\n\ninternal' },
          ],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-07-13T10:00:01.000Z',
        payload: {
          type: 'user_message',
          message: '图是什么?\n\n## Agent Role and Instructions\n\ninternal',
          local_images: ['/tmp/current.png'],
        },
      },
    ], imageLoader, {
      normalizeUserDisplayText: (text) => text.replace(/\n\n## Agent Role and Instructions\n\n[\s\S]*$/g, '').trim(),
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, '图是什么?');
    assert.deepEqual(messages[0].raw.message.content, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data-for:/tmp/current.png' } },
      { type: 'text', text: '图是什么?' },
    ]);
  });

  it('strips inline image XML when the referenced file cannot be materialized', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'event_msg',
        timestamp: '2026-07-13T10:00:00.000Z',
        payload: {
          type: 'user_message',
          message: '<image name=[Image #1] path="/tmp/missing.png">\n</image>\n图片里面有啥',
        },
      },
    ], {
      imageBlockFromLocalPath() {
        return null;
      },
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, '图片里面有啥');
    assert.deepEqual(messages[0].raw.message.content, [
      { type: 'text', text: '图片里面有啥' },
    ]);
  });

  it('strips orphan image closing tags from Codex user text', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'event_msg',
        timestamp: '2026-07-13T10:00:00.000Z',
        payload: {
          type: 'user_message',
          message: '</image>\n</image>\n图片里面有啥',
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, '图片里面有啥');
    assert.deepEqual(messages[0].raw.message.content, [
      { type: 'text', text: '图片里面有啥' },
    ]);
  });

  it('restores function_call and function_call_output rows as tool blocks', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-13T10:00:00.000Z',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'package.json' }),
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-13T10:00:01.000Z',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'file contents',
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'assistant');
    assert.deepEqual(messages[0].raw.message.content, [
      { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'package.json' } },
    ]);
    assert.equal(messages[1].type, 'user');
    assert.deepEqual(messages[1].raw.message.content, [
      { type: 'tool_result', tool_use_id: 'call-1', is_error: false, content: 'file contents' },
    ]);
  });
});
