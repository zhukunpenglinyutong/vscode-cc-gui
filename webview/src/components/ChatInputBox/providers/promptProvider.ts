import type { DropdownItemData } from '../types';
import type { PromptConfig, PromptScope, GetPromptsMessage } from '../../../types/prompt';
import { sendBridgeEvent } from '../../../utils/bridge';
import i18n from '../../../i18n/config';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

// ============================================================================
// Type Definitions
// ============================================================================

export interface PromptItem {
  id: string;
  name: string;
  content: string;
  scope?: PromptScope; // Add scope to track source
}

// ============================================================================
// State Management
// ============================================================================

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

let cachedGlobalPrompts: PromptItem[] = [];
let cachedProjectPrompts: PromptItem[] = [];
let globalLoadingState: LoadingState = 'idle';
let projectLoadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 1500; // Reduced to 1.5s for faster timeout feedback
const MAX_RETRY_COUNT = 1; // Max 1 retry to avoid long waits
const MAX_PENDING_WAITERS = 10; // Maximum concurrent waiters

// ============================================================================
// Core Functions
// ============================================================================

export function resetPromptsState() {
  cachedGlobalPrompts = [];
  cachedProjectPrompts = [];
  globalLoadingState = 'idle';
  projectLoadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('Prompts state reset')));
  pendingWaiters = [];
  debugLog('[PromptProvider] State reset');
}

export function setupPromptsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updateGlobalPrompts && window.updateProjectPrompts) return;

  const globalHandler = (json: string) => {
    debugLog('[PromptProvider] Received global prompts from backend, length=' + json.length);

    try {
      const parsed = JSON.parse(json);
      let prompts: PromptItem[] = [];

      if (Array.isArray(parsed)) {
        prompts = parsed.map((prompt: PromptConfig) => ({
          id: prompt.id,
          name: prompt.name,
          content: prompt.content,
          scope: 'global' as PromptScope,
        }));
      }

      cachedGlobalPrompts = prompts;
      globalLoadingState = 'success';
      retryCount = 0; // Reset retry count on success
      pendingWaiters.forEach(w => w.resolve());
      pendingWaiters = [];
      debugLog('[PromptProvider] Successfully loaded ' + prompts.length + ' global prompts');
    } catch (error) {
      globalLoadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[PromptProvider] Failed to parse global prompts:', error);
    }
  };

  const projectHandler = (json: string) => {
    debugLog('[PromptProvider] Received project prompts from backend, length=' + json.length);

    try {
      const parsed = JSON.parse(json);
      let prompts: PromptItem[] = [];

      if (Array.isArray(parsed)) {
        prompts = parsed.map((prompt: PromptConfig) => ({
          id: prompt.id,
          name: prompt.name,
          content: prompt.content,
          scope: 'project' as PromptScope,
        }));
      }

      cachedProjectPrompts = prompts;
      projectLoadingState = 'success';
      retryCount = 0; // Reset retry count on success
      pendingWaiters.forEach(w => w.resolve());
      pendingWaiters = [];
      debugLog('[PromptProvider] Successfully loaded ' + prompts.length + ' project prompts');
    } catch (error) {
      projectLoadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[PromptProvider] Failed to parse project prompts:', error);
    }
  };

  // Save original callbacks
  const originalGlobalHandler = window.updateGlobalPrompts;
  const originalProjectHandler = window.updateProjectPrompts;

  window.updateGlobalPrompts = (json: string) => {
    // Call our handler
    globalHandler(json);
    // Also call original handler (if exists)
    originalGlobalHandler?.(json);
  };

  window.updateProjectPrompts = (json: string) => {
    // Call our handler
    projectHandler(json);
    // Also call original handler (if exists)
    originalProjectHandler?.(json);
  };

  callbackRegistered = true;
  debugLog('[PromptProvider] Callbacks registered');
}

