import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';

import { guardWorkingDirectory } from '../bridge/pathUtils.ts';

const tmpdir = () => os.tmpdir();

describe('guardWorkingDirectory', () => {
  it('returns null when no project base to guard against', () => {
    // No base ⇒ caller has no anchor to clamp to, so it must keep its own cwd.
    assert.equal(guardWorkingDirectory(path.join(tmpdir(), 'anywhere'), null), null);
    assert.equal(guardWorkingDirectory(path.join(tmpdir(), 'anywhere'), ''), null);
  });

  it('clamps missing or sentinel cwd to the project base', () => {
    const project = path.join(tmpdir(), 'proj');
    // The webview sends these sentinels when no cwd was chosen.
    assert.equal(guardWorkingDirectory(null, project), project);
    assert.equal(guardWorkingDirectory(undefined, project), project);
    assert.equal(guardWorkingDirectory('', project), project);
    assert.equal(guardWorkingDirectory('undefined', project), project);
    assert.equal(guardWorkingDirectory('null', project), project);
  });

  it('accepts cwd equal to the project base', () => {
    const project = path.join(tmpdir(), 'proj');
    assert.equal(guardWorkingDirectory(project, project), project);
  });

  it('accepts cwd nested under the project base', () => {
    const project = path.join(tmpdir(), 'proj');
    const nested = path.join(project, 'src', 'deep');
    assert.equal(guardWorkingDirectory(nested, project), nested);
  });

  it('clamps cwd outside the project base', () => {
    const project = path.join(tmpdir(), 'proj');
    const outside = path.join(tmpdir(), 'elsewhere');
    assert.equal(guardWorkingDirectory(outside, project), project);
  });

  it('clamps cwd that escapes via dot-dot', () => {
    // /tmp/proj/../elsewhere normalizes to /tmp/elsewhere — outside the project.
    const project = path.join(tmpdir(), 'proj');
    const escape = project + path.sep + '..' + path.sep + 'elsewhere';
    assert.equal(guardWorkingDirectory(escape, project), project);
  });

  it('accepts cwd that stays inside after normalizing', () => {
    // /tmp/proj/sub/./file normalizes to /tmp/proj/sub/file — still inside — and
    // the original (non-normalized) cwd form is returned verbatim.
    const project = path.join(tmpdir(), 'proj');
    const inside = project + path.sep + 'sub' + path.sep + '.' + path.sep + 'file';
    assert.equal(guardWorkingDirectory(inside, project), inside);
  });
});
