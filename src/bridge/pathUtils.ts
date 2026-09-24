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

/** Case-fold for platforms whose filesystem is case-insensitive by default. */
export function foldPathCase(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

/**
 * Case-tolerant variant of `isWithinOrEqual` — AI CLIs report paths with their
 * own casing (e.g. Windows drive letter `C:` vs VS Code's normalized `c:`),
 * and macOS/Windows filesystems do not distinguish case.
 */
export function isWithinOrEqualTolerant(p: string, base: string): boolean {
  if (isWithinOrEqual(p, base)) {
    return true;
  }
  return isWithinOrEqual(foldPathCase(p), foldPathCase(base));
}

/**
 * Resolve a possibly-relative file path against a base directory. Absolute
 * paths are only normalized; relative paths must NOT fall back to the
 * extension-host process cwd (Codex apply_patch sends repo-relative paths).
 */
export function resolveFilePathAgainstBase(filePath: string, baseDir: string): string {
  if (!filePath) {
    return filePath;
  }
  if (path.isAbsolute(filePath)) {
    return path.normalize(filePath);
  }
  return baseDir ? path.resolve(baseDir, filePath) : path.normalize(filePath);
}

/**
 * Relative path of `target` inside `base`, tolerating case-only differences.
 * Returns null when target is outside base; '' when they are equal.
 * The returned path keeps the target's real casing.
 */
export function relativePathInside(base: string, target: string): string | null {
  const rel = path.relative(base, target);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel;
  }
  const baseFolded = foldPathCase(base);
  const targetFolded = foldPathCase(target);
  if (targetFolded === baseFolded) {
    return '';
  }
  const prefix = baseFolded.endsWith(path.sep) ? baseFolded : baseFolded + path.sep;
  if (targetFolded.startsWith(prefix)) {
    return target.slice(prefix.length);
  }
  return null;
}
