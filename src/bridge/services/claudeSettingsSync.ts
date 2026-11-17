/**
 * Helpers for syncing Claude provider config into ~/.claude/settings.json.
 * Extracted so the switch rules can be unit-tested.
 *
 * Only explicit user actions (switch provider / cc-switch import) call this, so it
 * applies the active provider (aligned with the JetBrains plugin's
 * ClaudeSettingsSyncPlan.plan, not its startup-only repair pass):
 * - Plugin-managed env keys are cleared, then the provider env is merged in;
 *   unrelated user env keys (proxies, custom vars) are preserved.
 * - Unmanaged env values the previous provider wrote (e.g. MiniMax's
 *   API_TIMEOUT_MS) leave with it, unless the user changed them by hand.
 * - Top-level non-managed fields (hooks, permissions, custom) are preserved.
 * - Local settings / CLI login / disabled modes never touch settings.json.
 * - A provider with a missing or empty settingsConfig.env payload is skipped
 *   entirely so an incomplete state cannot wipe credentials.
 */

/** Env keys owned by the plugin for a managed provider (mirrors JetBrains CLAUDE_MANAGED_ENV_KEYS). */
export const CLAUDE_MANAGED_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CCGUI_CLI_LOGIN_AUTHORIZED',
] as const;

/**
 * Provider-managed top-level fields copied from settingsConfig. Everything else
 * in settings.json (hooks, permissions, mcpServers, …) is user-owned.
 */
export const CLAUDE_PROVIDER_MANAGED_FIELDS = [
  'model',
  'alwaysThinkingEnabled',
  'ccSwitchProviderId',
  'maxContextLengthTokens',
  'temperature',
  'topP',
  'topK',
] as const;

export type ClaudeSettingsSyncDecision =
  | { action: 'skip'; reason: string }
  | { action: 'write'; nextSettings: Record<string, any> };

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function envOf(provider: any): Record<string, unknown> | null {
  const settingsConfig = isPlainObject(provider?.settingsConfig) ? provider.settingsConfig : null;
  return settingsConfig && isPlainObject(settingsConfig.env) ? settingsConfig.env : null;
}

/**
 * Decide whether / how to write settings.json for the active Claude provider.
 *
 * @param previous the provider named by settings.json's codemossProviderId, if known;
 *                 its unchanged unmanaged env values are removed.
 */
export function planClaudeSettingsSync(
  currentSettings: Record<string, any> | null | undefined,
  active: any | null | undefined,
  previous?: any | null,
): ClaudeSettingsSyncDecision {
  if (
    !active ||
    active.id === '__local_settings_json__' ||
    active.id === '__cli_login__' ||
    active.id === '__disabled__'
  ) {
    return { action: 'skip', reason: 'sync-exempt-mode' };
  }

  const envPayload = envOf(active);
  if (!envPayload || Object.keys(envPayload).length === 0) {
    return { action: 'skip', reason: 'empty-env-payload' };
  }

  const settings: Record<string, any> = isPlainObject(currentSettings) ? { ...currentSettings } : {};
  const env: Record<string, unknown> = isPlainObject(settings.env) ? { ...settings.env } : {};

  for (const key of CLAUDE_MANAGED_ENV_KEYS) {
    delete env[key];
  }

  const previousEnv = envOf(previous);
  if (previousEnv && previous.id && previous.id === settings.codemossProviderId) {
    for (const [key, written] of Object.entries(previousEnv)) {
      if (written !== null && written !== undefined && env[key] === written) {
        delete env[key];
      }
    }
  }

  for (const [key, value] of Object.entries(envPayload)) {
    if (value !== null && value !== undefined) {
      env[key] = value;
    }
  }
  settings.env = env;

  for (const key of CLAUDE_PROVIDER_MANAGED_FIELDS) {
    const value = active.settingsConfig[key];
    if (value !== null && value !== undefined) {
      settings[key] = value;
    }
  }

  if (typeof active.id === 'string' && active.id) {
    settings.codemossProviderId = active.id;
  }

  return { action: 'write', nextSettings: settings };
}
