/**
 * streamingCallbacks.ts
 *
 * Registers window bridge callbacks for streaming:
 * onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd, onPermissionDenied.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage, ClaudeRawMessage } from '../../../types';
import { sendBridgeEvent } from '../../../utils/bridge';
import { THROTTLE_INTERVAL } from '../../useStreamingMessages';
import { parseSequence } from '../parseSequence';
import { getStreamEndHandlingMode } from '../messageSync';
import { applyCodexLiveMessage } from '../../../utils/codexLiveInsert';
import { createLocalizeMessage } from '../../../utils/localizationUtils';
import { isEmptyAssistantPlaceholder, parseSendErrorPayload } from '../../../utils/sendErrorPayload';
import {
  DEFAULT_STREAM_STALL_TIMEOUT_SECONDS,
  clampStreamStallTimeoutSeconds,
  streamStallTimeoutSecondsToMs,
} from '../../../utils/streamStallTimeout';

function extractRawContent(msg: ClaudeMessage): unknown[] | null {
  if (!msg.raw) return null;
  try {
    const rawObj = typeof msg.raw === 'string' ? JSON.parse(msg.raw) : msg.raw;
    const content = (rawObj as { content?: unknown; message?: { content?: unknown } })?.content
      ?? (rawObj as { message?: { content?: unknown } })?.message?.content;
    return Array.isArray(content) ? content : null;
  } catch {
    return null;
  }
}

function collectToolResultIdsFromMessages(
  messages: ClaudeMessage[],
  fromIndex = 0,
): Set<string> {
  const resolvedIds = new Set<string>();
  for (let i = fromIndex; i < messages.length; i++) {
    const content = extractRawContent(messages[i]);
    if (!content) continue;
    for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resolvedIds.add(block.tool_use_id);
      }
    }
  }
  return resolvedIds;
}

/**
 * Scans assistant messages containing tool_use blocks and returns IDs that have
 * no matching tool_result anywhere in the conversation.
 *
 * scope: 'lastTurn'  — inspect the most recent assistant tool_use group and
 *                       match tool_results in ANY subsequent message (not just
 *                       the immediate next user message). Multi-step agent
 *                       turns often interleave assistant text after tool_use
 *                       before tool_result arrives; only checking nextMsg left
 *                       spinners pending forever after timeout/stream end.
 * scope: 'all'       — collect every tool_use ID across the whole message list
 *                       and check against every tool_result block anywhere.
 *                       Required by historyLoadComplete because a replayed
 *                       Codex session may contain multiple aborted turns whose
 *                       missing results would otherwise be invisible to the
 *                       lastTurn heuristic.
 *
 * Without this, tool blocks like BashToolGroupBlock keep rendering pending
 * spinners forever because parseBashItem treats `result == null` as "still
 * running".
 */
export function collectUnresolvedToolUseIds(
  messages: ClaudeMessage[],
  scope: 'lastTurn' | 'all' = 'lastTurn',
): string[] {
  const idsToAdd: string[] = [];
  try {
    if (scope === 'all') {
      const resolvedIds = collectToolResultIdsFromMessages(messages, 0);
      for (const msg of messages) {
        if (msg.type !== 'assistant') continue;
        const content = extractRawContent(msg);
        if (!content) continue;
        for (const block of content as Array<{ type?: string; id?: string }>) {
          if (block?.type === 'tool_use' && block.id
              && !resolvedIds.has(block.id)
              && !window.__deniedToolIds?.has(block.id)) {
            idsToAdd.push(block.id);
          }
        }
      }
      return idsToAdd;
    }

    // scope === 'lastTurn': latest assistant that has tool_use blocks.
    // Match tool_results in ANY subsequent message (not only the immediate
    // next user message) so interleaved assistant text after tool_use still
    // resolves correctly when the result arrives later.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant') continue;
      const content = extractRawContent(msg);
      if (!content) continue;

      const toolUses: Array<{ id: string }> = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; id?: string };
        if (b.type === 'tool_use' && typeof b.id === 'string' && b.id) {
          toolUses.push({ id: b.id });
        }
      }
      if (toolUses.length === 0) continue;

      const existingResultIds = collectToolResultIdsFromMessages(messages, i + 1);

      for (const tu of toolUses) {
        if (!existingResultIds.has(tu.id) && !window.__deniedToolIds?.has(tu.id)) {
          idsToAdd.push(tu.id);
        }
      }
      break;
    }
  } catch (e) {
    console.error('[Frontend] Error in collectUnresolvedToolUseIds:', e);
  }
  return idsToAdd;
}

/** Synthetic user/tool_result carrier so findToolResult resolves after stream end. */
export function buildInterruptedToolResultMessage(toolIds: string[]): ClaudeMessage {
  return {
    type: 'user',
    content: '[tool_result]',
    raw: {
      role: 'user',
      content: toolIds.map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        is_error: true,
        content: 'Interrupted: tool did not complete (timeout or stream ended before result).',
      })),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Timeout for detecting a stalled stream.  If no content/thinking delta
 * arrives for this duration while isStreamingRef is still true, the frontend
 * auto-recovers by forcing the stream-end cleanup.  This guards against the
 * backend onStreamEnd signal being silently dropped by JCEF.
 *
 * Default is 3 minutes (configurable in Settings → Behavior). Codex app-server
 * emits [STREAM_HEARTBEAT] to bump __lastStreamActivityAt during long tool phases.
 */
/** Check every 1s so short timeouts (e.g. 1s for testing) can fire promptly. */
const STREAM_STALL_CHECK_INTERVAL_MS = 1_000;

