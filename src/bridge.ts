import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import { NodeDetector } from './nodeDetector';
import { MessageDispatcher } from './bridge/MessageDispatcher';
import { BridgeContext } from './bridge/types';
import { ProviderHandler } from './bridge/handlers/ProviderHandler';
import { SettingsHandler } from './bridge/handlers/SettingsHandler';
import { AgentHandler } from './bridge/handlers/AgentHandler';
import { PromptHandler } from './bridge/handlers/PromptHandler';
import { FileHandler } from './bridge/handlers/FileHandler';
import { McpServerHandler } from './bridge/handlers/McpServerHandler';
import { McpMarketplaceHandler } from './bridge/handlers/McpMarketplaceHandler';
import { SkillHandler } from './bridge/handlers/SkillHandler';
import { DependencyHandler } from './bridge/handlers/DependencyHandler';
import { SessionHandler } from './bridge/handlers/SessionHandler';
import { HistoryHandler } from './bridge/handlers/HistoryHandler';
import { PermissionHandler } from './bridge/handlers/PermissionHandler';
import { DiffHandler } from './bridge/handlers/DiffHandler';
import { ClipboardHandler } from './bridge/handlers/ClipboardHandler';
import { WindowEventHandler } from './bridge/handlers/WindowEventHandler';
import { PromptEnhancerHandler } from './bridge/handlers/PromptEnhancerHandler';
import { NodeProcessHandler } from './bridge/handlers/NodeProcessHandler';
import { ContextUsageHandler } from './bridge/handlers/ContextUsageHandler';
import { RewindHandler } from './bridge/handlers/RewindHandler';
import { UndoFileHandler } from './bridge/handlers/UndoFileHandler';
import { UsageStatisticsHandler } from './bridge/handlers/UsageStatisticsHandler';
import { TokenTrackerHandler } from './bridge/handlers/TokenTrackerHandler';
import { CustomModelPricingHandler } from './bridge/handlers/CustomModelPricingHandler';
import { RuntimeContextService } from './bridge/services/RuntimeContextService';
import { HistoryService } from './bridge/services/HistoryService';
import { sanitizeProjectPath } from './bridge/services/historyEntrypoint';
import { UsageStatisticsService } from './bridge/services/UsageStatisticsService';
import { DiffService } from './bridge/services/DiffService';
import { PermissionIpcService } from './bridge/services/PermissionIpcService';
import { ProviderStore } from './bridge/services/ProviderStore';
import { SlashCommandService } from './bridge/services/SlashCommandService';
import { SettingsStore } from './bridge/services/SettingsStore';
import {
  formatActiveFileSelectionInfo,
  shouldSyncActiveFileToWebview,
} from './bridge/activeFileSync';
import { sanitizeUserMessagePayload } from './bridge/services/userMessageSanitizer';
import type { SessionTemplate } from './sessionTemplate';
import type { RuntimeProviderId } from './bridge/types';
import { isRuntimeProvider } from './cli/cliTools';
import { CliStatusHandler } from './bridge/handlers/CliStatusHandler';
import { CliModelsHandler } from './bridge/handlers/CliModelsHandler';
import { createDebugGatedOutputChannel } from './debugOutputChannel';
import {
  formatNodeRequirementError,
  isNodeVersionSupported,
  readNodeVersion,
} from './nodeRequirements';
import { planClaudeSettingsSync } from './bridge/services/claudeSettingsSync';
import { dedupeTextChunks } from './bridge/services/textChunkDedupe';

type MessageCallback = (event: string, content: string) => void;
type CreateTabCallback = () => void;

const CCG_USER_INPUT_BY_SESSION_KEY = 'ccg.userInputBySession';

