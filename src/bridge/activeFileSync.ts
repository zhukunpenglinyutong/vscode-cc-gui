/**
 * Helpers for syncing the active editor file into the CC GUI ContextBar.
 * Kept pure so extension tests can cover the auto-open-file gate without vscode mocks.
 */

export function shouldSyncActiveFileToWebview(autoOpenFileEnabled: boolean): boolean {
  return Boolean(autoOpenFileEnabled);
}

export function formatActiveFileSelectionInfo(
  filePath: string,
  startLine: number,
  endLine: number,
  selectionEmpty: boolean,
): string {
  if (!selectionEmpty) {
    return startLine === endLine
      ? `@${filePath}#L${startLine}`
      : `@${filePath}#L${startLine}-${endLine}`;
  }
  return `@${filePath}`;
}
