export interface ParsedSelectionInfo {
  file: string;
  startLine?: number;
  endLine?: number;
  raw: string;
}

/**
 * Gate for auto-synced editor/explorer file chips in ContextBar.
 * Manual @mentions / insertCodeSnippet paths must not use this gate.
 */
export function shouldApplyAutoSelectionInfo(autoOpenFileEnabled: boolean): boolean {
  return Boolean(autoOpenFileEnabled);
}

export function parseSelectionInfo(selectionInfo: string): ParsedSelectionInfo | null {
  if (!selectionInfo) return null;
  const match = selectionInfo.match(/^@([^#]+)(?:#L(\d+)(?:-(\d+))?)?$/);
  if (!match) return null;

  const file = match[1];
  const startLine = match[2] ? parseInt(match[2], 10) : undefined;
  const endLine =
    match[3] ? parseInt(match[3], 10) : startLine !== undefined ? startLine : undefined;

  return {
    file,
    startLine,
    endLine,
    raw: selectionInfo,
  };
}
