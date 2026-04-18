/**
 * streamingCallbacks.ts
 *
 * Registers window bridge callbacks for streaming:
 * onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd, onPermissionDenied.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { sendBridgeEvent } from '../../../utils/bridge';
import { THROTTLE_INTERVAL } from '../../useStreamingMessages';
import { releaseSessionTransition } from '../sessionTransition';

/**
 * Timeout (ms) for detecting a stalled stream.  If no content/thinking delta
 * arrives for this duration while isStreamingRef is still true, the frontend
 * auto-recovers by forcing the stream-end cleanup.
 */
const STREAM_STALL_TIMEOUT_MS = 60_000;
const STREAM_STALL_CHECK_INTERVAL_MS = 5_000;

export function registerStreamingCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    setMessages,
    setStreamingActive,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setExpandedThinking,
    streamingContentRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingTextSegmentsRef,
    activeTextSegmentIndexRef,
    streamingThinkingSegmentsRef,
    activeThinkingSegmentIndexRef,
    seenToolUseCountRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    turnIdCounterRef,
    lastContentUpdateRef,
    contentUpdateTimeoutRef,
    lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,
    currentProviderRef,
  } = options;

  // ── Stream stall watchdog ──
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
      const elapsed = Date.now() - (window.__lastStreamActivityAt ?? 0);
      if (elapsed >= STREAM_STALL_TIMEOUT_MS) {
        console.warn(
          `[StreamWatchdog] Stream stalled for ${elapsed}ms — forcing stream-end recovery`,
        );
        clearStallWatchdog();
        if (typeof window.onStreamEnd === 'function') {
          window.onStreamEnd();
        }
      }
    }, STREAM_STALL_CHECK_INTERVAL_MS);
  };

  const extractTextFromBlocks = (blocks: any[]): string => {
    if (!Array.isArray(blocks)) return '';
    const parts: string[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
        continue;
      }
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          parts.push(block.content);
          continue;
        }
        if (Array.isArray(block.content)) {
          const contentText = block.content
            .map((it: any) => (typeof it?.text === 'string' ? it.text : ''))
            .filter(Boolean)
            .join('\n');
          if (contentText) parts.push(contentText);
        }
      }
    }
    return parts.join('\n').trim();
  };

  const readBlocksFromRaw = (raw: unknown): any[] => {
    if (!raw || typeof raw !== 'object') return [];
    const rawObj = raw as Record<string, unknown>;
    const direct = rawObj.content;
    if (Array.isArray(direct)) return direct;
    const nested = (rawObj.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(nested)) return nested;
    return [];
  };

  const mergeAssistantBlocks = (existingBlocks: any[], incomingBlocks: any[]): any[] => {
    if (!Array.isArray(existingBlocks) || existingBlocks.length === 0) return incomingBlocks;
    if (!Array.isArray(incomingBlocks) || incomingBlocks.length === 0) return existingBlocks;

    const merged = [...existingBlocks];
    for (const block of incomingBlocks) {
      if (!block || typeof block !== 'object') continue;
      const type = (block as { type?: string }).type;
      // Streaming text/thinking is handled by onContentDelta/onThinkingDelta.
      // Do NOT merge snapshot text/thinking from onMessage, otherwise blocks
      // can accumulate and make content appear garbled after collapsing thinking.
      if (type === 'text' || type === 'thinking') {
        continue;
      }

      // Keep tool blocks, but avoid duplicate insertion.
      if (type === 'tool_use') {
        const id = String((block as { id?: string }).id ?? '');
        if (id) {
          const exists = merged.some((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use' && String((b as { id?: string }).id ?? '') === id);
          if (exists) continue;
        }
      }
      if (type === 'tool_result') {
        const toolUseId = String((block as { tool_use_id?: string }).tool_use_id ?? '');
        if (toolUseId) {
          const exists = merged.some((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result' && String((b as { tool_use_id?: string }).tool_use_id ?? '') === toolUseId);
          if (exists) continue;
        }
      }

      merged.push(block);
    }
    return merged;
  };

  const mergeStreamingText = (existing: string, incoming: string): string => {
    const prev = existing || '';
    const next = incoming || '';
    if (!next) return prev;
    if (!prev) return next;
    if (next === prev) return prev;
    if (next.trim() === prev.trim()) return prev; // same content, ignore whitespace diff
    if (next.startsWith(prev)) return next; // backend sends full snapshot
    if (next.trimStart().startsWith(prev.trimEnd())) return next; // snapshot with whitespace
    if (prev.endsWith(next)) return prev;   // duplicated tail
    if (prev.trimEnd().endsWith(next.trimStart())) return prev; // dup tail with whitespace
    const needNewline = !prev.endsWith('\n') && !next.startsWith('\n');
    return `${prev}${needNewline ? '\n' : ''}${next}`;
  };

  window.onMessage = (payload: string) => {
    if (window.__sessionTransitioning) return;
    if (currentProviderRef.current !== 'codex') return;
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    const type = parsed?.type;
    const message = parsed?.message && typeof parsed.message === 'object' ? parsed.message : parsed;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = extractTextFromBlocks(blocks);

    if (type !== 'assistant' && type !== 'user') {
      return;
    }

    setMessages((prev) => {
      const next = [...prev];
      const msg = {
        type,
        content: text,
        raw: message,
        timestamp: new Date().toISOString(),
      };

      // During streaming, assistant MESSAGE payload should patch the current in-flight assistant item.
      if (type === 'assistant' && isStreamingRef.current) {
        const idx = streamingMessageIndexRef.current;
        if (idx >= 0 && idx < next.length && next[idx]?.type === 'assistant') {
          const previousContent = typeof next[idx].content === 'string' ? next[idx].content : '';
          const mergedContent = mergeStreamingText(previousContent, text);
          streamingContentRef.current = mergedContent;

          const currentRaw = (next[idx].raw && typeof next[idx].raw === 'object')
            ? next[idx].raw as Record<string, unknown>
            : { message: { content: [] } };
          const existingBlocks = readBlocksFromRaw(currentRaw);
          const incomingBlocks = Array.isArray(message?.content) ? message.content : [];
          const mergedBlocks = mergeAssistantBlocks(existingBlocks, incomingBlocks);
          const mergedMessage = {
            ...((currentRaw.message && typeof currentRaw.message === 'object') ? currentRaw.message as Record<string, unknown> : {}),
            ...(message && typeof message === 'object' ? message as Record<string, unknown> : {}),
            content: mergedBlocks,
          };

          next[idx] = {
            ...next[idx],
            content: mergedContent || (next[idx].content || ''),
            raw: {
              ...currentRaw,
              message: mergedMessage,
              content: mergedBlocks,
            },
            isStreaming: true,
          };
          return next;
        }
      }

      next.push(msg);
      return next;
    });
  };

  window.onStreamStart = () => {
    if (window.__sessionTransitioning) return;
    streamingContentRef.current = '';
    isStreamingRef.current = true;
    startStallWatchdog();
    useBackendStreamingRenderRef.current = false;
    autoExpandedThinkingKeysRef.current.clear();
    setStreamingActive(true);
    streamingTextSegmentsRef.current = [];
    activeTextSegmentIndexRef.current = -1;
    streamingThinkingSegmentsRef.current = [];
    activeThinkingSegmentIndexRef.current = -1;
    seenToolUseCountRef.current = 0;

    // FIX: Always reset streamingMessageIndexRef regardless of backend streaming mode
    streamingMessageIndexRef.current = -1;
    turnIdCounterRef.current += 1;
    streamingTurnIdRef.current = turnIdCounterRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === 'assistant' && last?.isStreaming) {
        streamingMessageIndexRef.current = prev.length - 1;
        const updated = [...prev];
        updated[prev.length - 1] = { ...updated[prev.length - 1], __turnId: streamingTurnIdRef.current };
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

  window.onContentDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingContentRef.current += delta;
    activeThinkingSegmentIndexRef.current = -1;

    if (activeTextSegmentIndexRef.current < 0) {
      activeTextSegmentIndexRef.current = streamingTextSegmentsRef.current.length;
      streamingTextSegmentsRef.current.push('');
    }
    streamingTextSegmentsRef.current[activeTextSegmentIndexRef.current] += delta;

    const now = Date.now();
    const timeSinceLastUpdate = now - lastContentUpdateRef.current;

    const updateMessages = () => {
      const currentContent = streamingContentRef.current;
      setMessages((prev) => {
        const newMessages = [...prev];
        let idx: number;
        if (useBackendStreamingRenderRef.current) {
          idx = streamingMessageIndexRef.current;
          // Index is still -1: backend hasn't created the assistant via updateMessages yet
          if (idx < 0) return prev;
        } else {
          idx = getOrCreateStreamingAssistantIndex(newMessages);
        }

        if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
          newMessages[idx] = patchAssistantForStreaming({
            ...newMessages[idx],
            content: currentContent,
            isStreaming: true,
          });
        }
        return newMessages;
      });
    };

    if (timeSinceLastUpdate >= THROTTLE_INTERVAL) {
      lastContentUpdateRef.current = now;
      updateMessages();
    } else {
      if (!contentUpdateTimeoutRef.current) {
        const remainingTime = THROTTLE_INTERVAL - timeSinceLastUpdate;
        contentUpdateTimeoutRef.current = setTimeout(() => {
          contentUpdateTimeoutRef.current = null;
          lastContentUpdateRef.current = Date.now();
          updateMessages();
        }, remainingTime);
      }
    }
  };

  // Heartbeat callback — keeps the stall watchdog alive during long tool execution
  window.onStreamingHeartbeat = () => {
    window.__lastStreamActivityAt = Date.now();
  };

  window.onThinkingDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    activeTextSegmentIndexRef.current = -1;

    let forceUpdate = false;
    if (activeThinkingSegmentIndexRef.current < 0) {
      activeThinkingSegmentIndexRef.current = streamingThinkingSegmentsRef.current.length;
      streamingThinkingSegmentsRef.current.push('');
      forceUpdate = true;
    }
    streamingThinkingSegmentsRef.current[activeThinkingSegmentIndexRef.current] += delta;

    const now = Date.now();
    const timeSinceLastUpdate = now - lastThinkingUpdateRef.current;

    const updateMessages = () => {
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
    };

    if (forceUpdate || timeSinceLastUpdate >= THROTTLE_INTERVAL) {
      lastThinkingUpdateRef.current = now;
      updateMessages();
    } else {
      if (!thinkingUpdateTimeoutRef.current) {
        const remainingTime = THROTTLE_INTERVAL - timeSinceLastUpdate;
        thinkingUpdateTimeoutRef.current = setTimeout(() => {
          thinkingUpdateTimeoutRef.current = null;
          lastThinkingUpdateRef.current = Date.now();
          updateMessages();
        }, remainingTime);
      }
    }
  };

  window.onStreamEnd = () => {
    if (window.__sessionTransitioning) return;
    // Notify backend about stream completion for tab status indicator
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

    // Release bridge ownership — stream is complete, other tabs can now send messages
    if (window.__ccg_releaseBridge) {
      window.__ccg_releaseBridge();
    }

    // Clear pending throttle timeouts — their content is already in streamingContentRef
    if (contentUpdateTimeoutRef.current) {
      clearTimeout(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current) {
      clearTimeout(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }

    // Snapshot keys that need collapsing BEFORE they are cleared inside the updater.
    const keysToCollapse = new Set(autoExpandedThinkingKeysRef.current);

    // Flush final content AND clear streaming refs inside the same updater.
    // This ensures any previously queued setMessages updater (e.g. from
    // updateMessages) still reads valid refs when it executes, because React
    // processes updaters in enqueue order.
    setMessages((prev) => {
      let newMessages = prev;
      const idx = streamingMessageIndexRef.current;
      if (prev.length > 0 && idx >= 0 && idx < prev.length && prev[idx]?.type === 'assistant') {
        const finalContent = streamingContentRef.current;
        newMessages = [...prev];
        newMessages[idx] = {
          ...newMessages[idx],
          content: finalContent || newMessages[idx].content,
          isStreaming: false,
        };
      }

      // Clear all streaming refs AFTER flushing content, inside the updater
      isStreamingRef.current = false;
      useBackendStreamingRenderRef.current = false;
      streamingMessageIndexRef.current = -1;
      streamingTurnIdRef.current = -1;
      streamingContentRef.current = '';
      streamingTextSegmentsRef.current = [];
      activeTextSegmentIndexRef.current = -1;
      streamingThinkingSegmentsRef.current = [];
      activeThinkingSegmentIndexRef.current = -1;
      seenToolUseCountRef.current = 0;
      autoExpandedThinkingKeysRef.current.clear();

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

    // Clear stall watchdog and cancel any pending RAF update
    clearStallWatchdog();
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }
    // Release bridge ownership
    if (typeof window.__ccg_releaseBridge === 'function') {
      window.__ccg_releaseBridge();
    }

    // FIX: onStreamEnd is the authoritative signal that streaming has ended.
    // Reset loading state here to prevent race conditions where showLoading("false")
    // arrives before onStreamEnd and gets ignored by the isStreamingRef guard,
    // while the flush callback's showLoading("false") may be delayed or lost
    // (e.g., due to slow message serialization or multi-hop async chains).
    setLoading(false);
    setLoadingStartTime(null);
    setIsThinking(false);

    // Safety net: if __sessionTransitioning was stuck (e.g. setSessionId never fired),
    // release it now so updateMessages and future content deltas are not blocked.
    if (window.__sessionTransitioning) {
      releaseSessionTransition();
    }
  };

  // Permission denied callback — marks incomplete tool calls as "interrupted"
  window.onPermissionDenied = () => {
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }

    const idsToAdd: string[] = [];

    setMessages((currentMessages) => {
      try {
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (msg.type === 'assistant' && msg.raw) {
            const rawObj = typeof msg.raw === 'string' ? JSON.parse(msg.raw) : msg.raw;
            const content = rawObj.content || rawObj.message?.content;

            if (Array.isArray(content)) {
              const toolUses = content.filter(
                (block: { type?: string; id?: string }) =>
                  block.type === 'tool_use' && block.id,
              ) as Array<{ type: string; id: string; name?: string }>;

              if (toolUses.length > 0) {
                const nextMsg = currentMessages[i + 1];
                const existingResultIds = new Set<string>();

                if (nextMsg?.type === 'user' && nextMsg.raw) {
                  const nextRaw =
                    typeof nextMsg.raw === 'string' ? JSON.parse(nextMsg.raw) : nextMsg.raw;
                  const nextContent = nextRaw.content || nextRaw.message?.content;
                  if (Array.isArray(nextContent)) {
                    nextContent.forEach((block: { type?: string; tool_use_id?: string }) => {
                      if (block.type === 'tool_result' && block.tool_use_id) {
                        existingResultIds.add(block.tool_use_id);
                      }
                    });
                  }
                }

                for (const tu of toolUses) {
                  if (!existingResultIds.has(tu.id)) {
                    idsToAdd.push(tu.id);
                  }
                }

                break;
              }
            }
          }
        }
      } catch (e) {
        console.error('[Frontend] Error in onPermissionDenied:', e);
      }

      return [...currentMessages];
    });

    for (const id of idsToAdd) {
      window.__deniedToolIds!.add(id);
    }
  };

  // Handle send errors (e.g. API key not configured, network errors)
  window.onSendError = (content: string) => {
    if (window.__sessionTransitioning) return;
    let errorMsg = content;
    try {
      const parsed = JSON.parse(content);
      errorMsg = parsed.error || parsed.message || content;
    } catch { /* use raw content */ }
    options.addToast(errorMsg, 'error');
    options.setLoading(false);
    options.setLoadingStartTime(null);
    options.setIsThinking(false);
    isStreamingRef.current = false;
    options.setStreamingActive(false);
    if (window.__ccg_releaseBridge) {
      window.__ccg_releaseBridge();
    }
  };
}
