import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRememberedApproval,
  normalizeApprovalCommand,
  sameRememberedApproval,
} from '../permissionApprovalUtils.ts';

describe('normalizeApprovalCommand', () => {
  it('unwraps Windows PowerShell wrappers', () => {
    const wrapped = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'Get-ChildItem -Force | Select-Object Mode,Length,LastWriteTime,Name\'';
    assert.equal(
      normalizeApprovalCommand(wrapped, 'win32'),
      'Get-ChildItem -Force | Select-Object Mode,Length,LastWriteTime,Name',
    );
  });

  it('unwraps bash wrappers', () => {
    const wrapped = '/bin/bash -lc "npm view @openai/codex-sdk version --json"';
    assert.equal(normalizeApprovalCommand(wrapped, 'linux'), 'npm view @openai/codex-sdk version --json');
  });
});

describe('buildRememberedApproval', () => {
  it('falls back to the top-level cwd when inputs.cwd is empty', () => {
    const approval = buildRememberedApproval(
      'Bash',
      { command: 'node -p process.execPath' },
      'C:\\Repo',
      'win32',
    );

    assert.equal(approval.cwd, 'c:\\repo');
  });

  it('normalizes file paths and compares Windows approvals case-insensitively', () => {
    const wrapped = buildRememberedApproval(
      'Bash',
      {
        command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'Get-ChildItem -Force\'',
        file_path: 'C:\\Repo\\App\\File.txt',
      },
      'C:\\Repo',
      'win32',
    );
    const plain = {
      toolName: 'Bash',
      command: 'Get-ChildItem -Force',
      cwd: 'c:\\repo',
      path: 'c:\\repo\\app\\file.txt',
    };

    assert.equal(sameRememberedApproval(wrapped, plain, 'win32'), true);
  });
});
