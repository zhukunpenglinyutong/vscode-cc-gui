import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildContextAppend } from './context-append.js';

test('buildContextAppend includes referenced file content and runtime context', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-context-'));
  const filePath = path.join(tmpDir, 'example.ts');
  fs.writeFileSync(filePath, 'export const answer = 42;\n', 'utf8');

  const prompt = buildContextAppend({
    active: filePath,
    workspaceRoot: tmpDir,
    others: [filePath],
    referencedFiles: [{
      path: filePath,
      displayPath: 'example.ts',
      language: 'ts',
      content: 'export const answer = 42;\n',
      truncated: false,
    }],
    runtimeContexts: [{
      type: 'terminal',
      name: 'Terminal: zsh',
      path: 'terminal://zsh',
      content: 'Last command: npm test\nOutput:\nPASS\n',
      captured: true,
    }],
  }, null);

  assert.doesNotMatch(prompt, /<ide-context>/);
  assert.match(prompt, /Referenced Files/);
  assert.match(prompt, /export const answer = 42/);
  assert.match(prompt, /Runtime Context/);
  assert.match(prompt, /Last command: npm test/);
});

test('buildContextAppend references fileTags by path only and avoids duplicate openedFiles references', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-context-tags-'));
  const first = path.join(tmpDir, 'first.js');
  const second = path.join(tmpDir, 'second.js');
  fs.writeFileSync(first, 'const first = true;\n', 'utf8');
  fs.writeFileSync(second, 'const second = true;\n', 'utf8');

  const prompt = buildContextAppend({
    referencedFiles: [{
      path: first,
      displayPath: 'first.js',
      language: 'js',
      content: 'const first = true;\n',
      truncated: false,
    }],
  }, [
    { displayPath: 'first.js', absolutePath: first },
    { displayPath: 'second.js', absolutePath: second },
    { displayPath: 'with-lines.js', absolutePath: `${tmpDir}/with-lines.js#L3-7` },
    { displayPath: 'terminal://zsh', absolutePath: 'terminal://zsh' },
  ]);

  // Extension-supplied referenced files keep their inline content.
  assert.equal((prompt.match(/const first = true/g) || []).length, 1);
  // File tags are path/line references only — never inlined content.
  assert.doesNotMatch(prompt, /const second = true/);
  assert.match(prompt, /- `second\.js`/);
  assert.match(prompt, /- `with-lines\.js#L3-7`/);
  assert.match(prompt, /Read them with your file tools as needed/);
  assert.doesNotMatch(prompt, /terminal:\/\/zsh/);
});

test('buildContextAppend does not inject single-workspace metadata by itself', () => {
  const prompt = buildContextAppend({
    workspaceRoot: '/tmp/example-workspace',
    isWorkspace: false,
    subprojects: [{
      name: 'example-workspace',
      path: '/tmp/example-workspace',
      type: 'vscode-workspace-folder',
      loaded: true,
    }],
  }, null);

  assert.equal(prompt, '');
});

test('buildContextAppend references the active file by path without inlining content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-context-active-'));
  const filePath = path.join(tmpDir, 'active.ts');
  fs.writeFileSync(filePath, 'export const active = true;\n', 'utf8');

  const prompt = buildContextAppend({
    active: filePath,
    workspaceRoot: tmpDir,
    isWorkspace: false,
  }, null);

  assert.doesNotMatch(prompt, /<ide-context>/);
  assert.match(prompt, /## User's Current IDE Context/);
  assert.match(prompt, /PRIMARY SUBJECT/);
  assert.match(prompt, /Read it with your file tools as needed/);
  assert.doesNotMatch(prompt, /export const active = true/);
});
