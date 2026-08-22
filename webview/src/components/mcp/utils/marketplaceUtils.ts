/**
 * Shared helpers for the MCP marketplace and GitHub Copilot import dialogs.
 */

/**
 * Marketplace/import payloads come from untrusted registry data or pasted JSON.
 * React does not sanitize the `href` scheme, so a `javascript:` link would
 * execute in the webview. Only allow http(s) links to be rendered as anchors.
 */
export function isSafeHttpUrl(url: string | undefined | null): boolean {
  if (!url) {
    return false;
  }
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Picks an id that does not collide with existing server ids by appending a
 * numeric suffix (`-2`, `-3`, ...). Used by both the marketplace install flow
 * and the GitHub Copilot import preview.
 */
export function createUniqueServerId(base: string, existingIds: string[] | Set<string>): string {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const baseId = base && base.trim() ? base.trim() : 'mcp-server';

  if (!existing.has(baseId)) {
    return baseId;
  }

  let counter = 2;
  while (existing.has(`${baseId}-${counter}`)) {
    counter++;
  }
  return `${baseId}-${counter}`;
}
