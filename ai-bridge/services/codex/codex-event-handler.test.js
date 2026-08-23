import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createInitialEventState,
  isWindowsTaskkillParseNoise,
  processCodexEventStream,
} from './codex-event-handler.js';

async function* eventsFrom(items) {
  for (const item of items) {
    yield item;
  }
}

async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    captured.push(text);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

function tagLines(captured, tag) {
  return captured.filter((line) => line.startsWith(tag));
}

function makeConfig(overrides = {}) {
  return {
    cwd: undefined,
    threadId: null,
    threadOptions: {},
    normalizedPermissionMode: 'default',
    turnAbortController: new AbortController(),
    streamingEnabled: true,
    ...overrides,
  };
}

test('Codex item.updated agent_message emits incremental content deltas before completion', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  const captured = await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'item.updated',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hel' },
        },
        {
          type: 'item.updated',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
        },
        {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
        },
      ]),
      state,
      makeConfig({ streamingEnabled: true }),
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(deltaLines.length, 2);
  assert.match(deltaLines[0], /"Hel"/);
  assert.match(deltaLines[1], /"lo"/);
  assert.equal(state.assistantText, 'Hello');
  assert.equal(emittedMessages.length, 1);
  assert.deepEqual(emittedMessages[0], {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    },
  });
});

test('Codex streamingEnabled=false suppresses CONTENT_DELTA but still emits final MESSAGE', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  const captured = await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'item.updated',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hel' },
        },
        {
          type: 'item.updated',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
        },
        {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
        },
      ]),
      state,
      makeConfig({ streamingEnabled: false }),
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');
  assert.equal(deltaLines.length, 0, 'non-streaming must not emit CONTENT_DELTA');
  assert.equal(state.assistantText, 'Hello');
  assert.equal(emittedMessages.length, 1);
  assert.equal(emittedMessages[0]?.message?.content?.[0]?.text, 'Hello');
});

test('Codex item.completed-only still emits CONTENT_DELTA when streaming is on', async () => {
  const state = createInitialEventState(() => {});
  const captured = await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'item.completed',
          item: { id: 'msg-final', type: 'agent_message', text: 'done' },
        },
      ]),
      state,
      makeConfig({ streamingEnabled: true }),
    );
  });
  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');
  assert.equal(deltaLines.length, 1);
  assert.match(deltaLines[0], /"done"/);
});

test('Codex event_msg user_message emits sanitized user content for history cache', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await processCodexEventStream(
    eventsFrom([
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<environment_context>cwd=/tmp/private</environment_context>\n\nWhat changed?',
        },
      },
    ]),
    state,
    makeConfig(),
  );

  assert.equal(emittedMessages.length, 1);
  assert.deepEqual(emittedMessages[0], {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'What changed?' }],
    },
  });
});

test('Codex event_msg user_message strips IDEA-style appended agent instructions', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await processCodexEventStream(
    eventsFrom([
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '你好.\n\n## Agent Role and Instructions\n\n我叫, 黄\n我老婆家 陈\n我孩子叫 小不点',
        },
      },
    ]),
    state,
    makeConfig(),
  );

  assert.equal(emittedMessages.length, 1);
  assert.deepEqual(emittedMessages[0], {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '你好.' }],
    },
  });
});

test('Codex event_msg user_message preserves marker-like text when it starts the prompt', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));
  const message = '## Agent Role and Instructions\n\n我叫, 黄\n我老婆家 陈\n我孩子叫 小不点';

  await processCodexEventStream(
    eventsFrom([
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message,
        },
      },
    ]),
    state,
    makeConfig(),
  );

  assert.equal(emittedMessages.length, 1);
  assert.deepEqual(emittedMessages[0], {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: message }],
    },
  });
});

test('Codex event_msg user_message preserves images as structural blocks', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await processCodexEventStream(
    eventsFrom([
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          local_images: ['/tmp/from-attachment.png'],
          images: ['data:image/png;base64,aW1n'],
          message: 'Look <image name=[Image #1]\n  path = "/tmp/from-text.png">\n</image> please',
        },
      },
    ]),
    state,
    makeConfig(),
  );

  assert.equal(emittedMessages.length, 1);
  assert.deepEqual(emittedMessages[0], {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'local_image', path: '/tmp/from-attachment.png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
        { type: 'text', text: 'Look' },
        { type: 'local_image', path: '/tmp/from-text.png' },
        { type: 'text', text: 'please' },
      ],
    },
  });
});

test('Codex event_msg user_message strips orphan image closing tags', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await processCodexEventStream(
    eventsFrom([
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '</image>\n</image>\nWhat is this?',
        },
      },
    ]),
    state,
    makeConfig(),
  );

  assert.equal(emittedMessages.length, 1);
  assert.deepEqual(emittedMessages[0], {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'What is this?' }],
    },
  });
});

test('Codex turn.completed normalizes cached input tokens without double counting', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await processCodexEventStream(
    eventsFrom([
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 600,
          output_tokens: 84,
        },
      },
    ]),
    state,
    makeConfig(),
  );

  assert.equal(emittedMessages.length, 1);
  assert.equal(emittedMessages[0].type, 'result');
  assert.deepEqual(emittedMessages[0].usage, {
    input_tokens: 400,
    output_tokens: 84,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 600,
  });
});

