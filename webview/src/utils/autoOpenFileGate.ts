/**
 * Module-level gate shared by window bridge callbacks.
 * Callbacks are registered once on mount, so they cannot close over React state;
 * this gate is updated whenever auto-open-file settings change.
 */
let autoOpenFileEnabled = false;

export function setAutoOpenFileGateEnabled(enabled: boolean): void {
  autoOpenFileEnabled = Boolean(enabled);
}

export function isAutoOpenFileGateEnabled(): boolean {
  return autoOpenFileEnabled;
}
