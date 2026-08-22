import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOpenedFilesToCliMessage } from '../services/cli-opened-files.js';

test('OpenCode send path would include ContextBar active file for path questions', () => {
  const message = '这个文件的路径是什么？';
  const openedFiles = {
    active: '/Users/zhukunpenglinyutong/Desktop/github/vscode-cc-gui/README.md',
  };
  const sent = applyOpenedFilesToCliMessage(message, openedFiles);
  assert.match(sent, /这个文件的路径是什么？/);
  assert.match(sent, /Active file path: \/Users\/zhukunpenglinyutong\/Desktop\/github\/vscode-cc-gui\/README\.md/);
  assert.match(sent, /这个文件/);
});
