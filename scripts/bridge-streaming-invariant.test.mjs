/**
 * Regression test for extension streaming: [CONTENT_DELTA] must set the same
 * "content already streamed" flag that [MESSAGE] result fallback consults.
 * Otherwise final `type: result` replays `result` as an extra content_delta
 * (visible as duplicated short answers, e.g. "2" → "22").
 *
 * Run from repo root: node --test scripts/bridge-streaming-invariant.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function fallbackResultEmissions(contentStarted, id, lines) {
  const out = [];
  for (const line of lines) {
    if (line.startsWith('[CONTENT_DELTA] ')) {
      contentStarted.add(id);
    }
    if (line.startsWith('[MESSAGE] ')) {
      const payload = line.slice('[MESSAGE] '.length);
      const parsed = JSON.parse(payload);
      if (parsed.type === 'result' && typeof parsed.result === 'string') {
        if (!contentStarted.has(id)) {
          out.push(parsed.result);
        }
      }
    }
  }
  return out;
}

test('after CONTENT_DELTA, result MESSAGE must not emit duplicate text', () => {
  const contentStarted = new Set();
  const id = '1';
  const dup = fallbackResultEmissions(contentStarted, id, [
    '[CONTENT_DELTA] ' + JSON.stringify('2'),
    '[MESSAGE] ' + JSON.stringify({ type: 'result', result: '2', usage: {} }),
  ]);
  assert.deepEqual(dup, []);
});

test('without CONTENT_DELTA, result MESSAGE may still emit once (non-streaming)', () => {
  const contentStarted = new Set();
  const id = '1';
  const once = fallbackResultEmissions(contentStarted, id, [
    '[MESSAGE] ' + JSON.stringify({ type: 'result', result: 'hello', usage: {} }),
  ]);
  assert.deepEqual(once, ['hello']);
});

/** Mirrors bridge: assistant MESSAGE text becomes one content_delta if none streamed yet. */
function assistantMessageFallbackEmissions(contentStarted, id, lines) {
  const out = [];
  for (const line of lines) {
    if (line.startsWith('[CONTENT_DELTA] ')) {
      contentStarted.add(id);
    }
    if (line.startsWith('[MESSAGE] ')) {
      const payload = line.slice('[MESSAGE] '.length);
      const parsed = JSON.parse(payload);
      if (parsed.type === 'assistant' && parsed.message?.content) {
        const text = Array.isArray(parsed.message.content)
          ? parsed.message.content
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n')
          : '';
        if (text.trim() && !contentStarted.has(id)) {
          contentStarted.add(id);
          out.push(text);
        }
      }
    }
  }
  return out;
}

test('Codex non-streaming: assistant MESSAGE without CONTENT_DELTA still surfaces once', () => {
  const contentStarted = new Set();
  const id = '1';
  const once = assistantMessageFallbackEmissions(contentStarted, id, [
    '[MESSAGE] ' + JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final only' }] },
    }),
  ]);
  assert.deepEqual(once, ['final only']);
});

test('after CONTENT_DELTA, assistant MESSAGE must not re-emit full text', () => {
  const contentStarted = new Set();
  const id = '1';
  const dup = assistantMessageFallbackEmissions(contentStarted, id, [
    '[CONTENT_DELTA] ' + JSON.stringify('final only'),
    '[MESSAGE] ' + JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final only' }] },
    }),
  ]);
  assert.deepEqual(dup, []);
});
