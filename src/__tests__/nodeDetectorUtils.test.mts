import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCommonNodeCandidates,
  getCommonNpmCandidates,
  getNpmCandidatesFromNodePath,
  isLikelyNodeExecutable,
} from '../nodeDetectorUtils.ts';

describe('isLikelyNodeExecutable', () => {
  it('rejects Code.exe on Windows', () => {
    assert.equal(
      isLikelyNodeExecutable('C:\\Users\\huang\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'win32'),
      false,
    );
  });

  it('accepts node.exe on Windows', () => {
    assert.equal(isLikelyNodeExecutable('C:\\Program Files\\nodejs\\node.exe', 'win32'), true);
  });

  it('accepts node on POSIX', () => {
    assert.equal(isLikelyNodeExecutable('/usr/bin/node', 'linux'), true);
  });
});

describe('getNpmCandidatesFromNodePath', () => {
  it('uses npm.cmd on Windows', () => {
    assert.deepEqual(
      getNpmCandidatesFromNodePath('C:\\Program Files\\nodejs\\node.exe', 'win32'),
      [
        'C:\\Program Files\\nodejs\\npm.cmd',
        'C:\\Program Files\\nodejs\\npm',
      ],
    );
  });
});

describe('getCommonNodeCandidates', () => {
  it('includes Windows node.exe install locations', () => {
    const candidates = getCommonNodeCandidates('win32', {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\huang\\AppData\\Local',
    });
    assert.ok(candidates.includes('C:\\Program Files\\nodejs\\node.exe'));
    assert.ok(candidates.includes('C:\\Users\\huang\\AppData\\Local\\Programs\\nodejs\\node.exe'));
  });
});

describe('getCommonNpmCandidates', () => {
  it('includes Windows npm.cmd install locations', () => {
    const candidates = getCommonNpmCandidates('win32', {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\huang\\AppData\\Local',
    });
    assert.ok(candidates.includes('C:\\Program Files\\nodejs\\npm.cmd'));
    assert.ok(candidates.includes('C:\\Users\\huang\\AppData\\Local\\Programs\\nodejs\\npm.cmd'));
  });
});