function resolveStreamStallTimeoutMs(): number {
  const seconds = clampStreamStallTimeoutSeconds(
    typeof window !== 'undefined' ? window.__streamStallTimeoutSeconds : undefined,
  );
  return streamStallTimeoutSecondsToMs(seconds);
}

function resolveStreamStallTimeoutSeconds(): number {
  return clampStreamStallTimeoutSeconds(
    typeof window !== 'undefined' ? window.__streamStallTimeoutSeconds : DEFAULT_STREAM_STALL_TIMEOUT_SECONDS,
  );
}

export function registerStreamingCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    t,
    addToast,
    setMessages,
    setStreamingActive,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setExpandedThinking,
    streamingContentRef,
    streamingThinkingRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    turnIdCounterRef,
    lastContentUpdateRef,
    contentUpdateTimeoutRef,
    lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,
  } = options;

  // ── Stream stall watchdog ──
  // Tracks the last time we received any streaming activity (delta or
  // updateMessages during streaming).  A periodic check auto-recovers
  // if the backend's onStreamEnd signal was silently lost.
  // Exposed on window so messageCallbacks can also bump this on updateMessages.
  //
  // The interval handle is stored on `window` so that if registerStreamingCallbacks
  // is called again (e.g., HMR, parent re-render), the previous interval is
  // cleared first — preventing multiple watchdogs from running simultaneously.
  if (window.__stallWatchdogInterval != null) {
    clearInterval(window.__stallWatchdogInterval);
    window.__stallWatchdogInterval = null;
  }
  window.__lastStreamActivityAt = 0;

  const clearStallWatchdog = () => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  };

  const startStallWatchdog = () => {
    clearStallWatchdog();
    window.__lastStreamActivityAt = Date.now();
    window.__stallWatchdogInterval = setInterval(() => {
      if (!isStreamingRef.current) {
        clearStallWatchdog();
        return;
      }
      const timeoutMs = resolveStreamStallTimeoutMs();
      const elapsed = Date.now() - (window.__lastStreamActivityAt ?? 0);
      if (elapsed >= timeoutMs) {
        const seconds = resolveStreamStallTimeoutSeconds();
        console.warn(
          `[StreamWatchdog] Stream stalled for ${elapsed}ms (limit=${timeoutMs}ms) — aborting turn`,
        );
        clearStallWatchdog();
        addToast(
          t('chat.streamStallTimeout', {
            seconds,
            defaultValue: `No model response for ${seconds} second(s). This turn was ended automatically.`,
          }),
          'warning',
          10_000, // keep stall notice visible longer; user can also click × to close
        );
        // Must abort the daemon/CLI — UI-only onStreamEnd left the process running
        // and late CONTENT_DELTA revived the turn via ensureStreamingStarted.
        hardStopStreamingTurn(`stall-watchdog ${seconds}s`);
      }
    }, STREAM_STALL_CHECK_INTERVAL_MS);
  };

  window.onStreamStart = (mode?: string | boolean) => {
    if (window.__sessionTransitioning) return;
    const isReplayStart = mode === 'replay' || mode === true;
    // New turn from the backend — allow ensureStreamingStarted again.
    window.__streamHardStopped = false;
    // Clear any stale pending updateMessages from previous turn.
    // This prevents onStreamEnd from using outdated snapshot data.
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }
    // Explicit null in case the rAF already executed (clearing pendingUpdateRaf)
    // but __pendingUpdateJson was not yet cleared by the rAF callback.
    window.__pendingUpdateJson = null;
    // Clear the previous stream-ended marker when a new turn starts
    window.__lastStreamEndedTurnId = undefined;
    window.__lastStreamEndedAt = undefined;
    // Clear idempotency guard for the new turn
    window.__streamEndProcessedTurnId = undefined;
    // Record turn start time for duration calculation in onStreamEnd
    window.__turnStartedAt = Date.now();
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    isStreamingRef.current = true;
    startStallWatchdog();
    useBackendStreamingRenderRef.current = false;
    autoExpandedThinkingKeysRef.current.clear();
    setStreamingActive(true);

    // FIX: Always reset streamingMessageIndexRef regardless of backend streaming mode
    streamingMessageIndexRef.current = -1;
    turnIdCounterRef.current += 1;
    streamingTurnIdRef.current = turnIdCounterRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (isReplayStart && last?.type === 'assistant') {
        streamingMessageIndexRef.current = prev.length - 1;
        const updated = [...prev];
        updated[prev.length - 1] = {
          ...updated[prev.length - 1],
          isStreaming: true,
          __turnId: streamingTurnIdRef.current,
        };
        return updated;
      }
      streamingMessageIndexRef.current = prev.length;
      return [
        ...prev,
        {
          type: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: new Date().toISOString(),
          __turnId: streamingTurnIdRef.current,
        },
      ];
    });
  };

  // rAF-scheduled streaming update: frame-aligned, avoids setTimeout jank.
  // Factory that creates a throttled scheduler bound to a specific timeoutRef +
  // lastUpdateRef pair.  patchAssistantForStreaming reads streamingContentRef /
  // streamingThinkingRef from the hook closure, so the factory only needs to
  // know which ref pair to guard against double-scheduling.
  const createStreamingRafScheduler = (
    timeoutRef: React.MutableRefObject<number | null>,
    lastUpdateRef: React.MutableRefObject<number>,
  ) => {
    const scheduleRaf = (): void => {
      if (timeoutRef.current != null) return;
      timeoutRef.current = requestAnimationFrame(() => {
        timeoutRef.current = null;
        const now = Date.now();
        const elapsed = now - lastUpdateRef.current;
        if (elapsed < THROTTLE_INTERVAL) {
          scheduleRaf(); // too soon — wait for next frame
          return;
        }
        lastUpdateRef.current = now;
        // NOTE: intentionally NOT wrapped in startTransition. Streamed assistant
        // text arrives only via content_delta and is the sole update on this rAF
        // path, whereas tool cards / tool_result use a direct (urgent) setMessages.
        // Marking the text flush as a low-priority transition let React starve it
        // during busy tool-heavy turns — the deltas accumulated in streamingContentRef
        // but never committed, so text appeared only after the turn went idle or the
        // user switched sessions. The rAF + THROTTLE_INTERVAL throttle already bounds
        // update frequency, so a normal-priority commit keeps text live without jank.
        setMessages((prev) => {
          const newMessages = [...prev];
          let idx: number;
          if (useBackendStreamingRenderRef.current) {
            idx = streamingMessageIndexRef.current;
            if (idx < 0) return prev;
          } else {
            idx = getOrCreateStreamingAssistantIndex(newMessages);
          }
          if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
            newMessages[idx] = patchAssistantForStreaming({
              ...newMessages[idx],
              isStreaming: true,
            });
          }
          return newMessages;
        });
      });
    };
    return scheduleRaf;
  };

  const scheduleContentRaf = createStreamingRafScheduler(contentUpdateTimeoutRef, lastContentUpdateRef);
  const scheduleThinkingRaf = createStreamingRafScheduler(thinkingUpdateTimeoutRef, lastThinkingUpdateRef);

  /**
   * Ensure streaming refs are live. STREAM_START can lag behind the first
   * content_delta / tool MESSAGE; without this, onContentDelta / onMessage
   * silently drop payloads while loading stays true (blank "generating" UI).
   *
   * Must NOT revive a turn after user Stop or the stall watchdog hard-stop —
   * otherwise late CONTENT_DELTA restarts the UI while the CLI is still dying.
   */
  const ensureStreamingStarted = (): void => {
    if (window.__sessionTransitioning) return;
    if (window.__streamHardStopped) return;
    if (isStreamingRef.current) return;
    window.onStreamStart?.();
  };

  /** Abort backend + freeze UI so late deltas cannot reopen the turn. */
  const hardStopStreamingTurn = (reason: string) => {
    window.__streamHardStopped = true;
    console.warn(`[Stream] hard-stop (${reason}) → interrupt_session + stream-end`);
    // Kill the in-flight daemon/CLI turn (same path as the Stop button).
    sendBridgeEvent('interrupt_session');
    isStreamingRef.current = false;
    setStreamingActive(false);
    setLoading(false);
    setLoadingStartTime(null);
    setIsThinking(false);
    if (typeof window.onStreamEnd === 'function') {
      window.onStreamEnd();
    }
  };

  /**
   * Guarantee a live assistant slot exists inside a setMessages updater.
   * onStreamStart sets streamingMessageIndexRef only inside its own updater,
   * so a second setMessages in the same tick can still see index === -1.
   */
  const ensureStreamingSlot = (
    list: ClaudeMessage[],
  ): { list: ClaudeMessage[]; index: number } => {
    let index = streamingMessageIndexRef.current;
    if (
      index >= 0
      && index < list.length
      && list[index]?.type === 'assistant'
      && list[index]?.isStreaming
    ) {
      return { list, index };
    }
    // Prefer the last streaming assistant of the current turn.
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i];
      if (msg?.type !== 'assistant' || !msg.isStreaming) continue;
      if (streamingTurnIdRef.current > 0 && msg.__turnId != null && msg.__turnId !== streamingTurnIdRef.current) {
        continue;
      }
      streamingMessageIndexRef.current = i;
      return { list, index: i };
    }
    // Append a fresh empty streaming slot.
    if (streamingTurnIdRef.current <= 0) {
      turnIdCounterRef.current += 1;
      streamingTurnIdRef.current = turnIdCounterRef.current;
    }
    index = list.length;
    const next: ClaudeMessage[] = [
      ...list,
      {
        type: 'assistant',
        content: '',
        isStreaming: true,
        timestamp: new Date().toISOString(),
        __turnId: streamingTurnIdRef.current,
      },
    ];
    streamingMessageIndexRef.current = index;
    return { list: next, index };
  };

  window.onContentDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (window.__streamHardStopped) return;
    ensureStreamingStarted();
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingContentRef.current += delta;
    scheduleContentRaf();
  };

  window.onThinkingDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (window.__streamHardStopped) return;
    ensureStreamingStarted();
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingThinkingRef.current += delta;
    scheduleThinkingRaf();
  };

  window.onStreamEnd = (sequence?: string | number) => {
    if (window.__sessionTransitioning) return;

    // Idempotency guard: dual-path delivery (primary via flush callback +
    // fallback via Alarm) may send onStreamEnd twice for the same turn.
    // Only the first arrival takes effect; the second is a no-op.
    //
    // After the first onStreamEnd processes, streamingTurnIdRef is cleared to -1
    // and isStreamingRef is set to false. The second arrival sees these cleared
    // refs and should bail out. We check both conditions:
    // 1. If the current turn ID was already processed (before refs were cleared)
    // 2. If streaming is already inactive (refs were already cleared by first call)
    const currentTurnId = streamingTurnIdRef.current;
    const handlingMode = getStreamEndHandlingMode(
      options.currentProviderRef.current,
      isStreamingRef.current,
      currentTurnId,
    );
    if (currentTurnId > 0 && window.__streamEndProcessedTurnId === currentTurnId) {
      return;
    }
    if (handlingMode === 'skip') {
      // Streaming refs already cleared by a previous onStreamEnd — nothing to do
      return;
    }

    clearStallWatchdog();
    const parsedSequence = parseSequence(sequence);
    // Only update minAcceptedUpdateSequence for valid positive sequences.
    // The fallback path sends sequence=-1 which means "no sequence info" —
    // it should not participate in sequence tracking.
    if (parsedSequence != null && parsedSequence >= 0) {
      window.__minAcceptedUpdateSequence = Math.max(window.__minAcceptedUpdateSequence ?? 0, parsedSequence);
    }
    // Notify backend about stream completion for tab status indicator
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

    if (handlingMode === 'minimal') {
      if (typeof window.__cancelPendingUpdateMessages === 'function') {
        window.__cancelPendingUpdateMessages();
      }
      setStreamingActive(false);
      setLoading(false);
      setLoadingStartTime(null);
      setIsThinking(false);
      window.__streamEndProcessedTurnId = currentTurnId > 0 ? currentTurnId : undefined;
      return;
    }

    // FIX: Extract backend final snapshot from pending updateMessages BEFORE cancelling rAF.
    // The backend's final flush contains the authoritative message state (complete raw blocks).
    // If onStreamEnd cancels the rAF without processing this snapshot, the final message may
    // show incomplete content (e.g., last delta missing) or duplicated content in raw blocks.
    //
    // FIX: Also preserve tool_result user messages from the pending snapshot.
    // Previously only the assistant message was extracted; tool_result user messages were
    // silently dropped when the pending rAF was cancelled.  This caused tool cards to
    // remain stuck in "pending" state (spinner) even though the tool had completed.
    let backendSnapshotContent: string | undefined;
    let backendSnapshotRaw: ClaudeRawMessage | string | undefined = undefined;
    const pendingToolResultMsgs: Array<{ content: string; raw: Record<string, unknown> }> = [];
    if (typeof window.__pendingUpdateJson === 'string' && window.__pendingUpdateJson.length > 0) {
      try {
        const parsed = JSON.parse(window.__pendingUpdateJson) as Array<Record<string, unknown>>;
        for (let i = parsed.length - 1; i >= 0; i--) {
          if (parsed[i]?.type === 'assistant') {
            const rawContent = parsed[i].content;
            const content = typeof rawContent === 'string' ? rawContent : '';
            if (content) {
              backendSnapshotContent = content;
              const rawVal = parsed[i].raw;
              if (rawVal != null && (typeof rawVal === 'object' || typeof rawVal === 'string')) {
                backendSnapshotRaw = rawVal as ClaudeRawMessage | string;
              }
            }
            break;
          }
        }
        // Collect tool_result user messages from the pending snapshot so that
        // completed tool calls are not lost when the rAF is cancelled below.
        for (let i = 0; i < parsed.length; i++) {
          const msg = parsed[i];
          if (msg?.type === 'user' && typeof msg.content === 'string' && msg.content.trim() === '[tool_result]') {
            const raw = msg.raw as Record<string, unknown> | undefined;
            if (raw != null && typeof raw === 'object') {
              pendingToolResultMsgs.push({ content: '[tool_result]', raw });
            }
          }
        }
      } catch (error) {
        // __pendingUpdateJson is produced internally by the bridge; a parse failure
        // indicates an upstream contract violation worth surfacing for diagnosis.
        console.warn('[Frontend] Failed to parse __pendingUpdateJson on stream end:', error);
      }
    }

    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }

    // Clear pending rAF callbacks — their content is already in streamingContentRef
    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }

    // Snapshot keys that need collapsing BEFORE they are cleared inside the updater.
    const keysToCollapse = new Set(autoExpandedThinkingKeysRef.current);

    // Snapshot turn start time BEFORE entering the updater
    const turnStartedAt = window.__turnStartedAt;
    window.__turnStartedAt = undefined;

    // Snapshot streaming state BEFORE clearing refs - used for post-stream merge guard
    const endedStreamingTurnId = streamingTurnIdRef.current;
    const endedStreamingMessageIndex = streamingMessageIndexRef.current;
    // FIX: Prioritize streaming content over backend snapshot to prevent digit loss
    // Streaming content has all the latest deltas (including the final one just flushed).
    // Backend snapshot might be from an earlier coalescer push and may be incomplete.
    const endedStreamingContent = streamingContentRef.current || backendSnapshotContent || '';
    const endedBackendRaw = backendSnapshotRaw;

    // Helper to measure total text length from raw blocks (for comparing completeness).
    // Handles both object and JSON string formats of raw.
    type TextBlock = { type: 'text'; text: string };
    const hasTextBlocks = (value: unknown): value is { message: { content: TextBlock[] } } => {
      if (!value || typeof value !== 'object') return false;
      const msg = (value as { message?: unknown }).message;
      if (!msg || typeof msg !== 'object') return false;
      const content = (msg as { content?: unknown }).content;
      return Array.isArray(content);
    };
    const getTextLenFromRaw = (raw: unknown): number => {
      let parsedRaw: unknown = raw;
      if (typeof raw === 'string') {
        try {
          parsedRaw = JSON.parse(raw);
        } catch (error) {
          console.warn('[Frontend] Failed to parse raw JSON for length comparison:', error);
          return 0;
        }
      }
      if (!hasTextBlocks(parsedRaw)) return 0;
      return parsedRaw.message.content
        .filter((b): b is TextBlock => b?.type === 'text' && typeof b.text === 'string')
        .reduce((sum, b) => sum + b.text.length, 0);
    };

    // FIX: Clear streaming refs BEFORE setMessages updater to prevent race conditions.
    //
    // Trade-off analysis:
    // - Original approach: refs cleared inside updater, leverages React batching to ensure
    //   clearing and state update happen together. But this caused timing issues when
    //   deferred operations (rAF, timeout) executed after the updater but before refs were
    //   actually cleared, allowing them to modify the streaming message incorrectly.
    // - New approach: refs cleared outside updater, uses snapshot values inside updater.
    //   This prevents race conditions where deferred updateMessages sees isStreamingRef=false
    //   but streamingMessageIndexRef still points to the old message.
    // - Benefit: More robust handling of async callback ordering, especially important
    //   when JCEF async chains can reorder callbacks unpredictably.
    // - Risk: Minimal, since snapshot values are used inside updater and refs are cleared
    //   synchronously before the updater is scheduled.
    //
    // Streaming state refs (isStreaming flag)
    isStreamingRef.current = false;
    useBackendStreamingRenderRef.current = false;

    // Index refs (message position tracking)
    streamingMessageIndexRef.current = -1;
    streamingTurnIdRef.current = -1;

    // Content buffer refs
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    autoExpandedThinkingKeysRef.current.clear();

    // Mark that streaming just ended - used by mergeConsecutiveAssistantMessages to
    // distinguish recently-ended streaming messages from true history messages.
    window.__lastStreamEndedTurnId = endedStreamingTurnId;
    window.__lastStreamEndedAt = Date.now();

    // Flush final content and finalize the streaming message.
    setMessages((prev) => {
      let newMessages = prev;
      const idx = endedStreamingMessageIndex;
      if (prev.length > 0 && idx >= 0 && idx < prev.length && prev[idx]?.type === 'assistant') {
        newMessages = [...prev];
        // FIX: Keep __turnId on the message for a short period to prevent
        // incorrect merging with history messages. The __turnId will be
        // removed later when history is loaded or a new turn starts.
        const finalContent = endedStreamingContent || newMessages[idx].content || '';
        // Calculate durationMs and stamp it on the assistant message
        const durationMs = (typeof turnStartedAt === 'number' && turnStartedAt > 0)
          ? Date.now() - turnStartedAt
          : undefined;
        // Use backend raw blocks only if they are more complete than the existing raw.
        // The backend snapshot may be from an earlier coalescer flush, so the existing
        // raw (updated by subsequent deltas) could actually be more up-to-date.
        let finalRaw = newMessages[idx].raw;
        if (endedBackendRaw != null) {
          if (getTextLenFromRaw(endedBackendRaw) >= getTextLenFromRaw(finalRaw)) {
            finalRaw = endedBackendRaw;
          }
        }
        newMessages[idx] = {
          ...newMessages[idx],
          content: finalContent,
          raw: finalRaw,
          isStreaming: false,
          __turnId: endedStreamingTurnId, // Keep __turnId for merge guard
          ...(durationMs != null ? { durationMs } : {}),
        };
      }

      // FIX: Merge tool_result user messages that were in the pending snapshot
      // but would otherwise be lost when the rAF is cancelled.  Without this,
      // tool cards remain stuck in "pending" spinner state.
      //
      // Runs INDEPENDENTLY of the assistant-patch branch above: a completed
      // tool_result can land in the pending snapshot even when there is no active
      // streaming assistant message to finalize (endedStreamingMessageIndex < 0,
      // e.g. backend-streaming-render paths or a message list mutated between the
      // last delta and stream end).  Coupling it to the assistant branch would
      // silently drop those completed results in exactly the stuck-spinner case
      // this fix targets.
      if (pendingToolResultMsgs.length > 0) {
        // Preserve immutability: lazily clone prev once before the first push so
        // the updater never mutates the previous state array in place (the
        // assistant branch above may have left newMessages === prev).
        if (newMessages === prev) {
          newMessages = [...prev];
        }
        // Build a set of existing tool_use_ids from the current message list
        // to avoid adding duplicate tool_result messages.
        const existingToolResultIds = new Set<string>();
        for (const m of newMessages) {
          const raw = m?.raw as Record<string, unknown> | undefined;
          if (!raw || typeof raw !== 'object') continue;
          const msg = raw.message as Record<string, unknown> | undefined;
          const content = (raw.content ?? msg?.content) as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              existingToolResultIds.add(block.tool_use_id);
            }
          }
        }
        // Append only tool_result messages that aren't already present
        for (const trMsg of pendingToolResultMsgs) {
          const raw = trMsg.raw;
          const msg = raw.message as Record<string, unknown> | undefined;
          const content = (raw.content ?? msg?.content) as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(content)) continue;
          const hasNewToolResult = content.some(
            (block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && !existingToolResultIds.has(block.tool_use_id),
          );
          if (hasNewToolResult) {
            newMessages.push({ ...trMsg, type: 'user' as const, timestamp: new Date().toISOString() });
            // Register the freshly-pushed ids so a duplicate tool_result carrying the same
            // tool_use_id later in this snapshot isn't appended a second time.
            for (const block of content) {
              if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                existingToolResultIds.add(block.tool_use_id);
              }
            }
          }
        }
      }

      return newMessages;
    });

    // Collapse auto-expanded thinking blocks using the pre-clear snapshot
    if (setExpandedThinking && keysToCollapse.size > 0) {
      setExpandedThinking((prev) => {
        const next = { ...prev };
        keysToCollapse.forEach((key) => {
          next[key] = false;
        });
        return next;
      });
    }

    // React state (not ref) — React batches this with setMessages automatically
    setStreamingActive(false);

    // FIX: onStreamEnd is the authoritative signal that streaming has ended.
    // Reset loading state here to prevent race conditions where showLoading("false")
    // arrives before onStreamEnd and gets ignored by the isStreamingRef guard,
    // while the flush callback's showLoading("false") may be delayed or lost
    // (e.g., due to slow message serialization or multi-hop async chains).
    setLoading(false);
    setLoadingStartTime(null);
    setIsThinking(false);

    // FIX: When stream ends (normal completion, user interrupt, timeout, or
    // backend abort), any tool_use without a matching tool_result would render
    // a perpetual pending spinner. Mark them denied AND append a synthetic
    // tool_result carrier so findToolResult / GenericToolBlock flip to error.
    //
    // For a normal turn the SDK delivers all tool_results before onStreamEnd,
    // so collectUnresolvedToolUseIds returns [] and we skip the extra message.
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }
    setMessages((currentMessages) => {
      const interruptedIds = collectUnresolvedToolUseIds(currentMessages, 'lastTurn');
      if (interruptedIds.length === 0) {
        return currentMessages;
      }
      for (const id of interruptedIds) {
        window.__deniedToolIds!.add(id);
      }
      return [...currentMessages, buildInterruptedToolResultMessage(interruptedIds)];
    });

    // Mark this turn as processed — idempotency guard for dual-path delivery
    window.__streamEndProcessedTurnId = endedStreamingTurnId;
  };

  // Streaming heartbeat — lightweight signal from backend during tool execution
  // phases where no content deltas arrive.  Keeps the stall watchdog alive.
  window.onStreamingHeartbeat = () => {
    if (isStreamingRef.current && window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }
  };

  // Permission denied callback — marks incomplete tool calls as "interrupted"
  window.onPermissionDenied = () => {
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }

    let idsToAdd: string[] = [];
    setMessages((currentMessages) => {
      idsToAdd = collectUnresolvedToolUseIds(currentMessages);
      return [...currentMessages];
    });

    for (const id of idsToAdd) {
      window.__deniedToolIds!.add(id);
    }
  };

  /**
   * Surface backend send failures as a chat error bubble (type: 'error').
   * Without this handler, panel maps send_error → onSendError but nothing
   * renders, so config/auth failures only "flash" and disappear.
   */
  window.onSendError = (payload?: string) => {
    if (window.__sessionTransitioning) return;

    const localize = createLocalizeMessage(t);
    const errorText = localize(parseSendErrorPayload(payload));

    // User clicked Stop — Codex/Grok may still surface "Aborted". Do not show ERROR bubble.
    const abortLike =
      /^(Aborted|User interrupted)$/i.test(errorText.trim())
      || /\bAborted\b/i.test(errorText)
      || /User interrupted/i.test(errorText)
      || /Request interrupted by user/i.test(errorText);
    if (abortLike) {
      clearStallWatchdog();
      isStreamingRef.current = false;
      setStreamingActive(false);
      setLoading(false);
      setLoadingStartTime(null);
      setIsThinking(false);
      return;
    }

    // Dual-path delivery (stderr + stdout [SEND_ERROR] + bare JSON) can fire
    // the same failure multiple times within one turn — keep a short debounce.
    const now = Date.now();
    if (
      window.__lastSendErrorText === errorText
      && typeof window.__lastSendErrorAt === 'number'
      && now - window.__lastSendErrorAt < 3000
    ) {
      setStreamingActive(false);
      setLoading(false);
      setLoadingStartTime(null);
      setIsThinking(false);
      return;
    }
    window.__lastSendErrorText = errorText;
    window.__lastSendErrorAt = now;

    clearStallWatchdog();
    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }

    isStreamingRef.current = false;
    useBackendStreamingRenderRef.current = false;
    streamingMessageIndexRef.current = -1;
    streamingTurnIdRef.current = -1;
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    autoExpandedThinkingKeysRef.current.clear();

    setMessages((prev) => {
      let next = [...prev];
      // Drop trailing empty assistant placeholders from the failed turn.
      while (next.length > 0 && isEmptyAssistantPlaceholder(next[next.length - 1])) {
        next = next.slice(0, -1);
      }
      // Avoid stacking identical error bubbles if dual-path delivery fires twice.
      const last = next[next.length - 1];
      if (last?.type === 'error' && last.content === errorText) {
        return next;
      }
      return [
        ...next,
        {
          type: 'error',
          content: errorText,
          timestamp: new Date().toISOString(),
        },
      ];
    });

    setStreamingActive(false);
    setLoading(false);
    setLoadingStartTime(null);
    setIsThinking(false);
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

    const toastLine = errorText.split('\n').find((line) => line.trim().length > 0) || errorText;
    addToast(toastLine.slice(0, 160), 'error');

    // Mirror into host Output channel (works even when chat styling is missed).
    try {
      sendBridgeEvent('debug_log', `[UI_SEND_ERROR] ${errorText.slice(0, 1000)}`);
    } catch {
      // ignore
    }
  };

  // Live message insert — fires for every `[MESSAGE]` event as it arrives during
  // a turn. Both providers stream answer text into a single assistant slot via
  // content deltas, but deliver their tool_use / tool_result blocks as structured
  // messages. Without this, the tool cards only materialise at end-of-turn
  // (onTurnMessages), so a narrated turn renders as one long paragraph — and a
  // tool-only turn (Claude calling tools with no narration) shows a blank panel —
  // that then "snaps" into cards. applyCodexLiveMessage freezes the current text
  // segment on a tool boundary and opens a fresh streaming slot, so cards appear
  // progressively. It safely no-ops when there is no valid streaming slot, so
  // enabling it for every provider only ever helps or falls back to prior
  // behaviour.
  //
  // Dedup is derived from the message list itself, so the pure updater is safe
  // under React StrictMode's double-invocation. Index / content-buffer resets are
  // computed from snapshots captured before the updater to keep it deterministic.
  window.onMessage = (json: string) => {
    if (window.__sessionTransitioning) return;
    // After Stop / stall hard-stop, ignore late tool/message frames from the dying CLI.
    if (window.__streamHardStopped) return;

    let incoming: ClaudeRawMessage;
    try {
      incoming = JSON.parse(json) as ClaudeRawMessage;
    } catch {
      return;
    }
    if (!incoming || typeof incoming !== 'object') return;

    // Tool cards / structural messages must not be dropped when they arrive
    // before stream_start (loading stays true while the list stays empty).
    ensureStreamingStarted();

    // Snapshot text buffer and turn id BEFORE the updater. Slot index is
    // resolved inside the updater via ensureStreamingSlot so a same-tick
    // onStreamStart setState race cannot leave startIndex at -1.
    const slotText = streamingContentRef.current;
    const turnId = streamingTurnIdRef.current > 0 ? streamingTurnIdRef.current : undefined;

    window.__lastStreamActivityAt = Date.now();

    setMessages((prev) => {
      const { list, index } = ensureStreamingSlot(prev);
      const res = applyCodexLiveMessage(list, index, incoming, slotText, turnId);
      if (!res.changed) {
        // Still keep the ensured slot even if this particular message was a no-op
        // (e.g. text-only duplicate already shown via content_delta).
        if (list !== prev) {
          streamingMessageIndexRef.current = index;
          return list;
        }
        return prev;
      }
      streamingMessageIndexRef.current = res.streamingIndex;
      if (res.openedFreshSlot) {
        streamingContentRef.current = '';
      }
      return res.messages;
    });
  };

  // Turn messages flush — fires once per turn, just before stream_end, with all
  // buffered assistant/user messages from this turn (Codex mode only).
  // Patches raw blocks onto the streaming assistant message and inserts any
  // intermediate tool-loop messages (assistant + tool_result user) so that
  // StatusPanel tabs (Tasks / SubAgent / FileChanges) can scan raw blocks.
  window.onTurnMessages = (json: string) => {
    if (window.__sessionTransitioning) return;
    ensureStreamingStarted();
    if (!isStreamingRef.current) return;
    try {
      const turnMsgs = JSON.parse(json) as Array<Record<string, unknown>>;
      if (!Array.isArray(turnMsgs) || turnMsgs.length === 0) return;

      // Find the index of the last assistant entry in turnMsgs.
      // This corresponds to the currently streaming assistant in the state.
      let lastTurnAsstIdx = turnMsgs.length - 1;
      while (lastTurnAsstIdx >= 0 && turnMsgs[lastTurnAsstIdx].type !== 'assistant') {
        lastTurnAsstIdx--;
      }
      if (lastTurnAsstIdx < 0) return;

      // Messages before the last assistant are intermediate tool-loop entries
      // (assistant tool_use / user tool_result / interstitial text). onMessage may
      // already have inserted them live during the turn, so onTurnMessages is now a
      // dedupe backstop: it only appends entries still missing from the list.
      const insertCount = lastTurnAsstIdx;
      const currentStreamingIdx = streamingMessageIndexRef.current;

      // Extract visible text from a Codex content-block array
      const extractText = (content: unknown): string => {
        if (!Array.isArray(content)) return '';
        return (content as Array<Record<string, unknown>>)
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
          .trim();
      };
      const contentOf = (raw: import('../../../types').ClaudeRawMessage): unknown => {
        const msg = (raw as Record<string, unknown>).message as Record<string, unknown> | undefined;
        return msg?.content ?? (raw as Record<string, unknown>).content;
      };
      const toolUseIdsOf = (content: unknown): string[] =>
        Array.isArray(content)
          ? (content as Array<Record<string, unknown>>)
              .filter((b) => b?.type === 'tool_use' && typeof b.id === 'string')
              .map((b) => b.id as string)
          : [];
      const stableStringify = (value: unknown): string => {
        if (Array.isArray(value)) {
          return `[${value.map((item) => stableStringify(item)).join(',')}]`;
        }
        if (value && typeof value === 'object') {
          return `{${Object.entries(value as Record<string, unknown>)
            .filter(([, entryValue]) => entryValue !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
            .join(',')}}`;
        }
        return JSON.stringify(value);
      };
      const toolUseSignaturesOf = (content: unknown): string[] =>
        Array.isArray(content)
          ? (content as Array<Record<string, unknown>>)
              .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
              .map((b) => `${b.name as string}::${stableStringify(b.input && typeof b.input === 'object' ? b.input : {})}`)
          : [];
      const toolResultIdsOf = (content: unknown): string[] =>
        Array.isArray(content)
          ? (content as Array<Record<string, unknown>>)
              .filter((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string')
              .map((b) => b.tool_use_id as string)
          : [];

      setMessages((prev) => {
        const streamingIdx = currentStreamingIdx;
        if (streamingIdx < 0 || streamingIdx >= prev.length) return prev;

        // Build dedupe sets from what is already in the list (live inserts).
        const presentToolUse = new Set<string>();
        const presentToolUseSignatures = new Set<string>();
        const presentToolResult = new Set<string>();
        const presentTexts = new Set<string>();
        for (const m of prev) {
          const blocks = options.extractRawBlocks(m.raw);
          for (const id of toolUseIdsOf(blocks)) presentToolUse.add(id);
          for (const signature of toolUseSignaturesOf(blocks)) presentToolUseSignatures.add(signature);
          for (const id of toolResultIdsOf(blocks)) presentToolResult.add(id);
          if (m.type === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
            presentTexts.add(m.content.trim());
          }
        }

        // Only append intermediate entries that are genuinely missing.
        const toInsert: import('../../../types').ClaudeMessage[] = [];
        for (let i = 0; i < insertCount; i++) {
          const rawMsg = turnMsgs[i] as import('../../../types').ClaudeRawMessage;
          const contentArr = contentOf(rawMsg);
          const tuIds = toolUseIdsOf(contentArr);
          const tuSignatures = toolUseSignaturesOf(contentArr);
          const trIds = toolResultIdsOf(contentArr);

          if (tuIds.length > 0) {
            const idsAlreadyPresent = tuIds.every((id) => presentToolUse.has(id));
            const signaturesAlreadyPresent = tuSignatures.length > 0 && tuSignatures.every((signature) => presentToolUseSignatures.has(signature));
            if (idsAlreadyPresent || signaturesAlreadyPresent) continue;
            tuIds.forEach((id) => presentToolUse.add(id));
            tuSignatures.forEach((signature) => presentToolUseSignatures.add(signature));
            toInsert.push({
              type: 'assistant',
              content: extractText(contentArr),
              raw: rawMsg,
              timestamp: new Date().toISOString(),
            });
          } else if (trIds.length > 0) {
            if (trIds.every((id) => presentToolResult.has(id))) continue;
            trIds.forEach((id) => presentToolResult.add(id));
            toInsert.push({
              type: 'user',
              content: '[tool_result]',
              raw: rawMsg,
              timestamp: new Date().toISOString(),
            });
          } else {
            const text = extractText(contentArr);
            if (!text || presentTexts.has(text)) continue;
            presentTexts.add(text);
            toInsert.push({
              type: 'assistant',
              content: text,
              raw: rawMsg,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Patch the streaming slot with the last assistant's raw blocks so
        // StatusPanel hooks can scan them — but not when that assistant is a
        // tool_use already inserted live (the trailing slot is an empty follow-on
        // slot in that case, and patching would duplicate the card).
        const lastTurnAsst = turnMsgs[lastTurnAsstIdx] as import('../../../types').ClaudeRawMessage;
        const lastTuIds = toolUseIdsOf(contentOf(lastTurnAsst));
        const lastTuSignatures = toolUseSignaturesOf(contentOf(lastTurnAsst));
        const lastAlreadyInserted =
          (lastTuIds.length > 0 && lastTuIds.every((id) => presentToolUse.has(id))) ||
          (lastTuSignatures.length > 0 && lastTuSignatures.every((signature) => presentToolUseSignatures.has(signature)));
        const patchedStreaming: import('../../../types').ClaudeMessage = lastAlreadyInserted
          ? prev[streamingIdx]
          : { ...prev[streamingIdx], raw: lastTurnAsst };

        if (toInsert.length === 0 && lastAlreadyInserted) return prev;

        // The streaming slot moves right by the number of freshly inserted entries;
        // keep the ref in sync so onStreamEnd finalizes the correct slot. This runs
        // in a separate task from onStreamEnd, so writing here is visible in time,
        // and it is deterministic given `prev` (safe under StrictMode).
        streamingMessageIndexRef.current = streamingIdx + toInsert.length;

        if (toInsert.length === 0) {
          const next = [...prev];
          next[streamingIdx] = patchedStreaming;
          return next;
        }

        return [
          ...prev.slice(0, streamingIdx),
          ...toInsert,
          patchedStreaming,
          ...prev.slice(streamingIdx + 1),
        ];
      });
    } catch { /* ignore parse errors */ }
  };

  // Block reset callback — clears streaming content refs when a new assistant
  // message starts within an ongoing stream (e.g., after tool_use loop iteration).
  // This prevents cross-turn content merging where new thinking/text deltas
  // would append to previous turn's buffered content.
  window.onBlockReset = () => {
    if (!isStreamingRef.current) {
      // Stream not active, ignore (could be stale signal after stream ended)
      return;
    }
    // Clear content buffers - new deltas will start fresh
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    // Intentionally NOT resetting streamingMessageIndexRef here: the backend will
    // send a new updateMessages snapshot for this turn, which will eventually set
    // the correct index via the isStaleSnapshot guard. Resetting the index now
    // would leave a window where incoming deltas have nowhere to land.
    // Reset throttle timeouts to ensure clean state for new deltas
    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }
    // Reset last update timestamps to prevent throttle delays
    lastContentUpdateRef.current = 0;
    lastThinkingUpdateRef.current = 0;
    // Clear auto-expanded thinking keys for the new turn
    autoExpandedThinkingKeysRef.current.clear();
  };
}
