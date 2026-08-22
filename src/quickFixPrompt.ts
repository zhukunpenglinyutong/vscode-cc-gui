import * as path from 'path';
import * as vscode from 'vscode';

const MAX_CONTEXT_LINES = 120;

export interface QuickFixActionSummary {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabledReason?: string;
}

export function buildQuickFixPrompt(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  editor?: vscode.TextEditor,
  availableActions: QuickFixActionSummary[] = [],
): string {
  const filePath = document.uri.fsPath;
  const targetRange = diagnostic.range;
  const startLine = targetRange.start.line + 1;
  const endLine = targetRange.end.line + 1;
  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .map((item) => formatDiagnostic(item))
    .join('\n');
  const selectedText = editor && !editor.selection.isEmpty ? document.getText(editor.selection) : '';
  const contextSnippet = getContextSnippet(document, targetRange);
  const targetText = document.getText(targetRange) || document.lineAt(targetRange.start.line).text;

  return [
    'Fix the following problem in the current file.',
    '',
    'Requirements:',
    '- Make the smallest correct code change.',
    '- Preserve the project style and public behavior unless the diagnostic requires a behavior change.',
    '- Prefer editing the file directly with tools when available.',
    '- Do not explain before making the fix. After the fix, summarize what changed briefly.',
    '',
    'File:',
    `${filePath}`,
    '',
    'Problem:',
    `- Severity: ${severityLabel(diagnostic.severity)}`,
    `- Range: ${path.basename(filePath)}:${startLine}-${endLine}`,
    `- Message: ${diagnostic.message}`,
    diagnostic.source ? `- Source: ${diagnostic.source}` : '',
    diagnostic.code !== undefined ? `- Code: ${String(diagnostic.code)}` : '',
    '',
    'Target code:',
    '```',
    targetText,
    '```',
    '',
    selectedText
      ? [
          'User selection:',
          '```',
          selectedText,
          '```',
          '',
        ].join('\n')
      : '',
    'Nearby file context:',
    '```',
    contextSnippet,
    '```',
    '',
    diagnostics
      ? [
          'Other diagnostics in this file:',
          diagnostics,
          '',
        ].join('\n')
      : '',
    availableActions.length > 0
      ? [
          'Available IDE quick fixes from VS Code language extensions:',
          ...availableActions.map((action) => formatQuickFixAction(action)),
          '',
          'Use these as hints when they are relevant. If an IDE quick fix is too narrow or unsafe, still make the smallest correct code change.',
          '',
        ].join('\n')
      : '',
  ].filter((part) => part !== '').join('\n');
}

export async function collectQuickFixActions(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): Promise<QuickFixActionSummary[]> {
  try {
    const actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
      'vscode.executeCodeActionProvider',
      document.uri,
      diagnostic.range,
      vscode.CodeActionKind.QuickFix.value,
      20,
    );
    if (!Array.isArray(actions)) return [];

    const seen = new Set<string>();
    const summaries: QuickFixActionSummary[] = [];
    for (const action of actions) {
      const title = typeof action?.title === 'string' ? action.title.trim() : '';
      if (!title || title.startsWith('Fix with CC GUI') || title.startsWith('Fix with Claude')) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const codeAction = action as vscode.CodeAction;
      summaries.push({
        title,
        kind: codeAction.kind?.value,
        isPreferred: codeAction.isPreferred === true,
        disabledReason: codeAction.disabled?.reason,
      });
      if (summaries.length >= 12) break;
    }
    return summaries;
  } catch {
    return [];
  }
}

function getContextSnippet(document: vscode.TextDocument, range: vscode.Range): string {
  const targetLines = Math.max(1, range.end.line - range.start.line + 1);
  const side = Math.max(10, Math.floor((MAX_CONTEXT_LINES - targetLines) / 2));
  const start = Math.max(0, range.start.line - side);
  const end = Math.min(document.lineCount - 1, range.end.line + side);
  const lines: string[] = [];
  for (let line = start; line <= end; line += 1) {
    const marker = line >= range.start.line && line <= range.end.line ? '>' : ' ';
    lines.push(`${marker} ${String(line + 1).padStart(4, ' ')} | ${document.lineAt(line).text}`);
  }
  return lines.join('\n');
}

function formatDiagnostic(diagnostic: vscode.Diagnostic): string {
  const start = diagnostic.range.start.line + 1;
  const end = diagnostic.range.end.line + 1;
  const source = diagnostic.source ? ` [${diagnostic.source}]` : '';
  const code = diagnostic.code !== undefined ? ` (${String(diagnostic.code)})` : '';
  return `- ${severityLabel(diagnostic.severity)}${source}${code} at ${start}-${end}: ${diagnostic.message}`;
}

function formatQuickFixAction(action: QuickFixActionSummary): string {
  const details = [
    action.kind ? `kind=${action.kind}` : '',
    action.isPreferred ? 'preferred' : '',
    action.disabledReason ? `disabled=${action.disabledReason}` : '',
  ].filter(Boolean);
  return details.length > 0
    ? `- ${action.title} (${details.join(', ')})`
    : `- ${action.title}`;
}

function severityLabel(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'unknown';
  }
}
