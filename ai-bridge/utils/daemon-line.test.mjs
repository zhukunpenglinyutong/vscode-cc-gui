import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDaemonEventJsonLine } from './daemon-line.js';

describe('isDaemonEventJsonLine', () => {
  it('accepts title_log / title_generated daemon events', () => {
    assert.equal(
      isDaemonEventJsonLine(
        JSON.stringify({
          type: 'daemon',
          event: 'title_log',
          level: 'info',
          message: 'Calling Haiku API, model: deepseek-v4-flash',
        }),
      ),
      true,
    );
    assert.equal(
      isDaemonEventJsonLine(
        JSON.stringify({ type: 'daemon', event: 'title_generated', sessionId: 's1', title: 'Add numbers' }),
      ),
      true,
    );
  });

  it('rejects request result envelopes and plain text', () => {
    assert.equal(isDaemonEventJsonLine(JSON.stringify({ success: true, result: '3' })), false);
    assert.equal(isDaemonEventJsonLine('[CONTENT_DELTA] "3"'), false);
    assert.equal(isDaemonEventJsonLine('hello'), false);
    assert.equal(isDaemonEventJsonLine('{not json'), false);
  });
});
