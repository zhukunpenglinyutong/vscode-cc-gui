import * as vscode from 'vscode';

export interface BridgeMessage {
  event: string;
  content: string;
  webview: vscode.Webview;
}

export interface BridgeHandler {
  readonly supportedEvents: readonly string[];
  handle(message: BridgeMessage): Promise<boolean> | boolean;
}

export type RuntimeProviderId = 'claude' | 'codex' | 'grok' | 'kimi' | 'opencode' | 'pi';

export interface BridgeCallbacks {
  setActiveProvider(provider: RuntimeProviderId): void;
  setSelectedModel(model: string): void;
  syncProviderToDisk(providers: unknown[]): void;
  playSound(content: string): void;
  sendToBridge(event: string, content: string, webview: vscode.Webview): void;
  sendDaemonRequest(event: string, method: string, params: Record<string, unknown>, webview: vscode.Webview): void;
  pushPermissionModeLive(mode: string): void;
  loadHistoryData(provider: string, webview: vscode.Webview): void;
  deepSearchHistory(provider: string, webview: vscode.Webview): void;
  loadSession(sessionId: string, provider: string | undefined, webview: vscode.Webview): void;
  deleteHistorySession(content: string, webview: vscode.Webview): void;
  deleteHistorySessions(content: string, webview: vscode.Webview): void;
  exportHistorySession(content: string, webview: vscode.Webview): void;
  updateHistoryTitle(content: string, webview: vscode.Webview): void;
  deleteHistoryTitle(content: string, webview: vscode.Webview): void;
  toggleFavoriteSession(content: string, webview: vscode.Webview): void;
  loadSubagentSession(content: string, webview: vscode.Webview): void;
  convertToCliSession(content: string, webview: vscode.Webview): void;
  getUsageStatistics(content: string, webview: vscode.Webview): void;
  writeClipboard(content: string): Promise<void>;
  readClipboard(webview: vscode.Webview): Promise<void>;
  getActiveFile(webview: vscode.Webview): void;
  refreshSlashCommands(webview: vscode.Webview): void;
  listRuntimeContextItems(query?: string): unknown[];
  frontendReady(webview: vscode.Webview): void;
  createNewSession(webview: vscode.Webview): void;
  createNewTab(webview: vscode.Webview): void;
  tabLoadingChanged(content: string): void;
  tabStatusChanged(content: string): void;
  updateStatusBarWidgetEnabled(enabled: boolean): void;
  restartBridgeDaemon(): void;
  getBridgeProcessPid(): number | undefined;
}

export interface BridgeContext {
  readonly extensionContext: vscode.ExtensionContext;
  readonly log: vscode.OutputChannel;
  getWorkspacePath(): string;
  callbacks: BridgeCallbacks;
}
