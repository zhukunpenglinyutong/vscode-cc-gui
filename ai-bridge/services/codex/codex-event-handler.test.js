import test from 'node:test';
import assert from 'node:assert/strict';
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