test('isWindowsTaskkillParseNoise: matches English SUCCESS taskkill output', () => {
  const message =
    'Failed to parse item: SUCCESS: The process with PID 12345 (child process of PID 67890) has been terminated.';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: matches Chinese 成功 taskkill output', () => {
  const message = 'Failed to parse item: 成功: 进程 PID 12345 (PID 67890 的子进程) 已被终止';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: matches mojibake (replacement char) with PID pair', () => {
  const message = 'Failed to parse item: ���: PID 12345 PID 67890 ��';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: ignores message without "Failed to parse item:" prefix', () => {
  const message = 'SUCCESS: process PID 12345 (child PID 67890) terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: ignores message with only a single PID', () => {
  const message = 'Failed to parse item: SUCCESS: process PID 12345 terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: ignores real Codex parse errors without taskkill keywords', () => {
  const message = 'Failed to parse item: {"id":"msg-1","type":"agent_message"';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: returns false for non-string input', () => {
  assert.equal(isWindowsTaskkillParseNoise(null), false);
  assert.equal(isWindowsTaskkillParseNoise(undefined), false);
  assert.equal(isWindowsTaskkillParseNoise(42), false);
  assert.equal(isWindowsTaskkillParseNoise({ msg: 'x' }), false);
});

test('isWindowsTaskkillParseNoise: returns false for empty payload after prefix', () => {
  assert.equal(isWindowsTaskkillParseNoise('Failed to parse item:'), false);
  assert.equal(isWindowsTaskkillParseNoise('Failed to parse item:   '), false);
});

test('isWindowsTaskkillParseNoise: matches when only "terminated" keyword present with PID pair', () => {
  const message = 'Failed to parse item: PID 100 PID 200 process tree terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

const CUSTOM_EXEC_PLAN_SOURCE = [
  'const result = await tools.update_plan({',
  '  explanation: "Implement and verify",',
  '  plan: [',
  '    { step: "Inspect current behavior", status: "completed" },',
  "    { step: 'Implement parser', status: 'in_progress' },",
  '    { step: `Run tests`, status: "pending" },',
  '  ],',
  '});',
  'text(result);',
].join('\n');

test('custom_tool_call exec update_plan emits normalized plan and result messages', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'plan-1', name: 'exec', input: CUSTOM_EXEC_PLAN_SOURCE },
        },
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'plan-1', output: '{}' },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  assert.equal(emittedMessages.length, 2);
  assert.deepEqual(emittedMessages[0].message.content[0], {
    type: 'tool_use',
    id: 'codex_plan_plan-1',
    name: 'update_plan',
    input: {
      explanation: 'Implement and verify',
      plan: [
        { step: 'Inspect current behavior', status: 'completed', content: 'Inspect current behavior' },
        { step: 'Implement parser', status: 'in_progress', content: 'Implement parser' },
        { step: 'Run tests', status: 'pending', content: 'Run tests' },
      ],
    },
  });
  assert.deepEqual(emittedMessages[1].message.content[0], {
    type: 'tool_result',
    tool_use_id: 'codex_plan_plan-1',
    is_error: false,
    content: 'Plan updated',
  });
});

test('custom_tool_call exec update_plan treats array script failure output as an error', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'plan-failure', name: 'exec', input: CUSTOM_EXEC_PLAN_SOURCE },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'plan-failure',
            output: [
              { type: 'input_text', text: 'Script failed\nThe update was not applied.' },
              { type: 'input_text', text: 'Script error:\nExit code: 1' },
            ],
          },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  assert.equal(emittedMessages.length, 2);
  assert.deepEqual(emittedMessages[1].message.content[0], {
    type: 'tool_result',
    tool_use_id: 'codex_plan_plan-failure',
    is_error: true,
    content: 'Plan update failed',
  });
});

test('session replay emits custom_tool_call exec plans found only in JSONL', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-custom-plan-replay-'));
  const tempSessionPath = join(tempDirectory, 'fixture-session.jsonl');
  await writeFile(tempSessionPath, '', 'utf8');

  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));
  state.sessionFilePath = tempSessionPath;

  try {
    await writeFile(
      tempSessionPath,
      [
        { type: 'turn_context', payload: { cwd: 'C:/fixture' } },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'session-plan-1',
            name: 'exec',
            input: CUSTOM_EXEC_PLAN_SOURCE,
          },
        },
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'session-plan-1', output: '{}' },
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    await captureStdout(async () => {
      await processCodexEventStream(
        eventsFrom([{ type: 'event_msg', payload: { type: 'status' } }, { type: 'turn.completed' }]),
        state,
        makeConfig(),
      );
    });

    assert.equal(emittedMessages.length, 2);
    assert.equal(emittedMessages[0].message.content[0].name, 'update_plan');
    assert.equal(emittedMessages[0].message.content[0].id, 'codex_plan_session-plan-1');
    assert.deepEqual(
      emittedMessages[0].message.content[0].input.plan.map(({ step, status }) => ({ step, status })),
      [
        { step: 'Inspect current behavior', status: 'completed' },
        { step: 'Implement parser', status: 'in_progress' },
        { step: 'Run tests', status: 'pending' },
      ],
    );
    assert.equal(emittedMessages[1].message.content[0].tool_use_id, 'codex_plan_session-plan-1');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('turn.completed flushes a plan call whose output never arrived', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'plan-orphan', name: 'exec', input: CUSTOM_EXEC_PLAN_SOURCE },
        },
        { type: 'turn.completed' },
      ]),
      state,
      makeConfig(),
    );
  });

  assert.equal(emittedMessages.length, 2);
  assert.deepEqual(emittedMessages[1].message.content[0], {
    type: 'tool_result',
    tool_use_id: 'codex_plan_plan-orphan',
    is_error: false,
    content: 'Plan updated',
  });
});
