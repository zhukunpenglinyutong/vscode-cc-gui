import * as fs from 'fs';
import type * as vscode from 'vscode';
import { codemossConfigPath, readCodemossConfigFile, writeCodemossConfigFile } from './codemossJsonStore.ts';

const SHARED_CONFIG_VERSION = 2;

const CLAUDE_PROVIDERS_KEY = 'ccg.providers';
const CODEX_PROVIDERS_KEY = 'ccg.codex_providers';
const CODEX_LOCAL_CONFIG_AUTHORIZED_KEY = 'ccg.codex_local_config_authorized';
const CODEX_CURRENT_PROVIDER_KEY = 'ccg.codex_current_provider_id';

const CLAUDE_LOCAL_SETTINGS_PROVIDER_ID = '__local_settings_json__';
const CLAUDE_CLI_LOGIN_PROVIDER_ID = '__cli_login__';
const CODEX_CLI_LOGIN_PROVIDER_ID = '__codex_cli_login__';

export interface ProviderStoreCallbacks {
  syncProviderToDisk(providers: unknown[]): void;
}

interface SharedProviderSection {
  current: string;
  providers: Record<string, any>;
  providerOrder?: string[];
  localConfigAuthorized?: boolean;
}

interface SharedConfigFile {
  version: number;
  claude: SharedProviderSection;
  codex: SharedProviderSection;
  [key: string]: any;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneProvider(provider: any): any {
  if (!isObject(provider)) {
    return provider;
  }
  return JSON.parse(JSON.stringify(provider));
}

function getOrderedIds(section: SharedProviderSection): string[] {
  const providerIds = Object.keys(section.providers);
  const savedOrder = Array.isArray(section.providerOrder)
    ? section.providerOrder.filter((id): id is string => typeof id === 'string' && providerIds.includes(id))
    : [];

  for (const id of providerIds) {
    if (!savedOrder.includes(id)) {
      savedOrder.push(id);
    }
  }

  return savedOrder;
}

function toProviderList(section: SharedProviderSection, currentId: string): any[] {
  return getOrderedIds(section).map((id) => ({
    ...cloneProvider(section.providers[id]),
    id,
    isActive: id === currentId,
  }));
}

function sanitizeStoredProvider(provider: any): any {
  const sanitized = { ...cloneProvider(provider) };
  delete sanitized.isActive;
  delete sanitized.isBuiltin;
  delete sanitized.isLocalProvider;
  delete sanitized.isCliLoginProvider;
  delete sanitized.isCodexCliLoginProvider;
  return sanitized;
}

export class ProviderStore {
  private readonly context: vscode.ExtensionContext;
  private readonly callbacks: ProviderStoreCallbacks;

  constructor(context: vscode.ExtensionContext, callbacks: ProviderStoreCallbacks) {
    this.context = context;
    this.callbacks = callbacks;
  }

  getClaudeProviders(): any[] {
    const config = this.readSharedConfig();
    const section = config.claude;
    const currentId = this.normalizeClaudeCurrent(section, config);
    return [
      {
        id: CLAUDE_LOCAL_SETTINGS_PROVIDER_ID,
        name: 'Local Settings (settings.json)',
        isActive: currentId === CLAUDE_LOCAL_SETTINGS_PROVIDER_ID,
        isBuiltin: true,
        isLocalProvider: true,
      },
      {
        id: CLAUDE_CLI_LOGIN_PROVIDER_ID,
        name: 'CLI Login',
        isActive: currentId === CLAUDE_CLI_LOGIN_PROVIDER_ID,
        isBuiltin: true,
        isCliLoginProvider: true,
      },
      ...toProviderList(section, currentId),
    ];
  }

  getStoredClaudeProviders(): any[] {
    const config = this.readSharedConfig();
    const currentId = this.normalizeClaudeCurrent(config.claude, config);
    return toProviderList(config.claude, currentId);
  }