export class BridgeServer {
  private _callbacks: MessageCallback[] = [];
  private _createTabCallback?: CreateTabCallback;
  private _bridgeProcess?: cp.ChildProcess;
  private _bridgePath: string;
  private _workspacePath: string;
  private _webview?: vscode.Webview;
  /** All live CC GUI webviews (sidebar + editor tabs) for multi-window routing. */
  private readonly _knownWebviews = new Set<vscode.Webview>();
  /** Flag-gated facade passed to services (append* no-op when debug log is off). */
  private _log: vscode.OutputChannel;
  /** Underlying OutputChannel — never monkey-patched. */
  private _rawLog: vscode.OutputChannel;
  private _logAppendLine: (value: string) => void;
  private _logAppend: (value: string) => void;
  private _debugLogEnabled = false;
  private _configListener?: vscode.Disposable;
  private _activeProvider: RuntimeProviderId = 'claude';
  private _selectedModel: string = '';
  /** request id → text as typed in the input before skill / bridge expansion (for history UI). */
  private _reqIdToUserInputAsTyped = new Map<string, string>();
  private readonly _dispatcher: MessageDispatcher;
  private readonly _statusBarItem: vscode.StatusBarItem;
  private _statusBarWidgetEnabled = true;
  private _latestAssistantPreview = new Map<string, string>();
  private _suppressTaskCompletionNotification = new Set<string>();
  private _textRequestResolvers = new Map<string, {
    resolve(value: string): void;
    reject(reason?: any): void;
    chunks: string[];
    timeout: ReturnType<typeof setTimeout>;
    onProgress?: (partial: string) => void;
  }>();
  private readonly _runtimeContext: RuntimeContextService;
  private readonly _historyService: HistoryService;
  private readonly _usageStatistics: UsageStatisticsService;
  private readonly _diffService: DiffService;
  private readonly _permissionIpc: PermissionIpcService;
  private readonly _providerStore: ProviderStore;
  private readonly _slashCommands: SlashCommandService;
  private readonly _settingsStore: SettingsStore;
  /** Buffer of assistant blocks accumulated during a streaming turn, keyed by request id. */
  private _assistantTurnBuffer = new Map<string, {
    blocks: Array<Record<string, unknown>>;
    text: string;
    usage?: Record<string, unknown>;
    model?: string;
  }>();
  constructor(private readonly context: vscode.ExtensionContext) {
    // Gate via a facade + flag. Do NOT replace OutputChannel.appendLine with a
    // no-op: VS Code reuses named channels across reloads, so a previous no-op
    // patch could be captured as the "real" writer and silence logs forever
    // until the switch was toggled after a full channel recreate.
    const gated = createDebugGatedOutputChannel(
      'CC GUI',
      () => this._debugLogEnabled,
      (name) => vscode.window.createOutputChannel(name),
    );
    this._rawLog = gated.raw;
    this._log = gated.log;
    this._logAppendLine = gated.forceAppendLine;
    this._logAppend = gated.forceAppend;
    // Keep the channel alive with the extension host (and avoid accidental GC/dispose races).
    context.subscriptions.push(this._rawLog);
    this._applyDebugLogSetting(false);
    this._configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ccGui.enableDebugLog')) {
        this._applyDebugLogSetting(true);
        // Keep webview toggle in sync when changed from VS Code Settings UI.
        if (this._webview) {
          const enabled =
            vscode.workspace.getConfiguration('ccGui').get<boolean>('enableDebugLog') === true;
          this._callWebviewJson(this._webview, 'updateEnableDebugLog', { enableDebugLog: enabled });
        }
      }
    });
    this._bridgePath = path.join(context.extensionPath, 'ai-bridge', 'daemon.js');
    this._workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    this._statusBarWidgetEnabled = context.globalState.get<boolean>('ccg.status_bar_widget_enabled', true);
    this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBarItem.command = 'ccGui.newSession';
    this._statusBarItem.tooltip = 'CC GUI';
    context.subscriptions.push(this._statusBarItem);
    this._updateStatusBarItem('Idle');
    this._runtimeContext = new RuntimeContextService(() => this._workspacePath, this._log);
    this._historyService = new HistoryService(this.context, this._log, (webview, functionName, payload) => {
      this._callWebviewJson(webview, functionName, payload);
    }, () => this._workspacePath);
    this._usageStatistics = new UsageStatisticsService(this.context, () => this._workspacePath);
    this._diffService = new DiffService(
      () => this._workspacePath,
      (webview, functionName, payload) => this._callWebviewJson(webview, functionName, payload),
    );
    this._permissionIpc = new PermissionIpcService(
      this._log,
      () => this._webview,
      this.context.globalState,
      // Multi-window: route permission dialogs to the webview that owns the daemon turn.
      (bridgeRequestId) => this._pendingWebviews.get(bridgeRequestId),
      // Used to refuse "active webview" fallback when multiple tabs are open.
      () => this._knownWebviews.size,
    );
    this._settingsStore = new SettingsStore(context);
    this._providerStore = new ProviderStore(context, {
      syncProviderToDisk: (providers) => {
        this._syncProviderToDisk(providers);
      },
    });
    this._slashCommands = new SlashCommandService(
      () => this._workspacePath,
      () => this._activeProvider,
      this._log,
      () => this._providerStore.isCodexLocalConfigAuthorized(),
    );
    context.subscriptions.push(this._runtimeContext, this._permissionIpc);
    this._dispatcher = this._createDispatcher();

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

  onCreateTab(cb: CreateTabCallback) {
    this._createTabCallback = cb;
  }

  broadcast(event: string, content: string) {
    this._callbacks.forEach(cb => cb(event, content));
  }

  getActiveProvider(): RuntimeProviderId {
    return this._activeProvider;
  }

  getSelectedModel(): string {
    return this._selectedModel;
  }

  getPermissionMode(): string {
    return this.context.globalState.get<string>('ccg.permission_mode') ?? 'default';
  }

  getReasoningEffort(): string {
    return this.context.globalState.get<string>('ccg.reasoning_effort') ?? '';
  }

  getCodexSandboxMode(): 'workspace-write' | 'danger-full-access' {
    const mode = this.context.globalState.get<string>('ccg.codex_sandbox_mode') ?? 'danger-full-access';
    return mode === 'workspace-write' ? 'workspace-write' : 'danger-full-access';
  }

  getEffectiveWorkingDirectory(): string {
    return this.context.globalState.get<string>('ccg.working_directory') || this._workspacePath;
  }

  applySessionTemplate(template: SessionTemplate): void {
    if (template.provider === 'claude' || template.provider === 'codex') {
      this._activeProvider = template.provider;
    }
    this._selectedModel = template.model ?? '';
    void this.context.globalState.update('ccg.permission_mode', template.permissionMode || 'default');
    void this.context.globalState.update('ccg.reasoning_effort', template.reasoningEffort || '');
    void this.context.globalState.update('ccg.working_directory', template.cwd || '');
    this._updateStatusBarItem();
    this.broadcast('mode_received', template.permissionMode || 'default');
  }

  requestAiText(
    provider: 'claude' | 'codex',
    prompt: string,
    options: {
      model?: string;
      disableThinking?: boolean;
      streaming?: boolean;
      onProgress?: (partial: string) => void;
    } = {},
  ): Promise<string> {
    if (!this._bridgeProcess || this._bridgeProcess.killed) {
      this._log.appendLine('[BRIDGE] Daemon not running, starting...');
      this._startBridge();
    }
    if (!this._bridgeProcess?.stdin) {
      return Promise.reject(new Error('AI bridge daemon is not available'));
    }

    const id = String(++this._reqId);
    const method = provider === 'codex' ? 'codex.send' : 'claude.send';
    const effectiveWorkingDirectory = this.getEffectiveWorkingDirectory();
    const params: Record<string, unknown> = {
      workspacePath: effectiveWorkingDirectory || this._workspacePath,
      cwd: effectiveWorkingDirectory,
      message: prompt,
      text: prompt,
      permissionMode: 'default',
      streaming: options.streaming ?? Boolean(options.onProgress),
      disableThinking: options.disableThinking ?? true,
    };
    if (provider === 'codex') {
      params.sandboxMode = this.getCodexSandboxMode();
    }
    if (options.model) {
      params.model = options.model;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._textRequestResolvers.delete(id);
        this._requestEvents.delete(id);
        reject(new Error('AI text request timed out'));
      }, 120000);
      this._textRequestResolvers.set(id, {
        resolve,
        reject,
        chunks: [],
        timeout,
        onProgress: options.onProgress,
      });
      this._requestEvents.set(id, 'internal_ai_text_request');
      const msg = JSON.stringify({ id, method, params }) + '\n';
      this._log.appendLine(`[BRIDGE] Sending internal AI text request: id=${id} provider=${provider}`);
      this._bridgeProcess!.stdin!.write(msg);
    });
  }

  private _createDispatcher(): MessageDispatcher {
    const bridgeContext: BridgeContext = {
      extensionContext: this.context,
      log: this._log,
      getWorkspacePath: () => this._workspacePath,
      callbacks: {
        setActiveProvider: (provider) => {
          this._activeProvider = provider;
          this._updateStatusBarItem();
        },
        setSelectedModel: (model) => {
          this._selectedModel = model;
          this._log.appendLine(`[BRIDGE] Model set to: ${this._selectedModel}`);
          this._updateStatusBarItem();
        },
        syncProviderToDisk: (providers) => {
          this._syncProviderToDisk(providers);
        },
        playSound: (content) => {
          this._playSound(content);
        },
        sendToBridge: (event, content, webview) => {
          this._sendToBridge(event, content, webview);
        },
        sendDaemonRequest: (event, method, params, webview) => {
          this._sendDaemonRequest(event, method, params, webview);
        },
        pushPermissionModeLive: (mode) => {
          this._pushPermissionModeLive(mode);
        },
        loadHistoryData: (provider, webview) => {
          this._historyService.loadHistoryData(provider, webview);
        },
        deepSearchHistory: (provider, webview) => {
          this._historyService.deepSearchHistory(provider, webview);
        },
        loadSession: (sessionId, provider, webview) => {
          this._historyService.loadSession(sessionId, provider, webview);
        },
        deleteHistorySession: (content, webview) => {
          this._historyService.deleteHistorySession(content, webview);
        },
        deleteHistorySessions: (content, webview) => {
          this._historyService.deleteHistorySessions(content, webview);
        },
        exportHistorySession: (content, webview) => {
          this._historyService.exportHistorySession(content, webview);
        },
        updateHistoryTitle: (content, webview) => {
          this._historyService.updateHistoryTitle(content, webview);
        },
        deleteHistoryTitle: (content, webview) => {
          this._historyService.deleteHistoryTitle(content, webview);
        },
        toggleFavoriteSession: (content, webview) => {
          this._historyService.toggleFavoriteSession(content, webview);
        },
        loadSubagentSession: (content, webview) => {
          this._historyService.loadSubagentSession(content, webview);
        },
        convertToCliSession: (content, webview) => {
          this._historyService.convertToCliSession(content, webview);
        },
        getUsageStatistics: (content, webview) => {
          this._getUsageStatistics(content, webview);
        },
        writeClipboard: (content) => Promise.resolve(vscode.env.clipboard.writeText(content)),
        readClipboard: (webview) => this._readClipboard(webview),
        getActiveFile: (webview) => this._pushActiveFile(vscode.window.activeTextEditor, webview),
        refreshSlashCommands: (webview) => {
          this._refreshSlashCommands(webview);
        },
        listRuntimeContextItems: (query) => this._runtimeContext.listItems(query),
        frontendReady: (webview) => {
          this._handleFrontendReady(webview);
        },
        createNewSession: (webview) => {
          this._handleCreateNewSession(webview);
        },
        createNewTab: () => {
          this._createTabCallback?.();
        },
        tabLoadingChanged: (content) => {
          this._handleTabLoadingChanged(content);
        },
        tabStatusChanged: (content) => {
          this._handleTabStatusChanged(content);
        },
        updateStatusBarWidgetEnabled: (enabled) => {
          this._updateStatusBarWidgetEnabled(enabled);
        },
        restartBridgeDaemon: () => {
          this._restartBridgeDaemon();
        },
        getBridgeProcessPid: () => this._bridgeProcess?.pid,
      },
    };

    const dispatcher = new MessageDispatcher();
    dispatcher.register(new WindowEventHandler(bridgeContext));
    dispatcher.register(new PermissionHandler(this._permissionIpc));
    dispatcher.register(new SessionHandler(bridgeContext));
    dispatcher.register(new HistoryHandler(bridgeContext));
    dispatcher.register(new DiffHandler(this._diffService));
    dispatcher.register(new ClipboardHandler(bridgeContext));
    dispatcher.register(new PromptEnhancerHandler(bridgeContext));
    dispatcher.register(new NodeProcessHandler(bridgeContext));
    dispatcher.register(new ContextUsageHandler(bridgeContext));
    dispatcher.register(new RewindHandler(bridgeContext));
    dispatcher.register(new UndoFileHandler(this._diffService));
    dispatcher.register(new UsageStatisticsHandler(bridgeContext));
    dispatcher.register(new TokenTrackerHandler(bridgeContext));
    dispatcher.register(new CustomModelPricingHandler(bridgeContext));
    dispatcher.register(new ProviderHandler(bridgeContext));
    dispatcher.register(new SettingsHandler(bridgeContext, this._settingsStore));
    dispatcher.register(new AgentHandler(bridgeContext));
    dispatcher.register(new PromptHandler(bridgeContext));
    dispatcher.register(new FileHandler(bridgeContext));
    dispatcher.register(new McpServerHandler(bridgeContext));
    dispatcher.register(new McpMarketplaceHandler(bridgeContext));
    dispatcher.register(new SkillHandler(bridgeContext));
    dispatcher.register(new DependencyHandler(bridgeContext));
    dispatcher.register(new CliStatusHandler(bridgeContext));
    dispatcher.register(new CliModelsHandler(bridgeContext));
    this._log.appendLine(`[BRIDGE] Registered ${dispatcher.getHandlerCount()} modular handlers`);
    return dispatcher;
  }

  setWebview(webview: vscode.Webview) {
    this._webview = webview;
    this._knownWebviews.add(webview);
    this._permissionIpc.start();
    // Push UI language early so first paint can follow VS Code locale / user override
    this.pushLanguageConfig(webview);
    // Push current active file immediately when webview is ready
    setTimeout(() => this._pushActiveFile(vscode.window.activeTextEditor), 500);
  }

  /** Register a webview without making it the active target (multi-tab isolation). */
  registerWebview(webview: vscode.Webview): void {
    this._knownWebviews.add(webview);
  }

  /** Drop a disposed webview so permission routing count stays accurate. */
  unregisterWebview(webview: vscode.Webview): void {
    this._knownWebviews.delete(webview);
    if (this._webview === webview) {
      this._webview = undefined;
    }
    // Drop request→webview mappings that pointed at the disposed surface.
    for (const [id, mapped] of this._pendingWebviews.entries()) {
      if (mapped === webview) {
        this._pendingWebviews.delete(id);
      }
    }
  }

  /** Effective language config for HTML injection / webview bootstrap. */
  getLanguageConfig() {
    return this._settingsStore.resolveLanguageConfig();
  }

  /** Push language to an already-loaded webview (and seed pending if JS not ready yet). */
  pushLanguageConfig(webview?: vscode.Webview): void {
    const target = webview ?? this._webview;
    if (!target) {
      return;
    }
    const config = this._settingsStore.resolveLanguageConfig();
    const payload = JSON.stringify(config);
    target.postMessage({
      type: 'js_eval',
      content:
        `window.__pendingLanguageConfig=${payload};`
        + `(window.applyIdeaLanguageConfig&&window.applyIdeaLanguageConfig(${JSON.stringify(payload)}));`,
    });
  }

  async handleWebviewMessage(message: any, webview: vscode.Webview) {
    if (message.type !== 'bridge') return;
    const payload: string = message.payload ?? '';
    const colonIdx = payload.indexOf(':');
    const event = colonIdx >= 0 ? payload.slice(0, colonIdx) : payload;
    const content = colonIdx >= 0 ? payload.slice(colonIdx + 1) : '';

    this._logBridgeEvent(event, content);

    if (await this._dispatcher.dispatch({ event, content, webview })) {
      return;
    }

    switch (event) {
      case 'debug_log':
        // UI-surfaced failures must always hit Output (even when enableDebugLog is off).
        if (typeof content === 'string' && content.includes('[UI_SEND_ERROR]')) {
          this._forceLog(`[WEBVIEW] ${content}`);
        } else {
          this._log.appendLine(`[WEBVIEW] ${content}`);
        }
        break;

      // ── Slash commands / agents / MCP (pass to ai-bridge) ─────────────────
      default:
        this._sendToBridge(event, content, webview);
    }
  }

  private _logBridgeEvent(event: string, content: string): void {
    try {
      const parsed = content ? JSON.parse(content) : '';
      this._log.appendLine(`[CCG_PARAMS] ${event} ${JSON.stringify(this._summarizeForLog(parsed))}`);
    } catch {
      const preview = content.length > 240 ? `${content.slice(0, 240)}…` : content;
      this._log.appendLine(`[CCG_PARAMS] ${event} ${JSON.stringify(preview)}`);
    }
  }

  private _summarizeForLog(value: unknown, depth = 0): unknown {
    if (depth > 4) {
      return '[MaxDepth]';
    }
    if (value == null) {
      return value;
    }
    if (typeof value === 'string') {
      if (value.length <= 200) {
        return value;
      }
      return {
        type: 'string',
        length: value.length,
        preview: `${value.slice(0, 200)}…`,
      };
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) {
      const summarizedItems = value.slice(0, 10).map((item) => this._summarizeForLog(item, depth + 1));
      if (value.length > 10) {
        summarizedItems.push(`[+${value.length - 10} more]`);
      }
      return summarizedItems;
    }
    if (typeof value === 'object') {
      const input = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(input)) {
        if (key === 'apiKey' || key === 'authToken' || key === 'accessToken' || key === 'refreshToken') {
          result[key] = '[REDACTED]';
          continue;
        }
        if (key === 'data' && typeof raw === 'string') {
          result[key] = `[base64:${raw.length}]`;
          continue;
        }
        if (key === 'attachments' && Array.isArray(raw)) {
          result[key] = raw.map((item) => {
            const attachment = item as Record<string, unknown>;
            return {
              fileName: attachment.fileName,
              mediaType: attachment.mediaType,
              data: typeof attachment.data === 'string' ? `[base64:${attachment.data.length}]` : undefined,
              path: attachment.path,
              type: attachment.type,
            };
          });
          continue;
        }
        result[key] = this._summarizeForLog(raw, depth + 1);
      }
      return result;
    }
    return String(value);
  }

  private _pushActiveFile(editor?: vscode.TextEditor, targetWebview?: vscode.Webview) {
    const webview = targetWebview ?? this._webview;
    if (!webview) return;
    // Respect "发送打开的文件路径" — when closed, do not auto-select files in ContextBar.
    if (!shouldSyncActiveFileToWebview(this._settingsStore.getAutoOpenFileEnabled())) {
      return;
    }
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const sel = editor.selection;
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    const selectionInfo = formatActiveFileSelectionInfo(
      filePath,
      startLine,
      endLine,
      sel.isEmpty,
    );

    webview.postMessage({ type: 'add_selection_info', content: selectionInfo });
  }

  private async _readClipboard(webview: vscode.Webview): Promise<void> {
    try {
      const text = await vscode.env.clipboard.readText();
      webview.postMessage({
        type: 'js_eval',
        content: `window.onClipboardRead && window.onClipboardRead(${JSON.stringify(text ?? '')})`,
      });
    } catch {
      webview.postMessage({
        type: 'js_eval',
        content: 'window.onClipboardRead && window.onClipboardRead("")',
      });
    }
  }

  private _callWebviewJson(webview: vscode.Webview, functionName: string, payload: unknown): void {
    webview.postMessage({
      type: 'js_eval',
      content: `window.${functionName} && window.${functionName}(${JSON.stringify(JSON.stringify(payload))})`,
    });
  }

  private _callWebviewArgs(webview: vscode.Webview, functionName: string, args: unknown[]): void {
    webview.postMessage({
      type: 'js_eval',
      content: `window.${functionName} && window.${functionName}(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
    });
  }

  private _safeJson<T>(content: string, fallback: T): T {
    try {
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }

  private _refreshSlashCommands(webview: vscode.Webview): void {
    this._slashCommands.refresh(webview);
  }

  private _handleFrontendReady(webview: vscode.Webview): void {
    this._webview = webview;
    this._permissionIpc.start();
    this._refreshSlashCommands(webview);
    webview.postMessage({ type: 'mode_received', content: this._state('permission_mode', 'default') });
    setTimeout(() => this._pushActiveFile(vscode.window.activeTextEditor), 100);
  }

  private _handleCreateNewSession(webview: vscode.Webview): void {
    this._lastModel.clear();
    this._lastSessionId.clear();
    this._activeSessionId = '';
    this._activeRuntimeEpoch = '';
    this._lastUsage.clear();
    this._lastEpoch.clear();
    this._reqIdToUserInputAsTyped.clear();
    webview.postMessage({ type: 'session_id', content: '' });
    this._log.appendLine('[BRIDGE] create_new_session handled');
  }

  private _handleTabLoadingChanged(content: string): void {
    try {
      const payload = JSON.parse(content);
      this._log.appendLine(`[BRIDGE] tab_loading_changed loading=${payload?.loading === true}`);
      this._updateStatusBarItem(payload?.loading === true ? 'Running' : 'Idle');
    } catch {
      this._log.appendLine(`[BRIDGE] tab_loading_changed ${content}`);
    }
  }

  private _handleTabStatusChanged(content: string): void {
    try {
      const payload = JSON.parse(content);
      this._log.appendLine(`[BRIDGE] tab_status_changed status=${payload?.status ?? ''}`);
      if (typeof payload?.status === 'string' && payload.status.trim()) {
        this._updateStatusBarItem(payload.status.trim());
      }
    } catch {
      this._log.appendLine(`[BRIDGE] tab_status_changed ${content}`);
    }
  }

  private _updateStatusBarWidgetEnabled(enabled: boolean): void {
    this._statusBarWidgetEnabled = enabled;
    this._updateStatusBarItem();
  }

  private _updateStatusBarItem(status?: string): void {
    if (!this._statusBarWidgetEnabled) {
      this._statusBarItem.hide();
      return;
    }
    const providerLabels: Record<RuntimeProviderId, string> = {
      claude: 'Claude',
      codex: 'Codex',
      grok: 'Grok',
      kimi: 'Kimi',
      opencode: 'OpenCode',
      pi: 'PI',
    };
    const provider = providerLabels[this._activeProvider] ?? this._activeProvider;
    const model = this._selectedModel ? ` ${this._selectedModel}` : '';
    const state = status ? ` ${status}` : '';
    this._statusBarItem.text = `$(comment-discussion) ${provider}${model}${state}`;
    this._statusBarItem.show();
  }

  private _notifyTaskCompletion(id: string): void {
    if (this._suppressTaskCompletionNotification.has(id)) {
      this._forceLog(
        `[STREAM] id=${id} → skip task completion notification (user abort / interactive turn)`,
      );
      return;
    }

    this._maybeShowTaskCompletionNotification(id);
    this._maybePlayTaskCompletionSound();
  }

  /**
   * Opt-in in-panel toast when an AI turn completes.
   * Only the chat webview toast (no VS Code notification / status bar).
   */
  private _maybeShowTaskCompletionNotification(id: string): void {
    try {
      const enabled = this._settingsStore.getTaskCompletionNotificationEnabled();
      if (!enabled) {
        this._forceLog(`[STREAM] id=${id} taskCompletionNotification=off (skipped)`);
        return;
      }
      const preview = (this._latestAssistantPreview.get(id) ?? '').trim();
      const condensed = this._condenseForNotification(preview);
      const title = '任务完成';
      const detail = condensed || 'AI 任务已完成';
      const toastText = `${title}: ${detail.length > 80 ? `${detail.slice(0, 80)}…` : detail}`;

      this._forceLog(`[STREAM] id=${id} taskCompletionNotification → panel toast "${toastText.slice(0, 120)}"`);

      const webview = this._pendingWebviews.get(id) ?? this._webview;
      if (!webview) {
        this._forceLog(`[STREAM] id=${id} taskCompletionNotification skipped: no webview`);
        return;
      }
      webview.postMessage({
        type: 'js_eval',
        content:
          `try{window.addToast&&window.addToast(${JSON.stringify(toastText)},'success');}`
          + 'catch(e){console.error("[CCG] task toast failed",e);}',
      });
    } catch (error) {
      this._forceLog(`[STREAM] task completion notification failed: ${error}`);
    }
  }

  /** Collapse multi-line / code-fenced assistant text for a short notification body. */
  private _condenseForNotification(raw: string): string {
    if (!raw) return '';
    const maxInput = 4096;
    const input = raw.length > maxInput ? raw.slice(0, maxInput) : raw;
    const stripped = input
      .replace(/```[a-zA-Z0-9_+\-]*\n/g, '')
      .replace(/```/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const maxLen = 220;
    if (stripped.length <= maxLen) return stripped;
    return `${stripped.slice(0, maxLen - 3)}...`;
  }

  private _maybePlayTaskCompletionSound(): void {
    const soundConfig = this.context.globalState.get<{
      enabled?: boolean;
      onlyWhenUnfocused?: boolean;
      selectedSound?: string;
      customSoundPath?: string;
    }>('ccg.soundConfig', {});

    if (!soundConfig?.enabled) {
      return;
    }

    if (soundConfig.onlyWhenUnfocused && vscode.window.state.focused) {
      return;
    }

    this._playSound(JSON.stringify({
      soundId: soundConfig.selectedSound ?? 'default',
      path: soundConfig.customSoundPath ?? '',
    }));
  }

  /**
   * Kill the current ai-bridge daemon and start a new one with the configured Node.
   * Must be called after `ccGui.nodePath` changes — otherwise chat keeps using
   * the old Node process while settings only show a version warning.
   */
  private _restartBridgeDaemon(): void {
    this._logAppendLine('[BRIDGE] Restarting daemon (node path / CLI override may have changed)');
    try {
      this._bridgeProcess?.kill();
    } catch { /* ignore */ }
    this._bridgeProcess = undefined;
    this._startBridge();
  }

  /** Debounce Node-version / missing-daemon user notices (avoid toast spam). */
  private _lastNodeRequirementNotifyAt = 0;
  private _lastNodeRequirementNotifyText = '';

  /**
   * Notify the user about Node requirement failures at most once per 60s per message.
   * Settings page already has a persistent banner; chat only needs a rare reminder.
   */
  private _notifyNodeRequirementOnce(webview: vscode.Webview | undefined, message: string): void {
    const now = Date.now();
    if (
      message === this._lastNodeRequirementNotifyText
      && now - this._lastNodeRequirementNotifyAt < 60_000
    ) {
      return;
    }
    this._lastNodeRequirementNotifyAt = now;
    this._lastNodeRequirementNotifyText = message;
    if (webview) {
      this._postSendError(webview, message);
    }
  }

  private _lastModel = new Map<string, string>(); // id → model name
  private _lastSessionId = new Map<string, string>(); // id → session id
  /** Most recent Claude session id (for live permission-mode hot-swap). */
  private _activeSessionId = '';
  private _activeRuntimeEpoch = '';
  private _lastUsage = new Map<string, any>(); // id → last usage data
  private _lastEpoch = new Map<string, string>(); // id → runtimeSessionEpoch (tabId)
  private _reqId = 0;
  private _pendingWebviews = new Map<string, vscode.Webview>();
  private _requestEvents = new Map<string, string>();
  /** request id → runtime provider that owned the turn (for provider-scoped history writes). */
  private _requestProvider = new Map<string, RuntimeProviderId>();
  private _streamStarted = new Set<string>();
  private _contentStarted = new Set<string>();
  private _inThinking = new Set<string>();
  /** Buffer of [MESSAGE] events (assistant/user) accumulated during each streaming turn.
   *  Flushed to the webview as 'turn_messages' just before stream_end, so the frontend
   *  can patch tool_use / tool_result blocks that may have been missed during streaming. */
  private _turnMessageBuffer = new Map<string, any[]>();

  /**
   * Always write to the CC GUI Output channel, even when enableDebugLog is off.
   * Used for user-facing failures so diagnostics are never silently dropped.
   */
  private _forceLog(line: string): void {
    try {
      this._logAppendLine(line);
    } catch {
      // ignore output channel failures
    }
  }

  /**
   * Deliver a send failure to the webview chat UI and always log it.
   * Dual delivery (postMessage + js_eval) covers handler-registration races.
   */
  private _postSendError(webview: vscode.Webview, payload: string, requestId?: string): void {
    const content = typeof payload === 'string' ? payload : String(payload ?? 'Unknown error');
    // User Stop must not surface as a chat ERROR (Codex historically threw "Aborted").
    if (
      requestId
      && this._suppressTaskCompletionNotification.has(requestId)
      && /Aborted|User interrupted|operation was aborted/i.test(content)
    ) {
      this._forceLog(`[CCG_ERROR] id=${requestId} suppress user-abort send_error`);
      return;
    }
    const preview = content.length > 800 ? `${content.slice(0, 800)}…` : content;
    this._forceLog(`[CCG_ERROR]${requestId ? ` id=${requestId}` : ''} ${preview}`);
    // When debug is on, also go through the gated logger for continuity in the stream.
    this._log.appendLine(`[CCG_ERROR] send_error posted${requestId ? ` id=${requestId}` : ''} len=${content.length}`);

    webview.postMessage({ type: 'send_error', content });
    // Backup path: call the window handler directly if the type-map path is missed.
    const escaped = JSON.stringify(content);
    webview.postMessage({
      type: 'js_eval',
      content: `try{window.onSendError&&window.onSendError(${escaped});}catch(e){console.error('[CCG] onSendError failed',e);}`,
    });
  }

  private _emitStreamStart(id: string, webview: vscode.Webview) {
    if (!this._streamStarted.has(id)) {
      this._streamStarted.add(id);
      this._updateStatusBarItem('Running');
      this._log.appendLine(`[STREAM] id=${id} → stream_start posted to webview`);
      webview.postMessage({ type: 'stream_start' });
    }
  }

  private _emitStreamEnd(id: string, webview: vscode.Webview) {
    // Idempotent: STREAM_END line and msg.done both call this. After the first
    // delivery, request maps are cleared — a second call must not re-post stream_end.
    if (!this._streamStarted.has(id) && !this._turnMessageBuffer.has(id) && !this._pendingWebviews.has(id)) {
      return;
    }

    // Flush turn message buffer BEFORE sending stream_end so the webview can
    // patch tool_use / tool_result blocks before it finalises the assistant message.
    const turnMessages = this._turnMessageBuffer.get(id);
    const shouldPostStreamEnd = this._streamStarted.has(id) || (turnMessages && turnMessages.length > 0);
    if (turnMessages && turnMessages.length > 0) {
      const usage = this._lastUsage.get(id);
      if (usage && turnMessages.some((message) => message?.type === 'assistant')) {
        const patchedMessages = [...turnMessages];
        for (let i = patchedMessages.length - 1; i >= 0; i--) {
          const message = patchedMessages[i];
          if (message?.type !== 'assistant') continue;
          patchedMessages[i] = {
            ...message,
            turnUsage: {
              input_tokens: usage.inputTokens ?? 0,
              output_tokens: usage.outputTokens ?? 0,
              cache_creation_input_tokens: usage.cacheWrite ?? 0,
              cache_read_input_tokens: usage.cacheRead ?? 0,
            },
          };
          break;
        }
        this._turnMessageBuffer.set(id, patchedMessages);
      }
      this._log.appendLine(`[STREAM] id=${id} → turn_messages flushing ${turnMessages.length} msgs`);
      webview.postMessage({ type: 'turn_messages', content: JSON.stringify(this._turnMessageBuffer.get(id) ?? turnMessages) });
    }
    this._turnMessageBuffer.delete(id);

    this._streamStarted.delete(id);
    this._contentStarted.delete(id);
    this._inThinking.delete(id);
    this._lastModel.delete(id);
    this._lastSessionId.delete(id);
    this._updateStatusBarItem('Idle');
    if (shouldPostStreamEnd) {
      this._log.appendLine(`[STREAM] id=${id} → stream_end posted to webview`);
      webview.postMessage({ type: 'stream_end' });
      this._notifyTaskCompletion(id);
    }
    this._lastUsage.delete(id);
    this._lastEpoch.delete(id);
    // Keep _pendingWebviews / _requestEvents until msg.done so late SEND_ERROR
    // (emitted after STREAM_END in some paths) can still resolve the request webview.
    // Final cleanup happens in _cleanupRequest / done branch below via _finishRequest.
    this._latestAssistantPreview.delete(id);
    this._suppressTaskCompletionNotification.delete(id);
  }

  /** Drop request-scoped maps after the turn is fully finished (done envelope). */
  private _finishRequest(id: string): void {
    this._pendingWebviews.delete(id);
    this._requestEvents.delete(id);
    this._requestProvider.delete(id);
    this._streamStarted.delete(id);
    this._contentStarted.delete(id);
    this._inThinking.delete(id);
    this._turnMessageBuffer.delete(id);
    this._lastUsage.delete(id);
    this._lastEpoch.delete(id);
    this._lastModel.delete(id);
    this._lastSessionId.delete(id);
    this._latestAssistantPreview.delete(id);
    this._suppressTaskCompletionNotification.delete(id);
  }

  /** Prefer request-scoped webview; fall back to active panel after stream_end cleanup. */
  private _resolveWebview(requestId?: string): vscode.Webview | undefined {
    if (requestId) {
      const pending = this._pendingWebviews.get(requestId);
      if (pending) return pending;
    }
    return this._webview;
  }

  /**
   * Persist the input-box text (before skill expansion) in order, keyed by session/thread id.
   * Used so "Load from history" shows what the user typed, not the expanded SKILL body.
   */
  private _flushUserInputDisplayForRequest(reqId: string, sessionId: string): void {
    if (!sessionId) return;
    const text = this._reqIdToUserInputAsTyped.get(reqId);
    if (text == null) return;
    this._reqIdToUserInputAsTyped.delete(reqId);
    const storageKey = this._getHistorySessionStorageKey(sessionId);
    const all = this.context.globalState.get<Record<string, string[]>>(CCG_USER_INPUT_BY_SESSION_KEY) ?? {};
    const list = all[storageKey] ? [...all[storageKey]] : [];
    list.push(text);
    all[storageKey] = list;
    void this.context.globalState.update(CCG_USER_INPUT_BY_SESSION_KEY, all);
  }

  private _getHistorySessionStorageKey(sessionId: string): string {
    const workspaceScope = sanitizeProjectPath(this._workspacePath);
    return workspaceScope ? `${workspaceScope}::${sessionId}` : sessionId;
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
      // Common cause: configured Node is below MIN_NODE_MAJOR_VERSION and
      // _startBridge refused to spawn.
      const nodePath = NodeDetector.find(this.context);
      const version = nodePath ? readNodeVersion(nodePath) : null;
      const detail =
        formatNodeRequirementError(nodePath, version)
        || 'AI bridge daemon is not running (no stdin). Check Node.js path in Settings → Environment.';
      this._forceLog(`[BRIDGE] ERROR: No stdin available after _startBridge — ${detail}`);
      // Only remind on real user sends — never on heartbeat / background polls.
      if (event === 'send_message' || event === 'send_message_with_attachments') {
        this._notifyNodeRequirementOnce(webview, detail);
      }
      return;
    }

    const id = String(++this._reqId);

    let params: any = {};
    try { params = content ? JSON.parse(content) : {}; } catch { params = { text: content }; }
    const effectiveWorkingDirectory = this.getEffectiveWorkingDirectory();
    params.workspacePath = params.workspacePath ?? (effectiveWorkingDirectory || this._workspacePath);
    params.cwd = params.cwd ?? effectiveWorkingDirectory;

    const providerFromPayload = typeof params?.provider === 'string' ? params.provider : '';
    const activeProvider: RuntimeProviderId =
      isRuntimeProvider(providerFromPayload)
        ? (providerFromPayload as RuntimeProviderId)
        : this._activeProvider;

    // Map webview event names → daemon method names
    const METHOD_MAP: Record<string, string> = {
      'send_message':                  `${activeProvider}.send`,
      // Claude has a dedicated multimodal send; Grok/Codex/etc. share `.send`
      // and must read `params.attachments` themselves (Grok uses --prompt-file).
      'send_message_with_attachments':
        activeProvider === 'claude'
          ? 'claude.sendWithAttachments'
          : `${activeProvider}.send`,
      'preconnect':                    'claude.preconnect',
      'abort':                         'abort',
      'reset_runtime':                 'claude.resetRuntime',
      'get_context_usage':             'claude.getContextUsage',
      'rewind_files':                  'claude.rewindFiles',
      'get_dependency_status':         'status',
      'heartbeat':                     'heartbeat',
    };

    const method = METHOD_MAP[event];
    if (!method) {
      this._log.appendLine(`[BRIDGE] No method mapping for event: ${event}`);
      return;
    }

    // Scope abort to this webview's in-flight send requests so multi-window
    // stop only cancels that window (not every concurrent turn).
    if (event === 'abort') {
      const targetRequestIds: string[] = [];
      for (const [reqId, wv] of this._pendingWebviews.entries()) {
        if (wv !== webview) continue;
        const reqEvent = this._requestEvents.get(reqId);
        if (
          reqEvent === 'send_message' ||
          reqEvent === 'send_message_with_attachments' ||
          this._streamStarted.has(reqId)
        ) {
          targetRequestIds.push(reqId);
        }
      }
      // User Stop is not a successful completion — do not fire "任务完成" toast/sound
      // when the CLI process exits and stream_end is emitted after abort.
      for (const reqId of targetRequestIds) {
        this._suppressTaskCompletionNotification.add(reqId);
      }
      params = {
        ...params,
        targetRequestIds,
      };
      this._log.appendLine(
        `[BRIDGE] abort scoped to webview requestIds=${targetRequestIds.join(',') || '(none)'}`,
      );
    }

    this._fillSelectedText(params);

    if (params.text !== undefined && params.message === undefined) {
      params.message = params.text;
    }

    if (event === 'send_message' || event === 'send_message_with_attachments') {
      this._runtimeContext.enrichSendParams(params, {
        includeEditorContext: this._settingsStore.getAutoOpenFileEnabled(),
      });
      this._fillSelectedText(params);
      if (activeProvider === 'codex') {
        params.sandboxMode = params.sandboxMode ?? this.getCodexSandboxMode();
      }
      // Ensure daemon routing receives the active provider even if the webview
      // omitted it (CLI providers rely on this for session continuity).
      params.provider = activeProvider;
    }

    const userInputAsTyped =
      typeof params.text === 'string'
        ? params.text
        : typeof params.message === 'string'
          ? params.message
          : '';

    // Expand skill commands: /skill-name [args] → SKILL.md body with $ARGUMENTS substituted
    if (params.text?.startsWith('/')) {
      const expanded = this._slashCommands.expandSkillCommand(params.text);
      if (expanded !== null) {
        params.text = expanded;
        params.message = expanded;
      }
    }

    // Inject the selected model if not already set in params
    if (!params.model && this._selectedModel) {
      params.model = this._selectedModel;
    }

    if (
      (event === 'send_message' || event === 'send_message_with_attachments') &&
      userInputAsTyped.length > 0
    ) {
      this._reqIdToUserInputAsTyped.set(id, userInputAsTyped);
    }

    if (event === 'send_message' || event === 'send_message_with_attachments') {
      this._log.appendLine(
        `[CCG_DEBUG] ${event} provider=${activeProvider} streaming=${String(params.streaming ?? false)} model=${String(params.model ?? '')}`,
      );
    }

    this._pendingWebviews.set(id, webview);
    this._requestEvents.set(id, event);
    if (event === 'send_message' || event === 'send_message_with_attachments') {
      this._requestProvider.set(id, activeProvider);
    }
    const msg = JSON.stringify({ id, method, params }) + '\n';
      if (!isHeartbeat) {
        this._log.appendLine(`[BRIDGE] Sending to daemon: id=${id} method=${method} msg_len=${msg.length}`);
      }
      this._bridgeProcess.stdin.write(msg);
  }

  private _fillSelectedText(params: any): void {
    if (!params.openedFiles?.selection || params.openedFiles.selection.selectedText || !params.openedFiles.active) {
      return;
    }
    try {
      const filePath = String(params.openedFiles.active).replace(/#L\d+(-\d+)?$/, '');
      const { startLine, endLine } = params.openedFiles.selection;
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.split('\n');
      const start = Math.max(0, (startLine ?? 1) - 1);
      const end = Math.min(lines.length, (endLine ?? startLine ?? 1));
      params.openedFiles.selection.selectedText = lines.slice(start, end).join('\n');
    } catch { /* ignore read errors */ }
  }

  /**
   * Push permission mode to the live Claude runtime so mid-turn tool calls honor it.
   * Codex rebuilds thread options per turn, so only Claude is hot-swapped.
   */
  private _pushPermissionModeLive(mode: string): void {
    const provider = this.getActiveProvider();
    if (provider !== 'claude') {
      return;
    }
    const sessionId = this._activeSessionId || undefined;
    const runtimeSessionEpoch = this._activeRuntimeEpoch || undefined;
    this._log.appendLine(
      `[BRIDGE] pushPermissionModeLive mode=${mode} sessionId=${sessionId || '(none)'} epoch=${runtimeSessionEpoch || '(none)'}`,
    );
    if (!this._bridgeProcess || this._bridgeProcess.killed) {
      this._startBridge();
    }
    if (!this._bridgeProcess?.stdin) {
      this._log.appendLine('[BRIDGE] pushPermissionModeLive skipped: daemon stdin unavailable');
      return;
    }
    const id = String(++this._reqId);
    const params: Record<string, unknown> = { permissionMode: mode };
    if (sessionId) params.sessionId = sessionId;
    if (runtimeSessionEpoch) params.runtimeSessionEpoch = runtimeSessionEpoch;
    const msg = JSON.stringify({ id, method: 'claude.setPermissionMode', params }) + '\n';
    this._bridgeProcess.stdin.write(msg);
  }

  private _sendDaemonRequest(event: string, method: string, params: Record<string, unknown>, webview: vscode.Webview): void {
    if (!this._bridgeProcess || this._bridgeProcess.killed) {
      this._log.appendLine('[BRIDGE] Daemon not running, starting...');
      this._startBridge();
    }
    if (!this._bridgeProcess?.stdin) {
      this._log.appendLine(`[BRIDGE] ERROR: No stdin available for ${event}`);
      return;
    }

    const id = String(++this._reqId);
    this._pendingWebviews.set(id, webview);
    this._requestEvents.set(id, event);
    const normalizedParams = {
      workspacePath: this.getEffectiveWorkingDirectory() || this._workspacePath,
      cwd: this.getEffectiveWorkingDirectory(),
      ...params,
    };
    const msg = JSON.stringify({ id, method, params: normalizedParams }) + '\n';
    this._log.appendLine(`[BRIDGE] Sending daemon request: id=${id} event=${event} method=${method}`);
    this._bridgeProcess.stdin.write(msg);
  }

  private _startBridge() {
    if (!fs.existsSync(this._bridgePath)) {
      this._log.appendLine(`[BRIDGE] ERROR: daemon not found at ${this._bridgePath}`);
      return;
    }
    const nodePath = NodeDetector.find(this.context);
    if (!nodePath) {
      const msg = formatNodeRequirementError(undefined, null);
      this._forceLog(`[BRIDGE] ERROR: ${msg}`);
      // Log only — do not toast on every start attempt (frontend polls often).
      return;
    }
    const nodeVersion = readNodeVersion(nodePath);
    if (!isNodeVersionSupported(nodeVersion)) {
      const msg = formatNodeRequirementError(nodePath, nodeVersion);
      this._forceLog(`[BRIDGE] ERROR: ${msg}`);
      // Log only. Settings Environment tab shows a persistent banner; chat
      // is notified (debounced) when the user actually sends a message.
      return;
    }
    this._log.appendLine(
      `[BRIDGE] Starting daemon: node=${nodePath} version=${nodeVersion ?? '?'} path=${this._bridgePath}`,
    );

    // Remove proxy environment variables to prevent 502 Bad Gateway errors
    // Node.js HTTP client auto-reads these vars, but the proxy may not handle all requests correctly
    const bridgeEnv = { ...process.env };
    const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
    const removedProxyVars: string[] = [];
    for (const key of proxyVars) {
      if (bridgeEnv[key]) {
        removedProxyVars.push(key);
        delete bridgeEnv[key];
      }
    }
    if (removedProxyVars.length > 0) {
      this._log.appendLine(`[BRIDGE] Removed proxy env vars for daemon: ${removedProxyVars.join(', ')}`);
    }
    const effectiveWorkingDirectory = this.getEffectiveWorkingDirectory();
    bridgeEnv.WORKSPACE_PATH = this._workspacePath;
    if (effectiveWorkingDirectory) {
      bridgeEnv.PROJECT_PATH = effectiveWorkingDirectory;
      bridgeEnv.IDEA_PROJECT_PATH = effectiveWorkingDirectory;
    }

    this._bridgeProcess = cp.spawn(nodePath, [this._bridgePath], {
      cwd: effectiveWorkingDirectory || os.homedir(),
      env: bridgeEnv,
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
      for (const [id, request] of this._textRequestResolvers.entries()) {
        clearTimeout(request.timeout);
        request.reject(new Error(`AI bridge daemon exited before request completed (${code ?? 'unknown'})`));
        this._textRequestResolvers.delete(id);
        this._requestEvents.delete(id);
      }
    });
  }

  private _handleDaemonLine(msg: any) {
    // Daemon lifecycle / side-channel events (no request id)
    if (msg.type === 'daemon') {
      if (msg.event === 'ready') {
        if (this._webview) this._webview.postMessage({ type: 'js_eval', content: 'window.onSdkLoaded && window.onSdkLoaded()' });
      } else if (msg.event === 'title_generated') {
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
        const title = typeof msg.title === 'string' ? msg.title.trim() : '';
        if (sessionId && title && this._webview) {
          this._callWebviewArgs(this._webview, 'updateSessionTitle', [sessionId, title]);
        }
      } else if (msg.event === 'title_log') {
        const level = typeof msg.level === 'string' ? msg.level : 'info';
        const message = typeof msg.message === 'string' ? msg.message : '';
        this._log.appendLine(`[TITLE] ${level}: ${message}`.slice(0, 400));
      }
      return;
    }

    // heartbeat response — ignore after clearing request bookkeeping.
    if (msg.type === 'heartbeat') {
      if (msg.id) this._cleanupRequest(msg.id);
      return;
    }

    if (msg.id && this._handleInternalTextRequestLine(msg)) {
      return;
    }

    // Prefer request-scoped webview; fall back to active panel after STREAM_END
    // clears _pendingWebviews (Codex often emits SEND_ERROR after STREAM_END).
    const webview = this._resolveWebview(msg.id);
    if (!webview) {
      if (
        msg.stderr !== undefined
        || (typeof msg.line === 'string' && (msg.line.includes('[SEND_ERROR]') || msg.line.includes('"success":false')))
      ) {
        this._forceLog(`[CCG_ERROR] drop: no webview for id=${msg.id ?? ''} (send_error lost)`);
      }
      return;
    }

    // Tagged stderr (e.g. [SEND_ERROR]) must still reach the UI. Daemon routes
    // console.error to msg.stderr; without this branch config/auth failures are
    // only visible in the log panel and the chat appears to "flash then stop".
    if (msg.stderr !== undefined) {
      const stderrLine = String(msg.stderr);
      // Always log stderr that looks like a failure (not gated by enableDebugLog).
      if (
        stderrLine.includes('[SEND_ERROR]')
        || stderrLine.includes('Error loading config')
        || stderrLine.includes('ERROR')
        || /error/i.test(stderrLine)
      ) {
        this._forceLog(`[BRIDGE] AI stderr: ${stderrLine.slice(0, 600)}`);
      } else {
        this._log.appendLine(`[BRIDGE] Internal AI stderr: ${stderrLine.slice(0, 400)}`);
      }
      const sendErrorIdx = stderrLine.indexOf('[SEND_ERROR] ');
      if (sendErrorIdx >= 0) {
        const payload = stderrLine.slice(sendErrorIdx + '[SEND_ERROR] '.length).trim();
        if (payload) {
          this._postSendError(webview, payload, msg.id);
        }
      }
      // Continue — a request may also emit stdout lines in the same envelope.
      if (msg.line === undefined && !msg.done) {
        return;
      }
    }

    // Streaming line events
    if (msg.line !== undefined) {
      const line: string = msg.line;
      const requestEvent = this._requestEvents.get(msg.id);

      if (requestEvent === 'get_context_usage' && this._handleContextUsageLine(line, webview)) {
        return;
      }

      if (requestEvent === 'rewind_files' && this._handleRewindLine(line, webview)) {
        return;
      }

      if (this._handleMcpLine(line, requestEvent, webview)) {
        return;
      }

      if (line === '[STREAM_START]') {
        this._emitStreamStart(msg.id, webview);
      } else if (line === '[STREAM_END]' || line === '[MESSAGE_END]') {
        this._emitStreamEnd(msg.id, webview);
      } else if (line === '[STREAM_HEARTBEAT]') {
        // Keep stall watchdog alive during long tool phases with no text deltas
        // (Codex app-server / multi-step turns). Does not open a new stream.
        webview.postMessage({
          type: 'js_eval',
          content: 'window.onStreamingHeartbeat && window.onStreamingHeartbeat()',
        });
      } else if (line.startsWith('[CONTENT_DELTA] ')) {
        let delta: string;
        const rawDelta = line.slice('[CONTENT_DELTA] '.length);
        try {
          delta = JSON.parse(rawDelta);
        } catch {
          // Malformed JSON: daemon appends an extra trailing `"` in some versions.
          // Strip the trailing `"` and retry parse (e.g. `"3""` → `"3"` → `3`).
          try {
            delta = JSON.parse(rawDelta.trimEnd().replace(/"$/, ''));
          } catch {
            // Last resort: strip all surrounding quotes
            delta = rawDelta.trim().replace(/^"|"$/g, '');
          }
        }
        this._emitStreamStart(msg.id, webview);
        // Mark that assistant text has already been streamed. Otherwise the later
        // [MESSAGE] { type: "result" } handler would treat the turn as having no
        // streamed text and emit `parsed.result` as an extra content_delta (e.g. "2"
        // + "2" → "22" for a short answer like 1+1). See _contentStarted in result branch.
        this._contentStarted.add(msg.id);
        webview.postMessage({ type: 'content_delta', content: delta });
        if (typeof delta === 'string' && delta) {
          const prev = this._latestAssistantPreview.get(msg.id) ?? '';
          this._latestAssistantPreview.set(msg.id, prev + delta);
        }
      } else if (line.startsWith('[CONTENT] ')) {
        const delta = line.slice('[CONTENT] '.length);
        this._inThinking.delete(msg.id); // switch from thinking to content
        this._emitStreamStart(msg.id, webview);
        if (this._contentStarted.has(msg.id)) {
          webview.postMessage({ type: 'content_delta', content: '\n' });
        }
        this._contentStarted.add(msg.id);
        webview.postMessage({ type: 'content_delta', content: delta });
        if (delta) {
          const prev = this._latestAssistantPreview.get(msg.id) ?? '';
          this._latestAssistantPreview.set(msg.id, prev ? `${prev}\n${delta}` : delta);
        }
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
        this._activeSessionId = sessionId;
        this._flushUserInputDisplayForRequest(msg.id, sessionId);
        webview.postMessage({ type: 'session_id', content: sessionId });
        // Record this session in our own index so history only shows plugin sessions
        this._historyService.recordSessionId(sessionId);
        // Send back the epoch (tabId) so webview can route messages to the correct tab
        const epoch = this._lastEpoch.get(msg.id);
        if (epoch) {
          this._activeRuntimeEpoch = epoch;
          webview.postMessage({ type: 'js_eval', content: `window.__ccg_onSessionEpoch && window.__ccg_onSessionEpoch(${JSON.stringify(sessionId)}, ${JSON.stringify(epoch)})` });
        }
      } else if (line.startsWith('[THREAD_ID] ')) {
        // Codex runtime emits thread IDs; treat them as session IDs for UI/history compatibility.
        const threadId = line.slice('[THREAD_ID] '.length).trim();
        this._lastSessionId.set(msg.id, threadId);
        this._activeSessionId = threadId;
        this._flushUserInputDisplayForRequest(msg.id, threadId);
        webview.postMessage({ type: 'session_id', content: threadId });
        this._historyService.recordSessionId(threadId);
        const epoch = this._lastEpoch.get(msg.id);
        if (epoch) {
          this._activeRuntimeEpoch = epoch;
          webview.postMessage({ type: 'js_eval', content: `window.__ccg_onSessionEpoch && window.__ccg_onSessionEpoch(${JSON.stringify(threadId)}, ${JSON.stringify(epoch)})` });
        }
      } else if (line.startsWith('[MODEL] ')) {
        const model = line.slice('[MODEL] '.length).trim();
        if (model) this._lastModel.set(msg.id, model);
      } else if (line.startsWith('[MESSAGE] ')) {
        let payload = line.slice('[MESSAGE] '.length);
        // Extract model from assistant messages
        try {
          let parsed = JSON.parse(payload);
          parsed = sanitizeUserMessagePayload(parsed);
          // Resolve local_image file paths to base64 so webview CSP can render them
          if (parsed?.message?.content && Array.isArray(parsed.message.content)) {
            const resolved = parsed.message.content.map((block: any) => {
              if (block?.type === 'local_image' && typeof block.path === 'string' && block.path) {
                try {
                  const data = fs.readFileSync(block.path);
                  const ext = path.extname(block.path).slice(1).toLowerCase();
                  const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`;
                  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } };
                } catch { return block; }
              }
              return block;
            });
            parsed = { ...parsed, message: { ...parsed.message, content: resolved } };
          }
          payload = JSON.stringify(parsed);
          if (
            parsed?.type === 'status' &&
            typeof parsed.message === 'string' &&
            /Reconnecting\.\.\.\s*\d+\/\d+/i.test(parsed.message)
          ) {
            webview.postMessage({
              type: 'js_eval',
              content: `window.addErrorMessage && window.addErrorMessage(${JSON.stringify(parsed.message)})`,
            });
          }
          if ((parsed.type === 'assistant' || parsed.type === 'user') && parsed.message?.content) {
            const sid = this._lastSessionId.get(msg.id) ?? '';
            const text = this._historyService.extractCodexTextFromContent(parsed.message.content);
            if (parsed.type === 'assistant' && text.trim()) {
              // Codex non-streaming (or final-only CLI snapshots) may only send
              // [MESSAGE] without prior [CONTENT_DELTA]. Surface text once so the
              // webview streaming slot is not left blank.
              if (!this._contentStarted.has(msg.id)) {
                this._emitStreamStart(msg.id, webview);
                this._contentStarted.add(msg.id);
                webview.postMessage({ type: 'content_delta', content: text });
              } else {
                this._contentStarted.add(msg.id);
              }
              this._latestAssistantPreview.set(msg.id, text.trim());
            }
            // Codex history cache is provider-specific. Grok/Claude/etc. also emit
            // [MESSAGE] with session ids — writing them here incorrectly lists those
            // turns under Codex history when the user switches providers.
            if (sid) {
              const requestProvider =
                this._requestProvider.get(msg.id) ?? this._activeProvider;
              if (
                requestProvider === 'codex'
                && (text || this._historyService.extractCodexBlocksFromContent(parsed.message.content).length > 0)
              ) {
                this._historyService.appendCodexHistoryMessage(
                  sid,
                  parsed.type === 'assistant' ? 'assistant' : 'user',
                  parsed.message.content,
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
            this._usageStatistics.recordUsage({
              sessionId,
              model,
              inputTokens,
              outputTokens,
              cacheRead,
              cacheWrite,
            }, { avoidDailyDoubleCount: true });
          }
          // Parse result message for token usage and final content
          if (parsed.type === 'result') {
            const usage = parsed.usage ?? {};
            const inputTokens = usage.input_tokens ?? 0;
            const outputTokens = usage.output_tokens ?? 0;
            const cacheRead = usage.cache_read_input_tokens ?? 0;
            const cacheWrite = usage.cache_creation_input_tokens ?? 0;
            const model = this._lastModel.get(msg.id) ?? 'unknown';
            const sessionId = parsed.session_id ?? '';
            this._usageStatistics.recordUsage({
              sessionId,
              model,
              inputTokens,
              outputTokens,
              cacheRead,
              cacheWrite,
              costOverride: parsed.total_cost_usd,
              summary: typeof parsed.result === 'string' ? parsed.result.slice(0, 100) : undefined,
            }, { avoidDailyDoubleCount: false });
            this._lastUsage.set(msg.id, {
              inputTokens,
              outputTokens,
              cacheRead,
              cacheWrite,
              cost: parsed.total_cost_usd,
              model,
              sessionId,
            });

            if (parsed.result && typeof parsed.result === 'string') {
              if (parsed.result.trim()) {
                this._latestAssistantPreview.set(msg.id, parsed.result.trim());
              }
              // Fallback only: if no assistant text streamed this turn, emit final result once.
              if (!this._contentStarted.has(msg.id)) {
                this._emitStreamStart(msg.id, webview);
                this._contentStarted.add(msg.id);
                webview.postMessage({ type: 'content_delta', content: parsed.result });
              }
            }
            this._usageStatistics.postUsageUpdate(webview, inputTokens);
          }
          // Structural assistant/user messages (tool_use / tool_result) must open
          // the stream even when no CONTENT_DELTA has arrived yet — otherwise the
          // webview keeps loading=true while onMessage drops the payload.
          if (parsed.type === 'assistant' || parsed.type === 'user') {
            this._emitStreamStart(msg.id, webview);
            if (!this._turnMessageBuffer.has(msg.id)) this._turnMessageBuffer.set(msg.id, []);
            this._turnMessageBuffer.get(msg.id)!.push(parsed);
            const hasToolUse = Array.isArray(parsed.message?.content) && parsed.message.content.some((b: any) => b?.type === 'tool_use');
            const hasAskUserQuestionToolUse = Array.isArray(parsed.message?.content) && parsed.message.content.some((b: any) =>
              b?.type === 'tool_use' && (b?.name === 'AskUserQuestion' || b?.tool_name === 'AskUserQuestion')
            );
            if (hasAskUserQuestionToolUse) {
              this._suppressTaskCompletionNotification.add(msg.id);
              this._log.appendLine(`[STREAM] id=${msg.id} detected AskUserQuestion tool_use → suppress completion notification`);
            }
            this._log.appendLine(`[STREAM] id=${msg.id} buffered [MESSAGE] type=${parsed.type} toolUse=${hasToolUse}`);
          }
          // Background Agent lifecycle: SDK emits type=system subtype=task_notification
          // after the parent turn's result. Webview StatusPanel listens on
          // window.onTaskEvent — without this fan-out async agents stay "running"
          // forever after the main conversation settles.
          if (parsed.type === 'system' && parsed.subtype === 'task_notification') {
            this._callWebviewJson(webview, 'onTaskEvent', parsed);
            this._log.appendLine(
              `[STREAM] id=${msg.id} task_notification tool_use_id=${parsed.tool_use_id ?? ''} status=${parsed.status ?? ''}`,
            );
          }
        } catch { /* ignore */ }
        webview.postMessage({ type: 'message_data', content: payload });
      } else if (line.startsWith('[SEND_ERROR] ') || line.startsWith('[ERROR] ')) {
        const payload = line.replace(/^\[[A-Z_]+\] /, '');
        this._postSendError(webview, payload, msg.id);
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

          const { cost } = this._usageStatistics.recordUsage({
            sessionId,
            model,
            inputTokens,
            outputTokens,
            cacheRead,
            cacheWrite,
          }, { avoidDailyDoubleCount: true });
          this._lastUsage.set(msg.id, { inputTokens, outputTokens, cacheRead, cacheWrite, cost, model, sessionId });
          this._usageStatistics.postUsageUpdate(webview, inputTokens);
        } catch { /* ignore */ }
      } else if (!line.startsWith('[')) {
        // Daemon request-result envelopes (no protocol tag) must never become chat text.
        // Codex/Claude print e.g. {"success":true,"threadId":"...","result":"3","transport":"app-server"}
        // at end of turn for demux — showing them as content_delta leaks JSON into the UI.
        // Same for structured daemon events (title_log / title_generated) that may still
        // arrive tagged with a request id if demux missed the pass-through path.
        const trimmedBare = line.trim();
        if (trimmedBare.startsWith('{')) {
          try {
            const parsedBare = JSON.parse(trimmedBare) as {
              type?: unknown;
              event?: unknown;
              success?: unknown;
              error?: unknown;
              threadId?: unknown;
              sessionId?: unknown;
              title?: unknown;
              result?: unknown;
              transport?: unknown;
              details?: unknown;
              level?: unknown;
              message?: unknown;
            };
            if (parsedBare && typeof parsedBare === 'object' && parsedBare.type === 'daemon') {
              if (parsedBare.event === 'title_generated') {
                const sessionId = typeof parsedBare.sessionId === 'string' ? parsedBare.sessionId.trim() : '';
                const title = typeof parsedBare.title === 'string' ? parsedBare.title.trim() : '';
                if (sessionId && title) {
                  this._callWebviewArgs(webview, 'updateSessionTitle', [sessionId, title]);
                }
              } else if (parsedBare.event === 'title_log') {
                const level = typeof parsedBare.level === 'string' ? parsedBare.level : 'info';
                const message = typeof parsedBare.message === 'string' ? parsedBare.message : '';
                this._log.appendLine(`[TITLE] ${level}: ${message}`.slice(0, 400));
              } else {
                this._log.appendLine(
                  `[STREAM] id=${msg.id} swallow daemon event event=${String(parsedBare.event ?? '')}`,
                );
              }
              return;
            }
            if (parsedBare && typeof parsedBare === 'object' && 'success' in parsedBare) {
              if (parsedBare.success === false) {
                this._postSendError(webview, trimmedBare, msg.id);
              } else {
                this._log.appendLine(
                  `[STREAM] id=${msg.id} swallow success envelope transport=${String(parsedBare.transport ?? '')}`,
                );
              }
              return;
            }
          } catch {
            // fall through to content routing
          }
        }
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
        this._reqIdToUserInputAsTyped.delete(msg.id);
        const requestEvent = this._requestEvents.get(msg.id);
        if (requestEvent === 'get_context_usage') {
          this._callWebviewArgs(webview, 'onContextUsageError', [msg.error ?? 'Unknown error']);
          this._cleanupRequest(msg.id);
          return;
        }
        if (requestEvent === 'rewind_files') {
          this._callWebviewJson(webview, 'onRewindResult', { success: false, message: msg.error ?? 'Unknown error' });
          this._cleanupRequest(msg.id);
          return;
        }
        this._postSendError(webview, JSON.stringify(msg.error ?? 'Unknown error'), msg.id);
      } else {
        const sid = this._lastSessionId.get(msg.id);
        if (sid) {
          this._flushUserInputDisplayForRequest(msg.id, sid);
        }
      }
      const requestEvent = this._requestEvents.get(msg.id);
      if (
        requestEvent === 'get_context_usage' ||
        requestEvent === 'rewind_files' ||
        requestEvent === 'heartbeat' ||
        this._isMcpRequestEvent(requestEvent)
      ) {
        this._cleanupRequest(msg.id);
      } else {
        this._emitStreamEnd(msg.id, webview);
        // STREAM_END keeps pending webview for late SEND_ERROR; done is the final envelope.
        this._finishRequest(msg.id);
      }
    }
  }

  private _isMcpRequestEvent(event: string | undefined): boolean {
    return event === 'get_mcp_server_status'
      || event === 'get_codex_mcp_server_status'
      || event === 'get_mcp_server_tools'
      || event === 'get_codex_mcp_server_tools'
      // Codex list/write ops stream the native server list tagged [MCP_SERVER_LIST].
      || event === 'get_codex_mcp_servers'
      || event === 'add_codex_mcp_server'
      || event === 'update_codex_mcp_server'
      || event === 'delete_codex_mcp_server'
      || event === 'toggle_codex_mcp_server';
  }

  private _handleInternalTextRequestLine(msg: any): boolean {
    const request = this._textRequestResolvers.get(msg.id);
    if (!request) {
      return false;
    }

    if (msg.stderr) {
      this._log.appendLine(`[BRIDGE] Internal AI stderr: ${String(msg.stderr).slice(0, 400)}`);
      return true;
    }

    if (msg.line !== undefined) {
      const line = String(msg.line);
      if (line.startsWith('[CONTENT_DELTA] ')) {
        const rawDelta = line.slice('[CONTENT_DELTA] '.length);
        try {
          const parsed = JSON.parse(rawDelta);
          request.chunks.push(typeof parsed === 'string' ? parsed : String(parsed ?? ''));
        } catch {
          // Keep whitespace; only strip wrapping JSON quotes when present.
          const unquoted = rawDelta.replace(/^"/, '').replace(/"$/, '');
          request.chunks.push(unquoted);
        }
        this._emitInternalTextProgress(request);
        return true;
      }
      if (line.startsWith('[CONTENT] ')) {
        request.chunks.push(line.slice('[CONTENT] '.length));
        this._emitInternalTextProgress(request);
        return true;
      }
      if (line.startsWith('[MESSAGE] ')) {
        const parsed = this._safeJson<any>(line.slice('[MESSAGE] '.length), null);
        const text = this._extractTextFromDaemonMessage(parsed);
        if (text) {
          request.chunks.push(text);
          this._emitInternalTextProgress(request);
        }
        return true;
      }
      const parsed = this._safeJson<any>(line, null);
      if (parsed?.result && typeof parsed.result === 'string') {
        request.chunks.push(parsed.result);
        this._emitInternalTextProgress(request);
      }
      return true;
    }

    if (msg.done) {
      this._textRequestResolvers.delete(msg.id);
      this._requestEvents.delete(msg.id);
      clearTimeout(request.timeout);
      if (!msg.success) {
        request.reject(new Error(msg.error ?? 'Internal AI text request failed'));
        return true;
      }
      request.resolve(dedupeTextChunks(request.chunks));
      return true;
    }

    return true;
  }

  private _emitInternalTextProgress(request: {
    chunks: string[];
    onProgress?: (partial: string) => void;
  }): void {
    if (!request.onProgress) return;
    const partial = dedupeTextChunks(request.chunks);
    if (partial) {
      try {
        request.onProgress(partial);
      } catch {
        // ignore consumer errors
      }
    }
  }

  private _extractTextFromDaemonMessage(parsed: any): string {
    if (!parsed) {
      return '';
    }
    if (parsed.type === 'result' && typeof parsed.result === 'string') {
      return parsed.result;
    }
    if (parsed.type === 'assistant' && parsed.message?.content) {
      return this._historyService.extractCodexTextFromContent(parsed.message.content);
    }
    if (parsed.type === 'assistant' && typeof parsed.text === 'string') {
      return parsed.text;
    }
    return '';
  }

  private _handleMcpLine(line: string, requestEvent: string | undefined, webview: vscode.Webview): boolean {
    if (!this._isMcpRequestEvent(requestEvent)) {
      return false;
    }

    if (line.startsWith('[MCP_SERVER_STATUS]')) {
      const payload = this._safeJson<any[]>(this._tagPayload(line, '[MCP_SERVER_STATUS]'), []);
      webview.postMessage({
        type: requestEvent === 'get_codex_mcp_server_status' ? 'update_codex_mcp_server_status' : 'update_mcp_server_status',
        content: JSON.stringify(payload),
      });
      return true;
    }

    // Codex native server list (from the `codex mcp` CLI). A plain list request
    // refreshes the panel; a status request maps the list to status entries.
    if (line.startsWith('[MCP_SERVER_LIST]')) {
      const servers = this._safeJson<any[]>(this._tagPayload(line, '[MCP_SERVER_LIST]'), []);
      if (requestEvent === 'get_codex_mcp_server_status') {
        const statusList = servers.map((s) => ({
          name: s.name || s.id,
          status: s.enabled === false ? 'failed' : 'pending',
          error: s.enabled === false ? 'Disabled' : undefined,
        }));
        webview.postMessage({ type: 'update_codex_mcp_server_status', content: JSON.stringify(statusList) });
      } else {
        webview.postMessage({ type: 'update_codex_mcp_servers', content: JSON.stringify(servers) });
      }
      return true;
    }

    if (line.startsWith('[MCP_SERVER_TOOLS]')) {
      const payload = this._safeJson<any>(this._tagPayload(line, '[MCP_SERVER_TOOLS]'), null);
      if (payload) {
        this._callWebviewJson(webview, 'updateMcpServerTools', payload);
      }
      return true;
    }

    const barePayload = this._safeJson<any>(line.trim(), null);
    if (barePayload && typeof barePayload === 'object') {
      if (requestEvent === 'get_mcp_server_tools' || requestEvent === 'get_codex_mcp_server_tools') {
        this._callWebviewJson(webview, 'updateMcpServerTools', barePayload);
      }
      return true;
    }

    return false;
  }

  private _tagPayload(line: string, tag: string): string {
    return line.slice(tag.length).trim();
  }

  private _handleContextUsageLine(line: string, webview: vscode.Webview): boolean {
    const payload = this._tryParseJsonLine(line);
    if (!payload) return true;
    if (payload.success === false) {
      this._callWebviewArgs(webview, 'onContextUsageError', [payload.error ?? 'Failed to get context usage', payload.requestId]);
      return true;
    }
    this._callWebviewJson(webview, 'showContextUsageDialog', payload);
    return true;
  }

  private _handleRewindLine(line: string, webview: vscode.Webview): boolean {
    const payload = this._tryParseJsonLine(line);
    if (!payload) return true;
    const success = payload.success === true;
    this._callWebviewJson(webview, 'onRewindResult', {
      success,
      filesRestored: payload.filesRestored,
      message: success ? undefined : `Failed to restore files: ${payload.error ?? 'Unknown error'}`,
    });
    return true;
  }

  private _tryParseJsonLine(line: string): any | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private _cleanupRequest(id: string): void {
    this._turnMessageBuffer.delete(id);
    this._streamStarted.delete(id);
    this._contentStarted.delete(id);
    this._inThinking.delete(id);
    this._lastModel.delete(id);
    this._lastSessionId.delete(id);
    this._lastUsage.delete(id);
    this._lastEpoch.delete(id);
    this._pendingWebviews.delete(id);
    this._requestEvents.delete(id);
    this._requestProvider.delete(id);
    this._latestAssistantPreview.delete(id);
    this._assistantTurnBuffer.delete(id);
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

  private _getUsageStatistics(_content: string, webview: vscode.Webview) {
    this._usageStatistics.postStatistics(webview);
  }

  /**
   * Gate Output Channel writes via `ccGui.enableDebugLog` (default: false).
   * When disabled, the gated facade's append* is a no-op so normal use stays quiet.
   */
  private _applyDebugLogSetting(fromConfigChange: boolean): void {
    const enabled =
      vscode.workspace.getConfiguration('ccGui').get<boolean>('enableDebugLog') === true;
    this._debugLogEnabled = enabled;
    // Drive view/title menu visibility for openDevTools (package.json when clause).
    void vscode.commands.executeCommand('setContext', 'ccGui.enableDebugLog', enabled);
    if (enabled) {
      // Always stamp a marker when the gate opens — including cold start with a
      // persisted ON setting — so users do not need to toggle the switch to verify.
      // Use force writer (not the gated facade) so the marker is never dropped.
      this._logAppendLine(`[CC GUI] Debug log enabled (ccGui.enableDebugLog) at ${new Date().toISOString()}`);
      // Select this channel in the Output panel. Without show(), dispose+recreate
      // can leave the panel stuck on a disposed/empty view even though logs write.
      try {
        this._rawLog.show(true);
      } catch {
        // ignore UI failures
      }
    } else if (fromConfigChange) {
      this._logAppendLine('[CC GUI] Debug log disabled (ccGui.enableDebugLog)');
    }
  }

  dispose() {
    this._configListener?.dispose();
    this._runtimeContext.dispose();
    this._permissionIpc.dispose();
    this._bridgeProcess?.kill();
    // Output channel is also on context.subscriptions; avoid double-dispose races.
  }

  // ── globalState helpers ───────────────────────────────────────────────────
  private _state(key: string, defaultVal: string): string {
    return (this.context.globalState.get<string>(`ccg.${key}`) ?? defaultVal);
  }
  private _setState(key: string, value: string) {
    this.context.globalState.update(`ccg.${key}`, value);
  }
  /**
   * Sync the active Claude provider env into ~/.claude/settings.json so the
   * daemon and CLI follow the shared provider selection stored in ~/.codemoss/config.json.
   *
   * Safety rules (prevents wiping cc-switch / user CLI credentials):
   * - Never write when no managed provider is active (local / disabled / null).
   * - Never clear managed env keys unless we have a non-empty env payload or CLI-login mode.
   */
  private _syncProviderToDisk(providers: any[]) {
    const active = providers.find((p: any) => p.isActive) ?? null;

    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      const settingsPath = path.join(claudeDir, 'settings.json');
      let settings: any = {};
      try {
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
      } catch { /* start fresh */ }

      const decision = planClaudeSettingsSync(settings, active);
      if (decision.action === 'skip') {
        this._log.appendLine(
          `[bridge] Skip settings.json sync: ${decision.reason}`
          + (active?.id ? ` (active=${active.id})` : ''),
        );
        return;
      }

      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      fs.writeFileSync(settingsPath, JSON.stringify(decision.nextSettings, null, 2));
    } catch (e: any) {
      console.error('[bridge] Failed to write ~/.claude/settings.json:', e.message);
    }
  }
}
