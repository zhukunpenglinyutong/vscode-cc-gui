import * as vscode from 'vscode';
import { CcGuiPanel } from './panel';
import { BridgeServer } from './bridge';
import { ClaudeQuickFixProvider, QuickFixCommandArgs } from './quickFix';
import { buildQuickFixPrompt, collectQuickFixActions } from './quickFixPrompt';
import {
  CommitMessageService,
  getWorkspacePath,
  setScmCommitInputBox,
} from './commitMessage';
import { SessionTemplateService } from './sessionTemplate';
import { registerSetupWizard } from './setupWizard';

export function activate(context: vscode.ExtensionContext) {
  const bridge = new BridgeServer(context);
  const panel = new CcGuiPanel(context, bridge);
  const sessionTemplates = new SessionTemplateService(context, bridge, panel);
  context.subscriptions.push(bridge);

  registerSetupWizard(context);

  const webviewViewOptions = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    // Left Activity Bar (solid icon)
    vscode.window.registerWebviewViewProvider('ccGui.mainView', panel, webviewViewOptions),
    // Right Secondary Side Bar (outline icon)
    vscode.window.registerWebviewViewProvider('ccGui.secondaryView', panel, webviewViewOptions)
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
    vscode.commands.registerCommand('ccGui.openPanel', async () => {
      // Focus primary Activity Bar webview (left sidebar).
      await vscode.commands.executeCommand('ccGui.mainView.focus');
    }),

    vscode.commands.registerCommand('ccGui.newSession', () => {
      panel.openChatTab();
    }),

    vscode.commands.registerCommand('ccGui.renameActiveChatTab', async () => {
      await panel.renameActiveChatTab();
    }),

    vscode.commands.registerCommand('ccGui.openDevTools', async () => {
      // Same gate as view/title visibility: only when debug log is enabled.
      const enabled =
        vscode.workspace.getConfiguration('ccGui').get<boolean>('enableDebugLog') === true;
      if (!enabled) {
        void vscode.window.showInformationMessage(
          'Enable “CC GUI: Enable Debug Log” in settings to open Webview Developer Tools.'
        );
        return;
      }
      try {
        await vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
      } catch {
        await vscode.commands.executeCommand('workbench.action.toggleDevTools');
      }
    }),

    vscode.commands.registerCommand('ccGui.hidePanel', async () => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
    }),

    vscode.commands.registerCommand('ccGui.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.selection.isEmpty) {
        await vscode.commands.executeCommand('ccGui.mainView.focus');
        return;
      }
      insertIntoChatInput(bridge, buildSelectionReference(editor));
      await vscode.commands.executeCommand('ccGui.mainView.focus');
    }),

    vscode.commands.registerCommand('ccGui.copySelectionReference', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const reference = buildSelectionReference(editor);
      await vscode.env.clipboard.writeText(reference);
      vscode.window.showInformationMessage('AI reference copied');
    }),

    vscode.commands.registerCommand('ccGui.sendFilePath', async (...args: unknown[]) => {
      const filePaths = resolveCommandFilePaths(args);
      if (filePaths.length === 0) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') return;
        filePaths.push(editor.document.uri.fsPath);
      }
      insertIntoChatInput(bridge, filePaths.map((filePath) => `@${filePath}`).join(' '));
      await vscode.commands.executeCommand('ccGui.mainView.focus');
    }),

    vscode.commands.registerCommand('ccGui.generateCommitMessage', async () => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
      }

      const service = new CommitMessageService(context, bridge);
      if (!service.isEnabled()) {
        vscode.window.showInformationMessage('AI commit message generation is disabled in CC GUI settings');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Generating commit message...',
          cancellable: false,
        },
        async () => {
          try {
            const result = await service.generate(workspacePath, {
              onProgress: (partial) => {
                // Stream partial commit text into the SCM input box as tokens arrive.
                setScmCommitInputBox(partial);
              },
            });
            if (result.commitMessage) {
              const applied = setScmCommitInputBox(result.commitMessage);
              if (applied) {
                vscode.window.showInformationMessage('Commit message generated');
                return;
              }
              bridge.broadcast('js_eval',
                `window.insertCodeSnippetAtCursor && window.insertCodeSnippetAtCursor(${JSON.stringify(result.commitMessage)})`
              );
              await vscode.commands.executeCommand('ccGui.mainView.focus');
              return;
            }

            bridge.broadcast('js_eval',
              `window.insertCodeSnippetAtCursor && window.insertCodeSnippetAtCursor(${JSON.stringify(result.prompt)})`
            );
            await vscode.commands.executeCommand('ccGui.mainView.focus');
            vscode.window.showWarningMessage(`Commit message generation fell back to chat prompt: ${result.error ?? 'unknown error'}`);
          } catch (error: any) {
            vscode.window.showWarningMessage(error?.message || String(error));
          }
        }
      );
    }),

    vscode.commands.registerCommand('ccGui.quickFixWithClaude', async (input?: vscode.Diagnostic | QuickFixCommandArgs) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const targetUri = input && 'uri' in input ? input.uri : editor.document.uri;
      const document = targetUri.toString() === editor.document.uri.toString()
        ? editor.document
        : await vscode.workspace.openTextDocument(targetUri);
      const targetEditor = targetUri.toString() === editor.document.uri.toString() ? editor : undefined;
      const diag = input instanceof vscode.Diagnostic
        ? input
        : input && 'diagnostic' in input
          ? input.diagnostic
          : vscode.languages.getDiagnostics(targetUri)[0];
      if (!diag) return;

      const availableActions = await collectQuickFixActions(document, diag);
      const prompt = buildQuickFixPrompt(document, diag, targetEditor, availableActions);
      bridge.broadcast('js_eval',
        `window.insertCodeSnippetAtCursor && window.insertCodeSnippetAtCursor(${JSON.stringify(prompt)})`
      );
      await vscode.commands.executeCommand('ccGui.mainView.focus');
    }),

    vscode.commands.registerCommand('ccGui.saveSessionTemplate', async () => {
      await sessionTemplates.saveCurrentSessionAsTemplate();
    }),

    vscode.commands.registerCommand('ccGui.createSessionFromTemplate', async () => {
      await sessionTemplates.createSessionFromTemplate();
    })
  );
}

export function deactivate() {}

function insertIntoChatInput(bridge: BridgeServer, text: string): void {
  bridge.broadcast('js_eval',
    `window.insertCodeSnippetAtCursor && window.insertCodeSnippetAtCursor(${JSON.stringify(text)})`
  );
}

function buildSelectionReference(editor: vscode.TextEditor): string {
  const filePath = editor.document.uri.fsPath;
  const startLine = editor.selection.start.line + 1;
  let endLine = editor.selection.end.line + 1;
  if (endLine > startLine && editor.selection.end.character === 0) {
    endLine -= 1;
  }
  return startLine === endLine
    ? `@${filePath}#L${startLine}`
    : `@${filePath}#L${startLine}-${endLine}`;
}

function resolveCommandFilePaths(args: unknown[]): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (value instanceof vscode.Uri && value.scheme === 'file') {
      paths.push(value.fsPath);
    }
  };

  add(args[0]);
  const uriList = args.find(Array.isArray);
  if (Array.isArray(uriList)) {
    for (const item of uriList) {
      add(item);
    }
  }
  return Array.from(new Set(paths));
}
