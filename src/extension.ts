import * as vscode from 'vscode';
import { ClaudeCodeGuiPanel } from './panel';
import { BridgeServer } from './bridge';
import { ClaudeQuickFixProvider } from './quickFix';

export function activate(context: vscode.ExtensionContext) {
  const bridge = new BridgeServer(context);
  const panel = new ClaudeCodeGuiPanel(context, bridge);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'claudeCodeGui.mainView',
      panel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register Quick Fix Code Action provider
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new ClaudeQuickFixProvider(bridge),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeGui.newSession', () => {
      bridge.broadcast('create_new_tab', '');
    }),

    vscode.commands.registerCommand('claudeCodeGui.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) return;
      const filePath = editor.document.uri.fsPath;
      const startLine = editor.selection.start.line + 1;
      const endLine = editor.selection.end.line + 1;
      const snippet = `\`\`\`\n// ${filePath}:${startLine}-${endLine}\n${selection}\n\`\`\``;
      bridge.broadcast('js_eval',
        `window.insertCodeSnippetAtCursor && window.insertCodeSnippetAtCursor(${JSON.stringify(snippet)})`
      );
    }),

    vscode.commands.registerCommand('claudeCodeGui.sendFilePath', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const filePath = editor.document.uri.fsPath;
      bridge.broadcast('js_eval',
        `window.insertCodeSnippetAtCursor && window.insertCodeSnippetAtCursor(${JSON.stringify('@' + filePath)})`
      );
    }),

    vscode.commands.registerCommand('claudeCodeGui.generateCommitMessage', async () => {
      // Get git diff and ask Claude to generate commit message
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspacePath) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
      }
      const prompt = 'Please generate a concise git commit message for the staged changes. Use conventional commits format.';
      bridge.broadcast('js_eval',
        `window.insertCodeSnippetAtCursor && window.insertCodeSnippetAtCursor(${JSON.stringify(prompt)})`
      );
      // Focus the panel
      await vscode.commands.executeCommand('claudeCodeGui.mainView.focus');
    }),

    vscode.commands.registerCommand('claudeCodeGui.quickFixWithClaude', async (diagnostic?: vscode.Diagnostic) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const diag = diagnostic ?? vscode.languages.getDiagnostics(editor.document.uri)[0];
      if (!diag) return;

      const filePath = editor.document.uri.fsPath;
      const line = diag.range.start.line + 1;
      const errorText = diag.message;
      const codeSnippet = editor.document.getText(diag.range) || editor.document.lineAt(diag.range.start.line).text;

      const prompt = `Fix this error in ${filePath}:${line}\nError: ${errorText}\nCode: \`${codeSnippet}\``;
      bridge.broadcast('js_eval',
        `window.insertCodeSnippetAtCursor && window.insertCodeSnippetAtCursor(${JSON.stringify(prompt)})`
      );
      await vscode.commands.executeCommand('claudeCodeGui.mainView.focus');
    })
  );
}

export function deactivate() {}
