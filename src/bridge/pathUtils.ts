import * as path from 'path';

/**
 * TS port of jetbrains-cc-gui PathUtils.guardWorkingDirectory.
 *
 * Guards a provider daemon's requested working directory against the project
 * base so it cannot be pointed outside the project (the persistent Grok ACP
 * runtime keeps a long-lived daemon process rooted at this cwd).
 *
 * Returns `null` when there is no project base to guard against — the caller
 * should keep the original cwd. When the cwd is missing/sentinel or resolves
 * outside the project base, the project base is returned (clamping the daemon
 * back inside the project). A cwd that already resolves inside (or equal to)
 * the base is returned verbatim so legitimate sub-directory selections keep
 * their original path form.
 */
export function guardWorkingDirectory(
  cwd: string | null | undefined,
  projectBase: string | null | undefined,
): string | null {
  if (!projectBase) {
    return null;
  }
  const base = normalizeAbsolute(projectBase);
  if (!base) {
    return null;
  }
  if (!isValidWorkingDirectory(cwd)) {
    return projectBase;
  }
  const normalizedCwd = normalizeAbsolute(cwd);
  if (!normalizedCwd || !isWithinOrEqual(normalizedCwd, base)) {
    return projectBase;
  }
  return cwd;
}

/** Non-empty and not one of the sentinel strings the webview sends for "no cwd". */
function isValidWorkingDirectory(cwd: string | null | undefined): cwd is string {
  return typeof cwd === 'string' && cwd.length > 0 && cwd !== 'undefined' && cwd !== 'null';
}

/** Absolute, lexically normalized path ('.'/'..' collapsed, symlinks untouched). */
function normalizeAbsolute(p: string): string {
  if (!p) {
    return p;
  }
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

/** True when `p` equals `base` or is nested under it. */
function isWithinOrEqual(p: string, base: string): boolean {
  if (p === base) {
    return true;
  }
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return p.startsWith(prefix);
}
