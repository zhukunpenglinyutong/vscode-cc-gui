/**
 * Track in-flight CLI child processes (Grok / Kimi / OpenCode / Pi) so Stop
 * can kill them. Keyed by daemon request id from AsyncLocalStorage.
 */

import { getRequestId } from './request-context.js';

/** @type {Map<string, { kill: () => void, label: string }>} */
const activeCliProcesses = new Map();

/**
 * Register a killable CLI child for the current request context.
 * @param {() => void} killFn
 * @param {string} [label]
 * @returns {() => void} unregister
 */
export function registerCliProcess(killFn, label = 'cli') {
  const id = getRequestId();
  if (!id || typeof killFn !== 'function') {
    return () => {};
  }
  activeCliProcesses.set(id, { kill: killFn, label });
  return () => {
    const entry = activeCliProcesses.get(id);
    if (entry?.kill === killFn) {
      activeCliProcesses.delete(id);
    }
  };
}

/**
 * Abort one or more CLI turns.
 * @param {string[]|undefined|null} targetRequestIds
 *   - `undefined` / `null`: abort all active CLI processes
 *   - array (possibly empty): abort only those request ids
 * @returns {string[]} request ids that were signalled
 */
export function abortCliProcesses(targetRequestIds) {
  const ids = Array.isArray(targetRequestIds)
    ? targetRequestIds.map(String).filter(Boolean)
    : [...activeCliProcesses.keys()];

  const killed = [];
  for (const id of ids) {
    const entry = activeCliProcesses.get(id);
    if (!entry) continue;
    // Drop from map first so close-time unregister is a no-op.
    activeCliProcesses.delete(id);
    try {
      entry.kill();
      killed.push(id);
    } catch (error) {
      console.error(
        `[WARN][cli-abort] Failed to kill ${entry.label} request=${id}:`,
        error?.message || error,
      );
    }
  }
  return killed;
}

/** @returns {string[]} */
export function listActiveCliRequestIds() {
  return [...activeCliProcesses.keys()];
}