function waitForPrompts(signal: AbortSignal, timeoutMs: number): Promise<void> {
  // Consider success if either scope has loaded successfully
  if (globalLoadingState === 'success' || projectLoadingState === 'success') {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const waiter = { resolve: () => {}, reject: (_error: unknown) => {} } as {
      resolve: () => void;
      reject: (error: unknown) => void;
    };

    const cleanup = () => {
      pendingWaiters = pendingWaiters.filter(w => w !== waiter);
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Prompts loading timeout'));
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });

    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    waiter.reject = (error: unknown) => {
      cleanup();
      reject(error);
    };

    // Evict oldest waiters if limit exceeded
    if (pendingWaiters.length >= MAX_PENDING_WAITERS) {
      const evicted = pendingWaiters.splice(0, pendingWaiters.length - MAX_PENDING_WAITERS + 1);
      evicted.forEach(w => w.reject(new Error('Too many pending waiters')));
    }

    pendingWaiters.push(waiter);
  });
}

function requestRefresh(force = false): boolean {
  const now = Date.now();

  if (!force && now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
    debugLog('[PromptProvider] Skipping refresh (too soon)');
    return false;
  }

  if (!force && retryCount >= MAX_RETRY_COUNT) {
    debugWarn('[PromptProvider] Max retry count reached, giving up');
    globalLoadingState = 'failed';
    projectLoadingState = 'failed';
    return false;
  }

  const attempt = force ? 0 : retryCount + 1;

  // Request both global and project prompts
  const globalMessage: GetPromptsMessage = { scope: 'global' };
  const projectMessage: GetPromptsMessage = { scope: 'project' };

  const globalSent = sendBridgeEvent('get_prompts', JSON.stringify(globalMessage));
  const projectSent = sendBridgeEvent('get_prompts', JSON.stringify(projectMessage));

  if (!globalSent && !projectSent) {
    debugLog('[PromptProvider] Bridge not available yet, refresh not sent');
    return false;
  }

  lastRefreshTime = now;
  globalLoadingState = 'loading';
  projectLoadingState = 'loading';
  retryCount = attempt;

  debugLog('[PromptProvider] Requesting refresh from backend (force=' + force + ', attempt=' + retryCount + '/' + MAX_RETRY_COUNT + ')');
  return true;
}

function filterPrompts(prompts: PromptItem[], query: string): PromptItem[] {
  if (!query) return prompts;

  const lowerQuery = query.toLowerCase();
  return prompts.filter(prompt =>
    prompt.name.toLowerCase().includes(lowerQuery) ||
    prompt.content.toLowerCase().includes(lowerQuery)
  );
}

export const CREATE_NEW_PROMPT_ID = '__create_new__';
export const EMPTY_STATE_ID = '__empty_state__';

export async function promptProvider(
  query: string,
  signal: AbortSignal
): Promise<PromptItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupPromptsCallback();

  const now = Date.now();

  // Create prompt item
  const createNewPromptItem: PromptItem = {
    id: CREATE_NEW_PROMPT_ID,
    name: i18n.t('settings.prompt.createPrompt'),
    content: '',
  };

  // Combine prompts from both scopes (project prompts first)
  const allPrompts = [...cachedProjectPrompts, ...cachedGlobalPrompts];

  // If cached data exists, use cache directly
  if ((globalLoadingState === 'success' || projectLoadingState === 'success') && allPrompts.length > 0) {
    const filtered = filterPrompts(allPrompts, query);
    if (filtered.length === 0) {
      return [{
        id: EMPTY_STATE_ID,
        name: i18n.t('settings.prompt.noPromptsDropdown'),
        content: '',
      }, createNewPromptItem];
    }
    return [...filtered, createNewPromptItem];
  }

  // Attempt to refresh data (non-blocking)
  if ((globalLoadingState === 'idle' || globalLoadingState === 'failed') ||
      (projectLoadingState === 'idle' || projectLoadingState === 'failed')) {
    requestRefresh();
  } else if (now - lastRefreshTime > LOADING_TIMEOUT) {
    // Handle timeout for each scope separately
    if (globalLoadingState === 'loading') {
      debugWarn('[PromptProvider] Global prompts loading timeout');
      globalLoadingState = 'failed';
    }
    if (projectLoadingState === 'loading') {
      debugWarn('[PromptProvider] Project prompts loading timeout');
      projectLoadingState = 'failed';
    }
  }

  // Wait only briefly (500ms), then return currently available data
  if (globalLoadingState === 'loading' || projectLoadingState === 'loading') {
    await waitForPrompts(signal, 500).catch(() => {});
  }

  // Return results regardless of loading state
  const allPromptsAfterWait = [...cachedProjectPrompts, ...cachedGlobalPrompts];
  if ((globalLoadingState === 'success' || projectLoadingState === 'success') && allPromptsAfterWait.length > 0) {
    const filtered = filterPrompts(allPromptsAfterWait, query);
    if (filtered.length === 0) {
      return [{
        id: EMPTY_STATE_ID,
        name: i18n.t('settings.prompt.noPromptsDropdown'),
        content: '',
      }, createNewPromptItem];
    }
    return [...filtered, createNewPromptItem];
  }

  // When no data available, show empty state and create button
  return [{
    id: EMPTY_STATE_ID,
    name: i18n.t('settings.prompt.noPromptsDropdown'),
    content: '',
  }, createNewPromptItem];
}

