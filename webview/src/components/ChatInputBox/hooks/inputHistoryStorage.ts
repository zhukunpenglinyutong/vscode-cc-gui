/**
 * Pure storage functions for chat input history (localStorage I/O).
 * No React dependency — safe to import from any context.
 */
import { sendToJava } from '../../../utils/bridge.js';

/** localStorage key for chat input history */
export const HISTORY_STORAGE_KEY = 'chat-input-history';
/** localStorage key for history usage counts (importance) */
export const HISTORY_COUNTS_KEY = 'chat-input-history-counts';
/** localStorage key for history timestamps */
export const HISTORY_TIMESTAMPS_KEY = 'chat-input-history-timestamps';
/** localStorage key for history completion enabled setting */
export const HISTORY_ENABLED_KEY = 'historyCompletionEnabled';

/**
 * History item with importance (usage count) and timestamp
 */
export interface HistoryItem {
  /** Content text */
  text: string;
  /** Importance level (usage count, higher = more important) */
  importance: number;
  /** Timestamp when the item was last used (ISO string) */
  timestamp?: string;
}

/**
 * Keep the stored history bounded to avoid unbounded localStorage growth.
 * Note: The actual limit is 200 in the backend (.codemoss)
 */
export const MAX_HISTORY_ITEMS = 200;
export const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * Separator regex for splitting text into fragments
 * Includes: comma, period, semicolon, Chinese punctuation, whitespace, newlines
 */
const SEPARATORS_RE = /[,，.。;；、\s\n\r]+/;

/**
 * Maximum text length to perform fragment splitting
 * Longer texts are stored as-is without splitting
 */
const MAX_SPLIT_LENGTH = 300;

/**
 * Minimum fragment length to be recorded
 * Fragments shorter than this are ignored
 */
const MIN_FRAGMENT_LENGTH = 3;

/**
 * Maximum number of count records to keep in localStorage
 * Prevents unbounded growth
 * Note: Must match backend MAX_COUNT_RECORDS (200) in input-history-service.cjs
 */
const MAX_COUNT_RECORDS = 200;

/**
 * Split text into fragments by separators for fine-grained history matching
 *
 * Rules:
 * - If text length > MAX_SPLIT_LENGTH, return empty array (skip recording entirely)
 * - Split by separators (comma, period, semicolon, whitespace, etc.)
 * - Filter out fragments shorter than MIN_FRAGMENT_LENGTH
 * - Include the original text as well (if >= MIN_FRAGMENT_LENGTH)
 * - Deduplicate fragments
 */
export function splitTextToFragments(text: string): string[] {
  const trimmed = text.trim();

  // Skip recording for long texts (e.g., code snippets)
  if (trimmed.length > MAX_SPLIT_LENGTH) {
    return [];
  }

  // Split by separators
  const rawFragments = trimmed.split(SEPARATORS_RE);

  // Filter and deduplicate
  const result = new Set<string>();

  for (const fragment of rawFragments) {
    const cleaned = fragment.trim();
    if (cleaned.length >= MIN_FRAGMENT_LENGTH) {
      result.add(cleaned);
    }
  }

  // Also include the original text if it's long enough
  if (trimmed.length >= MIN_FRAGMENT_LENGTH) {
    result.add(trimmed);
  }

  return Array.from(result);
}

export function canUseLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

