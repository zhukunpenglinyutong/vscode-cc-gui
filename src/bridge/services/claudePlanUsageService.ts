/**
 * Claude plan-usage snapshot builder + cache (TypeScript port of the JetBrains
 * ClaudePlanUsageService).
 *
 * Feeds the ContextBar plan-usage indicator with a capacity payload
 * (`capacity_pct` + `windows[]`) so the shared PlanUsageIndicator renders it
 * unchanged.
 *
 * Data source on a real Anthropic (OAuth subscription) backend: the SDK emits
 * `rate_limit_event` messages (`rate_limit_info: {status, resetsAt, utilization}`)
 * during turns. The daemon `[MESSAGE]` parser in bridge.ts extracts the
 * `rate_limit_info` and calls `cacheClaudeRateLimitInfo`. The webview polls
 * `get_claude_plan_usage` (~every 120s) and `resolveClaudePlanUsagePayload`
 * returns the freshest cached snapshot.
 *
 * Note: `rate_limit_event` only fires on real Anthropic (OAuth subscription)
 * backends — third-party proxies do not emit it, so the bar stays hidden there.
 */

export interface ClaudeRateLimitInfo {
  status?: unknown;
  resetsAt?: unknown;
  resets_at?: unknown;
  resetAt?: unknown;
  utilization?: unknown;
}

export type ClaudePlanUsagePayload = Record<string, unknown>;

/** Last rate_limit_event snapshot (real Anthropic). Null until the first event arrives. */
let cachedRateLimit: ClaudePlanUsagePayload | null = null;

/**
 * Cache a `rate_limit_event` snapshot from the SDK stream (real Anthropic).
 * Called by the bridge daemon `[MESSAGE]` parser.
 */
export function cacheClaudeRateLimitInfo(rateLimitInfo: ClaudeRateLimitInfo | null | undefined): void {
  if (!rateLimitInfo || typeof rateLimitInfo !== 'object') {
    return;
  }
  try {
    const payload = buildClaudeCapacityPayload(rateLimitInfo);
    if (payload) {
      cachedRateLimit = payload;
    }
  } catch {
    // Malformed rate_limit_info must not break the stream parser.
  }
}

/**
 * Resolve the plan-usage payload for the webview poll. Returns the cached
 * rate_limit snapshot if one is available, otherwise an unavailable marker.
 */
export function resolveClaudePlanUsagePayload(): ClaudePlanUsagePayload {
  if (cachedRateLimit) {
    return { ...cachedRateLimit };
  }
  return claudePlanUsageUnavailable('Claude usage unavailable');
}

/**
 * Build the capacity payload from a single `rate_limit_info` object.
 *
 * `utilization` is a 0–1 fraction on Anthropic subscriptions; values > 1 are
 * treated defensively as already-percent. `resetsAt` is epoch milliseconds.
 */
export function buildClaudeCapacityPayload(
  rateLimitInfo: ClaudeRateLimitInfo,
): ClaudePlanUsagePayload | null {
  const utilization = asNumber(rateLimitInfo, 'utilization');
  if (utilization === null || !Number.isFinite(utilization)) {
    return null;
  }
  const pct = clampClaudePct(utilization <= 1.0 ? utilization * 100.0 : utilization);

  const resetsAtMs = asNumber(rateLimitInfo, 'resetsAt', 'resets_at', 'resetAt');
  const resetAt = resetsAtMs !== null ? new Date(resetsAtMs).toISOString() : null;
  const periodType = resetsAtMs !== null ? claudePeriodTypeFromResetMs(resetsAtMs) : '5h';

  const windowEntry: Record<string, unknown> = {
    id: periodType,
    used_pct: pct,
    period_type: periodType,
  };
  if (resetAt !== null) {
    windowEntry.reset_at = resetAt;
  }

  const out: ClaudePlanUsagePayload = {
    ok: true,
    present: true,
    provider: 'claude',
    source: 'sdk-rate-limit',
    capacity_pct: pct,
    period_type: periodType,
    windows: [windowEntry],
  };
  if (resetAt !== null) {
    out.reset_at = resetAt;
  }
  const status = asString(rateLimitInfo, 'status');
  if (status !== null) {
    out.rate_limit_status = status;
  }
  return out;
}

/** Derive a 5h/7d window label from the reset timestamp's distance from now. */
export function claudePeriodTypeFromResetMs(resetsAtMs: number): string {
  const deltaMs = resetsAtMs - Date.now();
  if (deltaMs <= 6 * 60 * 60 * 1000) {
    return '5h';
  }
  return '7d';
}

export function clampClaudePct(v: number): number {
  if (!Number.isFinite(v)) {
    return 0;
  }
  return Math.max(0, Math.min(100, v));
}

export function claudePlanUsageUnavailable(message: string): ClaudePlanUsagePayload {
  return {
    present: false,
    unavailable: true,
    provider: 'claude',
    message,
  };
}

/** Test-only: drop the cached snapshot between cases. */
export function resetClaudePlanUsageCacheForTests(): void {
  cachedRateLimit = null;
}

function asNumber(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
  }
  return null;
}

function asString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' ? v : null;
}
