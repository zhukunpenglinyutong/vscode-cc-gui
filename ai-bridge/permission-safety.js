/**
 * Path safety utilities for permission checks.
 * Handles path rewriting (/tmp → project root) and dangerous path detection.
 */
import { basename, resolve, sep } from 'path';
import { getRealHomeDir } from './utils/path-utils.js';

const TEMP_PATH_PREFIXES = ['/tmp', '/var/tmp', '/private/tmp'];

export function getProjectRoot() {
  return process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH || process.cwd();
}

/**
 * Rewrite tool input paths from /tmp to the project root directory.
 * @param {string} toolName - Tool name (for logging)
 * @param {Object} input - Tool parameters (mutated in place)
 * @returns {{ changed: boolean }} - Whether any paths were rewritten
 */
export function rewriteToolInputPaths(toolName, input) {
  const projectRoot = getProjectRoot();
  if (!projectRoot || !input || typeof input !== 'object') {
    return { changed: false };
  }

  const prefixes = [...TEMP_PATH_PREFIXES];
  if (process.env.TMPDIR) {
    prefixes.push(process.env.TMPDIR);
  }

  const rewrites = [];

  const rewritePath = (pathValue) => {
    if (typeof pathValue !== 'string') return pathValue;
    const matchedPrefix = prefixes.find(prefix => prefix && pathValue.startsWith(prefix));
    if (!matchedPrefix) return pathValue;

    let relative = pathValue.slice(matchedPrefix.length).replace(/^\/+/, '');
    if (!relative) {
      relative = basename(pathValue);
    }
    const sanitized = resolve(projectRoot, relative);

    // Verify the resolved path is still within the project root
    const resolvedRoot = resolve(projectRoot);
    if (!sanitized.startsWith(resolvedRoot + sep) && sanitized !== resolvedRoot) {
      console.log(`[PERMISSION][PATH_REWRITE_BLOCKED] Rewritten path escaped project root: ${pathValue} → ${sanitized} (root: ${resolvedRoot})`);
      return pathValue;
    }

    rewrites.push({ from: pathValue, to: sanitized });
    return sanitized;
  };

  const traverse = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(traverse);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.file_path === 'string') {
        value.file_path = rewritePath(value.file_path);
      }
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (child && typeof child === 'object') {
          traverse(child);
        }
      }
    }
  };

  traverse(input);

  if (rewrites.length > 0) {
    console.log(`[PERMISSION] Rewrote paths for ${toolName}:`, JSON.stringify(rewrites));
  }

  return { changed: rewrites.length > 0 };
}

/**
 * Check whether a file path matches any known dangerous pattern.
 * @param {string} filePath - The path to check
 * @returns {boolean} - true if the path is dangerous and should be denied
 */
export function isDangerousPath(filePath) {
  if (!filePath) return false;

  const userHomeDir = getRealHomeDir();
  const isWindows = process.platform === 'win32';

  const dangerousPatterns = [
    // Unix/macOS system paths
    '/etc/',
    '/System/',
    '/usr/',
    '/bin/',
    '/sbin/',
    // User-sensitive directories (credentials, config)
    `${userHomeDir}/.ssh/`,
    `${userHomeDir}/.aws/`,
    `${userHomeDir}/.gnupg/`,
    `${userHomeDir}/.kube/`,
    `${userHomeDir}/.docker/`,
    `${userHomeDir}/.config/`,
    `${userHomeDir}/.local/`,
    `${userHomeDir}/.claude/.credentials.json`,
  ];

  if (isWindows) {
    dangerousPatterns.push(
      'C:\\Windows\\',
      'C:\\Program Files\\',
      'C:\\Program Files (x86)\\',
      `${userHomeDir}\\.ssh\\`,
      `${userHomeDir}\\.aws\\`,
      `${userHomeDir}\\.gnupg\\`,
      `${userHomeDir}\\.kube\\`,
      `${userHomeDir}\\.docker\\`,
      `${userHomeDir}\\AppData\\`,
      `${userHomeDir}\\.config\\`,
      `${userHomeDir}\\.local\\`,
    );
  }

  const normalizedPath = isWindows ? filePath.toLowerCase() : filePath;
  for (const pattern of dangerousPatterns) {
    const normalizedPattern = isWindows ? pattern.toLowerCase() : pattern;
    if (normalizedPath.includes(normalizedPattern)) {
      return true;
    }
  }

  return false;
}
