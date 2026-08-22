import * as cp from 'child_process';

/**
 * Minimum Node.js major version required to run the CC GUI ai-bridge / Claude SDK.
 * Users may keep an older Node (e.g. 16) for project work; they should install
 * Node 20+ separately and set `ccGui.nodePath` to that binary only.
 */
export const MIN_NODE_MAJOR_VERSION = 20;

export function parseNodeMajorVersion(versionOutput: string | undefined | null): number | null {
  if (!versionOutput) return null;
  const match = versionOutput.trim().match(/^v?(\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readNodeVersion(nodePath: string): string | null {
  try {
    return cp
      .execFileSync(nodePath, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch {
    return null;
  }
}

export function isNodeVersionSupported(versionOutput: string | null | undefined): boolean {
  const major = parseNodeMajorVersion(versionOutput);
  return major !== null && major >= MIN_NODE_MAJOR_VERSION;
}

/** Human-readable error when Node is missing or too old (for logs / send_error). */
export function formatNodeRequirementError(
  nodePath: string | undefined,
  version: string | null,
): string {
  const min = MIN_NODE_MAJOR_VERSION;
  if (!nodePath) {
    return (
      `Node.js not found. Install Node.js v${min}+ separately, then set the full path in ` +
      `CC GUI Settings → Basic → Environment (ccGui.nodePath). ` +
      `Your project can keep using an older Node.`
    );
  }
  if (!isNodeVersionSupported(version)) {
    const current = version?.trim() || 'unknown';
    return (
      `Node.js version too low (${current}). CC GUI requires v${min}+ and cannot run. ` +
      `Install Node.js v${min}+ independently and set its executable path in ` +
      `Settings → Basic → Environment (does not change your project Node). ` +
      `Detected path: ${nodePath}`
    );
  }
  return '';
}