  saveClaudeProviders(providers: any[], syncToDisk = false): Thenable<void> {
    const config = this.readSharedConfig();
    const section = config.claude;
    const regularProviders = providers
      .filter((provider: any) => provider?.id !== CLAUDE_LOCAL_SETTINGS_PROVIDER_ID && provider?.id !== CLAUDE_CLI_LOGIN_PROVIDER_ID)
      .filter((provider: any) => typeof provider?.id === 'string' && provider.id.trim().length > 0);

    const nextProviders: Record<string, any> = {};
    const orderedIds: string[] = [];
    for (const provider of regularProviders) {
      const id = String(provider.id).trim();
      if (!id || orderedIds.includes(id)) {
        continue;
      }
      orderedIds.push(id);
      nextProviders[id] = sanitizeStoredProvider({ ...provider, id });
    }

    // Prefer the provider marked isActive. When every provider is inactive
    // (switch_provider { id: '__disabled__' } / revoke local settings auth),
    // clear current — do NOT fall back to the previous section.current, or the
    // revoke button appears to do nothing.
    const hasActive = providers.some((provider: any) => provider?.isActive === true);
    const requestedCurrentId = providers.find((provider: any) => provider?.isActive)?.id;
    let currentId: string;
    if (!hasActive) {
      currentId = '';
    } else if (typeof requestedCurrentId === 'string') {
      currentId = requestedCurrentId;
    } else {
      currentId = typeof section.current === 'string' ? section.current : '';
    }
    if (
      currentId &&
      currentId !== CLAUDE_LOCAL_SETTINGS_PROVIDER_ID &&
      currentId !== CLAUDE_CLI_LOGIN_PROVIDER_ID &&
      !nextProviders[currentId]
    ) {
      currentId = orderedIds[0] ?? '';
    }

    section.providers = nextProviders;
    section.providerOrder = orderedIds;
    section.current = currentId;
    this.writeSharedConfig(config);
    if (syncToDisk) {
      this.callbacks.syncProviderToDisk(this.getClaudeProviders());
    }
    return Promise.resolve();
  }

  getActiveClaudeProvider(): any | null {
    return this.getClaudeProviders().find((provider: any) => provider.isActive) ?? null;
  }

  getCodexProviders(): any[] {
    const config = this.readSharedConfig();
    const section = config.codex;
    const currentId = this.getCurrentCodexProviderIdFromSection(section);
    return [
      {
        id: CODEX_CLI_LOGIN_PROVIDER_ID,
        name: 'Codex CLI Login',
        isActive: currentId === CODEX_CLI_LOGIN_PROVIDER_ID && this.isCodexLocalConfigAuthorizedFromSection(section),
        isCodexCliLoginProvider: true,
      },
      ...toProviderList(section, currentId),
    ];
  }

  getStoredCodexProviders(): any[] {
    const config = this.readSharedConfig();
    return toProviderList(config.codex, this.getCurrentCodexProviderIdFromSection(config.codex));
  }

  saveCodexProviders(providers: any[]): Thenable<void> {
    const config = this.readSharedConfig();
    const section = config.codex;
    const regularProviders = providers
      .filter((provider: any) => provider?.id !== CODEX_CLI_LOGIN_PROVIDER_ID)
      .filter((provider: any) => typeof provider?.id === 'string' && provider.id.trim().length > 0);

    const nextProviders: Record<string, any> = {};
    const orderedIds: string[] = [];
    for (const provider of regularProviders) {
      const id = String(provider.id).trim();
      if (!id || orderedIds.includes(id)) {
        continue;
      }
      orderedIds.push(id);
      nextProviders[id] = sanitizeStoredProvider({ ...provider, id });
    }

    const requestedCurrentId = providers.find((provider: any) => provider?.isActive)?.id;
    let currentId = typeof requestedCurrentId === 'string' ? requestedCurrentId : section.current;
    if (typeof currentId !== 'string') {
      currentId = '';
    }
    if (currentId && currentId !== CODEX_CLI_LOGIN_PROVIDER_ID && !nextProviders[currentId]) {
      currentId = orderedIds[0] ?? '';
    }

    section.providers = nextProviders;
    section.providerOrder = orderedIds;
    section.current = currentId;
    this.writeSharedConfig(config);
    return Promise.resolve();
  }

