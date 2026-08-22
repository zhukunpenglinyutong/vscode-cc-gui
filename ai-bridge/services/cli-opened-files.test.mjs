import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOpenedFilesToCliMessage,
  buildCliActiveFileHint,
} from './cli-opened-files.js';

test('buildCliActiveFileHint returns empty when no active file', () => {
  assert.equal(buildCliActiveFileHint(null), '');
  assert.equal(buildCliActiveFileHint({}), '');
  assert.equal(buildCliActiveFileHint({ active: '   ' }), '');
});

test('buildCliActiveFileHint includes active file path for "这个文件" questions', () => {
  const hint = buildCliActiveFileHint({
    active: '/Users/zhukunpenglinyutong/Desktop/github/vscode-cc-gui/README.md',
  });
  assert.match(hint, /Active file path:/);
  assert.match(hint, /README\.md/);
  assert.match(hint, /这个文件/);
  assert.doesNotMatch(hint, /```/);
});

test('buildCliActiveFileHint includes selected line range when present', () => {
  const hint = buildCliActiveFileHint({
    active: '/repo/src/a.ts#L3-9',
    selection: { startLine: 3, endLine: 9, selectedText: 'const x = 1' },
  });
  assert.match(hint, /Selected lines: 3-9/);
  // Path-only: do not dump selected body into the CLI hint.
  assert.doesNotMatch(hint, /const x = 1/);
});

test('applyOpenedFilesToCliMessage appends hint after user text', () => {
  const result = applyOpenedFilesToCliMessage(
    '这个文件的路径是什么？',
    { active: '/repo/README.md' },
  );
  assert.ok(result.startsWith('这个文件的路径是什么？'));
  assert.match(result, /Active file path: \/repo\/README\.md/);
});

test('applyOpenedFilesToCliMessage leaves message unchanged without openedFiles', () => {
  assert.equal(
    applyOpenedFilesToCliMessage('hello', null),
    'hello',
  );
});
