import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import * as cp from 'child_process';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { ProviderStore } from '../services/ProviderStore';
import { CodexSettingsStore } from '../services/CodexSettingsStore';
import { callWindowFunction, parseJson, postJson } from './helpers';
import { NodeDetector } from '../../nodeDetector';

const CODEX_CLI_LOGIN_PROVIDER_ID = '__codex_cli_login__';

export class ProviderHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_providers',
    'get_current_claude_config',
    'get_active_provider',
    'add_provider',
    'update_provider',
    'delete_provider',
    'switch_provider',
    'sort_providers',
    'open_file_chooser_for_cc_switch',
    'preview_cc_switch_import',
    'save_imported_providers',
    'get_codex_providers',
    'get_current_codex_config',
    'get_active_codex_provider',
    'add_codex_provider',
    'update_codex_provider',
    'delete_codex_provider',
    'switch_codex_provider',
    'sort_codex_providers',
    'revoke_codex_local_config_authorization',
  ] as const;

  private readonly store: ProviderStore;
  private readonly codexSettingsStore = new CodexSettingsStore();

  constructor(private readonly context: BridgeContext) {
    this.store = new ProviderStore(context.extensionContext, {
      syncProviderToDisk: (providers) => context.callbacks.syncProviderToDisk(providers),
    });
  }

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'get_providers':
        postJson(webview, 'providers_updated', this.store.getClaudeProviders());
        return true;

      case 'get_active_provider':
        postJson(webview, 'active_provider_updated', this.store.getActiveClaudeProvider());
        return true;

      case 'get_current_claude_config':
        callWindowFunction(webview, 'updateCurrentClaudeConfig', this.store.getActiveClaudeProvider()?.settingsConfig ?? {});
        return true;

      case 'add_provider': {
        const provider = parseJson<any>(content, {});
        const providers = this.store.getStoredClaudeProviders();
        providers.push(provider);
        await this.store.saveClaudeProviders(providers);
        postJson(webview, 'providers_updated', this.store.getClaudeProviders());
        postJson(webview, 'active_provider_updated', this.store.getActiveClaudeProvider());
        return true;
      }

      case 'update_provider': {
        const { id, updates } = parseJson<any>(content, {});
        const providers = this.store.getStoredClaudeProviders().map((provider: any) =>
          provider.id === id ? { ...provider, ...updates } : provider
        );
        await this.store.saveClaudeProviders(providers);
        postJson(webview, 'providers_updated', this.store.getClaudeProviders());
        postJson(webview, 'active_provider_updated', this.store.getActiveClaudeProvider());
        return true;
      }

      case 'delete_provider': {
        const { id } = parseJson<any>(content, {});
        const providers = this.store.getStoredClaudeProviders().filter((provider: any) => provider.id !== id);
        await this.store.saveClaudeProviders(providers);
        postJson(webview, 'providers_updated', this.store.getClaudeProviders());
        postJson(webview, 'active_provider_updated', this.store.getActiveClaudeProvider());
        return true;
      }

      case 'switch_provider': {
        const { id } = parseJson<any>(content, {});
        const targetId = String(id ?? '').trim();
        // Include builtin pseudo-providers so isActive can target local settings / CLI login.
        // __disabled__ marks every entry inactive; saveClaudeProviders then clears claude.current.
        const providers = this.store.getClaudeProviders().map((provider: any) => ({
          ...provider,
          isActive: targetId === '__disabled__' ? false : provider.id === targetId,
        }));
        await this.store.saveClaudeProviders(providers, true);
        postJson(webview, 'providers_updated', this.store.getClaudeProviders());
        postJson(webview, 'active_provider_updated', this.store.getActiveClaudeProvider());
        return true;
      }

      case 'sort_providers': {
        const { orderedIds } = parseJson<any>(content, {});
        const providers = this.orderByIds(this.store.getStoredClaudeProviders(), orderedIds);
        await this.store.saveClaudeProviders(providers);
        postJson(webview, 'providers_updated', this.store.getClaudeProviders());
        postJson(webview, 'active_provider_updated', this.store.getActiveClaudeProvider());
        return true;
      }

      case 'open_file_chooser_for_cc_switch':
      case 'preview_cc_switch_import':
        await this.openCcSwitchFilePicker(webview);
        return true;

      case 'save_imported_providers': {
        const { providers: imported } = parseJson<{ providers?: unknown }>(content, {});
        if (!Array.isArray(imported) || imported.length === 0) {
          this.postBackendNotification(webview, 'info', '', 'No providers selected');
          return true;
        }

        const merged = this.mergeImportedProviders(this.store.getStoredClaudeProviders(), imported);
        await this.store.saveClaudeProviders(merged, true);
        const providers = this.store.getClaudeProviders();
        postJson(webview, 'providers_updated', providers);
        postJson(webview, 'active_provider_updated', this.store.getActiveClaudeProvider());
        return true;
      }

      case 'get_codex_providers':
        postJson(webview, 'update_codex_providers', this.store.getCodexProviders());
        return true;

      case 'get_active_codex_provider':
        postJson(webview, 'update_active_codex_provider', this.store.getActiveCodexProvider());
        callWindowFunction(webview, 'updateActiveCodexProvider', this.store.getActiveCodexProvider());
        return true;

      case 'get_current_codex_config':
        callWindowFunction(webview, 'updateCurrentCodexConfig', this.codexSettingsStore.getCurrentConfig());
        return true;

      case 'add_codex_provider': {
        const incoming = parseJson<any>(content, {});
        const providers = this.store.getStoredCodexProviders();
        const id = String(incoming.id ?? Date.now().toString()).trim();
        if (!id || id === CODEX_CLI_LOGIN_PROVIDER_ID || providers.some((provider: any) => provider.id === id)) {
          this.postBackendNotification(webview, 'error', 'Invalid Codex provider', 'Provider id is empty, reserved, or already exists.');
          return true;
        }
        const provider = {
          ...incoming,
          id,
          createdAt: incoming.createdAt ?? Date.now(),
        };
        await this.store.saveCodexProviders(providers.concat(provider));
        postJson(webview, 'update_codex_providers', this.store.getCodexProviders());
        callWindowFunction(webview, 'updateActiveCodexProvider', this.store.getActiveCodexProvider());
        callWindowFunction(webview, 'updateCurrentCodexConfig', this.codexSettingsStore.getCurrentConfig());
        return true;
      }

      case 'update_codex_provider': {
        const { id, updates } = parseJson<any>(content, {});
        const existing = this.store.getStoredCodexProviders();
        if (!id || id === CODEX_CLI_LOGIN_PROVIDER_ID || !existing.some((provider: any) => provider.id === id)) {
          this.postBackendNotification(webview, 'error', 'Invalid Codex provider', 'Provider was not found.');
          return true;
        }
        const providers = existing.map((provider: any) =>
          provider.id === id ? { ...provider, ...updates } : provider
        );
        await this.store.saveCodexProviders(providers);
        if (this.store.getCurrentCodexProviderId() === id) {
          this.applyActiveCodexProvider();
        }
        postJson(webview, 'update_codex_providers', this.store.getCodexProviders());
        callWindowFunction(webview, 'updateActiveCodexProvider', this.store.getActiveCodexProvider());
        callWindowFunction(webview, 'updateCurrentCodexConfig', this.codexSettingsStore.getCurrentConfig());
        return true;
      }

      case 'delete_codex_provider': {
        const { id } = parseJson<any>(content, {});
        if (!id || id === CODEX_CLI_LOGIN_PROVIDER_ID) {
          this.postBackendNotification(webview, 'error', 'Invalid Codex provider', 'Cannot delete this provider.');
          return true;
        }
        let providers = this.store.getStoredCodexProviders().filter((provider: any) => provider.id !== id);
        if (this.store.getCurrentCodexProviderId() === id) {
          const fallback = providers[0] ?? null;
          await this.store.setCurrentCodexProviderId(fallback?.id ?? '');
          providers = providers.map((provider: any, index: number) => ({ ...provider, isActive: index === 0 }));
        }
        await this.store.saveCodexProviders(providers);
        this.applyActiveCodexProvider();
        postJson(webview, 'update_codex_providers', this.store.getCodexProviders());
        callWindowFunction(webview, 'updateActiveCodexProvider', this.store.getActiveCodexProvider());
        callWindowFunction(webview, 'updateCurrentCodexConfig', this.codexSettingsStore.getCurrentConfig());
        return true;
      }

      case 'switch_codex_provider': {
        const { id } = parseJson<any>(content, {});
        const targetId = String(id || '').trim();
        if (targetId && targetId !== CODEX_CLI_LOGIN_PROVIDER_ID && !this.store.getStoredCodexProviders().some((provider: any) => provider.id === targetId)) {
          this.postBackendNotification(webview, 'error', 'Invalid Codex provider', 'Provider was not found.');
          return true;
        }
        if (targetId === CODEX_CLI_LOGIN_PROVIDER_ID) {
          await this.store.setCodexLocalConfigAuthorized(true);
        } else {
          await this.store.setCodexLocalConfigAuthorized(false);
          this.codexSettingsStore.restoreCliLoginBackup();
        }
        const providers = this.store.getStoredCodexProviders().map((provider: any) => ({
          ...provider,
          isActive: provider.id === targetId,
        }));
        await this.store.saveCodexProviders(providers);
        await this.store.setCurrentCodexProviderId(targetId);
        this.applyActiveCodexProvider();
        postJson(webview, 'update_codex_providers', this.store.getCodexProviders());
        callWindowFunction(webview, 'updateActiveCodexProvider', this.store.getActiveCodexProvider());
        callWindowFunction(webview, 'updateCurrentCodexConfig', this.codexSettingsStore.getCurrentConfig());
        return true;
      }

      case 'sort_codex_providers': {
        const { orderedIds } = parseJson<any>(content, {});
        const providers = this.orderByIds(this.store.getStoredCodexProviders(), orderedIds);
        await this.store.saveCodexProviders(providers);
        postJson(webview, 'update_codex_providers', this.store.getCodexProviders());
        callWindowFunction(webview, 'updateCurrentCodexConfig', this.codexSettingsStore.getCurrentConfig());
        return true;
      }

      case 'revoke_codex_local_config_authorization': {
        const { fallbackProviderId } = parseJson<any>(content, {});
        const wasCliLoginActive = this.store.getCurrentCodexProviderId() === CODEX_CLI_LOGIN_PROVIDER_ID;
        await this.store.setCodexLocalConfigAuthorized(false);
        this.codexSettingsStore.restoreCliLoginBackup();
        if (wasCliLoginActive) {
          const fallback = this.store.getStoredCodexProviders().find((provider: any) => provider.id === fallbackProviderId)
            ?? this.store.getStoredCodexProviders()[0]
            ?? null;
          await this.store.setCurrentCodexProviderId(fallback?.id ?? '');
          const providers = this.store.getStoredCodexProviders().map((provider: any) => ({
            ...provider,
            isActive: fallback ? provider.id === fallback.id : false,
          }));
          await this.store.saveCodexProviders(providers);
          this.applyActiveCodexProvider();
        }
        postJson(webview, 'update_codex_providers', this.store.getCodexProviders());
        callWindowFunction(webview, 'updateActiveCodexProvider', this.store.getActiveCodexProvider());
        callWindowFunction(webview, 'updateCurrentCodexConfig', this.codexSettingsStore.getCurrentConfig());
        return true;
      }

      default:
        return false;
    }
  }

  private orderByIds(providers: any[], orderedIds: unknown): any[] {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return providers;
    }
    const byId = new Map(providers.map((provider: any) => [provider.id, provider]));
    const ordered: any[] = [];
    for (const id of orderedIds) {
      const provider = byId.get(id);
      if (provider) {
        ordered.push(provider);
        byId.delete(id);
      }
    }
    ordered.push(...Array.from(byId.values()));
    return ordered;
  }

  private async openCcSwitchFilePicker(webview: vscode.Webview): Promise<void> {
    const defaultDbPath = path.join(homedir(), '.cc-switch', 'cc-switch.db');
    if (fs.existsSync(defaultDbPath)) {
      this.previewCcSwitchDb(defaultDbPath, webview);
      return;
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'cc-switch database or JSON': ['db', 'sqlite', 'sqlite3', 'json'],
        'SQLite database': ['db', 'sqlite', 'sqlite3'],
        'JSON': ['json'],
      },
      title: 'Select cc-switch database or config.json',
    });

    if (!uris || uris.length === 0) {
      this.postBackendNotification(webview, 'info', '', 'No file selected');
      return;
    }

    const selectedPath = uris[0].fsPath;
    if (/\.(db|sqlite|sqlite3)$/i.test(selectedPath)) {
      this.previewCcSwitchDb(selectedPath, webview);
      return;
    }

    this.previewCcSwitchJson(selectedPath, webview);
  }

  private previewCcSwitchDb(dbPath: string, webview: vscode.Webview): void {
    try {
      const nodePath = NodeDetector.find(this.context.extensionContext);
      if (!nodePath) {
        throw new Error('Node.js executable was not found. Configure ccGui.nodePath and try again.');
      }

      const scriptPath = path.join(this.context.extensionContext.extensionPath, 'ai-bridge', 'read-cc-switch-db.js');
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`cc-switch import script was not found: ${scriptPath}`);
      }

      const output = cp.execFileSync(nodePath, [scriptPath, dbPath], {
        cwd: path.dirname(scriptPath),
        encoding: 'utf8',
        timeout: 10000,
      });
      const parsed = parseJson<{ success?: boolean; providers?: unknown[]; error?: string }>(output, {});
      if (!parsed.success) {
        throw new Error(parsed.error || 'cc-switch database import failed');
      }

      postJson(webview, 'import_preview_result', { providers: Array.isArray(parsed.providers) ? parsed.providers : [] });
    } catch (error: any) {
      this.postBackendNotification(webview, 'error', 'Import failed', this.errorMessage(error));
    }
  }

  private previewCcSwitchJson(filePath: string, webview: vscode.Webview): void {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const config = parseJson<any>(raw, {});
      const providers = Array.isArray(config.providers)
        ? config.providers
        : Array.isArray(config.configs)
          ? config.configs
          : [];
      postJson(webview, 'import_preview_result', { providers });
    } catch (error: any) {
      this.postBackendNotification(webview, 'error', 'Import failed', this.errorMessage(error));
    }
  }

  private mergeImportedProviders(existingProviders: any[], importedProviders: unknown[]): any[] {
    const merged = [...existingProviders];
    for (const [index, imported] of importedProviders.entries()) {
      const provider = this.normalizeImportedProvider(imported, index);
      if (!provider) {
        continue;
      }

      const existingIndex = merged.findIndex((candidate: any) => candidate.id === provider.id);
      if (existingIndex >= 0) {
        merged[existingIndex] = { ...merged[existingIndex], ...provider };
      } else {
        merged.push(provider);
      }
    }
    return merged;
  }

  private normalizeImportedProvider(provider: unknown, index: number): any | null {
    if (!provider || typeof provider !== 'object') {
      return null;
    }

    const raw = provider as Record<string, any>;
    const id = String(raw.id || raw.name || `cc-switch-${Date.now()}-${index}`).trim();
    if (!id) {
      return null;
    }

    const settingsConfig = this.normalizeSettingsConfig(raw.settingsConfig ?? raw.settings_config ?? {});
    return {
      ...raw,
      id,
      name: String(raw.name || id),
      source: raw.source || 'cc-switch',
      settingsConfig,
    };
  }

  private normalizeSettingsConfig(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
      return parseJson<Record<string, unknown>>(value, {});
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private postBackendNotification(webview: vscode.Webview, type: 'info' | 'success' | 'warning' | 'error', title: string, message: string): void {
    postJson(webview, 'backend_notification', { type, title, message });
  }

  private errorMessage(error: any): string {
    const stderr = typeof error?.stderr === 'string' ? error.stderr : error?.stderr?.toString?.();
    const message = stderr || error?.message || String(error);
    const parsed = parseJson<{ error?: string }>(message.trim(), {});
    return parsed.error || message.trim();
  }

  private applyActiveCodexProvider(): void {
    const active = this.store.getActiveCodexProvider();
    try {
      this.codexSettingsStore.applyProvider(active);
    } catch (error: any) {
      this.context.log.appendLine(`[ProviderHandler] Failed to apply Codex provider: ${error?.message || error}`);
    }
  }
}
