import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';

import {
  foldPathCase,
  guardWorkingDirectory,
  isWithinOrEqualTolerant,
  relativePathInside,
  resolveFilePathAgainstBase,
} from '../bridge/pathUtils.ts';

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

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

describe('foldPathCase', () => {
  it('lowercases on macOS/Windows, preserves on Linux', () => {
    const mixed = path.join(tmpdir(), 'AbC');
    assert.equal(foldPathCase(mixed), CASE_INSENSITIVE_FS ? mixed.toLowerCase() : mixed);
  });
});

describe('resolveFilePathAgainstBase', () => {
  it('normalizes absolute paths without rebasing', () => {
    const abs = path.join(tmpdir(), 'proj', 'src', '..', 'a.ts');
    assert.equal(resolveFilePathAgainstBase(abs, path.join(tmpdir(), 'other')), path.join(tmpdir(), 'proj', 'a.ts'));
  });

  it('resolves relative paths against the base dir, never the process cwd', () => {
    const base = path.join(tmpdir(), 'proj');
    assert.equal(resolveFilePathAgainstBase(path.join('src', 'a.ts'), base), path.join(base, 'src', 'a.ts'));
  });

  it('falls back to lexical normalize when no base dir is available', () => {
    assert.equal(resolveFilePathAgainstBase('a.ts', ''), 'a.ts');
  });
});

describe('isWithinOrEqualTolerant', () => {
  it('accepts exact and nested paths', () => {
    const base = path.join(tmpdir(), 'proj');
    assert.equal(isWithinOrEqualTolerant(base, base), true);
    assert.equal(isWithinOrEqualTolerant(path.join(base, 'src', 'a.ts'), base), true);
  });

  it('rejects sibling paths that only share a prefix string', () => {
    const base = path.join(tmpdir(), 'proj');
    assert.equal(isWithinOrEqualTolerant(path.join(tmpdir(), 'proj2', 'a.ts'), base), false);
  });

  it('tolerates case-only differences on case-insensitive filesystems (issue #3)', () => {
    const base = path.join(tmpdir(), 'Proj');
    const target = path.join(tmpdir(), 'proj', 'SRC', 'A.ts');
    assert.equal(isWithinOrEqualTolerant(target, base), CASE_INSENSITIVE_FS);
  });
});

describe('relativePathInside', () => {
  it('returns the relative path for nested targets', () => {
    const base = path.join(tmpdir(), 'proj');
    assert.equal(relativePathInside(base, path.join(base, 'src', 'a.ts')), path.join('src', 'a.ts'));
  });

  it('returns null for targets outside the base', () => {
    const base = path.join(tmpdir(), 'proj');
    assert.equal(relativePathInside(base, path.join(tmpdir(), 'elsewhere', 'a.ts')), null);
  });

  it('keeps target casing when only case differs (issue #3)', () => {
    const base = path.join(tmpdir(), 'PROJ');
    const target = path.join(tmpdir(), 'proj', 'src', 'A.ts');
    const expected = CASE_INSENSITIVE_FS ? path.join('src', 'A.ts') : null;
    assert.equal(relativePathInside(base, target), expected);
  });
});
