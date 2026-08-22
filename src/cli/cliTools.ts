/**
 * Headless CLI tools shown under Settings → Provider Management → CLI.
 * Detection only — the plugin never auto-installs these binaries.
 */

export type CliToolId = 'grok' | 'kimi' | 'opencode' | 'pi';

export const CLI_ONLY_PROVIDERS = new Set<string>(['grok', 'kimi', 'opencode', 'pi']);

export function isCliOnlyProvider(providerId: string | null | undefined): boolean {
  return !!providerId && CLI_ONLY_PROVIDERS.has(providerId);
}

export function isRuntimeProvider(providerId: string | null | undefined): boolean {
  return providerId === 'claude' || providerId === 'codex' || isCliOnlyProvider(providerId);
}

/** Providers with a first-class local history reader in HistoryService. */
export const HISTORY_SUPPORTED_PROVIDERS = new Set<string>(['claude', 'codex', 'grok']);

/**
 * True when the history panel can list/load sessions for this runtime.
 * Kimi / OpenCode / PI chat works, but they have no local history index yet —
 * they must not fall through to Claude/Codex session stores.
 */
export function hasLocalHistorySupport(providerId: string | null | undefined): boolean {
  return !!providerId && HISTORY_SUPPORTED_PROVIDERS.has(providerId);
}

export interface CliToolStatus {
  id: CliToolId;
  name: string;
  binaryName: string;
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface CliToolDefinition {
  id: CliToolId;
  displayName: string;
  binaryName: string;
  envKeys: string[];
  homeBinDirs: string[];
}

export const CLI_TOOL_DEFINITIONS: CliToolDefinition[] = [
  {
    id: 'grok',
    displayName: 'Grok CLI',
    binaryName: 'grok',
    envKeys: ['GROK_BIN', 'GROK_PATH', 'GROK_CLI_PATH'],
    homeBinDirs: ['.grok/bin', '.local/bin'],
  },
  {
    id: 'kimi',
    displayName: 'Kimi CLI',
    binaryName: 'kimi',
    envKeys: ['KIMI_BIN', 'KIMI_PATH', 'KIMI_CLI_PATH', 'KIMI_CODE_BIN'],
    homeBinDirs: ['.kimi-code/bin', '.kimi/bin', '.moonshot/bin', '.local/bin'],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    binaryName: 'opencode',
    envKeys: ['OPENCODE_BIN', 'OPENCODE_PATH', 'OPENCODE_CLI_PATH'],
    homeBinDirs: ['.opencode/bin', '.local/share/opencode/bin', '.local/bin'],
  },
  {
    id: 'pi',
    displayName: 'PI CLI',
    binaryName: 'pi',
    envKeys: ['PI_BIN', 'PI_PATH', 'PI_CLI_PATH'],
    homeBinDirs: ['.pi/bin', '.local/bin'],
  },
];

export function getCliToolDefinition(id: string): CliToolDefinition | undefined {
  return CLI_TOOL_DEFINITIONS.find((tool) => tool.id === id);
}
