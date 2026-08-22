import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeTextChunks } from '../bridge/services/textChunkDedupe.ts';

describe('dedupeTextChunks', () => {
  it('returns empty for no chunks', () => {
    assert.equal(dedupeTextChunks([]), '');
  });

  it('preserves spaces in incremental deltas (commit message regression)', () => {
    const chunks = ['chore: ', 'refresh ', 'comments ', 'and editor state'];
    assert.equal(dedupeTextChunks(chunks), 'chore: refresh comments and editor state');
  });

  it('keeps space-only chunks that mark word boundaries', () => {
    const chunks = ['chore:', ' ', 'add', ' ', 'login'];
    assert.equal(dedupeTextChunks(chunks), 'chore: add login');
  });

  it('does not trim leading spaces off delta chunks', () => {
    const chunks = ['Hello', ' world', '!'];
    assert.equal(dedupeTextChunks(chunks), 'Hello world!');
  });

  it('uses last snapshot when chunks are cumulative', () => {
    const chunks = ['Hello', 'Hello world', 'Hello world!'];
    assert.equal(dedupeTextChunks(chunks), 'Hello world!');
  });

  it('prefers full cumulative last chunk over joining', () => {
    const chunks = ['a', 'ab', 'abc', 'abcd'];
    assert.equal(dedupeTextChunks(chunks), 'abcd');
  });
});
