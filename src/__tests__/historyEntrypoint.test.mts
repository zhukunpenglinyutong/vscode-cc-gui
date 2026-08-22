import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  convertClaudeSessionEntrypoint,
  findClaudeSessionFile,
  isValidSessionId,
  shouldIncludeClaudeHistorySession,
} from '../bridge/services/historyEntrypoint.ts';

let tmpRoot: string;
let projectsDir: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'history-entrypoint-test-'));
  projectsDir = path.join(tmpRoot, 'projects');
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  if (fs.existsSync(projectsDir)) {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(projectsDir, { recursive: true });
});

function writeSession(projectName: string, sessionId: string, rows: object[]): string {
  const projectPath = path.join(projectsDir, projectName);
  fs.mkdirSync(projectPath, { recursive: true });
  const filePath = path.join(projectPath, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n'));
  return filePath;
}

describe('isValidSessionId', () => {
  it('accepts alphanumeric, dot, dash, underscore', () => {
    assert.equal(isValidSessionId('abc-123_def.456'), true);
  });

  it('rejects path-traversal payloads', () => {
    assert.equal(isValidSessionId('../escape'), false);
    assert.equal(isValidSessionId('a/b'), false);
    assert.equal(isValidSessionId('a\\b'), false);
  });

  it('rejects empty / whitespace / spaces', () => {
    assert.equal(isValidSessionId(''), false);
    assert.equal(isValidSessionId('   '), false);
    assert.equal(isValidSessionId('has space'), false);
  });
});

describe('findClaudeSessionFile', () => {
  it('returns null when projects dir does not exist', () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    assert.equal(findClaudeSessionFile(missing, 'sid-1'), null);
  });

  it('returns null when session id not found in any project', () => {
    fs.mkdirSync(path.join(projectsDir, 'proj-a'), { recursive: true });
    assert.equal(findClaudeSessionFile(projectsDir, 'missing'), null);
  });

  it('finds the file across multiple project subdirs', () => {
    const filePath = writeSession('proj-b', 'sid-xyz', [{ entrypoint: 'cli' }]);
    assert.equal(findClaudeSessionFile(projectsDir, 'sid-xyz'), filePath);
  });
});

describe('shouldIncludeClaudeHistorySession', () => {
  it('includes VS Code tagged sessions', () => {
    assert.equal(shouldIncludeClaudeHistorySession('claude-vscode', false), true);
  });

  it('includes legacy untagged plugin sessions for backward compatibility', () => {
    assert.equal(shouldIncludeClaudeHistorySession(undefined, true), true);
    assert.equal(shouldIncludeClaudeHistorySession('', true), true);
  });

  it('excludes foreign entrypoints and untracked untagged sessions', () => {
    assert.equal(shouldIncludeClaudeHistorySession('cli', true), false);
    assert.equal(shouldIncludeClaudeHistorySession('sdk-cli', true), false);
    assert.equal(shouldIncludeClaudeHistorySession('jetbrains-plugin', true), false);
    assert.equal(shouldIncludeClaudeHistorySession(undefined, false), false);
  });
});

describe('convertClaudeSessionEntrypoint', () => {
  it('rejects invalid session id without touching files', () => {
    const result = convertClaudeSessionEntrypoint('../etc', projectsDir);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'INVALID_SESSION_ID');
  });

  it('reports SESSION_NOT_FOUND when no project contains the session', () => {
    const result = convertClaudeSessionEntrypoint('nope', projectsDir);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'SESSION_NOT_FOUND');
  });

  it('converts sdk-cli entrypoint to cli', () => {
    const filePath = writeSession('proj-c', 'sid-1', [
      { entrypoint: 'sdk-cli', other: 1 },
      { entrypoint: 'sdk-cli', other: 2 },
    ]);
    const result = convertClaudeSessionEntrypoint('sid-1', projectsDir);
    assert.equal(result.success, true);
    assert.equal(result.sessionId, 'sid-1');
    const converted = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(converted.length, 2);
    assert.equal(converted[0].entrypoint, 'cli');
    assert.equal(converted[1].entrypoint, 'cli');
    assert.equal(converted[0].other, 1);
  });

  it('converts claude-vscode entrypoint to cli', () => {
    const filePath = writeSession('proj-d', 'sid-2', [
      { entrypoint: 'claude-vscode', mark: 'a' },
    ]);
    const result = convertClaudeSessionEntrypoint('sid-2', projectsDir);
    assert.equal(result.success, true);
    const row = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
    assert.equal(row.entrypoint, 'cli');
    assert.equal(row.mark, 'a');
  });

  it('returns ALREADY_CLI_SESSION info when all rows already have cli entrypoint', () => {
    writeSession('proj-e', 'sid-3', [{ entrypoint: 'cli' }, { entrypoint: 'cli' }]);
    const result = convertClaudeSessionEntrypoint('sid-3', projectsDir);
    assert.equal(result.success, true);
    assert.equal(result.infoCode, 'ALREADY_CLI_SESSION');
    assert.equal(result.errorCode, undefined);
  });

  it('returns NOT_SDK_SESSION when entrypoints are foreign (e.g. unknown adapter)', () => {
    writeSession('proj-f', 'sid-4', [{ entrypoint: 'jetbrains-plugin', x: 1 }]);
    const result = convertClaudeSessionEntrypoint('sid-4', projectsDir);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'NOT_SDK_SESSION');
  });

  it('leaves rows without entrypoint untouched', () => {
    const filePath = writeSession('proj-g', 'sid-5', [
      { no_entrypoint: true },
      { entrypoint: 'sdk-cli' },
    ]);
    const result = convertClaudeSessionEntrypoint('sid-5', projectsDir);
    assert.equal(result.success, true);
    const rows = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows[0].no_entrypoint, true);
    assert.equal(rows[0].entrypoint, undefined);
    assert.equal(rows[1].entrypoint, 'cli');
  });

  it('preserves malformed lines verbatim and still converts valid lines', () => {
    const projectPath = path.join(projectsDir, 'proj-h');
    fs.mkdirSync(projectPath, { recursive: true });
    const filePath = path.join(projectPath, 'sid-6.jsonl');
    fs.writeFileSync(filePath, [
      JSON.stringify({ entrypoint: 'sdk-cli' }),
      '{not-json',
      '',
      JSON.stringify({ entrypoint: 'sdk-cli', n: 2 }),
    ].join('\n'));
    const result = convertClaudeSessionEntrypoint('sid-6', projectsDir);
    assert.equal(result.success, true);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    assert.equal(lines[1], '{not-json');
    assert.equal(JSON.parse(lines[0]).entrypoint, 'cli');
    assert.equal(JSON.parse(lines[3]).entrypoint, 'cli');
  });

  it('does not leave .backup or .convert temp files behind on success', () => {
    writeSession('proj-i', 'sid-7', [{ entrypoint: 'sdk-cli' }]);
    convertClaudeSessionEntrypoint('sid-7', projectsDir);
    const remaining = fs.readdirSync(path.join(projectsDir, 'proj-i'));
    const stray = remaining.filter((f) => /\.(backup|convert)\.\d+\.tmp$/.test(f));
    assert.deepEqual(stray, []);
  });
});
