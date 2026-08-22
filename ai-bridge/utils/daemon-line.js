/**
 * Helpers for daemon stdout demux.
 *
 * Fire-and-forget work started inside a request ALS context (e.g. session title
 * generation) may still write structured daemon events after the chat turn ends.
 * Those lines must not be tagged as request `line` payloads or they leak into chat.
 */

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isDaemonEventJsonLine(line) {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed);
    return !!(obj && typeof obj === 'object' && !Array.isArray(obj) && obj.type === 'daemon');
  } catch {
    return false;
  }
}
