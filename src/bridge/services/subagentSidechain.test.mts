import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSubagentSidechainFileName,
  isSubagentSidechainCompletedFromJsonl,
} from './subagentSidechain.ts';

test('buildSubagentSidechainFileName adds agent- prefix when missing', () => {
  assert.equal(buildSubagentSidechainFileName('ab5f0df6a82ead573'), 'agent-ab5f0df6a82ead573.jsonl');
  assert.equal(buildSubagentSidechainFileName('agent-ab5f0df6a82ead573'), 'agent-ab5f0df6a82ead573.jsonl');
  assert.equal(buildSubagentSidechainFileName('  '), '');
});

test('isSubagentSidechainCompletedFromJsonl detects end_turn', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n');
  assert.equal(isSubagentSidechainCompletedFromJsonl(jsonl), true);
});

test('isSubagentSidechainCompletedFromJsonl stays incomplete on tool_use tail', () => {
  const jsonl = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [] } }),
  ].join('\n');
  assert.equal(isSubagentSidechainCompletedFromJsonl(jsonl), false);
});
