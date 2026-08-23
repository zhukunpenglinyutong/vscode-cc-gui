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

  it('replays a nested update_plan from a custom_tool_call exec script', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-23T02:00:00.000Z',
        payload: {
          type: 'custom_tool_call',
          call_id: 'plan-1',
          name: 'exec',
          input: 'const r = await tools.update_plan({'
            + 'explanation:"Implement and verify",'
            + 'plan:['
            + '{step:"Inspect current behavior",status:"completed"},'
            + "{step:'Implement parser',status:'in_progress'},"
            + '{step:`Run tests`,status:"pending"}'
            + ']}); text(r);',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-23T02:00:01.000Z',
        payload: { type: 'custom_tool_call_output', call_id: 'plan-1', output: '{}' },
      },
    ], imageLoader);

    assert.equal(messages.length, 2);
    const toolUse = messages[0].raw.message.content[0];
    assert.equal(toolUse.type, 'tool_use');
    assert.equal(toolUse.name, 'update_plan');
    assert.equal(toolUse.id, 'codex_plan_plan-1');
    assert.deepEqual(toolUse.input, {
      explanation: 'Implement and verify',
      plan: [
        { step: 'Inspect current behavior', status: 'completed', content: 'Inspect current behavior' },
        { step: 'Implement parser', status: 'in_progress', content: 'Implement parser' },
        { step: 'Run tests', status: 'pending', content: 'Run tests' },
      ],
    });
    const toolResult = messages[1].raw.message.content[0];
    assert.equal(toolResult.tool_use_id, 'codex_plan_plan-1');
    assert.equal(toolResult.is_error, false);
    assert.equal(toolResult.content, 'Plan updated');
  });

  it('preserves an explicit empty plan snapshot from history', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-23T02:00:00.000Z',
        payload: {
          type: 'custom_tool_call',
          call_id: 'plan-empty',
          name: 'exec',
          input: 'await tools.update_plan({ /* clear */ plan: [], });',
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 1);
    const toolUse = messages[0].raw.message.content[0];
    assert.equal(toolUse.name, 'update_plan');
    assert.deepEqual(toolUse.input.plan, []);
  });

  it('rejects dynamic update_plan expressions in history instead of evaluating them', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-23T02:00:00.000Z',
        payload: {
          type: 'custom_tool_call',
          call_id: 'plan-dynamic',
          name: 'exec',
          input: "await tools.update_plan({plan:[{step:buildStep(),status:'pending'}]});",
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 0);
  });

  it('ignores update_plan text inside strings and comments in history', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-23T02:00:00.000Z',
        payload: {
          type: 'custom_tool_call',
          call_id: 'plan-docs',
          name: 'exec',
          input: 'const example = "tools.update_plan({plan:[{step:\'Fake\'}]})";'
            + '// tools.update_plan({plan:[{step:"Fake"}]})\n'
            + '/* tools.update_plan({plan:[{step:"Fake"}]}) */',
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 0);
  });

  it('marks a failed plan output as an error tool_result', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-23T02:00:00.000Z',
        payload: {
          type: 'custom_tool_call',
          call_id: 'plan-fail',
          name: 'exec',
          input: 'await tools.update_plan({plan:[{step:"Only",status:"pending"}]});',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-07-23T02:00:01.000Z',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'plan-fail',
          output: 'Script failed\nExit code: 1',
        },
      },
    ], imageLoader);

    assert.equal(messages.length, 2);
    const toolResult = messages[1].raw.message.content[0];
    assert.equal(toolResult.is_error, true);
    assert.equal(toolResult.content, 'Plan update failed');
  });

  it('drops a custom_tool_call_output that has no replayed plan call', () => {
    const messages = transformCodexHistoryRows([
      {
        type: 'response_item',
        timestamp: '2026-07-23T02:00:01.000Z',
        payload: { type: 'custom_tool_call_output', call_id: 'orphan', output: '{}' },
      },
    ], imageLoader);

    assert.equal(messages.length, 0);
  });
});
