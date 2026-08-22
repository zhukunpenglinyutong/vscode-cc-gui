/**
 * Check whether the specified tool has been denied / interrupted.
 *
 * Prefer matching synthetic tool_result (is_error) when present; this Set is a
 * fallback for components that only receive toolId. Reads window each render —
 * callers must re-render when messages change after stream-end cleanup.
 */
export function useIsToolDenied(toolId?: string): boolean {
  return toolId ? window.__deniedToolIds?.has(toolId) ?? false : false;
}
