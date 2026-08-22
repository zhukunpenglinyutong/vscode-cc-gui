/**
 * Session registry for active query results.
 * Shared state extracted to avoid circular dependencies between message-sender,
 * message-rewind, and message-service modules.
 */

// Store active query results for rewind operations
// Key: sessionId, Value: { queryResult, createdAt }
const activeQueryResults = new Map();

// Maximum number of sessions to keep in memory
const MAX_SESSIONS = 50;
// Session TTL in milliseconds (30 minutes)
const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * Evict expired sessions and enforce max capacity.
 * Called automatically when adding new sessions.
 */
function evictStaleEntries() {
  const now = Date.now();
  for (const [id, entry] of activeQueryResults) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      activeQueryResults.delete(id);
    }
  }
  // If still over capacity, remove oldest entries
  if (activeQueryResults.size > MAX_SESSIONS) {
    const sortedEntries = [...activeQueryResults.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = sortedEntries.slice(0, activeQueryResults.size - MAX_SESSIONS);
    for (const [id] of toRemove) {
      activeQueryResults.delete(id);
    }
  }
}

/**
 * Get active session IDs for debugging
 * @returns {string[]} Array of active session IDs
 */
export function getActiveSessionIds() {
  return Array.from(activeQueryResults.keys());
}

/**
 * Check if a session has an active query result for rewind operations
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} True if session has active query result
 */
export function hasActiveSession(sessionId) {
  return activeQueryResults.has(sessionId);
}

/**
 * Remove a session from the active query results map
 * Should be called when a session ends to free up memory
 * @param {string} sessionId - Session ID to remove
 */
export function removeSession(sessionId) {
  if (activeQueryResults.has(sessionId)) {
    activeQueryResults.delete(sessionId);
    console.log('[REWIND_DEBUG] Removed session from active queries:', sessionId);
    return true;
  }
  return false;
}

/**
 * Register an active query object for a session (used by persistent daemon runtime).
 * @param {string} sessionId
 * @param {object} queryResult
 */
export function registerActiveQueryResult(sessionId, queryResult) {
  if (!sessionId || !queryResult) return false;
  evictStaleEntries();
  activeQueryResults.set(sessionId, { queryResult, createdAt: Date.now() });
  return true;
}

/**
 * Get the active query result for a session
 * @param {string} sessionId - The session ID
 * @returns {object|undefined} The query result or undefined
 */
export function getActiveQueryResult(sessionId) {
  const entry = activeQueryResults.get(sessionId);
  return entry?.queryResult;
}

/**
 * Set/update the active query result for a session
 * @param {string} sessionId - The session ID
 * @param {object} queryResult - The query result object
 */
export function setActiveQueryResult(sessionId, queryResult) {
  evictStaleEntries();
  activeQueryResults.set(sessionId, { queryResult, createdAt: Date.now() });
}
