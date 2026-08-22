import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BridgeServer } from './bridge';
import { clampTitle, extractTitleUpdate, resolveTabTitle } from './panelHelpers';

export class CcGuiPanel implements vscode.WebviewViewProvider {
  /** Primary/secondary sidebar webviews (left Activity Bar + right Secondary Side Bar). */
  private readonly _sidebarViews = new Set<vscode.WebviewView>();
  private readonly _sidebarDisposables = new Map<vscode.WebviewView, vscode.Disposable[]>();
  private _activeWebview?: vscode.Webview;
  private _activePanel?: vscode.WebviewPanel;
  private _tabCounter = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BridgeServer
  ) {
    bridge.onMessage((event, content) => {
      this._postToActiveWebview(event, content);
    });
    bridge.onCreateTab(() => {
      this.openChatTab();
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    // Support both left and right entries without tearing down the other.
    const previous = this._sidebarDisposables.get(webviewView);
    previous?.forEach((disposable) => disposable.dispose());

    this._configureWebview(webviewView.webview);
    webviewView.webview.html = this._getHtml(webviewView.webview);

    const disposables = this._bindWebview(webviewView.webview);
    disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this._activateWebview(webviewView.webview);
        }
      }),
      webviewView.onDidDispose(() => {
        this._disposeSidebarView(webviewView);
      })
    );

    this._sidebarViews.add(webviewView);
    this._sidebarDisposables.set(webviewView, disposables);
    this._activateWebview(webviewView.webview);
  }

  private _disposeSidebarView(webviewView: vscode.WebviewView): void {
    const disposables = this._sidebarDisposables.get(webviewView);
    disposables?.forEach((disposable) => disposable.dispose());
    this._sidebarDisposables.delete(webviewView);
    this._sidebarViews.delete(webviewView);
    this.bridge.unregisterWebview(webviewView.webview);

    if (this._activeWebview === webviewView.webview) {
      this._activeWebview = this._firstSidebarWebview();
      this._activePanel = undefined;
      if (this._activeWebview) {
        this.bridge.setWebview(this._activeWebview);
      }
    }
  }

  private _firstSidebarWebview(): vscode.Webview | undefined {
    for (const view of this._sidebarViews) {
      return view.webview;
    }
    return undefined;
  }

  openChatTab(title?: string): void {
    // Prefer the same editor group as the current chat panel so "+" opens a
    // native stacked tab (like Claude Code / editor tabs), not a side-by-side
    // split. Fall back to Active when the first tab is opened from the sidebar.
    const viewColumn = this._activePanel?.viewColumn ?? vscode.ViewColumn.Active;
    const panel = vscode.window.createWebviewPanel(
      'ccGui.chatTab',
      this._tabTitle(title),
      { viewColumn, preserveFocus: false },
      { ...this._webviewOptions(), retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon-small.svg');
    panel.webview.html = this._getHtml(panel.webview);

    const messageDisposables = this._bindWebview(panel.webview, panel);
    const viewStateDisposable = panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this._activateWebview(panel.webview, panel);
      }
    });
    const disposeDisposable = panel.onDidDispose(() => {
      messageDisposables.forEach((disposable) => disposable.dispose());
      viewStateDisposable.dispose();
      disposeDisposable.dispose();
      this.bridge.unregisterWebview(panel.webview);
      if (this._activeWebview === panel.webview) {
        this._activeWebview = this._firstSidebarWebview();
        this._activePanel = undefined;
        if (this._activeWebview) {
          this.bridge.setWebview(this._activeWebview);
        }
      }
    });

    this._activateWebview(panel.webview, panel);
  }

  async renameActiveChatTab(): Promise<void> {
    const panel = this._activePanel;
    if (!panel) {
      vscode.window.showInformationMessage('Activate a CC GUI chat tab first');
      return;
    }

    const title = await vscode.window.showInputBox({
      title: 'Rename Chat Tab',
      prompt: 'Tab title',
      value: panel.title,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'Tab title is required',
    });
    const trimmed = title?.trim();
    if (trimmed) {
      panel.title = clampTitle(trimmed);
    }
  }

  private _bindWebview(webview: vscode.Webview, panel?: vscode.WebviewPanel): vscode.Disposable[] {
    return [
      webview.onDidReceiveMessage((message) => {
        this._activateWebview(webview, panel);
        if (panel) {
          this._syncPanelTitleFromMessage(panel, message);
        }
        this.bridge.handleWebviewMessage(message, webview);
      }),
    ];
  }

  private _configureWebview(webview: vscode.Webview): void {
    webview.options = this._webviewOptions();
  }

  private _webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
  }

  private _activateWebview(webview: vscode.Webview, panel?: vscode.WebviewPanel): void {
    // Always register so multi-tab permission routing knows how many surfaces exist,
    // even when this webview is already "active".
    this.bridge.registerWebview(webview);
    if (this._activeWebview === webview) {
      if (panel) {
        this._activePanel = panel;
      }
      return;
    }
    this._activeWebview = webview;
    this._activePanel = panel;
    this.bridge.setWebview(webview);
  }

  private _postToActiveWebview(event: string, content: string): void {
    const target = this._activeWebview ?? this._firstSidebarWebview();
    if (!target) {
      return;
    }
    void target.postMessage({ type: event, content });
  }

  private _tabTitle(title?: string): string {
    if (!title?.trim()) {
      this._tabCounter += 1;
    }
    return resolveTabTitle(title, this._tabCounter);
  }

  private _syncPanelTitleFromMessage(panel: vscode.WebviewPanel, message: any): void {
    const title = extractTitleUpdate(message);
    if (title) {
      panel.title = title;
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const indexPath = path.join(this.context.extensionPath, 'webview', 'dist', 'index.html');
    if (!fs.existsSync(indexPath)) {
      return this._getLoadingHtml();
    }

    let html = fs.readFileSync(indexPath, 'utf8');

    // Replace relative asset paths with VSCode webview URIs
    const distUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist')
    ).toString();
    html = html.replace(/(?:src|href)="\.\/assets\//g, (m) => {
      const attr = m.startsWith('src') ? 'src' : 'href';
      return `${attr}="${distUri}/assets/`;
    });

    // Remove type="module" and crossorigin; add defer to external scripts so DOM is ready
    html = html.replace(/<(script|link)\b([^>]*)>/g, (match, tag, attrs) => {
      let cleaned = attrs
        .replace(/\s*type="module"/g, '')
        .replace(/\s*crossorigin(?:="[^"]*")?/g, '')
        .trim();
      if (tag === 'script' && /src=/.test(cleaned) && !/defer/.test(cleaned)) {
        cleaned += ' defer';
      }
      return cleaned ? `<${tag} ${cleaned}>` : `<${tag}>`;
    });

    // Replace the restrictive CSP (designed for JCEF) with one that works in VSCode webview
    html = html.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data: https: blob:; font-src ${webview.cspSource} data:; connect-src https: wss: http://localhost:* ws://localhost:*;">`
    );

    // Seed language before app JS so i18n can follow VS Code locale on first paint
    const languageConfig = this.bridge.getLanguageConfig();
    const languageSeed = JSON.stringify(languageConfig);

    // Inject VSCode bridge before </head>
    const bridgeScript = `
    <script>
      (function() {
        // Host language (manual override or vscode.env.language) — read by i18n before React mounts
        window.__pendingLanguageConfig = ${languageSeed};

        const vscode = acquireVsCodeApi();
        window.sendToJava = function(payload) {
          vscode.postMessage({ type: 'bridge', payload });
        };
        // Map postMessage type → window function name (matches Java plugin convention)
        const TYPE_TO_FN = {
          'providers_updated':             'updateProviders',
          'active_provider_updated':       'updateActiveProvider',
          'update_dependency_status':      'updateDependencyStatus',
          'dependency_update_available':   'dependencyUpdateAvailable',
          'update_streaming_enabled':      'updateStreamingEnabled',
          'update_send_shortcut':          'updateSendShortcut',
          'update_auto_open_file_enabled': 'updateAutoOpenFileEnabled',
          'update_thinking_enabled':       'updateThinkingEnabled',
          'mode_received':                 'onModeReceived',
          'workspace_path':                'onWorkspacePath',
          'node_environment_status':       'nodeEnvironmentStatus',
          'dependency_install_progress':   'dependencyInstallProgress',
          'dependency_install_result':     'dependencyInstallResult',
          'dependency_uninstall_result':   'dependencyUninstallResult',
          'dependency_versions_loaded':    'dependencyVersionsLoaded',
          'import_preview_result':         'import_preview_result',
          'backend_notification':          'backend_notification',
          // Streaming
          'stream_start':    'onStreamStart',
          'stream_end':      'onStreamEnd',
          'content_delta':   'onContentDelta',
          'thinking_delta':  'onThinkingDelta',
          'session_id':      'setSessionId',
          'message_data':    'onMessage',
          'turn_messages':   'onTurnMessages',
          'send_error':      'onSendError',
          'usage_data':      'onUsage',
          'usage_update':    'onUsageUpdate',
          // Active file context
          'add_selection_info':   'addSelectionInfo',
          'clear_selection_info': 'clearSelectionInfo',
          // File reference
          'file_list_result':     'onFileListResult',
          // MCP
          'update_mcp_servers':         'updateMcpServers',
          'update_mcp_server_status':   'updateMcpServerStatus',
          'update_mcp_server_tools':    'updateMcpServerTools',
          'update_codex_mcp_servers':   'updateCodexMcpServers',
          'update_codex_mcp_server_status': 'updateCodexMcpServerStatus',
          'update_codex_mcp_server_tools': 'updateCodexMcpServerTools',
          // Usage statistics
          'update_usage_statistics':    'updateUsageStatistics',
          // Prompts
          'update_prompts':             'updatePrompts',
          'update_agents':              'updateAgents',
          'update_codex_providers':     'updateCodexProviders',
          // Skills
          'update_skills':              'updateSkills',
          'skill_import_result':        'skillImportResult',
          'skill_delete_result':        'skillDeleteResult',
          'skill_toggle_result':        'skillToggleResult',
          // Slash commands
          'update_slash_commands':       'updateSlashCommands',
          'update_dollar_commands':      'updateDollarCommands',
          // History
          'history_data':               'setHistoryData',
          'session_messages':           'onSessionMessages',
          // Sound
          'update_ask_user_question_notification_enabled': 'updateAskUserQuestionNotificationEnabled',
          'update_task_completion_notification_enabled': 'updateTaskCompletionNotificationEnabled',
          'update_sound_notification_config': 'updateSoundNotificationConfig',
        };
        window.addEventListener('message', function(event) {
          const msg = event.data;
          if (!msg || !msg.type) return;
          if (msg.type === 'js_eval' && msg.content) {
            try { eval(msg.content); } catch(e) { console.error('[BRIDGE] js_eval error:', e); }
            return;
          }
          // Try direct window function first
          const fnName = TYPE_TO_FN[msg.type];
          // session_messages: buffer if handler not ready yet
          if (msg.type === 'session_messages') {
            var smFnExists = typeof window[fnName] === 'function';
            if (smFnExists) {
              window[fnName](msg.content);
            } else {
              console.log('[PANEL] session_messages: handler not ready, buffering');
              window.__pendingSessionMessages = msg.content;
            }
            return;
          }
          if (fnName) {
            // import_preview_result and backend_notification use CustomEvent dispatch
            if (msg.type === 'import_preview_result' || msg.type === 'backend_notification') {
              let detail = msg.content;
              try { detail = JSON.parse(msg.content); } catch(e) {}
              window.dispatchEvent(new CustomEvent(msg.type, { detail }));
              return;
            }
            // history_data needs parsed object
            if (msg.type === 'history_data') {
              let data = msg.content;
              try { data = JSON.parse(msg.content); } catch(e) {}
              if (typeof window[fnName] === 'function') { window[fnName](data); }
              return;
            }
            if (typeof window[fnName] === 'function') {
              window[fnName](msg.content);
              return;
            }
            // Handler not registered yet — buffer streaming lifecycle events so they
            // are not lost during the React app mount race on first query.
            var PRE_MOUNT_BUFFERABLE = {stream_start:1,content_delta:1,thinking_delta:1,stream_end:1,send_error:1,session_id:1,message_data:1,usage_update:1,usage_data:1,turn_messages:1};
            if (PRE_MOUNT_BUFFERABLE[msg.type]) {
              if (!window.__preMountStreamBuffer) window.__preMountStreamBuffer = [];
              window.__preMountStreamBuffer.push({fn: fnName, data: msg.content});
              console.log('[CCG:bridge] pre-mount buffered', msg.type, '(total:', window.__preMountStreamBuffer.length, ')');
              return;
            }
          }
          // Fallback: __ccg_cb_ mechanism
          const cb = window['__ccg_cb_' + msg.type];
          if (cb) cb(msg.content);
        });
        window.__registerCallback = function(event, cb) {
          window['__ccg_cb_' + event] = cb;
        };
      })();
    </script>`;

    html = html.replace('</head>', bridgeScript + '</head>');
    return html;
  }

  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
           font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           background: var(--vscode-sideBar-background); }
    .msg { text-align:center; opacity:0.6; }
  </style>
</head>
<body>
  <div class="msg">
    <p>Building webview...</p>
    <p style="font-size:12px">Run: npm run build:webview</p>
  </div>
</body>
</html>`;
  }
}
