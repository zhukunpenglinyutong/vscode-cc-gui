/**
 * Correlation helpers for skill toggle results (vscode-free, unit-testable).
 *
 * Mirrors the JetBrains `SkillHandler.attachToggleCorrelation*`: the webview
 * tracks in-flight toggles by stable skill id + per-request requestId, so the
 * backend must echo both (plus the display name) on every toggle result —
 * success, failure, and even unparseable requests.
 */

export interface SkillToggleCorrelation {
  id?: string;
  requestId?: string;
  name?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Attach id/requestId/name from the request payload to a toggle result. */
export function attachToggleCorrelation<T extends Record<string, unknown>>(
  result: T,
  payload: { id?: unknown; requestId?: unknown; name?: unknown },
): T {
  const id = nonEmptyString(payload?.id);
  const requestId = nonEmptyString(payload?.requestId);
  const name = nonEmptyString(payload?.name);
  if (id) result.id = id;
  if (requestId) result.requestId = requestId;
  if (name) result.name = name;
  return result;
}

/**
 * Best-effort correlation extraction from raw request content, for the path
 * where handling threw before/while parsing. Invalid requests simply cannot be
 * correlated safely.
 */
export function extractToggleCorrelation(content: string): SkillToggleCorrelation {
  try {
    const request = JSON.parse(content);
    return {
      id: nonEmptyString(request?.id),
      requestId: nonEmptyString(request?.requestId),
      name: nonEmptyString(request?.name),
    };
  } catch {
    return {};
  }
}
