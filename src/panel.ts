import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BridgeServer } from './bridge';

export class ClaudeCodeGuiPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: BridgeServer
  ) {
    bridge.onMessage((event, content) => {
      this._view?.webview.postMessage({ type: event, content });
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      this.bridge.handleWebviewMessage(message, webviewView.webview);
    });

    // Register webview with bridge for active file push
    this.bridge.setWebview(webviewView.webview);

    // Handle js_eval messages (for window.addSelectionInfo etc.)
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === 'js_eval') {
        // Already handled by the webview itself via postMessage listener
      }
    });

    // Forward js_eval from bridge to webview
    this.bridge.onMessage((event, content) => {
      if (event === 'js_eval') {
        webviewView.webview.postMessage({ type: 'js_eval', content });
      }
    });
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

    // Inject VSCode bridge before </head>
    const bridgeScript = `
    <script>
      (function() {
        const vscode = acquireVsCodeApi();
        window.sendToJava = function(payload) {
          vscode.postMessage({ type: 'bridge', payload });
        };
        // Map postMessage type → window function name (matches Java plugin convention)
        const TYPE_TO_FN = {
          'providers_updated':             'updateProviders',
          'active_provider_updated':       'updateActiveProvider',
          'update_dependency_status':      'updateDependencyStatus',
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
          'import_preview_result':         'import_preview_result',
          'backend_notification':          'backend_notification',
          // Streaming
          'stream_start':    'onStreamStart',
          'stream_end':      'onStreamEnd',
          'content_delta':   'onContentDelta',
          'thinking_delta':  'onThinkingDelta',
          'session_id':      'onSessionId',
          'message_data':    'onMessage',
          'send_error':      'onSendError',
          'usage_data':      'onUsage',
          'usage_update':    'onUsageUpdate',
          // Active file context
          'add_selection_info':   'addSelectionInfo',
          'clear_selection_info': 'clearSelectionInfo',
          // MCP
          'update_mcp_servers':         'updateMcpServers',
          'update_mcp_server_status':   'updateMcpServerStatus',
          'update_codex_mcp_servers':   'updateCodexMcpServers',
          'update_codex_mcp_server_status': 'updateCodexMcpServerStatus',
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
          // History
          'history_data':               'setHistoryData',
          // Sound
          'update_sound_notification_config': 'updateSoundNotificationConfig',
        };
        window.addEventListener('message', function(event) {
          const msg = event.data;
          if (!msg || !msg.type) return;
          if (msg.type === 'js_eval' && msg.content) {
            try { eval(msg.content); } catch(e) {}
            return;
          }
          // Try direct window function first
          const fnName = TYPE_TO_FN[msg.type];
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
