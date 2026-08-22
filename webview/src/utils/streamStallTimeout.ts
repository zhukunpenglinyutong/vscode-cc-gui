/** Default matches historical STREAM_STALL_TIMEOUT_MS (3 minutes). */
export const DEFAULT_STREAM_STALL_TIMEOUT_SECONDS = 180;
/** Allow 1s for local testing; no practical upper cap for now. */
export const MIN_STREAM_STALL_TIMEOUT_SECONDS = 1;
export const MAX_STREAM_STALL_TIMEOUT_SECONDS = 86400;

/**
 * Normalize stream-stall timeout (seconds) into a supported whole-second range.
 * Invalid values fall back to the default.
 */
export function clampStreamStallTimeoutSeconds(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return DEFAULT_STREAM_STALL_TIMEOUT_SECONDS;
  }

  return Math.max(
    MIN_STREAM_STALL_TIMEOUT_SECONDS,
    Math.min(MAX_STREAM_STALL_TIMEOUT_SECONDS, Math.trunc(parsed)),
  );
}

export function streamStallTimeoutSecondsToMs(seconds: number): number {
  return clampStreamStallTimeoutSeconds(seconds) * 1000;
}
