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

test('buildContextAppend reads fileTags and avoids duplicate openedFiles references', () => {
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
    { displayPath: 'terminal://zsh', absolutePath: 'terminal://zsh' },
  ]);

  assert.equal((prompt.match(/const first = true/g) || []).length, 1);
  assert.match(prompt, /const second = true/);
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

test('buildContextAppend uses IDEA-style active file context', () => {
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
  assert.match(prompt, /export const active = true/);
});