function isQuotaExceededError(err: unknown): boolean {
  const domError = err as { name?: unknown; code?: unknown } | null;
  const name = typeof domError?.name === 'string' ? domError.name : '';
  const code = typeof domError?.code === 'number' ? domError.code : undefined;

  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

/**
 * Load history items from localStorage
 */
export function loadHistory(): string[] {
  if (!canUseLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Load usage counts from localStorage
 */
export function loadCounts(): Record<string, number> {
  if (!canUseLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(HISTORY_COUNTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    // Validate that all values are numbers
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load timestamps from localStorage
 */
export function loadTimestamps(): Record<string, string> {
  if (!canUseLocalStorage()) return {};
  try {
    const raw = window.localStorage.getItem(HISTORY_TIMESTAMPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    // Validate that all values are strings
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveHistory(items: string[]): string[] {
  if (!canUseLocalStorage()) return items;

  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
    return items;
  } catch (err) {
    // If quota exceeded, drop older entries and retry, keeping the most recent.
    if (isQuotaExceededError(err)) {
      for (let startIndex = 1; startIndex < items.length; startIndex++) {
        try {
          const subset = items.slice(startIndex);
          window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(subset));
          return subset;
        } catch (retryErr) {
          if (!isQuotaExceededError(retryErr)) {
            return items;
          }
        }
      }

      // If even a single item cannot be stored, keep in-memory history only.
      return items;
    }

    return items;
  }
}

/**
 * Save timestamps for history items (batch operation)
 * @param texts Array of text items to update timestamps for
 */
export function saveTimestamps(texts: string[]): void {
  if (!canUseLocalStorage() || texts.length === 0) return;
  try {
    const timestamps = loadTimestamps();
    const now = new Date().toISOString();
    for (const text of texts) {
      timestamps[text] = now;
    }
    // Keep only MAX_COUNT_RECORDS timestamps
    const entries = Object.entries(timestamps);
    if (entries.length > MAX_COUNT_RECORDS) {
      // Sort by timestamp descending and keep the most recent
      entries.sort((a, b) => b[1].localeCompare(a[1]));
      const kept = entries.slice(0, MAX_COUNT_RECORDS);
      window.localStorage.setItem(HISTORY_TIMESTAMPS_KEY, JSON.stringify(Object.fromEntries(kept)));
    } else {
      window.localStorage.setItem(HISTORY_TIMESTAMPS_KEY, JSON.stringify(timestamps));
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Check if history completion is enabled
 */
export function isHistoryCompletionEnabled(): boolean {
  if (!canUseLocalStorage()) return true;
  try {
    const value = window.localStorage.getItem(HISTORY_ENABLED_KEY);
    return value !== 'false'; // Default to enabled
  } catch {
    return true;
  }
}

/**
 * Clean up counts to keep only the most frequently used records
 */
export function cleanupCounts(
  counts: Record<string, number>,
  timestamps?: Record<string, string>
): Record<string, number> {
  const entries = Object.entries(counts);
  if (entries.length <= MAX_COUNT_RECORDS) return counts;

  // Sort by count descending, keep top MAX_COUNT_RECORDS
  entries.sort((a, b) => b[1] - a[1]);
  const kept = entries.slice(0, MAX_COUNT_RECORDS);
  const keptKeys = new Set(kept.map(([key]) => key));

  // Sync timestamps: remove entries not in kept counts
  if (timestamps) {
    for (const key of Object.keys(timestamps)) {
      if (!keptKeys.has(key)) {
        delete timestamps[key];
      }
    }
  }

  return Object.fromEntries(kept);
}

// ============================================================================
// History Management APIs (for Settings page)
// ============================================================================

/**
 * Delete a specific history item
 * Dual-write: localStorage + .codemoss
 */
export function deleteHistoryItem(item: string): void {
  // Write to localStorage (sync)
  if (canUseLocalStorage()) {
    try {
      const items = loadHistory();
      const filtered = items.filter((i) => i !== item);
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(filtered));

      // Also remove from counts
      const counts = loadCounts();
      delete counts[item];
      window.localStorage.setItem(HISTORY_COUNTS_KEY, JSON.stringify(counts));

      // Also remove from timestamps
      const timestamps = loadTimestamps();
      delete timestamps[item];
      window.localStorage.setItem(HISTORY_TIMESTAMPS_KEY, JSON.stringify(timestamps));
    } catch {
      // Ignore errors
    }
  }

  // Also sync to .codemoss (async)
  sendToJava('delete_input_history_item', item);
}

/**
 * Clear all history items
 * Dual-write: localStorage + .codemoss
 */
export function clearAllHistory(): void {
  // Write to localStorage (sync)
  if (canUseLocalStorage()) {
    try {
      window.localStorage.removeItem(HISTORY_STORAGE_KEY);
      window.localStorage.removeItem(HISTORY_COUNTS_KEY);
      window.localStorage.removeItem(HISTORY_TIMESTAMPS_KEY);
    } catch {
      // Ignore errors
    }
  }

  // Also sync to .codemoss (async)
  sendToJava('clear_input_history', {});
}

/**
 * Load history items with their importance (usage count) and timestamp
 * Returns items sorted by importance (descending)
 */
export function loadHistoryWithImportance(): HistoryItem[] {
  const items = loadHistory();
  const counts = loadCounts();
  const timestamps = loadTimestamps();

  // Merge items with their counts and timestamps, default importance is 1
  const result: HistoryItem[] = items.map((text) => ({
    text,
    importance: counts[text] || 1,
    timestamp: timestamps[text],
  }));

  // Sort by importance descending
  result.sort((a, b) => b.importance - a.importance);

  return result;
}

/**
 * Add a new history item manually
 * @param text Content text
 * @param importance Initial importance (default: 1)
 */
export function addHistoryItem(text: string, importance: number = 1): void {
  const sanitized = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!sanitized) return;

  if (!canUseLocalStorage()) return;

  try {
    // Add to history list
    const items = loadHistory();
    // Remove if already exists (to avoid duplicates)
    const filtered = items.filter((i) => i !== sanitized);
    const newItems = [...filtered, sanitized].slice(-MAX_HISTORY_ITEMS);
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(newItems));

    // Set importance
    const counts = loadCounts();
    const timestamps = loadTimestamps();
    counts[sanitized] = Math.max(1, Math.floor(importance));
    const cleaned = cleanupCounts(counts, timestamps);
    window.localStorage.setItem(HISTORY_COUNTS_KEY, JSON.stringify(cleaned));
    window.localStorage.setItem(HISTORY_TIMESTAMPS_KEY, JSON.stringify(timestamps));

    // Save timestamp
    saveTimestamps([sanitized]);
  } catch {
    // Ignore errors
  }

  // Sync to backend
  sendToJava('record_input_history', JSON.stringify([sanitized]));
}

/**
 * Update an existing history item's content and/or importance
 * @param oldText Original content
 * @param newText New content (if different from oldText)
 * @param importance New importance value
 */
export function updateHistoryItem(
  oldText: string,
  newText: string,
  importance: number
): void {
  if (!canUseLocalStorage()) return;

  const sanitizedNew = newText.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!sanitizedNew) return;

  try {
    const items = loadHistory();
    const counts = loadCounts();
    const timestamps = loadTimestamps();

    // Find and update the item
    const index = items.indexOf(oldText);
    if (index === -1) {
      // Item not found, add as new
      addHistoryItem(sanitizedNew, importance);
      return;
    }

    // Update content if changed
    if (oldText !== sanitizedNew) {
      // Check if new text already exists
      const existingIndex = items.indexOf(sanitizedNew);
      if (existingIndex !== -1 && existingIndex !== index) {
        // Merge: remove old, update existing with higher importance
        items.splice(index, 1);
        delete counts[oldText];
        delete timestamps[oldText];
        counts[sanitizedNew] = Math.max(
          counts[sanitizedNew] || 1,
          Math.max(1, Math.floor(importance))
        );
      } else {
        // Update in place
        items[index] = sanitizedNew;
        delete counts[oldText];
        // Transfer timestamp from old to new
        if (timestamps[oldText]) {
          timestamps[sanitizedNew] = timestamps[oldText];
          delete timestamps[oldText];
        }
        counts[sanitizedNew] = Math.max(1, Math.floor(importance));
      }
    } else {
      // Only update importance
      counts[oldText] = Math.max(1, Math.floor(importance));
    }

    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
    const cleaned = cleanupCounts(counts, timestamps);
    window.localStorage.setItem(HISTORY_COUNTS_KEY, JSON.stringify(cleaned));
    window.localStorage.setItem(HISTORY_TIMESTAMPS_KEY, JSON.stringify(timestamps));
  } catch {
    // Ignore errors
  }

  // Sync deletion of old item and addition of new
  if (oldText !== sanitizedNew) {
    sendToJava('delete_input_history_item', oldText);
    sendToJava('record_input_history', JSON.stringify([sanitizedNew]));
  }
}

/**
 * Clear history items with low importance (importance <= threshold)
 * @param threshold Items with importance <= this value will be deleted (default: 1)
 * @returns Number of items deleted
 */
export function clearLowImportanceHistory(threshold: number = 1): number {
  if (!canUseLocalStorage()) return 0;

  try {
    const items = loadHistory();
    const counts = loadCounts();
    const timestamps = loadTimestamps();

    let deletedCount = 0;
    const itemsToKeep: string[] = [];
    const itemsToDelete: string[] = [];

    for (const item of items) {
      const importance = counts[item] || 1;
      if (importance <= threshold) {
        itemsToDelete.push(item);
        delete counts[item];
        delete timestamps[item];
        deletedCount++;
      } else {
        itemsToKeep.push(item);
      }
    }

    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(itemsToKeep));
    window.localStorage.setItem(HISTORY_COUNTS_KEY, JSON.stringify(counts));
    window.localStorage.setItem(HISTORY_TIMESTAMPS_KEY, JSON.stringify(timestamps));

    // Sync deletions to backend
    for (const item of itemsToDelete) {
      sendToJava('delete_input_history_item', item);
    }

    return deletedCount;
  } catch {
    return 0;
  }
}
