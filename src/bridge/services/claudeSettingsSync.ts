/**
 * Helpers for syncing Claude provider env into ~/.claude/settings.json.
 * Extracted so the "do not wipe credentials" rules can be unit-tested.
 */

export const CLAUDE_MANAGED_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'API_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CCGUI_CLI_LOGIN_AUTHORIZED',
] as const;

export type ClaudeSettingsSyncDecision =
  | { action: 'skip'; reason: string }
  | { action: 'write'; nextSettings: Record<string, any> };

/**
 * Decide whether / how to mutate settings.json for the active Claude provider.
 * Returns skip when writing would only clear credentials (common with incomplete
 * imports / multi-window races / no active managed provider).
 */
export function planClaudeSettingsSync(
  currentSettings: Record<string, any> | null | undefined,
  active: any | null | undefined,
): ClaudeSettingsSyncDecision {
  if (!active || active.id === '__local_settings_json__' || active.id === '__disabled__') {
    return { action: 'skip', reason: 'no-managed-provider' };
  }

  const isCliLogin = active.id === '__cli_login__';
  const envPayload =
    active?.settingsConfig?.env && typeof active.settingsConfig.env === 'object'
      ? (active.settingsConfig.env as Record<string, unknown>)
      : null;
  const hasEnvPayload = !!envPayload && Object.keys(envPayload).length > 0;

  if (!isCliLogin && !hasEnvPayload) {
    return { action: 'skip', reason: 'empty-env-payload' };
  }

  const settings: Record<string, any> = currentSettings && typeof currentSettings === 'object'
    ? { ...currentSettings, env: { ...(currentSettings.env && typeof currentSettings.env === 'object' ? currentSettings.env : {}) } }
    : { env: {} };

  if (!settings.env || typeof settings.env !== 'object') {
    settings.env = {};
  }

  for (const key of CLAUDE_MANAGED_ENV_KEYS) {
    delete settings.env[key];
  }

  if (isCliLogin) {
    settings.env.CCGUI_CLI_LOGIN_AUTHORIZED = '1';
  } else if (envPayload) {
    Object.assign(settings.env, envPayload);
  }

  return { action: 'write', nextSettings: settings };
}
