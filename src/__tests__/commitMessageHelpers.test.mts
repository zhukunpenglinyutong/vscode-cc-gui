import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommitPrompt,
  cleanupCommitMessage,
  getUserAdditionalPrompt,
  normalizeCommitMessage,
  truncateDiff,
} from '../commitMessageHelpers.ts';

describe('buildCommitPrompt', () => {
  it('includes diff inside fenced ```diff block', () => {
    const prompt = buildCommitPrompt('diff --git a/foo b/foo');
    assert.match(prompt, /```diff\ndiff --git a\/foo b\/foo\n```/);
  });

  it('omits user additional section when prompt is empty', () => {
    const prompt = buildCommitPrompt('d', '   ', '');
    assert.doesNotMatch(prompt, /用户附加要求/);
  });

  it('includes user additional section when non-empty', () => {
    const prompt = buildCommitPrompt('d', 'use English only');
    assert.match(prompt, /用户附加要求/);
    assert.match(prompt, /use English only/);
  });

  it('includes project additional section when non-empty', () => {
    const prompt = buildCommitPrompt('d', '', 'prefix with [SCOPE]');
    assert.match(prompt, /项目专属要求/);
    assert.match(prompt, /prefix with \[SCOPE\]/);
  });

  it('truncates very long diff inline', () => {
    const big = 'x'.repeat(5000);
    const prompt = buildCommitPrompt(big);
    assert.match(prompt, /diff 过长，已截断/);
  });

  it('always demands <commit></commit> wrapping', () => {
    const prompt = buildCommitPrompt('d');
    assert.match(prompt, /<commit>/);
    assert.match(prompt, /<\/commit>/);
  });
});

describe('cleanupCommitMessage', () => {
  it('returns empty for null or empty input', () => {
    assert.equal(cleanupCommitMessage(null), '');
    assert.equal(cleanupCommitMessage(undefined), '');
    assert.equal(cleanupCommitMessage(''), '');
  });

  it('extracts content from <commit></commit> tags', () => {
    const raw = 'Analysis blah\n<commit>\nfeat(api): add endpoint\n\nDetails.\n</commit>\nmore noise';
    assert.equal(cleanupCommitMessage(raw), 'feat(api): add endpoint\n\nDetails.');
  });

  it('falls back to ``` code block when tags missing', () => {
    const raw = '```\nfix: handle null\n```';
    assert.equal(cleanupCommitMessage(raw), 'fix: handle null');
  });

  it('finds conventional commit line when no fence/tag', () => {
    const raw = 'Here is the message:\n\nfeat(ui): hide panel\n\nBody line one.\n\nAnalysis: something';
    assert.equal(cleanupCommitMessage(raw), 'feat(ui): hide panel\n\nBody line one.');
  });

  it('strips <thinking> blocks before parsing', () => {
    const raw = '<thinking>internal reasoning</thinking>\n<commit>chore: bump</commit>';
    assert.equal(cleanupCommitMessage(raw), 'chore: bump');
  });

  it('converts literal \\n into newlines', () => {
    const raw = '<commit>feat: thing\\n\\nbody</commit>';
    assert.equal(cleanupCommitMessage(raw), 'feat: thing\n\nbody');
  });

  it('stops at analysis markers in fallback path', () => {
    const raw = 'feat: x\nmore\n---\nanalysis here';
    const result = cleanupCommitMessage(raw);
    assert.ok(!result.includes('analysis here'));
    assert.match(result, /^feat: x/);
  });

  it('repairs missing space after type colon', () => {
    assert.equal(cleanupCommitMessage('<commit>chore:bump deps</commit>'), 'chore: bump deps');
  });

  it('repairs hyphen-glued multi-change subject from streaming bug', () => {
    const raw =
      '<commit>chore:Refreshcommentsandeditorstate-Rewordprogresscommentsforclarity-KeepREADME</commit>';
    const result = cleanupCommitMessage(raw);
    assert.match(result, /^chore: /);
    assert.ok(result.includes('\n'));
    assert.ok(result.includes('- '));
    assert.ok(!result.includes('chore:Refresh'));
  });
});

describe('normalizeCommitMessage', () => {
  it('inserts space after colon', () => {
    assert.equal(normalizeCommitMessage('feat:add login'), 'feat: add login');
  });

  it('splits hyphen-glued description into subject and body', () => {
    const result = normalizeCommitMessage('chore:AlphaChange-BetaChange-GammaChange');
    assert.match(result, /^chore: alpha change/i);
    assert.match(result, /- beta change/i);
    assert.match(result, /- gamma change/i);
  });
});

describe('getUserAdditionalPrompt', () => {
  it('returns empty for empty input', () => {
    assert.equal(getUserAdditionalPrompt(''), '');
    assert.equal(getUserAdditionalPrompt('   '), '');
  });

  it('returns empty for the legacy default placeholder', () => {
    assert.equal(
      getUserAdditionalPrompt('你是一个commit提交专员，请你阅读git记录，帮我生成commit记录'),
      '',
    );
  });

  it('returns trimmed text for normal user prompt', () => {
    assert.equal(getUserAdditionalPrompt('  use English only  '), 'use English only');
  });
});

describe('truncateDiff', () => {
  it('returns input unchanged when shorter than threshold', () => {
    const diff = 'a'.repeat(100);
    assert.equal(truncateDiff(diff), diff);
  });

  it('truncates and appends marker when over threshold', () => {
    const diff = 'a'.repeat(5000);
    const result = truncateDiff(diff);
    assert.ok(result.length < diff.length);
    assert.match(result, /diff 过长，已截断/);
  });
});
