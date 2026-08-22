/**
 * sessionTransition.ts
 *
 * Helpers for session transition guard management and transient UI state reset.
 * These functions encapsulate the logic that coordinates the React state setters
 * and streaming refs when a new session is initiated.
 */

import type { MutableRefObject, RefObject } from 'react';
import { forceWebviewRepaint } from '../../utils/forceWebviewRepaint';

export interface ResetTransientUiStateOptions {
  clearToasts: () => void;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;

  // Streaming refs
  isStreamingRef: MutableRefObject<boolean>;
  useBackendStreamingRenderRef: MutableRefObject<boolean>;
  streamingMessageIndexRef: MutableRefObject<number>;
  streamingContentRef: MutableRefObject<string>;
  streamingThinkingRef: MutableRefObject<string>;
  autoExpandedThinkingKeysRef: MutableRefObject<Set<string>>;
  contentUpdateTimeoutRef: MutableRefObject<number | null>;
  thinkingUpdateTimeoutRef: MutableRefObject<number | null>;

  // Turn tracking ref (for streaming assistant isolation)
  streamingTurnIdRef: MutableRefObject<number>;

  /** Optional: reset scroll position when leaving a session. */
  messagesContainerRef?: RefObject<HTMLDivElement | null>;
}

/**
 * Drop any in-flight / buffered message snapshots so a session transition
 * cannot be undone by a deferred updateMessages timer (streaming coalescer)
 * that was scheduled before the user clicked "new session".
 */
export const invalidatePendingMessageSnapshots = (): void => {
  if (typeof window.__cancelPendingUpdateMessages === 'function') {
    window.__cancelPendingUpdateMessages();
  }
  // Pre-mount buffer used by main.tsx before React handlers are registered.
  const pending = (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
  if (pending !== undefined) {
    delete (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
  }
  // Reject any already-in-flight updateMessages sequence numbers from the
  // previous session. Sequences are monotonic per daemon connection; bumping
  // to max(current, 1) is enough when no sequence was ever seen (stays 0→1).
  const currentMin = window.__minAcceptedUpdateSequence ?? 0;
  window.__minAcceptedUpdateSequence = currentMin + 1;
};

/**
 * Clear all transient UI state (streaming refs + React state flags).
 * Called on clearMessages and exposed as window.__resetTransientUiState so
 * useSessionManagement can invoke it synchronously during session transitions.
 */
export const buildResetTransientUiState = (opts: ResetTransientUiStateOptions) => {
  return () => {
    // Must run first: a deferred processUpdateMessages (setTimeout ~16ms from
    // streaming coalescer) would otherwise re-apply the old session's snapshot
    // after setMessages([]) and resurrect the previous conversation in the UI.
    invalidatePendingMessageSnapshots();

    opts.clearToasts();
    opts.setStatus('');
    opts.setLoading(false);
    opts.setLoadingStartTime(null);
    opts.setIsThinking(false);
    opts.setStreamingActive(false);
    opts.isStreamingRef.current = false;
    opts.useBackendStreamingRenderRef.current = false;
    opts.streamingMessageIndexRef.current = -1;
    opts.streamingContentRef.current = '';
    opts.streamingThinkingRef.current = '';
    opts.autoExpandedThinkingKeysRef.current.clear();
    // Reset active turn ID to prevent stale streaming assistant recovery.
    // NOTE: turnIdCounterRef is intentionally NOT reset — it must stay monotonically
    // increasing across sessions so that stale messages from an old session can never
    // collide with a new session's turn IDs (and React keys like "turn-N" stay unique).
    opts.streamingTurnIdRef.current = -1;
    // Clear stream-end idempotency guard to avoid stale state across sessions.
    window.__streamEndProcessedTurnId = undefined;
    if (opts.contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(opts.contentUpdateTimeoutRef.current);
      opts.contentUpdateTimeoutRef.current = null;
    }
    if (opts.thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(opts.thinkingUpdateTimeoutRef.current);
      opts.thinkingUpdateTimeoutRef.current = null;
    }

    // Reset scroll so the new session's WelcomeScreen is not under leftover
    // scroll offset from a long previous conversation.
    const container = opts.messagesContainerRef?.current;
    if (container) {
      container.scrollTop = 0;
    }

    // Clear JCEF native-rendering ghosting left by the outgoing session's message
    // list / overlays. Schedule once after React unmounts (double rAF inside
    // forceWebviewRepaint) and once more on the next macrotask for heavy markdown
    // unmounts that can outlive two animation frames.
    forceWebviewRepaint('session-transition');
    window.setTimeout(() => {
      forceWebviewRepaint('session-transition-delayed');
    }, 50);
  };
};

/**
 * Release the session transition guard flags set by beginSessionTransition
 * (useSessionManagement).
 */
export const releaseSessionTransition = (): void => {
  if (window.__sessionTransitioning) {
    window.__sessionTransitioning = false;
  }
  window.__sessionTransitionToken = null;
};
