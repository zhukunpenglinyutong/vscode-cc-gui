import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { attachToggleCorrelation, extractToggleCorrelation } =
  await import('../bridge/handlers/skillToggleCorrelation.ts');

describe('attachToggleCorrelation', () => {
  it('echoes id, requestId and name onto a success result', () => {
    const result = attachToggleCorrelation(
      { success: true, enabled: false },
      { id: 'user:/skills/review', requestId: '1-1', name: 'review' },
    );
    assert.deepEqual(result, {
      success: true,
      enabled: false,
      id: 'user:/skills/review',
      requestId: '1-1',
      name: 'review',
    });
  });

  it('echoes correlation onto an error result', () => {
    const result = attachToggleCorrelation(
      { success: false, error: 'denied' },
      { id: 'user:/skills/review', requestId: '1-2', name: 'review' },
    );
    assert.equal(result.id, 'user:/skills/review');
    assert.equal(result.requestId, '1-2');
    assert.equal(result.name, 'review');
  });

  it('omits empty correlation fields instead of overwriting with blanks', () => {
    const result = attachToggleCorrelation({ success: true, name: 'kept' }, { id: '', requestId: '' });
    assert.equal('id' in result, false);
    assert.equal('requestId' in result, false);
    assert.equal(result.name, 'kept');
  });
});

describe('extractToggleCorrelation', () => {
  it('recovers correlation fields from raw request content', () => {
    const correlation = extractToggleCorrelation(
      JSON.stringify({ id: 'repo:/ws/.agents/skills/a', requestId: '9-3', name: 'a', scope: 'repo' }),
    );
    assert.deepEqual(correlation, { id: 'repo:/ws/.agents/skills/a', requestId: '9-3', name: 'a' });
  });

  it('returns empty correlation for unparseable content', () => {
    assert.deepEqual(extractToggleCorrelation('not-json{'), {});
  });
});