  getActiveCodexProvider(): any | null {
    return this.getCodexProviders().find((provider: any) => provider.isActive) ?? null;
  }

  isCodexLocalConfigAuthorized(): boolean {
    return this.isCodexLocalConfigAuthorizedFromSection(this.readSharedConfig().codex);
  }

  async setCodexLocalConfigAuthorized(authorized: boolean): Promise<void> {
    const config = this.readSharedConfig();
    config.codex.localConfigAuthorized = authorized;
    this.writeSharedConfig(config);
  }

  getCurrentCodexProviderId(): string {
    return this.getCurrentCodexProviderIdFromSection(this.readSharedConfig().codex);
  }

  async setCurrentCodexProviderId(id: string): Promise<void> {
    const config = this.readSharedConfig();
    config.codex.current = typeof id === 'string' ? id : '';
    this.writeSharedConfig(config);
  }

  private configFilePath(): string {
    return codemossConfigPath('config.json');
  }

  private defaultConfig(): SharedConfigFile {
    return {
      version: SHARED_CONFIG_VERSION,
      claude: {
        current: '',
        providers: {},
      },
      codex: {
        current: '',
        providers: {},
        localConfigAuthorized: false,
      },
    };
  }

  private readSharedConfig(): SharedConfigFile {
    const filePath = this.configFilePath();
    const parsed = readCodemossConfigFile<Record<string, any>>(filePath, {});
    const config = isObject(parsed) ? parsed as SharedConfigFile : this.defaultConfig();
    const fileMissing = !fs.existsSync(filePath);

    if (!Number.isInteger(config.version)) {
      config.version = SHARED_CONFIG_VERSION;
    }

    this.ensureSectionShape(config, 'claude');
    this.ensureSectionShape(config, 'codex', true);
    this.migrateLegacyClaudeIfNeeded(config, fileMissing);
    this.migrateLegacyCodexIfNeeded(config, fileMissing);

    return config;
  }

  private writeSharedConfig(config: SharedConfigFile): void {
    writeCodemossConfigFile(this.configFilePath(), config);
  }

  private ensureSectionShape(config: SharedConfigFile, sectionKey: 'claude' | 'codex', withLocalAuth = false): boolean {
    const section = isObject(config[sectionKey]) ? config[sectionKey] as SharedProviderSection : {} as SharedProviderSection;
    if (!isObject(config[sectionKey])) {
      config[sectionKey] = section;
    }

    if (typeof section.current !== 'string') {
      section.current = '';
    }
    if (!isObject(section.providers)) {
      section.providers = {};
    }
    if (section.providerOrder !== undefined && !Array.isArray(section.providerOrder)) {
      delete section.providerOrder;
    }
    if (withLocalAuth && typeof section.localConfigAuthorized !== 'boolean') {
      section.localConfigAuthorized = false;
    }

    return true;
  }

