import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUnifiedDiffToStrings,
  fileUpdateChangeToTool,
  emitFileChangeItemAsTools,
} from './codex-file-change-emit.js';

test('parseUnifiedDiffToStrings extracts only changed lines and stats', () => {
  const diff = [
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-old line',
    '+new line',
    ' line3',
  ].join('\n');

  const { oldString, newString, additions, deletions } = parseUnifiedDiffToStrings(diff);
  // Context omitted so useFileChanges LCS / explicit stats stay non-zero
  assert.equal(oldString, 'old line');
  assert.equal(newString, 'new line');
  assert.equal(additions, 1);
  assert.equal(deletions, 1);
});

test('fileUpdateChangeToTool maps add to write', () => {
  const tool = fileUpdateChangeToTool({
    path: 'src/a.ts',
    kind: { type: 'add' },
    diff: '@@ -0,0 +1,2 @@\n+hello\n+world\n',
  });
  assert.equal(tool.toolName, 'write');
  assert.equal(tool.input.file_path, 'src/a.ts');
  assert.equal(tool.input.content.trimEnd(), 'hello\nworld');
  assert.equal(tool.input.old_string, '');
});

test('fileUpdateChangeToTool maps update to edit', () => {
  const tool = fileUpdateChangeToTool({
    path: 'README.md',
    kind: { type: 'update' },
    diff: '@@ -1 +1 @@\n-a\n+b',
  });
  assert.equal(tool.toolName, 'edit');
  assert.equal(tool.input.file_path, 'README.md');
  assert.equal(tool.input.old_string, 'a');
  assert.equal(tool.input.new_string, 'b');
});

test('emitFileChangeItemAsTools emits tool_use + tool_result pairs', () => {
  const messages = [];
  const count = emitFileChangeItemAsTools(
    {
      id: 'item_9',
      type: 'fileChange',
      status: 'completed',
      changes: [
        {
          path: 'SiteFooter.tsx',
          kind: { type: 'update' },
          diff: '@@ -1 +1 @@\n-2024\n+2026\n',
        },
      ],
    },
    (msg) => messages.push(msg),
  );

  assert.equal(count, 1);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, 'assistant');
  assert.equal(messages[0].message.content[0].type, 'tool_use');
  assert.equal(messages[0].message.content[0].name, 'edit');
  assert.equal(messages[0].message.content[0].input.file_path, 'SiteFooter.tsx');
  assert.equal(messages[1].type, 'user');
  assert.equal(messages[1].message.content[0].type, 'tool_result');
  assert.equal(messages[1].message.content[0].is_error, false);
  assert.equal(
    messages[1].message.content[0].tool_use_id,
    messages[0].message.content[0].id,
  );
});

test('emitFileChangeItemAsTools dedupes by tool id', () => {
  const seen = new Set();
  const messages = [];
  const item = {
    id: 'item_1',
    type: 'fileChange',
    status: 'completed',
    changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '+x\n' }],
  };
  assert.equal(emitFileChangeItemAsTools(item, (m) => messages.push(m), seen), 1);
  assert.equal(emitFileChangeItemAsTools(item, (m) => messages.push(m), seen), 0);
  assert.equal(messages.length, 2);
});
