import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { NodeDetector } from './nodeDetector';

type MessageCallback = (event: string, content: string) => void;

// Claude model pricing (USD per 1M tokens) — approximate, kept in sync with Anthropic pricing page
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4':        { input: 15,   output: 75,   cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4':      { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-haiku-4':       { input: 0.8,  output: 4,    cacheRead: 0.08, cacheWrite: 1     },
  'claude-opus-4-5':      { input: 15,   output: 75,   cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-5':    { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-haiku-4-5':     { input: 0.8,  output: 4,    cacheRead: 0.08, cacheWrite: 1     },
  'claude-3-7-sonnet':    { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-3-5-sonnet':    { input: 3,    output: 15,   cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-3-5-haiku':     { input: 0.8,  output: 4,    cacheRead: 0.08, cacheWrite: 1     },
  'claude-3-opus':        { input: 15,   output: 75,   cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-3-haiku':       { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3   },
};

function _estimateCost(model: string, inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number): number {
  // Match by prefix (e.g. "claude-3-5-sonnet-20241022" → "claude-3-5-sonnet")
  const pricing = Object.entries(MODEL_PRICING).find(([key]) => model.toLowerCase().startsWith(key))?.[1]
    ?? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }; // default to sonnet pricing
  return (
    (inputTokens  * pricing.input     / 1_000_000) +
    (outputTokens * pricing.output    / 1_000_000) +
    (cacheRead    * pricing.cacheRead / 1_000_000) +
    (cacheWrite   * pricing.cacheWrite/ 1_000_000)
  );
}

export class BridgeServer {
  private _callbacks: MessageCallback[] = [];
  private _bridgeProcess?: cp.ChildProcess;
  private _bridgePath: string;
  private _workspacePath: string;
  private _webview?: vscode.Webview;
  private _log: vscode.OutputChannel;
  private _activeProvider: 'claude' | 'codex' = 'claude';
  private _selectedModel: string = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    this._log = vscode.window.createOutputChannel('Claude Code GUI');
    this._log.show(true);
    this._bridgePath = path.join(context.extensionPath, 'ai-bridge', 'daemon.js');
    this._workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    // Sync existing providers to disk so the daemon can read them on startup
    this._syncProviderToDisk(this._getProviders());

    this._startBridge();

    // Sync active file context when editor changes
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(e => this._pushActiveFile(e)),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this._pushActiveFile(e.textEditor);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      })
    );
  }

  onMessage(cb: MessageCallback) {
    this._callbacks.push(cb);
  }

  broadcast(event: string, content: string) {
    this._callbacks.forEach(cb => cb(event, content));
  }

  setWebview(webview: vscode.Webview) {
    this._webview = webview;
    // Push current active file immediately when webview is ready
    setTimeout(() => this._pushActiveFile(vscode.window.activeTextEditor), 500);
  }

  async handleWebviewMessage(message: any, webview: vscode.Webview) {
    if (message.type !== 'bridge') return;
    const payload: string = message.payload ?? '';
    const colonIdx = payload.indexOf(':');
    const event = colonIdx >= 0 ? payload.slice(0, colonIdx) : payload;
    const content = colonIdx >= 0 ? payload.slice(colonIdx + 1) : '';

    switch (event) {
      case 'debug_log':
        this._log.appendLine(`[WEBVIEW] ${content}`);
        break;
      case 'open_file':
        await this._openFile(content);
        break;
      case 'open_browser':
        vscode.env.openExternal(vscode.Uri.parse(content));
        break;
      case 'show_diff':
        await this._showDiff(content);
        break;
      case 'show_editable_diff':
      case 'show_interactive_diff':
        await this._showInteractiveDiff(content, webview);
        break;
      case 'show_multi_edit_diff':
      case 'show_edit_preview_diff':
      case 'show_edit_full_diff':
        await this._showEditDiff(event, content);
        break;
      case 'refresh_file':
        await this._refreshFile(content);
        break;
      case 'write_clipboard':
        await vscode.env.clipboard.writeText(content);
        break;
      case 'get_workspace_path':
        webview.postMessage({ type: 'workspace_path', content: this._workspacePath });
        break;
      case 'get_active_file':
        this._pushActiveFile(vscode.window.activeTextEditor);
        break;
      // Slash commands: read built-in + user-defined commands from .claude/commands/
      case 'refresh_slash_commands': {
        const cmds = this._getSlashCommands();
        webview.postMessage({ type: 'update_slash_commands', content: JSON.stringify(cmds) });
        break;
      }

      // File listing for @ mentions in the input box
      case 'list_files': {
        try {
          const activeEditorPath = vscode.window.activeTextEditor?.document?.uri?.fsPath || '';
          const activeEditorDir = activeEditorPath ? path.dirname(activeEditorPath) : '';
          const root = this._workspacePath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || activeEditorDir || '';
          const files: Array<{ name: string; path: string; absolutePath: string; type: 'file' | 'directory'; extension: string }> = [];
          if (root && fs.existsSync(root)) {
            let params: any = {};
            try { params = content ? JSON.parse(content) : {}; } catch { /* ignore */ }
            const query: string = (params.query || '').toLowerCase();
            const requestedPath: string = (params.currentPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

            // If frontend provided a directory hint (e.g. "src/"), narrow scan to that directory.
            let scanRoot = root;
            let scanRootRelPrefix = '';
            if (requestedPath) {
              const candidate = path.resolve(root, requestedPath);
              const normalizedRoot = path.resolve(root);
              const insideRoot = candidate === normalizedRoot || candidate.startsWith(normalizedRoot + path.sep);
              if (insideRoot && fs.existsSync(candidate)) {
                try {
                  if (fs.statSync(candidate).isDirectory()) {
                    scanRoot = candidate;
                    scanRootRelPrefix = requestedPath;
                  }
                } catch {
                  // Ignore invalid path and keep root scan.
                }
              }
            }

            const MAX = 2000;
            const shouldIgnore = this._buildIgnoreFilter(root);
            const walk = (dir: string, rel: string) => {
              if (files.length >= MAX) return;
              let entries: string[];
              try { entries = fs.readdirSync(dir); } catch { return; }
              for (const name of entries) {
                if (name === '.git') continue; // always skip .git
                const full = path.join(dir, name);
                const relPath = rel ? `${rel}/${name}` : name;
                try {
                  const stat = fs.statSync(full);
                  const isDir = stat.isDirectory();
                  if (shouldIgnore(relPath, isDir)) continue;
                  if (isDir) {
                    walk(full, relPath);
                  } else {
                    if (query && !relPath.toLowerCase().includes(query) && !name.toLowerCase().includes(query)) continue;
                    const ext = path.extname(name).replace('.', '');
                    files.push({ name, path: relPath, absolutePath: full, type: 'file', extension: ext });
                    if (files.length >= MAX) return;
                  }
                } catch { /* skip */ }
              }
            };
            walk(scanRoot, scanRootRelPrefix);
          }
          webview.postMessage({ type: 'file_list_result', content: JSON.stringify({ files, root }) });
        } catch {
          webview.postMessage({ type: 'file_list_result', content: JSON.stringify({ files: [], root: '' }) });
        }
        break;
      }

      case 'set_provider': {
        const provider = (content || '').trim();
        if (provider === 'codex' || provider === 'claude') {
          this._activeProvider = provider;
        }
        break;
      }
      case 'set_model':
        this._selectedModel = content || '';
        this._log.appendLine(`[BRIDGE] Model set to: ${this._selectedModel}`);
        break;
      // Silently ignore these — handled client-side or not needed in VSCode
      case 'tab_status_changed':
      case 'get_selected_agent':
      case 'sort_providers':
      case 'get_node_path':
      case 'get_working_directory':
      case 'get_editor_font_config':
      case 'get_codex_sandbox_mode':
      case 'get_commit_prompt':
      case 'get_sound_notification_config': {
        const cfg = this.context.globalState.get<any>('ccg.soundConfig') ?? {};
        webview.postMessage({ type: 'update_sound_notification_config', content: JSON.stringify({
          enabled: cfg.enabled ?? false,
          onlyWhenUnfocused: cfg.onlyWhenUnfocused ?? false,
          selectedSound: cfg.selectedSound ?? 'default',
          customSoundPath: cfg.customSoundPath ?? '',
        })});
        break;
      }
      case 'set_sound_notification_config':
      case 'set_sound_notification_enabled': {
        const cfg = this.context.globalState.get<any>('ccg.soundConfig') ?? {};
        try { Object.assign(cfg, JSON.parse(content)); } catch { /* ignore */ }
        this.context.globalState.update('ccg.soundConfig', cfg);
        break;
      }
      case 'set_sound_only_when_unfocused': {
        const cfg = this.context.globalState.get<any>('ccg.soundConfig') ?? {};
        try { cfg.onlyWhenUnfocused = JSON.parse(content).onlyWhenUnfocused; } catch { /* ignore */ }
        this.context.globalState.update('ccg.soundConfig', cfg);
        break;
      }
      case 'set_selected_sound': {
        const cfg = this.context.globalState.get<any>('ccg.soundConfig') ?? {};
        try { cfg.selectedSound = JSON.parse(content).soundId; } catch { /* ignore */ }
        this.context.globalState.update('ccg.soundConfig', cfg);
        break;
      }
      case 'set_custom_sound_path': {
        const cfg = this.context.globalState.get<any>('ccg.soundConfig') ?? {};
        try { cfg.customSoundPath = JSON.parse(content).path; } catch { /* ignore */ }
        this.context.globalState.update('ccg.soundConfig', cfg);
        break;
      }
      case 'test_sound':
        this._playSound(content);
        break;
      case 'browse_sound_file':
        vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
          filters: { 'Audio': ['mp3', 'wav', 'ogg', 'aiff', 'm4a'] }, title: 'Select Sound File',
        }).then(uris => {
          if (uris?.[0]) {
            webview.postMessage({ type: 'js_eval', content: `window.__onBrowseSoundResult && window.__onBrowseSoundResult(${JSON.stringify(uris[0].fsPath)})` });
          }
        });
        break;
      // ── Agents ────────────────────────────────────────────────────────────
      case 'get_agents':
        webview.postMessage({ type: 'update_agents', content: JSON.stringify(this.context.globalState.get('ccg.agents') ?? []) });
        break;
      case 'add_agent': {
        const agents = this.context.globalState.get<any[]>('ccg.agents') ?? [];
        const a = JSON.parse(content); a.id = a.id ?? Date.now().toString();
        agents.push(a); this.context.globalState.update('ccg.agents', agents);
        webview.postMessage({ type: 'update_agents', content: JSON.stringify(agents) });
        break;
      }
      case 'update_agent': {
        const { id: aid, updates: au } = JSON.parse(content);
        const agents = (this.context.globalState.get<any[]>('ccg.agents') ?? []).map((a: any) => a.id === aid ? { ...a, ...au } : a);
        this.context.globalState.update('ccg.agents', agents);
        webview.postMessage({ type: 'update_agents', content: JSON.stringify(agents) });
        break;
      }
      case 'delete_agent': {
        const { id: did } = JSON.parse(content);
        const agents = (this.context.globalState.get<any[]>('ccg.agents') ?? []).filter((a: any) => a.id !== did);
        this.context.globalState.update('ccg.agents', agents);
        webview.postMessage({ type: 'update_agents', content: JSON.stringify(agents) });
        break;
      }

      // ── Codex providers ───────────────────────────────────────────────────
      case 'get_codex_providers':
        this._postCodexProviders(webview);
        break;
      case 'add_codex_provider': {
        const incoming = JSON.parse(content || '{}');
        const providers = this._getCodexProviders();
        const provider = {
          ...incoming,
          id: incoming.id ?? Date.now().toString(),
          createdAt: incoming.createdAt ?? Date.now(),
          isActive: providers.length === 0 ? true : !!incoming.isActive,
        };
        providers.push(provider);
        this._saveCodexProviders(providers);
        this._postCodexProviders(webview);
        break;
      }
      case 'update_codex_provider': {
        const { id, updates } = JSON.parse(content || '{}');
        if (!id || !updates || typeof updates !== 'object') {
          this._postCodexProviders(webview);
          break;
        }
        const providers = this._getCodexProviders().map((p: any) =>
          p.id === id ? { ...p, ...updates } : p
        );
        this._saveCodexProviders(providers);
        this._postCodexProviders(webview);
        break;
      }
      case 'delete_codex_provider': {
        const { id } = JSON.parse(content || '{}');
        let providers = this._getCodexProviders();
        const deleting = providers.find((p: any) => p.id === id);
        providers = providers.filter((p: any) => p.id !== id);
        if (deleting?.isActive && providers.length > 0 && !providers.some((p: any) => p.isActive)) {
          providers = providers.map((p: any, idx: number) => ({ ...p, isActive: idx === 0 }));
        }
        this._saveCodexProviders(providers);
        this._postCodexProviders(webview);
        break;
      }
      case 'switch_codex_provider': {
        const { id } = JSON.parse(content || '{}');
        const providers = this._getCodexProviders().map((p: any) => ({
          ...p,
          isActive: p.id === id,
        }));
        this._saveCodexProviders(providers);
        this._postCodexProviders(webview);
        break;
      }
      case 'sort_codex_providers': {
        const { orderedIds } = JSON.parse(content || '{}');
        const providers = this._getCodexProviders();
        if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
          this._postCodexProviders(webview);
          break;
        }
        const byId = new Map(providers.map((p: any) => [p.id, p]));
        const ordered: any[] = [];
        for (const id of orderedIds) {
          const item = byId.get(id);
          if (item) {
            ordered.push(item);
            byId.delete(id);
          }
        }
        ordered.push(...Array.from(byId.values()));
        this._saveCodexProviders(ordered);
        this._postCodexProviders(webview);
        break;
      }

      // ── MCP servers ───────────────────────────────────────────────────────
      case 'get_mcp_servers':
      case 'get_codex_mcp_servers':
        this._getMcpServers(event.startsWith('get_codex'), webview);
        break;
      case 'get_mcp_server_status':
      case 'get_codex_mcp_server_status':
        this._getMcpServerStatus(event.startsWith('get_codex'), webview);
        break;
      case 'add_mcp_server':
      case 'add_codex_mcp_server':
        this._addMcpServer(event.startsWith('add_codex'), content, webview);
        break;
      case 'update_mcp_server':
      case 'update_codex_mcp_server':
        this._updateMcpServer(event.startsWith('update_codex'), content, webview);
        break;
      case 'delete_mcp_server':
      case 'delete_codex_mcp_server':
        this._deleteMcpServer(event.startsWith('delete_codex'), content, webview);
        break;
      case 'toggle_mcp_server':
      case 'toggle_codex_mcp_server':
        this._toggleMcpServer(event.startsWith('toggle_codex'), content, webview);
        break;
      case 'get_mcp_server_tools':
      case 'get_codex_mcp_server_tools':
        this._getMcpServerTools(content, webview);
        break;

      // ── Usage statistics ──────────────────────────────────────────────────
      case 'get_usage_statistics':
        this._getUsageStatistics(content, webview);
        break;

      // ── Prompts ───────────────────────────────────────────────────────────
      case 'get_project_info': {
        const info = this._getPromptProjectInfo();
        webview.postMessage({
          type: 'js_eval',
          content: `window.updateProjectInfo && window.updateProjectInfo(${JSON.stringify(JSON.stringify(info))})`,
        });
        break;
      }
      case 'get_prompts': {
        let scope: 'global' | 'project' = 'global';
        try { scope = (JSON.parse(content || '{}').scope ?? 'global') === 'project' ? 'project' : 'global'; } catch { /* ignore */ }
        this._postPrompts(scope, webview);
        break;
      }
      case 'add_prompt': {
        try {
          const payload = JSON.parse(content || '{}');
          const scope: 'global' | 'project' = payload?.scope === 'project' ? 'project' : 'global';
          const prompt = payload?.prompt && typeof payload.prompt === 'object' ? payload.prompt : null;
          if (!prompt?.id || !prompt?.name) throw new Error('Invalid prompt payload');
          const list = this._getPrompts(scope);
          list.push({
            id: String(prompt.id),
            name: String(prompt.name),
            content: String(prompt.content ?? ''),
            createdAt: Number(prompt.createdAt ?? Date.now()),
            updatedAt: Number(prompt.updatedAt ?? Date.now()),
          });
          await this._savePrompts(scope, list);
          this._postPrompts(scope, webview, list);
          webview.postMessage({
            type: 'js_eval',
            content: `window.promptOperationResult && window.promptOperationResult(${JSON.stringify(JSON.stringify({ success: true, operation: 'add' }))})`,
          });
        } catch (e: any) {
          webview.postMessage({
            type: 'js_eval',
            content: `window.promptOperationResult && window.promptOperationResult(${JSON.stringify(JSON.stringify({ success: false, operation: 'add', error: String(e?.message || 'Add failed') }))})`,
          });
        }
        break;
      }
      case 'update_prompt': {
        try {
          const payload = JSON.parse(content || '{}');
          const scope: 'global' | 'project' = payload?.scope === 'project' ? 'project' : 'global';
          const id = String(payload?.id ?? '');
          const updates = payload?.updates && typeof payload.updates === 'object' ? payload.updates : {};
          if (!id) throw new Error('Invalid prompt id');
          const list = this._getPrompts(scope).map((item: any) =>
            item.id === id ? { ...item, ...updates, id } : item
          );
          await this._savePrompts(scope, list);
          this._postPrompts(scope, webview, list);
          webview.postMessage({
            type: 'js_eval',
            content: `window.promptOperationResult && window.promptOperationResult(${JSON.stringify(JSON.stringify({ success: true, operation: 'update' }))})`,
          });
        } catch (e: any) {
          webview.postMessage({
            type: 'js_eval',
            content: `window.promptOperationResult && window.promptOperationResult(${JSON.stringify(JSON.stringify({ success: false, operation: 'update', error: String(e?.message || 'Update failed') }))})`,
          });
        }
        break;
      }
      case 'delete_prompt': {
        try {
          const payload = JSON.parse(content || '{}');
          const scope: 'global' | 'project' = payload?.scope === 'project' ? 'project' : 'global';
          const id = String(payload?.id ?? '');
          const list = this._getPrompts(scope).filter((item: any) => item.id !== id);
          await this._savePrompts(scope, list);
          this._postPrompts(scope, webview, list);
          webview.postMessage({
            type: 'js_eval',
            content: `window.promptOperationResult && window.promptOperationResult(${JSON.stringify(JSON.stringify({ success: true, operation: 'delete' }))})`,
          });
        } catch (e: any) {
          webview.postMessage({
            type: 'js_eval',
            content: `window.promptOperationResult && window.promptOperationResult(${JSON.stringify(JSON.stringify({ success: false, operation: 'delete', error: String(e?.message || 'Delete failed') }))})`,
          });
        }
        break;
      }
      case 'export_prompts': {
        try {
          const payload = JSON.parse(content || '{}');
          const scope: 'global' | 'project' = payload?.scope === 'project' ? 'project' : 'global';
          const selectedIds = Array.isArray(payload?.promptIds) ? new Set(payload.promptIds.map((id: unknown) => String(id))) : null;
          const all = this._getPrompts(scope);
          const items = selectedIds ? all.filter((p: any) => selectedIds.has(String(p.id))) : all;

          vscode.window.showSaveDialog({
            title: 'Export Prompts',
            filters: { JSON: ['json'] },
            defaultUri: vscode.Uri.file(path.join(this._workspacePath || require('os').homedir(), `prompts-${scope}.json`)),
          }).then((uri) => {
            if (!uri) return;
            try {
              fs.writeFileSync(uri.fsPath, JSON.stringify({ scope, prompts: items }, null, 2), 'utf8');
              webview.postMessage({
                type: 'js_eval',
                content: `window.addToast && window.addToast('提示词导出成功', 'success')`,
              });
            } catch (err: any) {
              webview.postMessage({
                type: 'js_eval',
                content: `window.addToast && window.addToast(${JSON.stringify(String(err?.message || '导出失败'))}, 'error')`,
              });
            }
          });
        } catch { /* ignore */ }
        break;
      }
      case 'import_prompts_file': {
        let scope: 'global' | 'project' = 'global';
        try { scope = (JSON.parse(content || '{}').scope ?? 'global') === 'project' ? 'project' : 'global'; } catch { /* ignore */ }
        vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
          filters: { JSON: ['json'] }, title: 'Import Prompts',
        }).then((uris) => {
          if (!uris || uris.length === 0) return;
          try {
            const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
            const parsed = JSON.parse(raw);
            const imported = Array.isArray(parsed?.prompts) ? parsed.prompts : Array.isArray(parsed) ? parsed : [];
            const existing = this._getPrompts(scope);
            const existingIds = new Set(existing.map((p: any) => String(p.id)));
            const items = imported
              .filter((p: any) => p && typeof p === 'object' && p.id && p.name)
              .map((p: any) => {
                const id = String(p.id);
                const conflict = existingIds.has(id);
                return {
                  data: {
                    id,
                    name: String(p.name),
                    content: String(p.content ?? ''),
                    createdAt: Number(p.createdAt ?? Date.now()),
                    updatedAt: Number(p.updatedAt ?? Date.now()),
                  },
                  status: conflict ? 'update' : 'new',
                  conflict,
                };
              });
            const preview = {
              items,
              summary: {
                total: items.length,
                newCount: items.filter((i: any) => i.status === 'new').length,
                updateCount: items.filter((i: any) => i.status === 'update').length,
              },
            };
            webview.postMessage({
              type: 'js_eval',
              content: `window.promptImportPreviewResult && window.promptImportPreviewResult(${JSON.stringify(JSON.stringify(preview))})`,
            });
          } catch (e: any) {
            webview.postMessage({
              type: 'js_eval',
              content: `window.addToast && window.addToast(${JSON.stringify(String(e?.message || '导入失败'))}, 'error')`,
            });
          }
        });
        break;
      }
      case 'save_imported_prompts': {
        try {
          const payload = JSON.parse(content || '{}');
          const scope: 'global' | 'project' = payload?.scope === 'project' ? 'project' : 'global';
          const strategy: 'skip' | 'overwrite' | 'duplicate' = payload?.strategy === 'overwrite' || payload?.strategy === 'duplicate' ? payload.strategy : 'skip';
          const incoming = Array.isArray(payload?.prompts) ? payload.prompts : [];
          const list = this._getPrompts(scope);
          const byId = new Map(list.map((item: any) => [String(item.id), item]));
          let imported = 0;
          let updated = 0;
          let skipped = 0;

          for (const rawPrompt of incoming) {
            if (!rawPrompt || typeof rawPrompt !== 'object' || !rawPrompt.id || !rawPrompt.name) {
              skipped += 1;
              continue;
            }
            const id = String(rawPrompt.id);
            const exists = byId.has(id);
            const base = {
              id,
              name: String(rawPrompt.name),
              content: String(rawPrompt.content ?? ''),
              createdAt: Number(rawPrompt.createdAt ?? Date.now()),
              updatedAt: Number(rawPrompt.updatedAt ?? Date.now()),
            };

            if (!exists) {
              list.push(base);
              byId.set(id, base);
              imported += 1;
              continue;
            }

            if (strategy === 'skip') {
              skipped += 1;
              continue;
            }
            if (strategy === 'overwrite') {
              const idx = list.findIndex((item: any) => String(item.id) === id);
              if (idx >= 0) list[idx] = { ...list[idx], ...base };
              byId.set(id, list[idx]);
              updated += 1;
              continue;
            }

            const newId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`);
            const dup = { ...base, id: newId };
            list.push(dup);
            byId.set(String(dup.id), dup);
            imported += 1;
          }

          await this._savePrompts(scope, list);
          this._postPrompts(scope, webview, list);
          const result = { success: true, imported, updated, skipped, scope };
          webview.postMessage({
            type: 'js_eval',
            content: `window.promptImportResult && window.promptImportResult(${JSON.stringify(JSON.stringify(result))})`,
          });
        } catch (e: any) {
          const result = { success: false, imported: 0, updated: 0, skipped: 0, scope: 'global', error: String(e?.message || 'Import failed') };
          webview.postMessage({
            type: 'js_eval',
            content: `window.promptImportResult && window.promptImportResult(${JSON.stringify(JSON.stringify(result))})`,
          });
        }
        break;
      }

      // ── History ───────────────────────────────────────────────────────────
      case 'load_history_data':
        this._loadHistoryData(content, webview);
        break;
      case 'load_session':
        this._loadSession(content.trim(), webview);
        break;
      case 'delete_session':
      case 'delete_history_session':
        this._deleteHistorySession(content, webview);
        break;
      case 'update_title':
      case 'update_history_title':
        this._updateHistoryTitle(content, webview);
        break;
      case 'toggle_favorite':
      case 'toggle_favorite_session':
        this._toggleFavoriteSession(content, webview);
        break;

      // ── Skills ────────────────────────────────────────────────────────────
      case 'get_all_skills':
        this._getAllSkills(webview);
        break;
      case 'import_skill':
        this._importSkill(content, webview);
        break;
      case 'delete_skill':
        this._deleteSkill(content, webview);
        break;
      case 'toggle_skill':
        this._toggleSkill(content, webview);
        break;
      case 'open_skill': {
        try { const { path: skillPath } = JSON.parse(content); vscode.commands.executeCommand('vscode.open', vscode.Uri.file(skillPath)); } catch { /* ignore */ }
        break;
      }

      // ── Settings: simple key/value stored in globalState ──────────────────
      case 'get_streaming_enabled':
        webview.postMessage({ type: 'update_streaming_enabled', content: JSON.stringify({ streamingEnabled: this._state('streaming_enabled', 'true') === 'true' }) });
        break;
      case 'get_send_shortcut':
        webview.postMessage({ type: 'update_send_shortcut', content: JSON.stringify({ sendShortcut: this._state('send_shortcut', 'Enter').toLowerCase() === 'enter' ? 'enter' : 'cmdEnter' }) });
        break;
      case 'get_auto_open_file_enabled':
        webview.postMessage({ type: 'update_auto_open_file_enabled', content: JSON.stringify({ autoOpenFileEnabled: this._state('auto_open_file', 'false') === 'true' }) });
        break;
      case 'get_thinking_enabled':
        webview.postMessage({ type: 'update_thinking_enabled', content: this._state('thinking_enabled', 'false') });
        break;
      case 'get_mode':
        webview.postMessage({ type: 'mode_received', content: this._state('permission_mode', 'default') });
        break;
      case 'set_streaming_enabled':
        this._setState('streaming_enabled', content);
        break;
      case 'set_send_shortcut':
        this._setState('send_shortcut', content);
        break;
      case 'set_auto_open_file_enabled':
        this._setState('auto_open_file', content);
        break;
      case 'set_thinking_enabled':
        this._setState('thinking_enabled', content);
        break;
      case 'set_mode':
        this._setState('permission_mode', content);
        webview.postMessage({ type: 'mode_received', content });
        break;

      // ── Dependency status ─────────────────────────────────────────────────
      case 'get_dependency_status':
        this._sendDependencyStatus(webview);
        break;
      case 'update_dependency':
        // If content contains an id, treat as SDK update (reinstall)
        if (content && content.includes('"id"')) {
          this._installDependency(content, webview);
        } else {
          this._sendDependencyStatus(webview);
        }
        break;
      case 'check_node_environment':
        this._checkNodeEnvironment(webview);
        break;
      case 'install_dependency':
      case 'update_dependency_sdk':
        this._installDependency(content, webview);
        break;
      case 'uninstall_dependency':
        this._uninstallDependency(content, webview);
        break;
      case 'get_dependency_versions': {
        const { id: depsId } = content ? JSON.parse(content) : { id: '' };
        this._getDependencyVersions(depsId, webview);
        break;
      }

      // ── cc-switch import ──────────────────────────────────────────────────
      case 'open_file_chooser_for_cc_switch':
        this._openCcSwitchFilePicker(webview);
        break;
      case 'preview_cc_switch_import':
        this._openCcSwitchFilePicker(webview); // reuse same logic
        break;
      case 'save_imported_providers': {
        const { providers: imported } = typeof content === 'string' ? JSON.parse(content) : content;
        const existing = this._getProviders();
        const merged = [...existing];
        for (const p of imported) {
          const idx = merged.findIndex((e: any) => e.id === p.id);
          if (idx >= 0) merged[idx] = p; else merged.push(p);
        }
        this._saveProviders(merged);
        webview.postMessage({ type: 'providers_updated', content: JSON.stringify(merged) });
        break;
      }

      // ── Provider management (stored in globalState) ───────────────────────
      case 'get_providers':
        webview.postMessage({ type: 'providers_updated', content: JSON.stringify(this._getProviders()) });
        break;
      case 'get_active_provider':
        webview.postMessage({ type: 'active_provider_updated', content: JSON.stringify(this._getActiveProvider()) });
        break;
      case 'add_provider': {
        const p = JSON.parse(content);
        const providers = this._getProviders();
        providers.push(p);
        this._saveProviders(providers);
        webview.postMessage({ type: 'providers_updated', content: JSON.stringify(providers) });
        break;
      }
      case 'update_provider': {
        const { id, updates } = JSON.parse(content);
        const providers = this._getProviders().map((p: any) =>
          p.id === id ? { ...p, ...updates } : p
        );
        this._saveProviders(providers);
        webview.postMessage({ type: 'providers_updated', content: JSON.stringify(providers) });
        break;
      }
      case 'delete_provider': {
        const { id: delId } = JSON.parse(content);
        const providers = this._getProviders().filter((p: any) => p.id !== delId);
        this._saveProviders(providers);
        webview.postMessage({ type: 'providers_updated', content: JSON.stringify(providers) });
        break;
      }
      case 'switch_provider': {
        const { id: switchId } = JSON.parse(content);
        const providers = this._getProviders().map((p: any) => ({
          ...p,
          isActive: switchId === '__disabled__' ? false : p.id === switchId,
        }));
        this._saveProviders(providers);
        const active = providers.find((p: any) => p.isActive) ?? null;
        webview.postMessage({ type: 'providers_updated', content: JSON.stringify(providers) });
        webview.postMessage({ type: 'active_provider_updated', content: JSON.stringify(active) });
        break;
      }

      // ── Slash commands / agents / MCP (pass to ai-bridge) ─────────────────
      default:
        this._sendToBridge(event, content, webview);
    }
  }

  private _pushActiveFile(editor?: vscode.TextEditor) {
    if (!this._webview) return;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const sel = editor.selection;
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;

    let selectionInfo: string;
    if (!sel.isEmpty) {
      selectionInfo = startLine === endLine
        ? `@${filePath}#L${startLine}`
        : `@${filePath}#L${startLine}-${endLine}`;
    } else {
      selectionInfo = `@${filePath}`;
    }

    this._webview.postMessage({ type: 'add_selection_info', content: selectionInfo });
  }

  private async _openFile(pathWithLine: string) {
    const parts = pathWithLine.split(':');
    const filePath = parts[0];
    const lineStr = parts[1];
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (lineStr) {
      const line = parseInt(lineStr, 10) - 1;
      const pos = new vscode.Position(Math.max(0, line), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async _showDiff(content: string) {
    try {
      const data = JSON.parse(content);
      const uri = vscode.Uri.file(data.filePath);
      const oldContent = data.oldContent ?? '';
      const newContent = data.newContent ?? '';
      const title = data.title ?? path.basename(data.filePath);

      const oldUri = await this._writeTempFile(data.filePath + '.ccg-old', oldContent);
      const newUri = await this._writeTempFile(data.filePath + '.ccg-new', newContent);
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
    } catch { /* ignore */ }
  }

  private async _showInteractiveDiff(content: string, webview: vscode.Webview) {
    try {
      const data = JSON.parse(content);
      const filePath: string = data.filePath;
      const newContents: string = data.newFileContents ?? data.newContent ?? '';
      const isNewFile: boolean = data.isNewFile ?? false;
      const title = data.tabName ?? `${path.basename(filePath)} (proposed)`;

      if (isNewFile) {
        // For new files, show a preview and offer to create
        const action = await vscode.window.showInformationMessage(
          `Claude wants to create: ${path.basename(filePath)}`,
          'Create File', 'Cancel'
        );
        if (action === 'Create File') {
          await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newContents, 'utf8'));
          await vscode.window.showTextDocument(vscode.Uri.file(filePath));
          webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: true }) });
        }
        return;
      }

      // For existing files: show diff with Apply/Reject via quick pick
      const originalContent = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf8') : '';

      const oldUri = await this._writeTempFile(filePath + '.ccg-original', originalContent);
      const newUri = await this._writeTempFile(filePath + '.ccg-proposed', newContents);

      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);

      const action = await vscode.window.showInformationMessage(
        `Apply changes to ${path.basename(filePath)}?`,
        'Apply', 'Reject'
      );

      // Clean up temp files
      try {
        await vscode.workspace.fs.delete(oldUri);
        await vscode.workspace.fs.delete(newUri);
      } catch { /* ignore */ }

      if (action === 'Apply') {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newContents, 'utf8'));
        webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: true }) });
      } else {
        webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: false }) });
      }
    } catch { /* ignore */ }
  }

  private async _showEditDiff(event: string, content: string) {
    try {
      const data = JSON.parse(content);
      const filePath: string = data.filePath;
      const originalContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

      let newContent = originalContent;
      const edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }> =
        data.edits ?? (data.oldString !== undefined ? [{ oldString: data.oldString, newString: data.newString, replaceAll: data.replaceAll }] : []);

      for (const edit of edits) {
        if (edit.replaceAll) {
          newContent = newContent.split(edit.oldString).join(edit.newString);
        } else {
          newContent = newContent.replace(edit.oldString, edit.newString);
        }
      }

      const title = data.title ?? `${path.basename(filePath)} (edit preview)`;
      const oldUri = await this._writeTempFile(filePath + '.ccg-old', originalContent);
      const newUri = await this._writeTempFile(filePath + '.ccg-new', newContent);
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
    } catch { /* ignore */ }
  }

  private async _refreshFile(content: string) {
    try {
      const data = typeof content === 'string' && content.startsWith('{')
        ? JSON.parse(content) : { filePath: content };
      const uri = vscode.Uri.file(data.filePath);
      // Trigger file system watcher by touching the document
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === data.filePath);
      if (doc) {
        await vscode.commands.executeCommand('workbench.action.files.revert', uri);
      }
    } catch { /* ignore */ }
  }

  private async _writeTempFile(filePath: string, content: string): Promise<vscode.Uri> {
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return uri;
  }

  private _lastModel = new Map<string, string>(); // id → model name
  private _lastSessionId = new Map<string, string>(); // id → session id
  private _lastUsage = new Map<string, any>(); // id → last usage data
  private _lastEpoch = new Map<string, string>(); // id → runtimeSessionEpoch (tabId)
  private _reqId = 0;
  private _pendingWebviews = new Map<string, vscode.Webview>();
  private _streamStarted = new Set<string>();
  private _contentStarted = new Set<string>();
  private _inThinking = new Set<string>();

  private _emitStreamStart(id: string, webview: vscode.Webview) {
    if (!this._streamStarted.has(id)) {
      this._streamStarted.add(id);
      webview.postMessage({ type: 'stream_start' });
    }
  }

  private _emitStreamEnd(id: string, webview: vscode.Webview) {
    this._streamStarted.delete(id);
    this._contentStarted.delete(id);
    this._inThinking.delete(id);
    this._lastModel.delete(id);
    this._lastSessionId.delete(id);
    this._lastUsage.delete(id);
    this._lastEpoch.delete(id);
    this._pendingWebviews.delete(id);
    webview.postMessage({ type: 'stream_end' });
  }

  private _sendToBridge(event: string, content: string, webview: vscode.Webview) {
    const isHeartbeat = event === 'heartbeat';
    if (!isHeartbeat) {
      this._log.appendLine(`[BRIDGE] _sendToBridge called: event=${event}`);
    }
    if (!this._bridgeProcess || this._bridgeProcess.killed) {
      this._log.appendLine('[BRIDGE] Daemon not running, starting...');
      this._startBridge();
    }
    if (!this._bridgeProcess?.stdin) {
      this._log.appendLine('[BRIDGE] ERROR: No stdin available after _startBridge');
      return;
    }

    const id = String(++this._reqId);

    let params: any = {};
    try { params = content ? JSON.parse(content) : {}; } catch { params = { text: content }; }
    params.workspacePath = params.workspacePath ?? this._workspacePath;

    const providerFromPayload = params?.provider;
    const activeProvider: 'claude' | 'codex' =
      providerFromPayload === 'codex' || providerFromPayload === 'claude'
        ? providerFromPayload
        : this._activeProvider;

    // Map webview event names → daemon method names
    const METHOD_MAP: Record<string, string> = {
      'send_message':                  `${activeProvider}.send`,
      'send_message_with_attachments': activeProvider === 'codex' ? 'codex.send' : 'claude.sendWithAttachments',
      'preconnect':                    'claude.preconnect',
      'abort':                         'claude.abort',
      'reset_runtime':                 'claude.resetRuntime',
      'get_dependency_status':         'status',
      'heartbeat':                     'heartbeat',
    };

    const method = METHOD_MAP[event];
    if (!method) {
      this._log.appendLine(`[BRIDGE] No method mapping for event: ${event}`);
      return;
    }

    // Fill in selectedText for openedFiles.selection if missing
    if (params.openedFiles?.selection && !params.openedFiles.selection.selectedText && params.openedFiles.active) {
      try {
        const filePath = params.openedFiles.active.replace(/#L\d+(-\d+)?$/, '');
        const { startLine, endLine } = params.openedFiles.selection;
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n');
        const start = Math.max(0, (startLine ?? 1) - 1);
        const end = Math.min(lines.length, (endLine ?? startLine ?? 1));
        params.openedFiles.selection.selectedText = lines.slice(start, end).join('\n');
      } catch { /* ignore read errors */ }
    }

    if (params.text !== undefined && params.message === undefined) {
      params.message = params.text;
    }

    // Inject the selected model if not already set in params
    if (!params.model && this._selectedModel) {
      params.model = this._selectedModel;
    }

    this._pendingWebviews.set(id, webview);
    const msg = JSON.stringify({ id, method, params }) + '\n';
      if (!isHeartbeat) {
        this._log.appendLine(`[BRIDGE] Sending to daemon: id=${id} method=${method} msg_len=${msg.length}`);
      }
      this._bridgeProcess.stdin.write(msg);
  }

  private _startBridge() {
    if (!fs.existsSync(this._bridgePath)) {
      this._log.appendLine(`[BRIDGE] ERROR: daemon not found at ${this._bridgePath}`);
      return;
    }
    const nodePath = NodeDetector.find(this.context);
    if (!nodePath) {
      this._log.appendLine('[BRIDGE] ERROR: Node.js not found');
      return;
    }
    this._log.appendLine(`[BRIDGE] Starting daemon: node=${nodePath} path=${this._bridgePath}`);

    this._bridgeProcess = cp.spawn(nodePath, [this._bridgePath], {
      cwd: path.dirname(this._bridgePath),
      env: { ...process.env, WORKSPACE_PATH: this._workspacePath },
    });

    this._bridgeProcess.on('error', (err) => { this._log.appendLine(`[BRIDGE] Spawn error: ${err.message}`); });
    this._bridgeProcess.stderr?.on('data', (d: Buffer) => this._log.appendLine(`[ERR] ${d.toString().trim().slice(0, 400)}`));

    let buf = '';
    this._bridgeProcess.stdout?.on('data', (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: any | null = null;
        try {
          parsed = JSON.parse(line);
          // Keep heartbeat alive, but avoid flooding output channel with repetitive noise.
          if (parsed?.type !== 'heartbeat') {
            this._log.appendLine(`[D] ${line.slice(0, 400)}`);
          }
          this._handleDaemonLine(parsed);
        } catch { /* ignore malformed */ }
      }
    });

    this._bridgeProcess.on('exit', (code) => {
      this._bridgeProcess = undefined;
    });
  }

  private _handleDaemonLine(msg: any) {
    // Daemon lifecycle events (no id)
    if (msg.type === 'daemon') {
      if (msg.event === 'ready') {
        if (this._webview) this._webview.postMessage({ type: 'js_eval', content: 'window.onSdkLoaded && window.onSdkLoaded()' });
      }
      return;
    }

    // heartbeat response — ignore
    if (msg.type === 'heartbeat') return;

    const webview = msg.id ? this._pendingWebviews.get(msg.id) : this._webview;
    if (!webview) return;

    // Streaming line events
    if (msg.line !== undefined) {
      const line: string = msg.line;

      if (line === '[STREAM_START]') {
        this._emitStreamStart(msg.id, webview);
      } else if (line === '[STREAM_END]' || line === '[MESSAGE_END]') {
        this._emitStreamEnd(msg.id, webview);
      } else if (line.startsWith('[CONTENT_DELTA] ')) {
        const delta = JSON.parse(line.slice('[CONTENT_DELTA] '.length));
        this._emitStreamStart(msg.id, webview);
        webview.postMessage({ type: 'content_delta', content: delta });
      } else if (line.startsWith('[CONTENT] ')) {
        const delta = line.slice('[CONTENT] '.length);
        this._inThinking.delete(msg.id); // switch from thinking to content
        this._emitStreamStart(msg.id, webview);
        if (this._contentStarted.has(msg.id)) {
          webview.postMessage({ type: 'content_delta', content: '\n' });
        }
        this._contentStarted.add(msg.id);
        webview.postMessage({ type: 'content_delta', content: delta });
      } else if (line.startsWith('[THINKING_DELTA] ')) {
        const delta = JSON.parse(line.slice('[THINKING_DELTA] '.length));
        this._emitStreamStart(msg.id, webview);
        webview.postMessage({ type: 'thinking_delta', content: delta });
      } else if (line.startsWith('[THINKING] ')) {
        const text = line.slice('[THINKING] '.length);
        this._emitStreamStart(msg.id, webview);
        this._inThinking.add(msg.id);
        webview.postMessage({ type: 'thinking_delta', content: text });
      } else if (line.startsWith('[THINKING_HINT] ')) {
        const hint = line.slice('[THINKING_HINT] '.length).trim();
        if (hint) {
          webview.postMessage({
            type: 'js_eval',
            content: `window.addToast && window.addToast(${JSON.stringify(hint)}, 'info')`,
          });
        }
      } else if (line.startsWith('[SESSION_ID] ')) {
        const sessionId = line.slice('[SESSION_ID] '.length).trim();
        this._lastSessionId.set(msg.id, sessionId);
        webview.postMessage({ type: 'session_id', content: sessionId });
        // Record this session in our own index so history only shows plugin sessions
        this._recordSessionId(sessionId);
        // Send back the epoch (tabId) so webview can route messages to the correct tab
        const epoch = this._lastEpoch.get(msg.id);
        if (epoch) {
          webview.postMessage({ type: 'js_eval', content: `window.__ccg_onSessionEpoch && window.__ccg_onSessionEpoch(${JSON.stringify(sessionId)}, ${JSON.stringify(epoch)})` });
        }
      } else if (line.startsWith('[THREAD_ID] ')) {
        // Codex runtime emits thread IDs; treat them as session IDs for UI/history compatibility.
        const threadId = line.slice('[THREAD_ID] '.length).trim();
        this._lastSessionId.set(msg.id, threadId);
        webview.postMessage({ type: 'session_id', content: threadId });
        this._recordSessionId(threadId);
        const epoch = this._lastEpoch.get(msg.id);
        if (epoch) {
          webview.postMessage({ type: 'js_eval', content: `window.__ccg_onSessionEpoch && window.__ccg_onSessionEpoch(${JSON.stringify(threadId)}, ${JSON.stringify(epoch)})` });
        }
      } else if (line.startsWith('[MODEL] ')) {
        const model = line.slice('[MODEL] '.length).trim();
        if (model) this._lastModel.set(msg.id, model);
      } else if (line.startsWith('[MESSAGE] ')) {
        const payload = line.slice('[MESSAGE] '.length);
        // Extract model from assistant messages
        try {
          const parsed = JSON.parse(payload);
          if ((parsed.type === 'assistant' || parsed.type === 'user') && parsed.message?.content) {
            const sid = this._lastSessionId.get(msg.id) ?? '';
            const text = this._extractCodexTextFromContent(parsed.message.content);
            if (parsed.type === 'assistant' && text.trim()) {
              // Mark that assistant textual content has already streamed for this turn.
              this._contentStarted.add(msg.id);
            }
            if (sid) {
              if (text) {
                this._appendCodexHistoryMessage(
                  sid,
                  parsed.type === 'assistant' ? 'assistant' : 'user',
                  text,
                  new Date().toISOString(),
                );
              }
            }
          }
          if (parsed.type === 'assistant' && parsed.message?.model) {
            this._lastModel.set(msg.id, parsed.message.model);
          }
          // Also record usage from assistant messages directly (model + usage available together)
          if (parsed.type === 'assistant' && parsed.message?.usage) {
            const u = parsed.message.usage;
            const inputTokens = u.input_tokens ?? 0;
            const outputTokens = u.output_tokens ?? 0;
            const cacheRead = u.cache_read_input_tokens ?? 0;
            const cacheWrite = u.cache_creation_input_tokens ?? 0;
            const model = parsed.message.model ?? this._lastModel.get(msg.id) ?? 'unknown';
            const sessionId = this._lastSessionId.get(msg.id) ?? '';
            const cost = _estimateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);
            const now = Date.now();
            const dateKey = new Date(now).toISOString().slice(0, 10);
            const stats = this.context.globalState.get<any>('ccg.usageStats') ?? { sessions: [], dailyMap: {} };
            if (sessionId) {
              const existing = stats.sessions.findIndex((s: any) => s.sessionId === sessionId);
              const entry = {
                sessionId, timestamp: now, model,
                usage: { inputTokens, outputTokens, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead, totalTokens: inputTokens + outputTokens },
                cost,
              };
              if (existing >= 0) stats.sessions[existing] = entry; else stats.sessions.push(entry);
            }
            const day = stats.dailyMap[dateKey] ?? { cost: 0, inputTokens: 0, outputTokens: 0, sessions: 0, modelsUsed: [] };
            if (!sessionId) {
              day.cost += cost; day.inputTokens += inputTokens; day.outputTokens += outputTokens; day.sessions++;
            }
            if (!day.modelsUsed.includes(model)) day.modelsUsed.push(model);
            stats.dailyMap[dateKey] = day;
            this.context.globalState.update('ccg.usageStats', stats);
          }
          // Parse result message for token usage and final content
          if (parsed.type === 'result') {
            const usage = parsed.usage ?? {};
            const inputTokens = usage.input_tokens ?? 0;
            const outputTokens = usage.output_tokens ?? 0;
            const cacheRead = usage.cache_read_input_tokens ?? 0;
            const cacheWrite = usage.cache_creation_input_tokens ?? 0;
            const cost = parsed.total_cost_usd ?? 0;
            const model = this._lastModel.get(msg.id) ?? 'unknown';
            const sessionId = parsed.session_id ?? '';
            const now = Date.now();
            const dateKey = new Date(now).toISOString().slice(0, 10);

            const stats = this.context.globalState.get<any>('ccg.usageStats') ?? { sessions: [], dailyMap: {} };
            if (sessionId) {
              const existing = stats.sessions.findIndex((s: any) => s.sessionId === sessionId);
              const entry = {
                sessionId, timestamp: now, model,
                usage: { inputTokens, outputTokens, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead, totalTokens: inputTokens + outputTokens },
                cost, summary: (parsed.result ?? '').slice(0, 100),
              };
              if (existing >= 0) stats.sessions[existing] = entry; else stats.sessions.push(entry);
            }
            const day = stats.dailyMap[dateKey] ?? { cost: 0, inputTokens: 0, outputTokens: 0, sessions: 0, modelsUsed: [] };
            day.cost += cost; day.inputTokens += inputTokens; day.outputTokens += outputTokens; day.sessions++;
            if (!day.modelsUsed.includes(model)) day.modelsUsed.push(model);
            stats.dailyMap[dateKey] = day;
            this.context.globalState.update('ccg.usageStats', stats);

            if (parsed.result && typeof parsed.result === 'string') {
              // Fallback only: if no assistant text streamed this turn, emit final result once.
              if (!this._contentStarted.has(msg.id)) {
                this._emitStreamStart(msg.id, webview);
                this._contentStarted.add(msg.id);
                webview.postMessage({ type: 'content_delta', content: parsed.result });
              }
            }
            webview.postMessage({ type: 'usage_update', content: JSON.stringify({
              percentage: Math.min(100, (inputTokens / 200000) * 100),
              usedTokens: inputTokens, maxTokens: 200000,
            })});
          }
        } catch { /* ignore */ }
        webview.postMessage({ type: 'message_data', content: payload });
      } else if (line.startsWith('[SEND_ERROR] ') || line.startsWith('[ERROR] ')) {
        const payload = line.replace(/^\[[A-Z_]+\] /, '');
        webview.postMessage({ type: 'send_error', content: payload });
      } else if (line.startsWith('[USAGE] ')) {
        const payload = line.slice('[USAGE] '.length);
        webview.postMessage({ type: 'usage_data', content: payload });
        // Record usage for statistics (SDK path doesn't emit [MESSAGE] result with cost)
        try {
          const usage = JSON.parse(payload);
          const inputTokens: number = usage.input_tokens ?? 0;
          const outputTokens: number = usage.output_tokens ?? 0;
          const cacheRead: number = usage.cache_read_input_tokens ?? 0;
          const cacheWrite: number = usage.cache_creation_input_tokens ?? 0;
          const model = this._lastModel.get(msg.id) ?? 'unknown';
          const sessionId = this._lastSessionId.get(msg.id) ?? '';

          // Estimate cost based on model pricing (USD per 1M tokens)
          const cost = _estimateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);

          this._lastUsage.set(msg.id, { inputTokens, outputTokens, cacheRead, cacheWrite, cost, model, sessionId });

          const now = Date.now();
          const dateKey = new Date(now).toISOString().slice(0, 10);
          const stats = this.context.globalState.get<any>('ccg.usageStats') ?? { sessions: [], dailyMap: {} };

          if (sessionId) {
            const existing = stats.sessions.findIndex((s: any) => s.sessionId === sessionId);
            const entry = {
              sessionId, timestamp: now, model,
              usage: { inputTokens, outputTokens, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead, totalTokens: inputTokens + outputTokens },
              cost,
            };
            if (existing >= 0) stats.sessions[existing] = entry; else stats.sessions.push(entry);
          }

          const day = stats.dailyMap[dateKey] ?? { cost: 0, inputTokens: 0, outputTokens: 0, sessions: 0, modelsUsed: [] };
          // Avoid double-counting: only update daily if this session isn't already recorded today
          const alreadyToday = sessionId && stats.sessions.some((s: any) =>
            s.sessionId === sessionId && new Date(s.timestamp).toISOString().slice(0, 10) === dateKey
          );
          if (!alreadyToday || !sessionId) {
            day.cost += cost; day.inputTokens += inputTokens; day.outputTokens += outputTokens; day.sessions++;
          } else {
            // Update cost in place (latest usage wins)
            day.cost = (day.cost - (stats.sessions.find((s: any) => s.sessionId === sessionId)?.cost ?? 0)) + cost;
          }
          if (!day.modelsUsed.includes(model)) day.modelsUsed.push(model);
          stats.dailyMap[dateKey] = day;
          this.context.globalState.update('ccg.usageStats', stats);

          webview.postMessage({ type: 'usage_update', content: JSON.stringify({
            percentage: Math.min(100, (inputTokens / 200000) * 100),
            usedTokens: inputTokens, maxTokens: 200000,
          })});
        } catch { /* ignore */ }
      } else if (!line.startsWith('[')) {
        // Bare text line — route to thinking or content based on current state
        this._emitStreamStart(msg.id, webview);
        if (this._inThinking.has(msg.id)) {
          webview.postMessage({ type: 'thinking_delta', content: '\n' + line });
        } else {
          if (this._contentStarted.has(msg.id)) {
            webview.postMessage({ type: 'content_delta', content: '\n' });
          }
          this._contentStarted.add(msg.id);
          webview.postMessage({ type: 'content_delta', content: line });
        }
      }
      return;
    }

    // Request done
    if (msg.done) {
      if (!msg.success) {
        webview.postMessage({ type: 'send_error', content: JSON.stringify(msg.error ?? 'Unknown error') });
      }
      this._emitStreamEnd(msg.id, webview);
    }
  }

  private _checkNodeEnvironment(webview: vscode.Webview) {
    const nodePath = NodeDetector.find(this.context);
    webview.postMessage({
      type: 'node_environment_status',
      content: JSON.stringify({ available: !!nodePath, nodePath: nodePath ?? '' })
    });
  }

  private _installDependency(content: string, webview: vscode.Webview) {
    let sdkId = 'claude-sdk';
    try { sdkId = JSON.parse(content).id ?? sdkId; } catch { /* use default */ }

    const SDK_PKG_MAP: Record<string, string> = {
      'claude-sdk': '@anthropic-ai/claude-agent-sdk',
      'codex-sdk': '@openai/codex-sdk',
    };
    const pkg = SDK_PKG_MAP[sdkId] ?? sdkId;

    const send = (log: string) =>
      webview.postMessage({ type: 'dependency_install_progress', content: JSON.stringify({ sdkId, log }) });

    send(`Installing ${pkg}...\n`);

    // Install to ~/.codemoss/dependencies/<sdkId>/ — must match ai-bridge/utils/sdk-loader.js lookup path
    const os = require('os') as typeof import('os');
    const sdkDir = path.join(os.homedir(), '.codemoss', 'dependencies', sdkId);
    if (!fs.existsSync(sdkDir)) fs.mkdirSync(sdkDir, { recursive: true });

    // Ensure package.json exists — npm install in a bare directory can be unreliable
    const pkgJsonPath = path.join(sdkDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: sdkId, version: '1.0.0', private: true }, null, 2));
    }

    const proc = cp.spawn('npm', ['install', pkg], {
      cwd: sdkDir,
      env: process.env,
      shell: true,
    });

    proc.stdout?.on('data', (d: Buffer) => send(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => send(d.toString()));
    proc.on('error', (err: Error) => {
      send(`Error: ${err.message}\n`);
      webview.postMessage({ type: 'dependency_install_result', content: JSON.stringify({ sdkId, success: false, error: err.message }) });
    });
    proc.on('close', (code: number) => {
      webview.postMessage({ type: 'dependency_install_result', content: JSON.stringify({ sdkId, success: code === 0, error: code !== 0 ? `exit code ${code}` : undefined }) });
      this._sendDependencyStatus(webview);
    });
  }

  private _uninstallDependency(content: string, webview: vscode.Webview) {
    let sdkId = 'claude-sdk';
    try { sdkId = JSON.parse(content).id ?? sdkId; } catch { /* use default */ }
    const SDK_PKG_MAP: Record<string, string> = {
      'claude-sdk': '@anthropic-ai/claude-agent-sdk',
      'codex-sdk': '@openai/codex-sdk',
    };
    const pkg = SDK_PKG_MAP[sdkId] ?? sdkId;
    const os = require('os') as typeof import('os');
    const sdkDir = path.join(os.homedir(), '.codemoss', 'dependencies', sdkId);
    const proc = cp.spawn('npm', ['uninstall', pkg], { cwd: sdkDir, shell: true });
    proc.on('close', (code: number) => {
      webview.postMessage({ type: 'dependency_uninstall_result', content: JSON.stringify({ sdkId, success: code === 0 }) });
      this._sendDependencyStatus(webview);
    });
  }

  private async _openCcSwitchFilePicker(webview: vscode.Webview) {
    // Try reading from cc-switch SQLite database first
    const os = require('os') as typeof import('os');
    const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    if (fs.existsSync(dbPath)) {
      this._previewCcSwitchFromDb(dbPath, webview);
      return;
    }
    // Fallback: let user pick a JSON file
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      filters: { 'JSON': ['json'] }, title: 'Select cc-switch config.json',
    });
    if (!uris || uris.length === 0) {
      webview.postMessage({ type: 'backend_notification', content: JSON.stringify({ type: 'info', title: '', message: 'No file selected' }) });
      return;
    }
    this._previewCcSwitchImport(uris[0].fsPath, webview);
  }

  private _previewCcSwitchFromDb(dbPath: string, webview: vscode.Webview) {
    try {
      const rows = cp.execSync(
        `sqlite3 "${dbPath}" "SELECT id,name,settings_config,is_current FROM providers WHERE app_type='claude';"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim().split('\n').filter(Boolean);

      const providers = rows.map(row => {
        const parts = row.split('|');
        const id = parts[0], name = parts[1], settingsConfigRaw = parts[2], isCurrent = parts[3] === '1';
        let settingsConfig: any = {};
        try { settingsConfig = JSON.parse(settingsConfigRaw); } catch { /* ignore */ }
        return { id, name, settingsConfig, isActive: isCurrent, source: 'cc-switch' };
      });

      webview.postMessage({ type: 'import_preview_result', content: JSON.stringify({ providers }) });
    } catch (e: any) {
      webview.postMessage({ type: 'backend_notification', content: JSON.stringify({ type: 'error', title: 'Import failed', message: e.message }) });
    }
  }

  private _previewCcSwitchImport(filePath: string | null, webview: vscode.Webview) {
    const os = require('os') as typeof import('os');
    const target = filePath ?? path.join(os.homedir(), '.cc-switch', 'config.json');
    try {
      const raw = fs.readFileSync(target, 'utf8');
      const cfg = JSON.parse(raw);
      const providers: any[] = cfg.providers ?? cfg.configs ?? [];
      webview.postMessage({ type: 'import_preview_result', content: JSON.stringify({ providers }) });
    } catch (e: any) {
      webview.postMessage({ type: 'backend_notification', content: JSON.stringify({ type: 'error', title: 'Import failed', message: e.message }) });
    }
  }

  private _playSound(content: string) {
    let soundId = 'default';
    let customPath = '';
    try { const p = JSON.parse(content); soundId = p.soundId ?? 'default'; customPath = p.path ?? ''; } catch { /* ignore */ }

    // Built-in macOS system sounds
    const SYSTEM_SOUNDS: Record<string, string> = {
      default: '/System/Library/Sounds/Ping.aiff',
      chime:   '/System/Library/Sounds/Glass.aiff',
      bell:    '/System/Library/Sounds/Tink.aiff',
      ding:    '/System/Library/Sounds/Pop.aiff',
      success: '/System/Library/Sounds/Hero.aiff',
    };

    const soundFile = soundId === 'custom' ? customPath : (SYSTEM_SOUNDS[soundId] ?? SYSTEM_SOUNDS.default);
    if (!soundFile) return;

    // macOS: afplay, Linux: aplay/paplay, Windows: PowerShell
    const platform = process.platform;
    if (platform === 'darwin') {
      cp.spawn('afplay', [soundFile], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'linux') {
      cp.spawn('paplay', [soundFile], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'win32') {
      cp.spawn('powershell', ['-c', `(New-Object Media.SoundPlayer "${soundFile}").PlaySync()`], { detached: true, stdio: 'ignore' }).unref();
    }
  }

  // ── History helpers ───────────────────────────────────────────────────────

  private _getSessionIndexFile(): string {
    const os = require('os') as typeof import('os');
    return path.join(os.homedir(), '.codemoss', 'vscode-session-index.json');
  }

  private _recordSessionId(sessionId: string) {
    try {
      const os = require('os') as typeof import('os');
      const dir = path.join(os.homedir(), '.codemoss');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = this._getSessionIndexFile();
      const index: Record<string, number> = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      if (!index[sessionId]) {
        index[sessionId] = Date.now();
        fs.writeFileSync(file, JSON.stringify(index, null, 2), 'utf8');
      }
    } catch { /* ignore */ }
  }

  private _getClaudeProjectsDir(): string {
    const os = require('os') as typeof import('os');
    return path.join(os.homedir(), '.claude', 'projects');
  }
  private _getCodexArchivedDir(): string {
    const os = require('os') as typeof import('os');
    return path.join(os.homedir(), '.codex', 'archived_sessions');
  }
  private _extractCodexTextFromContent(content: any): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if ((block.type === 'text' || block.type === 'output_text' || block.type === 'input_text') && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n').trim();
  }
  private _appendCodexHistoryMessage(sessionId: string, role: 'user' | 'assistant', content: string, timestamp?: string) {
    if (!sessionId || !content.trim()) return;
    try {
      const key = 'ccg.codexHistoryCache';
      const cache = this.context.globalState.get<Record<string, { messages: any[]; updatedAt: string }>>(key) ?? {};
      const existing = cache[sessionId] ?? { messages: [], updatedAt: new Date().toISOString() };
      const nextMessages = [...existing.messages, {
        type: role,
        content,
        timestamp: timestamp ?? new Date().toISOString(),
      }];
      existing.messages = nextMessages.slice(-400);
      existing.updatedAt = timestamp ?? new Date().toISOString();
      cache[sessionId] = existing;

      const entries = Object.entries(cache)
        .sort((a, b) => new Date(b[1].updatedAt).getTime() - new Date(a[1].updatedAt).getTime())
        .slice(0, 200);
      const trimmed: Record<string, { messages: any[]; updatedAt: string }> = {};
      for (const [sid, data] of entries) trimmed[sid] = data;
      this.context.globalState.update(key, trimmed);
    } catch { /* ignore */ }
  }

  private _getFavoritesKey(): string { return 'ccg.historyFavorites'; }

  private _loadHistoryData(provider: string, webview: vscode.Webview) {
    if (provider === 'codex') {
      this._loadCodexHistoryData(webview);
      return;
    }
    const os = require('os') as typeof import('os');
    const projectsDir = this._getClaudeProjectsDir();
    const favorites: Record<string, { favoritedAt: number }> =
      this.context.globalState.get(this._getFavoritesKey()) ?? {};

    // Only show sessions that were created by this plugin (from our session index)
    let pluginSessionIds = new Set<string>();
    try {
      const indexFile = this._getSessionIndexFile();
      if (fs.existsSync(indexFile)) {
        const index: Record<string, number> = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        pluginSessionIds = new Set(Object.keys(index));
      }
    } catch { /* ignore */ }

    // Fallback: also include sessions from ccg.usageStats (for backward compat)
    const usageStats = this.context.globalState.get<any>('ccg.usageStats') ?? { sessions: [] };
    for (const s of (usageStats.sessions ?? [])) {
      if (s.sessionId) pluginSessionIds.add(s.sessionId);
    }

    // Load custom titles from ~/.codemoss/session-titles.json (IDEA plugin format)
    let codemossTitles: Record<string, { customTitle: string }> = {};
    try {
      const titlesFile = path.join(os.homedir(), '.codemoss', 'session-titles.json');
      if (fs.existsSync(titlesFile)) {
        codemossTitles = JSON.parse(fs.readFileSync(titlesFile, 'utf8'));
      }
    } catch { /* ignore */ }

    const vscTitles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};

    const sessions: any[] = [];

    try {
      if (!fs.existsSync(projectsDir)) {
        webview.postMessage({ type: 'history_data', content: JSON.stringify({ success: true, sessions: [], total: 0, favorites }) });
        return;
      }

      for (const projectDir of fs.readdirSync(projectsDir)) {
        const projectPath = path.join(projectsDir, projectDir);
        if (!fs.statSync(projectPath).isDirectory()) continue;

        for (const file of fs.readdirSync(projectPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = file.replace(/\.jsonl$/, '');

          // Only include sessions created by this plugin
          if (pluginSessionIds.size > 0 && !pluginSessionIds.has(sessionId)) continue;

          const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
          try {
            const stat = fs.statSync(filePath);
            const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);

            let firstUserText = '';
            let messageCount = 0;
            let lastTimestamp = stat.mtime.toISOString();

            for (const line of lines) {
              try {
                const msg = JSON.parse(line);
                if (!firstUserText && msg.type === 'user') {
                  const c = msg.message?.content;
                  const text = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((b: any) => b.type === 'text')?.text ?? '') : '');
                  if (text.trim()) firstUserText = text.slice(0, 80);
                }
                if (msg.type === 'user' || msg.type === 'assistant') messageCount++;
                if (msg.timestamp) lastTimestamp = msg.timestamp;
              } catch { /* skip */ }
            }

            if (messageCount === 0) continue;

            // Title priority: codemoss > vsc custom > first user message > sessionId
            const title = codemossTitles[sessionId]?.customTitle
              || vscTitles[sessionId]
              || firstUserText
              || sessionId.slice(0, 8);

            sessions.push({
              sessionId, title, messageCount, lastTimestamp,
              isFavorited: !!favorites[sessionId],
              favoritedAt: favorites[sessionId]?.favoritedAt,
              provider: 'claude',
            });
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }

    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());
    webview.postMessage({ type: 'history_data', content: JSON.stringify({ success: true, sessions, total: sessions.length, favorites }) });
  }

  private _loadCodexHistoryData(webview: vscode.Webview) {
    const favorites: Record<string, { favoritedAt: number }> =
      this.context.globalState.get(this._getFavoritesKey()) ?? {};
    const vscTitles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};
    const cache = this.context.globalState.get<Record<string, { messages: any[]; updatedAt: string }>>('ccg.codexHistoryCache') ?? {};
    const sessions: any[] = [];

    for (const [sessionId, data] of Object.entries(cache)) {
      const messages = Array.isArray(data.messages) ? data.messages : [];
      if (messages.length === 0) continue;
      const firstUser = messages.find((m: any) => m?.type === 'user' && typeof m?.content === 'string' && m.content.trim().length > 0);
      const title = vscTitles[sessionId] || (firstUser?.content ? String(firstUser.content).slice(0, 80) : sessionId.slice(0, 8));
      const lastTimestamp = data.updatedAt || messages[messages.length - 1]?.timestamp || new Date().toISOString();
      sessions.push({
        sessionId,
        title,
        messageCount: messages.length,
        lastTimestamp,
        isFavorited: !!favorites[sessionId],
        favoritedAt: favorites[sessionId]?.favoritedAt,
        provider: 'codex',
      });
    }

    try {
      const archivedDir = this._getCodexArchivedDir();
      if (fs.existsSync(archivedDir)) {
        for (const file of fs.readdirSync(archivedDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(archivedDir, file);
          const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
          let sessionId = '';
          let firstUserText = '';
          let messageCount = 0;
          let lastTimestamp = fs.statSync(filePath).mtime.toISOString();
          for (const line of lines) {
            try {
              const row = JSON.parse(line);
              if (row?.timestamp) lastTimestamp = row.timestamp;
              if (row?.type === 'session_meta' && row?.payload?.id) {
                sessionId = String(row.payload.id);
              }
              if (row?.type === 'response_item' && row?.payload?.type === 'message') {
                const role = row.payload.role;
                if (role !== 'user' && role !== 'assistant') continue;
                const text = this._extractCodexTextFromContent(row.payload.content);
                if (!text) continue;
                if (!firstUserText && role === 'user') firstUserText = text.slice(0, 80);
                messageCount += 1;
              }
            } catch { /* skip */ }
          }
          if (!sessionId) {
            const match = file.match(/([0-9a-f]{8,}-[0-9a-f-]{8,})\.jsonl$/i);
            sessionId = match ? match[1] : file.replace(/\.jsonl$/, '');
          }
          if (!sessionId || messageCount === 0) continue;
          if (sessions.some(s => s.sessionId === sessionId)) continue;
          sessions.push({
            sessionId,
            title: vscTitles[sessionId] || firstUserText || sessionId.slice(0, 8),
            messageCount,
            lastTimestamp,
            isFavorited: !!favorites[sessionId],
            favoritedAt: favorites[sessionId]?.favoritedAt,
            provider: 'codex',
          });
        }
      }
    } catch { /* ignore */ }

    sessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());
    webview.postMessage({ type: 'history_data', content: JSON.stringify({ success: true, sessions, total: sessions.length, favorites }) });
  }

  private _loadSession(sessionId: string, webview: vscode.Webview) {
    this._log.appendLine(`[BRIDGE] _loadSession called: sessionId="${sessionId}"`);
    const projectsDir = this._getClaudeProjectsDir();
    this._log.appendLine(`[BRIDGE] _loadSession projectsDir="${projectsDir}" exists=${fs.existsSync(projectsDir)}`);
    try {
      if (!fs.existsSync(projectsDir)) { this._log.appendLine('[BRIDGE] _loadSession: projectsDir not found'); return; }
      for (const projectDir of fs.readdirSync(projectsDir)) {
        const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
        if (!fs.existsSync(filePath)) continue;
        this._log.appendLine(`[BRIDGE] _loadSession: found file ${filePath}`);

        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        const messages: any[] = [];

        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.type !== 'user' && msg.type !== 'assistant') continue;

            const c = msg.message?.content;
            let text = '';
            if (typeof c === 'string') {
              text = c;
            } else if (Array.isArray(c)) {
              text = c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
            }

            if (!text.trim()) continue;
            if (msg.type === 'user' && (text.startsWith('You are a Claude') || text.startsWith('Hello memory agent'))) continue;

            messages.push({
              type: msg.type,
              content: text,
              timestamp: msg.timestamp ?? new Date().toISOString(),
            });
          } catch { /* skip */ }
        }

        // Send messages via broadcast (goes through panel's onMessage → postMessage)
        this._log.appendLine(`[BRIDGE] _loadSession: broadcasting ${messages.length} messages via session_messages`);
        this.broadcast('session_messages', JSON.stringify(messages));
        return;
      }
    } catch (e: any) {
      this._log.appendLine(`[BRIDGE] _loadSession error: ${e?.message || e}`);
    }

    // Codex cache fallback
    try {
      const cache = this.context.globalState.get<Record<string, { messages: any[]; updatedAt: string }>>('ccg.codexHistoryCache') ?? {};
      const entry = cache[sessionId];
      if (entry?.messages?.length) {
        const messages = entry.messages.filter((m: any) => m?.type === 'user' || m?.type === 'assistant');
        this._log.appendLine(`[BRIDGE] _loadSession: loaded ${messages.length} messages from codex cache`);
        this.broadcast('session_messages', JSON.stringify(messages));
        return;
      }
    } catch { /* ignore */ }

    // Codex archived file fallback
    try {
      const archivedDir = this._getCodexArchivedDir();
      if (fs.existsSync(archivedDir)) {
        for (const file of fs.readdirSync(archivedDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(archivedDir, file);
          const raw = fs.readFileSync(filePath, 'utf8');
          if (!raw.includes(sessionId)) continue;
          const lines = raw.split('\n').filter(Boolean);
          const messages: any[] = [];
          for (const line of lines) {
            try {
              const row = JSON.parse(line);
              if (row?.type !== 'response_item' || row?.payload?.type !== 'message') continue;
              const role = row.payload.role;
              if (role !== 'user' && role !== 'assistant') continue;
              const text = this._extractCodexTextFromContent(row.payload.content);
              if (!text.trim()) continue;
              messages.push({
                type: role,
                content: text,
                timestamp: row.timestamp ?? new Date().toISOString(),
              });
            } catch { /* skip */ }
          }
          if (messages.length > 0) {
            this._log.appendLine(`[BRIDGE] _loadSession: loaded ${messages.length} messages from codex archived file`);
            this.broadcast('session_messages', JSON.stringify(messages));
            return;
          }
        }
      }
    } catch { /* ignore */ }

    // No messages found — send empty array to release session transition
    this._log.appendLine(`[BRIDGE] _loadSession: no messages found, broadcasting empty`);
    this.broadcast('session_messages', JSON.stringify([]));
  }

  private _deleteHistorySession(content: string, webview: vscode.Webview) {
    try {
      const sessionId = typeof content === 'string' && content.startsWith('{')
        ? JSON.parse(content).sessionId : content.trim();
      const projectsDir = this._getClaudeProjectsDir();
      let deleted = false;
      if (fs.existsSync(projectsDir)) {
        for (const projectDir of fs.readdirSync(projectsDir)) {
          const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
          if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); deleted = true; break; }
        }
      }
      webview.postMessage({ type: 'delete_history_session_result', content: JSON.stringify({ success: deleted, sessionId }) });
    } catch (e: any) {
      webview.postMessage({ type: 'delete_history_session_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  private _updateHistoryTitle(content: string, webview: vscode.Webview) {
    try {
      const parsed = JSON.parse(content);
      const sessionId: string = parsed.sessionId;
      // Accept both `title` (bridge format) and `customTitle` (webview format)
      const title: string = parsed.title ?? parsed.customTitle ?? '';
      // Store custom titles in globalState
      const titles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};
      titles[sessionId] = title;
      this.context.globalState.update('ccg.historyTitles', titles);
      webview.postMessage({ type: 'update_history_title_result', content: JSON.stringify({ success: true, sessionId, title }) });
    } catch (e: any) {
      webview.postMessage({ type: 'update_history_title_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  private _toggleFavoriteSession(content: string, webview: vscode.Webview) {
    try {
      const sessionId = typeof content === 'string' && content.startsWith('{')
        ? JSON.parse(content).sessionId : content.trim();
      const favorites: Record<string, { favoritedAt: number }> =
        this.context.globalState.get(this._getFavoritesKey()) ?? {};
      if (favorites[sessionId]) {
        delete favorites[sessionId];
      } else {
        favorites[sessionId] = { favoritedAt: Date.now() };
      }
      this.context.globalState.update(this._getFavoritesKey(), favorites);
      webview.postMessage({ type: 'toggle_favorite_result', content: JSON.stringify({ success: true, sessionId, isFavorited: !!favorites[sessionId] }) });
    } catch (e: any) {
      webview.postMessage({ type: 'toggle_favorite_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  // ── Skills helpers ────────────────────────────────────────────────────────

  private _readSkillsFromDir(dir: string, scope: 'global' | 'local', enabled: boolean): Record<string, any> {
    const result: Record<string, any> = {};
    if (!fs.existsSync(dir)) return result;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        let name = entry.name;
        let type: 'file' | 'directory' = 'file';
        let description: string | undefined;
        let stat: fs.Stats | undefined;
        try { stat = fs.statSync(fullPath); } catch { continue; }

        if (entry.isDirectory()) {
          type = 'directory';
          // Try case-insensitive match for SKILL.md / skill.md / Skill.md
          const mdPath = ['SKILL.md', 'skill.md', 'Skill.md'].map(f => path.join(fullPath, f)).find(p => fs.existsSync(p));
          if (!mdPath) continue;
          description = this._extractSkillDescription(mdPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          name = entry.name.replace(/\.md$/, '');
          description = this._extractSkillDescription(fullPath);
        } else {
          continue;
        }

        const id = `${scope}-${name}${enabled ? '' : '-disabled'}`;
        result[id] = {
          id, name, type, scope, path: fullPath, enabled,
          description,
          createdAt: stat?.birthtime?.toISOString(),
          modifiedAt: stat?.mtime?.toISOString(),
        };
      }
    } catch { /* ignore */ }
    return result;
  }

  private _extractSkillDescription(mdPath: string): string | undefined {
    try {
      const content = fs.readFileSync(mdPath, 'utf8');
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fm) {
        const frontmatter = fm[1];
        // Handle block scalar (description: |) — collect indented lines after "description: |"
        const blockMatch = frontmatter.match(/^description:\s*\|\s*\n((?:[ \t]+.+\n?)+)/m);
        if (blockMatch) {
          return blockMatch[1]
            .split('\n')
            .map(l => l.replace(/^[ \t]{2}/, '').trimEnd())
            .filter(Boolean)
            .join(' ')
            .trim();
        }
        // Handle inline description: value
        const inlineMatch = frontmatter.match(/^description:\s*(.+)/m);
        if (inlineMatch) return inlineMatch[1].trim();
      }
      // Fallback: first non-empty non-heading line
      const lines = content.replace(/^---[\s\S]*?---\n?/, '').split('\n').map(l => l.trim()).filter(Boolean);
      return lines[0]?.replace(/^#+\s*/, '').slice(0, 200);
    } catch { return undefined; }
  }

  private _getAllSkills(webview: vscode.Webview) {
    const os = require('os') as typeof import('os');
    const homeDir = os.homedir();
    const globalEnabled  = path.join(homeDir, '.claude', 'skills');
    const globalDisabled = path.join(homeDir, '.codemoss', 'skills', 'global');
    const localEnabled   = this._workspacePath ? path.join(this._workspacePath, '.claude', 'skills') : '';
    const localDisabled  = this._workspacePath
      ? path.join(homeDir, '.codemoss', 'skills', Buffer.from(this._workspacePath).toString('hex').slice(0, 16))
      : '';

    const globalSkills = {
      ...this._readSkillsFromDir(globalEnabled,  'global', true),
      ...this._readSkillsFromDir(globalDisabled, 'global', false),
    };
    const localSkills = {
      ...this._readSkillsFromDir(localEnabled,  'local', true),
      ...this._readSkillsFromDir(localDisabled, 'local', false),
    };

    webview.postMessage({ type: 'update_skills', content: JSON.stringify({ global: globalSkills, local: localSkills, user: {}, repo: {} }) });
  }

  private _importSkill(content: string, webview: vscode.Webview) {
    let scope: 'global' | 'local' = 'global';
    try { scope = JSON.parse(content).scope ?? 'global'; } catch { /* use default */ }
    const os = require('os') as typeof import('os');
    const targetDir = scope === 'global'
      ? path.join(os.homedir(), '.claude', 'skills')
      : (this._workspacePath ? path.join(this._workspacePath, '.claude', 'skills') : '');

    if (!targetDir) {
      webview.postMessage({ type: 'skill_import_result', content: JSON.stringify({ success: false, error: 'No workspace open' }) });
      return;
    }

    vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: true,
      filters: { 'Markdown': ['md'] }, title: 'Import Skill(s)',
    }).then(uris => {
      if (!uris || uris.length === 0) {
        webview.postMessage({ type: 'skill_import_result', content: JSON.stringify({ success: false, error: 'No file selected' }) });
        return;
      }
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      let count = 0;
      for (const uri of uris) {
        try {
          const dest = path.join(targetDir, path.basename(uri.fsPath));
          fs.copyFileSync(uri.fsPath, dest);
          count++;
        } catch { /* ignore individual failures */ }
      }
      webview.postMessage({ type: 'skill_import_result', content: JSON.stringify({ success: true, count, total: uris.length }) });
    });
  }

  private _deleteSkill(content: string, webview: vscode.Webview) {
    try {
      const { name, scope, enabled } = JSON.parse(content);
      const os = require('os') as typeof import('os');
      const baseDir = enabled
        ? (scope === 'global' ? path.join(os.homedir(), '.claude', 'skills') : path.join(this._workspacePath, '.claude', 'skills'))
        : (scope === 'global' ? path.join(os.homedir(), '.codemoss', 'skills', 'global') : path.join(os.homedir(), '.codemoss', 'skills', Buffer.from(this._workspacePath).toString('hex').slice(0, 16)));

      // Try file first, then directory
      const filePath = path.join(baseDir, `${name}.md`);
      const dirPath  = path.join(baseDir, name);
      if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
      else if (fs.existsSync(dirPath)) { fs.rmSync(dirPath, { recursive: true }); }
      webview.postMessage({ type: 'skill_delete_result', content: JSON.stringify({ success: true }) });
    } catch (e: any) {
      webview.postMessage({ type: 'skill_delete_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  private _toggleSkill(content: string, webview: vscode.Webview) {
    try {
      const { name, scope, enabled } = JSON.parse(content);
      const os = require('os') as typeof import('os');
      const enabledDir  = scope === 'global' ? path.join(os.homedir(), '.claude', 'skills') : path.join(this._workspacePath, '.claude', 'skills');
      const disabledDir = scope === 'global'
        ? path.join(os.homedir(), '.codemoss', 'skills', 'global')
        : path.join(os.homedir(), '.codemoss', 'skills', Buffer.from(this._workspacePath).toString('hex').slice(0, 16));

      const srcDir = enabled ? enabledDir : disabledDir;
      const dstDir = enabled ? disabledDir : enabledDir;
      if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });

      const srcFile = path.join(srcDir, `${name}.md`);
      const srcDirPath = path.join(srcDir, name);
      const dstFile = path.join(dstDir, `${name}.md`);
      const dstDirPath = path.join(dstDir, name);

      if (fs.existsSync(srcFile)) { fs.renameSync(srcFile, dstFile); }
      else if (fs.existsSync(srcDirPath)) { fs.renameSync(srcDirPath, dstDirPath); }

      webview.postMessage({ type: 'skill_toggle_result', content: JSON.stringify({ success: true, name, enabled: !enabled }) });
    } catch (e: any) {
      webview.postMessage({ type: 'skill_toggle_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  private _getMcpServers(isCodex: boolean, webview: vscode.Webview) {
    const os = require('os') as typeof import('os');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const mcpServers: any[] = [];
      const raw = settings.mcpServers ?? settings.mcp?.servers ?? {};
      for (const [id, cfg] of Object.entries(raw as Record<string, any>)) {
        mcpServers.push({ id, name: id, server: cfg, enabled: true });
      }
      const type = isCodex ? 'update_codex_mcp_servers' : 'update_mcp_servers';
      webview.postMessage({ type, content: JSON.stringify(mcpServers) });
    } catch {
      const type = isCodex ? 'update_codex_mcp_servers' : 'update_mcp_servers';
      webview.postMessage({ type, content: JSON.stringify([]) });
    }
  }

  private _getMcpServerStatus(isCodex: boolean, webview: vscode.Webview) {
    // Return empty status list — actual connectivity check not implemented
    const type = isCodex ? 'update_codex_mcp_server_status' : 'update_mcp_server_status';
    webview.postMessage({ type, content: JSON.stringify([]) });
  }

  private _readMcpSettings(): any {
    const os = require('os') as typeof import('os');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      return {};
    }
  }

  private _writeMcpSettings(settings: any): void {
    const os = require('os') as typeof import('os');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  private _addMcpServer(isCodex: boolean, content: string, webview: vscode.Webview) {
    try {
      const server = JSON.parse(content || '{}');
      const settings = this._readMcpSettings();
      if (!settings.mcpServers) settings.mcpServers = {};
      const serverId = server.id || server.name || `mcp-${Date.now()}`;
      settings.mcpServers[serverId] = server.server || {
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      };
      this._writeMcpSettings(settings);
      this._getMcpServers(isCodex, webview);
    } catch (e: any) {
      this._log.appendLine(`[MCP] add error: ${e.message}`);
    }
  }

  private _updateMcpServer(isCodex: boolean, content: string, webview: vscode.Webview) {
    try {
      const server = JSON.parse(content || '{}');
      const settings = this._readMcpSettings();
      if (!settings.mcpServers) settings.mcpServers = {};
      const serverId = server.id || server.name;
      if (serverId && settings.mcpServers[serverId]) {
        settings.mcpServers[serverId] = server.server || {
          command: server.command,
          args: server.args || [],
          env: server.env || {},
        };
        this._writeMcpSettings(settings);
      }
      this._getMcpServers(isCodex, webview);
    } catch (e: any) {
      this._log.appendLine(`[MCP] update error: ${e.message}`);
    }
  }

  private _deleteMcpServer(isCodex: boolean, content: string, webview: vscode.Webview) {
    try {
      const { id } = JSON.parse(content || '{}');
      const settings = this._readMcpSettings();
      if (settings.mcpServers && id) {
        delete settings.mcpServers[id];
        this._writeMcpSettings(settings);
      }
      this._getMcpServers(isCodex, webview);
    } catch (e: any) {
      this._log.appendLine(`[MCP] delete error: ${e.message}`);
    }
  }

  private _toggleMcpServer(isCodex: boolean, content: string, webview: vscode.Webview) {
    try {
      const server = JSON.parse(content || '{}');
      const settings = this._readMcpSettings();
      if (!settings.mcpServers) settings.mcpServers = {};
      const serverId = server.id || server.name;
      if (serverId) {
        if (server.enabled === false) {
          // Disable: move to disabled list
          if (!settings.disabledMcpServers) settings.disabledMcpServers = {};
          if (settings.mcpServers[serverId]) {
            settings.disabledMcpServers[serverId] = settings.mcpServers[serverId];
            delete settings.mcpServers[serverId];
          }
        } else {
          // Enable: move back from disabled list
          if (settings.disabledMcpServers?.[serverId]) {
            settings.mcpServers[serverId] = settings.disabledMcpServers[serverId];
            delete settings.disabledMcpServers[serverId];
          }
        }
        this._writeMcpSettings(settings);
      }
      this._getMcpServers(isCodex, webview);
    } catch (e: any) {
      this._log.appendLine(`[MCP] toggle error: ${e.message}`);
    }
  }

  private _getMcpServerTools(content: string, webview: vscode.Webview) {
    // Tools discovery requires MCP server connection — return empty for now
    try {
      const { serverId } = JSON.parse(content || '{}');
      webview.postMessage({
        type: 'js_eval',
        content: `window.updateMcpServerTools && window.updateMcpServerTools(${JSON.stringify(JSON.stringify({ serverId, tools: [] }))})`,
      });
    } catch { /* ignore */ }
  }

  private _getDependencyVersions(sdkId: string, webview: vscode.Webview) {
    // Map SDK IDs to npm package names
    const pkgMap: Record<string, string> = {
      'claude-sdk': '@anthropic-ai/claude-code',
      'codex-sdk': 'openai',
    };
    // Empty id (e.g. `get_dependency_versions:` from settings) means load all SDKs.
    // Must return one entry per SDK so the webview can clear per-SDK loading spinners.
    const ids = !sdkId ? Object.keys(pkgMap) : pkgMap[sdkId] ? [sdkId] : [];
    if (ids.length === 0) {
      webview.postMessage({
        type: 'js_eval',
        content: `window.dependencyVersionsLoaded && window.dependencyVersionsLoaded(${JSON.stringify(JSON.stringify({}))})`,
      });
      return;
    }

    const nodePath = NodeDetector.find(this.context);
    const npmPath = nodePath ? path.join(path.dirname(nodePath), 'npm') : 'npm';

    const fetchOne = (id: string): Promise<[string, { versions: string[]; latestVersion: string; fallbackVersions: [] }]> =>
      new Promise((resolve) => {
        const pkg = pkgMap[id];
        cp.exec(`"${npmPath}" view ${pkg} versions --json`, { timeout: 30000 }, (err, stdout) => {
          try {
            const allVersions: string[] = err ? [] : JSON.parse(stdout.trim());
            // Return last 20 versions (most recent)
            const versions = allVersions.slice(-20).reverse();
            const latestVersion = versions[0] ?? '';
            resolve([id, { versions, latestVersion, fallbackVersions: [] }]);
          } catch {
            resolve([id, { versions: [], latestVersion: '', fallbackVersions: [] }]);
          }
        });
      });

    Promise.all(ids.map(fetchOne)).then((entries) => {
      const result = Object.fromEntries(entries) as Record<string, any>;
      webview.postMessage({
        type: 'js_eval',
        content: `window.dependencyVersionsLoaded && window.dependencyVersionsLoaded(${JSON.stringify(JSON.stringify(result))})`,
      });
    });
  }

  private _getUsageStatistics(_content: string, webview: vscode.Webview) {
    const os = require('os') as typeof import('os');
    const stored = this.context.globalState.get<any>('ccg.usageStats') ?? { sessions: [], dailyMap: {} };

    const sessions: any[] = stored.sessions ?? [];
    const dailyMap: Record<string, any> = stored.dailyMap ?? {};

    // Back-fill cost for old sessions that were stored with cost=0
    let needsSave = false;
    for (const s of sessions) {
      if ((s.cost === 0 || s.cost == null) && s.usage && (s.usage.inputTokens > 0 || s.usage.outputTokens > 0)) {
        s.cost = _estimateCost(
          s.model ?? 'unknown',
          s.usage.inputTokens ?? 0,
          s.usage.outputTokens ?? 0,
          s.usage.cacheReadTokens ?? 0,
          s.usage.cacheWriteTokens ?? 0,
        );
        needsSave = true;
      }
    }
    if (needsSave) {
      // Rebuild dailyMap costs from sessions
      const rebuiltDailyMap: Record<string, any> = {};
      for (const s of sessions) {
        const dateKey = new Date(s.timestamp).toISOString().slice(0, 10);
        const day = rebuiltDailyMap[dateKey] ?? { cost: 0, inputTokens: 0, outputTokens: 0, sessions: 0, modelsUsed: [] };
        day.cost += s.cost ?? 0;
        day.inputTokens += s.usage?.inputTokens ?? 0;
        day.outputTokens += s.usage?.outputTokens ?? 0;
        day.sessions++;
        if (s.model && !day.modelsUsed.includes(s.model)) day.modelsUsed.push(s.model);
        rebuiltDailyMap[dateKey] = day;
      }
      // Merge: keep days that have no sessions (from dailyMap) but update days that do
      for (const [date, day] of Object.entries(rebuiltDailyMap)) {
        dailyMap[date] = day;
      }
      this.context.globalState.update('ccg.usageStats', { sessions, dailyMap });
    }

    let totalInputTokens = 0, totalOutputTokens = 0, totalCost = 0;
    const dailyUsage = Object.entries(dailyMap).map(([date, d]: [string, any]) => {
      totalInputTokens += d.inputTokens ?? 0;
      totalOutputTokens += d.outputTokens ?? 0;
      totalCost += d.cost ?? 0;
      return {
        date,
        sessions: d.sessions ?? 0,
        cost: d.cost ?? 0,
        usage: {
          inputTokens: d.inputTokens ?? 0,
          outputTokens: d.outputTokens ?? 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalTokens: (d.inputTokens ?? 0) + (d.outputTokens ?? 0),
        },
        modelsUsed: d.modelsUsed ?? [],
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    // Build byModel
    const modelMap = new Map<string, any>();
    for (const s of sessions) {
      const m = s.model ?? 'unknown';
      const e = modelMap.get(m) ?? { model: m, totalCost: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, sessionCount: 0 };
      e.totalCost += s.cost ?? 0;
      e.inputTokens += s.usage?.inputTokens ?? 0;
      e.outputTokens += s.usage?.outputTokens ?? 0;
      e.totalTokens += s.usage?.totalTokens ?? 0;
      e.sessionCount++;
      modelMap.set(m, e);
    }

    const stats = {
      projectPath: this._workspacePath || os.homedir(),
      projectName: require('path').basename(this._workspacePath || os.homedir()),
      totalSessions: sessions.length,
      totalUsage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalTokens: totalInputTokens + totalOutputTokens,
      },
      estimatedCost: totalCost,
      sessions: sessions.slice(-100).reverse(),
      dailyUsage,
      weeklyComparison: {
        currentWeek: { sessions: 0, cost: 0, tokens: 0 },
        lastWeek: { sessions: 0, cost: 0, tokens: 0 },
        trends: { sessions: 0, cost: 0, tokens: 0 },
      },
      byModel: Array.from(modelMap.values()),
      lastUpdated: Date.now(),
    };
    webview.postMessage({ type: 'update_usage_statistics', content: JSON.stringify(stats) });
  }

  dispose() {
    this._bridgeProcess?.kill();
  }

  // ── globalState helpers ───────────────────────────────────────────────────
  private _state(key: string, defaultVal: string): string {
    return (this.context.globalState.get<string>(`ccg.${key}`) ?? defaultVal);
  }
  private _setState(key: string, value: string) {
    this.context.globalState.update(`ccg.${key}`, value);
  }
  private _getProviders(): any[] {
    const stored = this.context.globalState.get<any[]>('ccg.providers') ?? [];
    // Ensure built-in providers always exist
    const builtins = [
      { id: '__local_settings_json__', name: 'Local Settings (settings.json)', isActive: false, isBuiltin: true },
      { id: '__cli_login__', name: 'CLI Login', isActive: false, isBuiltin: true },
    ];
    const result = [...stored];
    for (const b of builtins) {
      if (!result.find((p: any) => p.id === b.id)) result.unshift(b);
    }
    return result;
  }
  private _saveProviders(providers: any[]) {
    this.context.globalState.update('ccg.providers', providers);
    this._syncProviderToDisk(providers);
  }
  private _getCodexProviders(): any[] {
    return this.context.globalState.get<any[]>('ccg.codex_providers') ?? [];
  }
  private _saveCodexProviders(providers: any[]) {
    this.context.globalState.update('ccg.codex_providers', providers);
  }
  private _postCodexProviders(webview: vscode.Webview) {
    webview.postMessage({ type: 'update_codex_providers', content: JSON.stringify(this._getCodexProviders()) });
  }
  private _getPromptProjectInfo(): { name: string; path: string; available: boolean } {
    const workspacePath = this._workspacePath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return {
      name: workspacePath ? path.basename(workspacePath) : '',
      path: workspacePath,
      available: !!workspacePath,
    };
  }
  private _promptProjectKey(): string {
    const info = this._getPromptProjectInfo();
    return info.path || '__NO_PROJECT__';
  }
  private _getPrompts(scope: 'global' | 'project'): any[] {
    if (scope === 'global') {
      return this.context.globalState.get<any[]>('ccg.prompts.global') ?? [];
    }
    const map = this.context.globalState.get<Record<string, any[]>>('ccg.prompts.projectMap') ?? {};
    return map[this._promptProjectKey()] ?? [];
  }
  private async _savePrompts(scope: 'global' | 'project', prompts: any[]): Promise<void> {
    if (scope === 'global') {
      await this.context.globalState.update('ccg.prompts.global', prompts);
      return;
    }
    const map = this.context.globalState.get<Record<string, any[]>>('ccg.prompts.projectMap') ?? {};
    map[this._promptProjectKey()] = prompts;
    await this.context.globalState.update('ccg.prompts.projectMap', map);
  }
  private _postPrompts(scope: 'global' | 'project', webview: vscode.Webview, prompts?: any[]) {
    const payload = JSON.stringify(Array.isArray(prompts) ? prompts : this._getPrompts(scope));
    const callbackName = scope === 'project' ? 'updateProjectPrompts' : 'updateGlobalPrompts';
    webview.postMessage({
      type: 'js_eval',
      content: `window.${callbackName} && window.${callbackName}(${JSON.stringify(payload)})`,
    });
    // Legacy callback compatibility
    webview.postMessage({ type: 'update_prompts', content: payload });
  }

  /**
   * Sync the active provider configuration to disk so the ai-bridge daemon can read it.
   * - ~/.codemoss/config.json: records current provider ID
   * - ~/.claude/settings.json: writes the active provider's env (API key, base URL, etc.)
   */
  private _syncProviderToDisk(providers: any[]) {
    const os = require('os') as typeof import('os');
    const active = providers.find((p: any) => p.isActive) ?? null;

    // ── 1. Write ~/.codemoss/config.json ──
    try {
      const codemossDir = path.join(os.homedir(), '.codemoss');
      if (!fs.existsSync(codemossDir)) {
        fs.mkdirSync(codemossDir, { recursive: true });
      }
      const configPath = path.join(codemossDir, 'config.json');
      let codemossConfig: any = {};
      try {
        if (fs.existsSync(configPath)) {
          codemossConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
      } catch { /* start fresh */ }

      if (!codemossConfig.claude) { codemossConfig.claude = {}; }
      if (!codemossConfig.claude.providers) { codemossConfig.claude.providers = {}; }

      if (active) {
        codemossConfig.claude.current = active.id;
        codemossConfig.claude.providers[active.id] = { name: active.name };
      } else {
        codemossConfig.claude.current = null;
      }
      fs.writeFileSync(configPath, JSON.stringify(codemossConfig, null, 2));
    } catch (e: any) {
      console.error('[bridge] Failed to write ~/.codemoss/config.json:', e.message);
    }

    // ── 2. Sync env to ~/.claude/settings.json ──
    // Skip for local mode: the user manages settings.json themselves.
    if (active?.id === '__local_settings_json__') { return; }

    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      const settingsPath = path.join(claudeDir, 'settings.json');
      let settings: any = {};
      try {
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
      } catch { /* start fresh */ }

      if (!settings.env) { settings.env = {}; }

      // Clear all provider-managed auth/config keys before setting new ones
      const MANAGED_ENV_KEYS = [
        'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL',
        'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'CLAUDE_CODE_USE_BEDROCK',
        'API_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CCGUI_CLI_LOGIN_AUTHORIZED',
      ];
      for (const key of MANAGED_ENV_KEYS) {
        delete settings.env[key];
      }

      if (active?.id === '__cli_login__') {
        settings.env.CCGUI_CLI_LOGIN_AUTHORIZED = '1';
      } else if (active?.settingsConfig?.env) {
        Object.assign(settings.env, active.settingsConfig.env);
      }

      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (e: any) {
      console.error('[bridge] Failed to write ~/.claude/settings.json:', e.message);
    }
  }
  private _getActiveProvider(): any {
    return this._getProviders().find((p: any) => p.isActive) ?? null;
  }

  /**
   * Return all available slash commands:
   * - Built-in Claude Code SDK commands
   * - User-defined: ~/.claude/commands/*.md  (global)
   * - Project-defined: <workspace>/.claude/commands/*.md
   */
  private _getSlashCommands(): Array<{ name: string; description: string; source: string }> {
    const os = require('os') as typeof import('os');

    // Built-in Claude Code commands
    const builtins: Array<{ name: string; description: string; source: string }> = [
      { name: '/bug',        description: 'Report a bug to Anthropic',                    source: 'built-in' },
      { name: '/clear',      description: 'Clear conversation history and start fresh',   source: 'built-in' },
      { name: '/compact',    description: 'Compact conversation with optional focus',     source: 'built-in' },
      { name: '/config',     description: 'Open config panel',                            source: 'built-in' },
      { name: '/cost',       description: 'Show token usage and cost',                    source: 'built-in' },
      { name: '/doctor',     description: 'Check Claude Code health',                     source: 'built-in' },
      { name: '/help',       description: 'Show help and available commands',             source: 'built-in' },
      { name: '/init',       description: 'Initialize Claude Code in this project',       source: 'built-in' },
      { name: '/login',      description: 'Switch Claude account',                        source: 'built-in' },
      { name: '/logout',     description: 'Sign out from Claude',                         source: 'built-in' },
      { name: '/memory',     description: 'Edit Claude memory files (CLAUDE.md)',         source: 'built-in' },
      { name: '/model',      description: 'Set the AI model',                             source: 'built-in' },
      { name: '/pr-comments',description: 'Get comments from a GitHub PR',               source: 'built-in' },
      { name: '/review',     description: 'Request code review',                          source: 'built-in' },
      { name: '/status',     description: 'Show account and connection status',           source: 'built-in' },
      { name: '/terminal',   description: 'Open terminal',                                source: 'built-in' },
      { name: '/vim',        description: 'Toggle vim mode',                              source: 'built-in' },
    ];

    // Read markdown files from a commands directory, return as commands
    const readCommandsDir = (dir: string, source: string) => {
      const result: Array<{ name: string; description: string; source: string }> = [];
      try {
        if (!fs.existsSync(dir)) return result;
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.md')) continue;
          const cmdName = '/' + file.replace(/\.md$/, '');
          let description = '';
          try {
            const firstLine = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')[0] ?? '';
            description = firstLine.replace(/^#+\s*/, '').trim();
          } catch { /* ignore */ }
          result.push({ name: cmdName, description, source });
        }
      } catch { /* ignore */ }
      return result;
    };

    const globalCmds = readCommandsDir(
      path.join(os.homedir(), '.claude', 'commands'),
      'global'
    );
    const projectCmds = this._workspacePath
      ? readCommandsDir(path.join(this._workspacePath, '.claude', 'commands'), 'project')
      : [];

    return [...builtins, ...globalCmds, ...projectCmds];
  }
  /**
   * Build an ignore-filter function from .gitignore (and .git/info/exclude) in the given root.
   * Falls back to a small set of sensible defaults when no .gitignore exists.
   * Returns: (relPath, isDirectory) => boolean  — true means "should be ignored"
   */
  private _buildIgnoreFilter(root: string): (relPath: string, isDir: boolean) => boolean {
    const rules: Array<{ pattern: RegExp; negated: boolean; dirOnly: boolean }> = [];

    const compilePattern = (raw: string) => {
      let line = raw.trimEnd();
      if (!line || line.startsWith('#')) return;

      let negated = false;
      let dirOnly = false;

      if (line.startsWith('!')) { negated = true; line = line.slice(1); }
      if (line.startsWith('\\')) { line = line.slice(1); } // escaped first char
      if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
      if (!line) return;

      // A pattern is "anchored" (relative to root) if it contains a slash after stripping trailing one
      const hasSlash = line.includes('/');
      if (hasSlash && line.startsWith('/')) { line = line.slice(1); } // strip leading /

      // Convert glob-style pattern to regex
      const regexStr = line
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars
        .replace(/\*\*\//g, '(.*\\/)?')          // **/ = zero or more path segments
        .replace(/\*\*/g, '.*')                  // ** = anything
        .replace(/\*/g, '[^/]*')                 // * = any chars except /
        .replace(/\?/g, '[^/]');                 // ? = single char except /

      let regex: RegExp;
      if (hasSlash) {
        // Anchored to root
        regex = new RegExp(`^${regexStr}(\\/.*)?$`);
      } else {
        // Matches at any depth
        regex = new RegExp(`(^|.*\\/)${regexStr}(\\/.*)?$`);
      }
      rules.push({ pattern: regex, negated, dirOnly });
    };

    const parseFile = (filePath: string) => {
      try {
        if (!fs.existsSync(filePath)) return;
        for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
          try { compilePattern(line); } catch { /* skip bad pattern */ }
        }
      } catch { /* ignore */ }
    };

    parseFile(path.join(root, '.gitignore'));
    parseFile(path.join(root, '.git', 'info', 'exclude'));

    // If no patterns loaded, use sensible defaults
    if (rules.length === 0) {
      for (const def of ['node_modules', 'dist', 'out', 'build', '.cache', '.next', '.nuxt']) {
        try { compilePattern(def); } catch { /* ignore */ }
      }
    }

    return (relPath: string, isDir: boolean): boolean => {
      const normalized = relPath.replace(/\\/g, '/');
      let ignored = false;
      for (const { pattern, negated, dirOnly } of rules) {
        if (dirOnly && !isDir) continue;
        if (pattern.test(normalized)) {
          ignored = !negated;
        }
      }
      return ignored;
    };
  }

  private _sendDependencyStatus(webview: vscode.Webview) {
    const os = require('os') as typeof import('os');
    const check = (sdkId: string, pkg: string): { installed: boolean; version: string } => {
      // Must match ai-bridge/utils/sdk-loader.js: ~/.codemoss/dependencies/<sdkId>/node_modules/<pkg>
      const pkgDir = path.join(os.homedir(), '.codemoss', 'dependencies', sdkId, 'node_modules', ...pkg.split('/'));
      if (fs.existsSync(pkgDir)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
          return { installed: true, version: pkgJson.version ?? '' };
        } catch { return { installed: true, version: '' }; }
      }
      return { installed: false, version: '' };
    };

    const claudeSdk = check('claude-sdk', '@anthropic-ai/claude-agent-sdk');
    const codexSdk = check('codex-sdk', '@openai/codex-sdk');

    const status = {
      'claude-sdk': {
        id: 'claude-sdk',
        name: 'Claude Agent SDK',
        status: claudeSdk.installed ? 'installed' : 'not_installed',
        installedVersion: claudeSdk.version,
      },
      'codex-sdk': {
        id: 'codex-sdk',
        name: 'Codex SDK',
        status: codexSdk.installed ? 'installed' : 'not_installed',
        installedVersion: codexSdk.version,
      },
    };
    webview.postMessage({ type: 'update_dependency_status', content: JSON.stringify(status) });
  }
}
