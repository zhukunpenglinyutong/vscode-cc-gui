import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampTitle,
  extractTitleUpdate,
  isBridgeEvent,
  nextTabName,
  parseBridgeEvent,
  resolveTabTitle,
} from '../panelHelpers.ts';

describe('nextTabName', () => {
  it('returns AI<counter>', () => {
    assert.equal(nextTabName(1), 'AI1');
    assert.equal(nextTabName(42), 'AI42');
  });
});

describe('resolveTabTitle', () => {
  it('returns trimmed title when provided', () => {
    assert.equal(resolveTabTitle('  Hello  ', 7), 'Hello');
  });

  it('falls back to AI<counter> when title is empty or whitespace', () => {
    assert.equal(resolveTabTitle('', 3), 'AI3');
    assert.equal(resolveTabTitle('   ', 4), 'AI4');
    assert.equal(resolveTabTitle(undefined, 5), 'AI5');
  });

  it('clamps long titles to 15 chars plus an ellipsis', () => {
    const huge = 'x'.repeat(200);
    assert.equal(resolveTabTitle(huge, 1), `${'x'.repeat(15)}...`);
  });
});

describe('clampTitle', () => {
  it('returns title unchanged when under limit', () => {
    assert.equal(clampTitle('short'), 'short');
  });

  it('truncates titles over 15 chars and adds an ellipsis', () => {
    const long = 'a'.repeat(120);
    assert.equal(clampTitle(long), `${'a'.repeat(15)}...`);
  });

  it('counts Chinese characters as one displayed character', () => {
    assert.equal(clampTitle('安装CCGUI以后在VSCode中新打开窗口'), '安装CCGUI以后在VSCod...');
  });
});

describe('parseBridgeEvent', () => {
  it('returns null for non-bridge messages', () => {
    assert.equal(parseBridgeEvent(null), null);
    assert.equal(parseBridgeEvent(undefined), null);
    assert.equal(parseBridgeEvent({ type: 'other', payload: 'a:b' } as any), null);
    assert.equal(parseBridgeEvent({ type: 'bridge', payload: 123 } as any), null);
  });

  it('parses event:payload format', () => {
    const parsed = parseBridgeEvent({ type: 'bridge', payload: 'send_message:{"text":"hi"}' });
    assert.deepEqual(parsed, { event: 'send_message', payload: '{"text":"hi"}' });
  });

  it('handles event without colon as event=payload-string, empty payload', () => {
    const parsed = parseBridgeEvent({ type: 'bridge', payload: 'heartbeat' });
    assert.deepEqual(parsed, { event: 'heartbeat', payload: '' });
  });

  it('preserves additional colons inside the JSON payload', () => {
    const parsed = parseBridgeEvent({ type: 'bridge', payload: 'update_title:{"title":"a:b:c"}' });
    assert.equal(parsed?.event, 'update_title');
    assert.equal(parsed?.payload, '{"title":"a:b:c"}');
  });
});

describe('isBridgeEvent', () => {
  it('returns true for matching event', () => {
    assert.equal(isBridgeEvent({ type: 'bridge', payload: 'foo:bar' }, 'foo'), true);
  });

  it('returns false for non-matching event', () => {
    assert.equal(isBridgeEvent({ type: 'bridge', payload: 'foo:bar' }, 'baz'), false);
  });

  it('returns false for non-bridge messages', () => {
    assert.equal(isBridgeEvent({ type: 'other', payload: 'foo:bar' } as any, 'foo'), false);
  });
});

describe('extractTitleUpdate', () => {
  it('returns trimmed clamped title from update_title event', () => {
    const msg = { type: 'bridge', payload: 'update_title:{"title":"  Renamed  "}' };
    assert.equal(extractTitleUpdate(msg), 'Renamed');
  });

  it('returns title from update_history_title event using newTitle key', () => {
    const msg = { type: 'bridge', payload: 'update_history_title:{"newTitle":"From history"}' };
    assert.equal(extractTitleUpdate(msg), 'From history');
  });

  it('prefers title over newTitle when both present', () => {
    const msg = { type: 'bridge', payload: 'update_title:{"title":"Primary","newTitle":"Secondary"}' };
    assert.equal(extractTitleUpdate(msg), 'Primary');
  });

  it('clamps very long titles', () => {
    const huge = 'y'.repeat(120);
    const msg = { type: 'bridge', payload: `update_title:${JSON.stringify({ title: huge })}` };
    const result = extractTitleUpdate(msg);
    assert.equal(result, `${'y'.repeat(15)}...`);
  });

  it('returns null for non-title bridge events', () => {
    const msg = { type: 'bridge', payload: 'send_message:{"title":"ignored"}' };
    assert.equal(extractTitleUpdate(msg), null);
  });

  it('returns null when payload is empty string', () => {
    const msg = { type: 'bridge', payload: 'update_title:' };
    assert.equal(extractTitleUpdate(msg), null);
  });

  it('returns null on invalid JSON payload', () => {
    const msg = { type: 'bridge', payload: 'update_title:{not-json' };
    assert.equal(extractTitleUpdate(msg), null);
  });

  it('returns null when JSON has neither title nor newTitle', () => {
    const msg = { type: 'bridge', payload: 'update_title:{"other":"foo"}' };
    assert.equal(extractTitleUpdate(msg), null);
  });

  it('returns null when title is whitespace only', () => {
    const msg = { type: 'bridge', payload: 'update_title:{"title":"   "}' };
    assert.equal(extractTitleUpdate(msg), null);
  });

  it('returns null for non-bridge messages', () => {
    assert.equal(extractTitleUpdate(null), null);
    assert.equal(extractTitleUpdate({ type: 'other', payload: 'update_title:{"title":"x"}' } as any), null);
  });
});