  private migrateLegacyClaudeIfNeeded(config: SharedConfigFile, fileMissing: boolean): boolean {
    const section = config.claude;
    const hasSharedData =
      Object.keys(section.providers).length > 0 ||
      section.current === CLAUDE_LOCAL_SETTINGS_PROVIDER_ID ||
      section.current === CLAUDE_CLI_LOGIN_PROVIDER_ID ||
      !!section.current ||
      Array.isArray(section.providerOrder);

    if (hasSharedData && !fileMissing) {
      return false;
    }

    const legacyProviders = (this.context.globalState.get<any[]>(CLAUDE_PROVIDERS_KEY) ?? [])
      .filter((provider: any) => provider?.id !== CLAUDE_LOCAL_SETTINGS_PROVIDER_ID && provider?.id !== CLAUDE_CLI_LOGIN_PROVIDER_ID)
      .filter((provider: any) => typeof provider?.id === 'string' && provider.id.trim().length > 0);
    const legacyCurrentId = (this.context.globalState.get<any[]>(CLAUDE_PROVIDERS_KEY) ?? []).find((provider: any) => provider?.isActive)?.id ?? '';

    if (legacyProviders.length === 0 && !legacyCurrentId) {
      return false;
    }

    section.providers = {};
    section.providerOrder = [];
    for (const provider of legacyProviders) {
      const id = String(provider.id).trim();
      if (!id || section.providerOrder.includes(id)) {
        continue;
      }
      section.providerOrder.push(id);
      section.providers[id] = sanitizeStoredProvider({ ...provider, id });
    }
    section.current = typeof legacyCurrentId === 'string' ? legacyCurrentId : '';
    return true;
  }

  private migrateLegacyCodexIfNeeded(config: SharedConfigFile, fileMissing: boolean): boolean {
    const section = config.codex;
    const hasSharedData =
      Object.keys(section.providers).length > 0 ||
      !!section.current ||
      section.localConfigAuthorized === true ||
      Array.isArray(section.providerOrder);

    if (hasSharedData && !fileMissing) {
      return false;
    }

    const rawLegacyProviders = this.context.globalState.get<any[]>(CODEX_PROVIDERS_KEY) ?? [];
    const legacyProviders = rawLegacyProviders
      .filter((provider: any) => provider?.id !== CODEX_CLI_LOGIN_PROVIDER_ID)
      .filter((provider: any) => typeof provider?.id === 'string' && provider.id.trim().length > 0);
    const legacyCurrentId = this.context.globalState.get<string>(CODEX_CURRENT_PROVIDER_KEY)
      || rawLegacyProviders.find((provider: any) => provider?.isActive)?.id
      || '';
    const legacyAuthorized = this.context.globalState.get<boolean>(CODEX_LOCAL_CONFIG_AUTHORIZED_KEY)
      ?? rawLegacyProviders.some((provider: any) => provider?.id === CODEX_CLI_LOGIN_PROVIDER_ID && provider?.isActive)
      ?? false;

    if (legacyProviders.length === 0 && !legacyCurrentId && !legacyAuthorized) {
      return false;
    }

    section.providers = {};
    section.providerOrder = [];
    for (const provider of legacyProviders) {
      const id = String(provider.id).trim();
      if (!id || section.providerOrder.includes(id)) {
        continue;
      }
      section.providerOrder.push(id);
      section.providers[id] = sanitizeStoredProvider({ ...provider, id });
    }
    section.current = typeof legacyCurrentId === 'string' ? legacyCurrentId : '';
    section.localConfigAuthorized = legacyAuthorized;
    return true;
  }

  private normalizeClaudeCurrent(section: SharedProviderSection, config: SharedConfigFile): string {
    const currentId = typeof section.current === 'string' ? section.current : '';
    if (
      currentId === '' ||
      currentId === CLAUDE_LOCAL_SETTINGS_PROVIDER_ID ||
      currentId === CLAUDE_CLI_LOGIN_PROVIDER_ID ||
      section.providers[currentId]
    ) {
      return currentId;
    }

    const fallback = getOrderedIds(section)[0] ?? '';
    section.current = fallback;
    return fallback;
  }

  private getCurrentCodexProviderIdFromSection(section: SharedProviderSection): string {
    const currentId = typeof section.current === 'string' ? section.current : '';
    if (currentId === CODEX_CLI_LOGIN_PROVIDER_ID) {
      return currentId;
    }
    if (currentId && !section.providers[currentId]) {
      return '';
    }
    return currentId;
  }

  private isCodexLocalConfigAuthorizedFromSection(section: SharedProviderSection): boolean {
    return section.localConfigAuthorized === true;
  }
}