export function promptToDropdownItem(prompt: PromptItem): DropdownItemData {
  // Special handling for loading and empty states
  if (prompt.id === '__loading__' || prompt.id === '__empty__' || prompt.id === EMPTY_STATE_ID) {
    return {
      id: prompt.id,
      label: prompt.name,
      description: prompt.content,
      icon: prompt.id === EMPTY_STATE_ID ? 'codicon-info' : 'codicon-bookmark',
      type: 'info',
      data: { prompt },
    };
  }

  // Special handling for create prompt item
  if (prompt.id === CREATE_NEW_PROMPT_ID) {
    return {
      id: prompt.id,
      label: prompt.name,
      description: i18n.t('settings.prompt.createPromptHint'),
      icon: 'codicon-add',
      type: 'prompt',
      data: { prompt },
    };
  }

  // Add scope label to prompt name
  const scopeLabel = prompt.scope === 'project' ? '[项目]' : '[全局]';
  const labelWithScope = `${prompt.name} ${scopeLabel}`;

  return {
    id: prompt.id,
    label: labelWithScope,
    description: prompt.content ?
      (prompt.content.length > 60 ? prompt.content.substring(0, 60) + '...' : prompt.content) :
      undefined,
    icon: 'codicon-bookmark',
    type: 'prompt',
    data: { prompt },
  };
}

/**
 * Directly update global prompts cache (called by PromptSection)
 * This ensures cache is always in sync with settings page
 */
export function updateGlobalPromptsCache(prompts: PromptItem[]) {
  cachedGlobalPrompts = prompts;
  globalLoadingState = 'success';
  lastRefreshTime = Date.now();
  debugLog('[PromptProvider] Global prompts cache updated directly:', prompts.length);
}

/**
 * Directly update project prompts cache (called by PromptSection)
 * This ensures cache is always in sync with settings page
 */
export function updateProjectPromptsCache(prompts: PromptItem[]) {
  cachedProjectPrompts = prompts;
  projectLoadingState = 'success';
  lastRefreshTime = Date.now();
  debugLog('[PromptProvider] Project prompts cache updated directly:', prompts.length);
}

/**
 * Preload prompts during app initialization
 * Load both global and project prompts before user types "!" to improve perceived performance
 *
 * Safety guarantees:
 * - Skips if already loading or loaded (checks loadingState)
 * - requestRefresh() has MIN_REFRESH_INTERVAL deduplication protection
 * - Shares state with promptProvider, subsequent calls hit cache directly
 */
export function preloadPrompts(): void {
  // Only preload in idle state, don't interfere with in-progress or completed loads
  if (globalLoadingState !== 'idle' && projectLoadingState !== 'idle') {
    debugLog('[PromptProvider] Preload skipped (globalState=' + globalLoadingState + ', projectState=' + projectLoadingState + ')');
    return;
  }

  debugLog('[PromptProvider] Preloading prompts on app init');

  // Ensure callback is registered before requesting refresh
  setupPromptsCallback();

  // Request refresh -- built-in deduplication protection
  requestRefresh();
}

/**
 * Force refresh prompts regardless of loading state
 * Used when switching to chat view to ensure project prompts are loaded
 * Ignores time interval and retry count limits
 */
export function forceRefreshPrompts(): void {
  debugLog('[PromptProvider] Force refreshing prompts');

  // Ensure callback is registered before requesting refresh
  setupPromptsCallback();

  // Reset retry count and force refresh
  retryCount = 0;
  requestRefresh(true);
}

export default promptProvider;
