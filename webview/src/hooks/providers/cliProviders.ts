import type { PermissionMode } from '../../components/ChatInputBox/types';

/** Headless CLI providers that share Grok-style marker streaming (no npm SDK). */
export const CLI_ONLY_PROVIDERS = new Set(['grok', 'kimi', 'opencode', 'pi']);

export function isCliOnlyProvider(providerId: string | null | undefined): boolean {
  return !!providerId && CLI_ONLY_PROVIDERS.has(providerId);
}

/** Plan mode is not exposed for CLI providers (always-approve / auto permission). */
export function normalizeCliPermissionMode(mode: PermissionMode): PermissionMode {
  return mode === 'plan' ? 'default' : mode;
}
