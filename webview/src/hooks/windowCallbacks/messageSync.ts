/**
 * messageSync.ts
 *
 * Pure utility functions for message identity preservation, optimistic message
 * handling, and streaming content repair.  These functions have no React state
 * dependencies and receive everything they need via parameters.
 */

import type { MutableRefObject } from 'react';
import type { ClaudeContentOrResultBlock, ClaudeMessage, ClaudeRawMessage } from '../../types';
import { stripInjectedContextTags } from '../../utils/contentBlockNormalize';

/** Time window (ms) for matching optimistic messages with backend messages. */
export const OPTIMISTIC_MESSAGE_TIME_WINDOW = 5000;

export const getStreamEndHandlingMode = (
  provider: string,
  isStreaming: boolean,
  currentTurnId: number,
): 'full' | 'minimal' | 'skip' => {
  if (isStreaming || currentTurnId > 0) {
    return 'full';
  }
  if (provider === 'codex') {
    return 'minimal';
  }
  return 'skip';
};

// ---------------------------------------------------------------------------
// Raw-field helpers
// ---------------------------------------------------------------------------

export const getRawUuid = (msg: ClaudeMessage | undefined): string | undefined => {
  const raw = msg?.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const rawObj = raw as Record<string, unknown>;
  return typeof rawObj.uuid === 'string' ? rawObj.uuid : undefined;
};

export const stripUuidFromRaw = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const rawObj = raw as any;
  if (!('uuid' in rawObj)) return raw;
  const { uuid: _uuid, ...rest } = rawObj;
  return rest;
};

const sanitizeUserContentBlocks = (blocks: unknown[]): unknown[] => {
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return block;
      const candidate = block as Record<string, unknown>;
      if (candidate.type !== 'text') return block;
      const text = stripInjectedContextTags(typeof candidate.text === 'string' ? candidate.text : '');
      return { ...candidate, text };
    })
    .filter((block) => {
      if (!block || typeof block !== 'object') return true;
      const candidate = block as Record<string, unknown>;
      return candidate.type !== 'text' || Boolean(candidate.text);
    });
};

const parseDataImageSource = (value: unknown): { mediaType: string; data: string } | null => {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return null;
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value);
  if (!match) return null;
  return { mediaType: match[1] || '', data: match[2] || '' };
};

const imageBlockIdentity = (block: Record<string, any>): string => {
  const source = block.source && typeof block.source === 'object' ? block.source : undefined;
  const srcData = parseDataImageSource(block.src);
  const sourceData = typeof source?.data === 'string'
    ? {
        mediaType: typeof source.media_type === 'string' ? source.media_type : '',
        data: source.data,
      }
    : null;
  const dataImage = sourceData ?? srcData;
  if (dataImage?.data) {
    return `image:data:${dataImage.mediaType}:${dataImage.data}`;
  }
  const url = block.src ?? source?.url ?? block.path ?? '';
  return `image:ref:${url}:${block.mediaType ?? source?.media_type ?? ''}`;
};

const structuralContentBlockKey = (block: unknown): string | null => {
  if (!block || typeof block !== 'object') return null;
  const candidate = block as Record<string, any>;
  if (candidate.type === 'image') {
    return imageBlockIdentity(candidate);
  }
  if (candidate.type === 'attachment') {
    return `attachment:${candidate.fileName ?? candidate.name ?? ''}:${candidate.mediaType ?? ''}`;
  }
  return null;
};

const dedupeStructuralContentBlocks = <T extends unknown[]>(blocks: T): T => {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = structuralContentBlockKey(block);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) as T;
};

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

/**
 * Merge identity fields (timestamp, uuid) from prevMsg into nextMsg so that
 * React referential equality checks remain stable across backend re-sends.
 */
export const preserveMessageIdentity = (
  prevMsg: ClaudeMessage | undefined,
  nextMsg: ClaudeMessage,
): ClaudeMessage => {
  if (!prevMsg?.timestamp) return nextMsg;
  if (prevMsg.type !== nextMsg.type) return nextMsg;

  const prevUuid = getRawUuid(prevMsg);
  const nextUuid = getRawUuid(nextMsg);

  const nextWithStableTimestamp =
    nextMsg.timestamp === prevMsg.timestamp
      ? nextMsg
      : { ...nextMsg, timestamp: prevMsg.timestamp };

  if (!prevUuid && nextUuid) {
    return {
      ...nextWithStableTimestamp,
      raw: stripUuidFromRaw(nextWithStableTimestamp.raw) as any,
    };
  }

  return nextWithStableTimestamp;
};

/**
 * If the previous list ended with an optimistic user message that has not yet
 * been matched by a backend message, keep it appended to nextList.
 * Also merges attachment blocks from the optimistic message into the matched
 * backend message so non-image file attachments remain visible.
 */
export const appendOptimisticMessageIfMissing = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
): ClaudeMessage[] => {
  const lastPrev = prevList[prevList.length - 1];
  if (!lastPrev?.isOptimistic) return nextList;

  const optimisticMsg = lastPrev;
  const optimisticText = getUserMessageComparableContent(optimisticMsg);
  const optimisticTime = getMessageTimestampMs(optimisticMsg) ?? Number.NaN;

  const matchFn = (m: ClaudeMessage) => {
    if (m.type !== 'user') return false;
    if (getUserMessageComparableContent(m) !== optimisticText) return false;
    const candidateTime = getMessageTimestampMs(m) ?? Number.NaN;
    if (!Number.isFinite(candidateTime) || !Number.isFinite(optimisticTime)) return false;
    return Math.abs(candidateTime - optimisticTime) < OPTIMISTIC_MESSAGE_TIME_WINDOW;
  };

  let matchedIndex = nextList.findIndex(matchFn);
  if (matchedIndex < 0 && optimisticText) {
    for (let i = nextList.length - 1; i >= 0; i -= 1) {
      const candidate = nextList[i];
      if (candidate?.type !== 'user') continue;
      if (getUserMessageComparableContent(candidate) !== optimisticText) continue;
      const candidateTime = getMessageTimestampMs(candidate) ?? Number.NaN;
      // Allow match when candidate is within time window (even if older than optimistic).
      // This handles cases where Java's timestamp (number format) may differ from
      // frontend's ISO string format due to clock skew or async processing delays.
      // Reject only if candidate is significantly older (> time window) to avoid
      // matching historical duplicate messages.
      if (Number.isFinite(optimisticTime) && Number.isFinite(candidateTime) &&
          optimisticTime - candidateTime > OPTIMISTIC_MESSAGE_TIME_WINDOW) {
        continue;
      }
      matchedIndex = i;
      break;
    }
  }
  if (matchedIndex < 0) {
    // Guard against stale backend updates: if the optimistic message was
    // created after the newest message in nextList, this update was
    // generated before the user sent the message — a future update will
    // include it. Don't append, otherwise the UI shows a duplicate until
    // the real update arrives.
    if (nextList.length > 0 && Number.isFinite(optimisticTime)) {
      let maxNextTime = 0;
      for (const m of nextList) {
        const ts = getMessageTimestampMs(m) ?? 0;
        if (Number.isFinite(ts) && ts > maxNextTime) {
          maxNextTime = ts;
        }
      }
      if (maxNextTime > 0 && optimisticTime > maxNextTime) {
        return nextList;
      }
    }
    return [...nextList, optimisticMsg];
  }

  // Backend message matched the optimistic message. Preserve structural blocks
  // from the optimistic message into the backend message's raw data; otherwise
  // attachments and images may disappear until the backend/history payload
  // includes equivalent rich blocks.
  const optimisticRaw = optimisticMsg.raw as any;
  const optimisticContent: unknown[] | undefined = optimisticRaw?.message?.content;
  if (Array.isArray(optimisticContent)) {
    const structuralBlocks = optimisticContent.filter(
      (b: any) => b && typeof b === 'object' && (b.type === 'attachment' || b.type === 'image'),
    );
    if (structuralBlocks.length > 0) {
      const backendMsg = nextList[matchedIndex];
      const backendRaw = (backendMsg.raw ?? {}) as any;
      const backendContent: unknown[] = Array.isArray(backendRaw?.message?.content)
        ? backendRaw.message.content
        : Array.isArray(backendRaw?.content)
          ? backendRaw.content
          : [];
      const mergedContent = dedupeStructuralContentBlocks([
        ...structuralBlocks,
        ...sanitizeUserContentBlocks(backendContent),
      ]);
      const mergedRaw = {
        ...backendRaw,
        message: { ...(backendRaw?.message ?? {}), content: mergedContent },
      };
      const result = [...nextList];
      result[matchedIndex] = { ...backendMsg, raw: mergedRaw };
      return result;
    }
  }

  return nextList;
};

const hasRichUserRawData = (message: ClaudeMessage): boolean => {
  if (!message.raw || typeof message.raw !== 'object') return false;
  const rawObj = message.raw as Record<string, unknown>;
  if (typeof rawObj.uuid === 'string' && rawObj.uuid) return true;
  const messageObj = rawObj.message;
  if (!messageObj || typeof messageObj !== 'object') return false;
  const content = (messageObj as { content?: unknown }).content;
  return Array.isArray(content) && content.length > 0;
};

const isPromptLikeUserMessage = (message: ClaudeMessage): boolean => {
  if (message.type !== 'user') return false;
  const blocks = getMessageContentArray(message);
  if (blocks.length === 0) {
    return typeof message.content === 'string' && message.content.trim().length > 0;
  }
  return blocks.every((block) => block.type === 'text' || block.type === 'image' || block.type === 'attachment');
};

const structuralUserBlocks = (message: ClaudeMessage): ClaudeContentOrResultBlock[] => {
  return getMessageContentArray(message).filter(
    (block) => block.type === 'image' || block.type === 'attachment',
  );
};

const structuralBlockKey = (block: ClaudeContentOrResultBlock): string => {
  if (block.type === 'image') {
    return imageBlockIdentity(block as any);
  }
  if (block.type === 'attachment') {
    const raw = block as any;
    return `attachment:${raw.fileName ?? raw.name ?? ''}:${raw.mediaType ?? ''}`;
  }
  return block.type;
};

const mergeUserStructuralBlocks = (preferred: ClaudeMessage, other: ClaudeMessage): ClaudeMessage => {
  const structural = [...structuralUserBlocks(preferred), ...structuralUserBlocks(other)];
  if (structural.length === 0) return preferred;

  const seen = new Set<string>();
  const uniqueStructural = structural.filter((block) => {
    const key = structuralBlockKey(block);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const raw = preferred.raw && typeof preferred.raw === 'object' ? preferred.raw as any : {};
  const existingContent: ClaudeContentOrResultBlock[] = Array.isArray(raw?.message?.content)
    ? raw.message.content
    : Array.isArray(raw?.content)
      ? raw.content
      : [];
  const textBlocks = existingContent
    .filter((block) => block?.type !== 'image' && block?.type !== 'attachment')
    .map((block) => {
      if (block?.type !== 'text') return block;
      const text = stripInjectedContextTags(typeof block.text === 'string' ? block.text : '');
      return { ...block, text };
    })
    .filter((block) => block?.type !== 'text' || Boolean(block.text));
  if (textBlocks.length === 0) {
    const text = getUserMessageComparableContent(preferred);
    if (text) {
      textBlocks.push({ type: 'text', text });
    }
  }
  const mergedRaw = {
    ...raw,
    message: { ...(raw?.message ?? {}), content: [...uniqueStructural, ...textBlocks] },
  };
  return { ...preferred, raw: mergedRaw as ClaudeRawMessage };
};

const choosePreferredAdjacentUserMessage = (
  first: ClaudeMessage,
  second: ClaudeMessage,
): ClaudeMessage => {
  const score = (message: ClaudeMessage): number => {
    let total = 0;
    if (!message.isOptimistic) total += 4;
    if (hasRichUserRawData(message)) total += 2;
    if (getRawUuid(message)) total += 1;
    return total;
  };

  return score(second) >= score(first) ? second : first;
};

export const dedupeAdjacentUserMessages = (messages: ClaudeMessage[]): ClaudeMessage[] => {
  if (messages.length < 2) return messages;

  const deduped: ClaudeMessage[] = [];

  for (const current of messages) {
    const previous = deduped[deduped.length - 1];
    if (!previous) {
      deduped.push(current);
      continue;
    }

    if (!isPromptLikeUserMessage(previous) || !isPromptLikeUserMessage(current)) {
      deduped.push(current);
      continue;
    }

    const previousText = getUserMessageComparableContent(previous);
    const currentText = getUserMessageComparableContent(current);
    if (!previousText || previousText !== currentText) {
      deduped.push(current);
      continue;
    }

    const previousTime = getMessageTimestampMs(previous);
    const currentTime = getMessageTimestampMs(current);
    const isLikelyDuplicate =
      previous.isOptimistic === true ||
      current.isOptimistic === true ||
      (!Number.isFinite(previousTime ?? Number.NaN) || !Number.isFinite(currentTime ?? Number.NaN)) ||
      Math.abs((previousTime ?? 0) - (currentTime ?? 0)) <= OPTIMISTIC_MESSAGE_TIME_WINDOW;

    if (!isLikelyDuplicate) {
      deduped.push(current);
      continue;
    }

    const chosen = choosePreferredAdjacentUserMessage(previous, current);
    const preferred = mergeUserStructuralBlocks(chosen, chosen === previous ? current : previous);
    const mergedTimestamp = preferred.timestamp ?? current.timestamp ?? previous.timestamp;
    deduped[deduped.length - 1] = {
      ...preferred,
      timestamp: mergedTimestamp,
    };
    console.debug('[CCG_DEBUG] dedupeAdjacentUserMessages collapsed duplicate user message', {
      textPreview: previousText.slice(0, 80),
      keptOptimistic: preferred.isOptimistic === true,
    });
  }

  return deduped;
};

/**
 * Extract comparable text content from a user message for deduplication matching.
 * Handles both direct content string and raw.message.content array format.
 */
const getUserMessageComparableContent = (message: ClaudeMessage): string => {
  if (message.type !== 'user') return message.content || '';
  const rawContent = (message.raw as any)?.message?.content ?? (message.raw as any)?.content;
  if (!Array.isArray(rawContent)) {
    return stripInjectedContextTags(message.content || '');
  }
  const rawText = rawContent
    .filter((block: any) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');
  return stripInjectedContextTags(rawText || message.content || '');
};

/**
 * Extract timestamp from a message, handling both formats:
 * - Java Message.timestamp: number (milliseconds)
 * - SDK message.raw.timestamp: string (ISO format)
 *
 * Returns milliseconds since epoch for consistent comparison.
 */
export const getMessageTimestampMs = (message: ClaudeMessage): number | undefined => {
  // First check the raw.timestamp field (SDK source, ISO string format)
  const rawTimestamp = (message.raw as any)?.timestamp;
  if (rawTimestamp != null) {
    if (typeof rawTimestamp === 'string') {
      const parsed = new Date(rawTimestamp).getTime();
      if (Number.isFinite(parsed)) return parsed;
    } else if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
      // Raw timestamp might already be milliseconds (numeric)
      return rawTimestamp;
    }
  }

  // Fall back to message.timestamp field (may be number from Java or string from frontend)
  const timestamp = message.timestamp;
  if (timestamp != null) {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp;
    } else if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
};

/**
 * Preserve the identity (timestamp / uuid) of the last assistant message
 * across list updates.
 */
export const preserveLastAssistantIdentity = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number,
): ClaudeMessage[] => {
  const prevAssistantIdx = findLastAssistantIndex(prevList);
  const nextAssistantIdx = findLastAssistantIndex(nextList);
  if (prevAssistantIdx < 0 || nextAssistantIdx < 0) return nextList;

  const prevAssistant = prevList[prevAssistantIdx];
  const nextAssistant = nextList[nextAssistantIdx];
  // Guard: do not merge identity across different streaming turns
  // Block when either side has __turnId and they differ
  if ((prevAssistant.__turnId !== undefined || nextAssistant.__turnId !== undefined) &&
      prevAssistant.__turnId !== nextAssistant.__turnId) {
    return nextList;
  }
  const stabilized = preserveMessageIdentity(prevAssistant, nextAssistant);
  if (stabilized === nextAssistant) return nextList;

  const copy = [...nextList];
  copy[nextAssistantIdx] = stabilized;
  return copy;
};

// ---------------------------------------------------------------------------
// Raw blocks merging during streaming
// ---------------------------------------------------------------------------

const isTextLikeBlock = (block: unknown): block is Record<string, unknown> => {
  if (!block || typeof block !== 'object') return false;
  const t = (block as Record<string, unknown>).type;
  return t === 'text' || t === 'thinking';
};

const getTextLikeLength = (block: Record<string, unknown>): number => {
  if (block.type === 'text') return typeof block.text === 'string' ? block.text.length : 0;
  if (block.type === 'thinking') {
    const t = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
    return t.length;
  }
  return 0;
};

const getTextLikeContent = (block: Record<string, unknown>): string => {
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
  if (block.type === 'thinking') {
    return typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
  }
  return '';
};

/**
 * Merge raw message blocks during active streaming so that the frontend's
 * accumulated segment text/thinking always wins over a stale backend snapshot,
 * while structural blocks (tool_use, tool_result, image, attachment) are
 * always taken from the backend (authoritative source for message structure).
 *
 * Matching is positional: the i-th text/thinking block in prevRaw is compared
 * against the i-th text/thinking block in nextRaw.
 *
 * Returns nextRaw unchanged (same reference) when no block needs protecting.
 */
export const mergeRawBlocksDuringStreaming = (
  prevRaw: unknown,
  nextRaw: unknown,
): unknown => {
  if (!prevRaw || typeof prevRaw !== 'object') return nextRaw;
  if (!nextRaw || typeof nextRaw !== 'object') return nextRaw;

  const prevObj = prevRaw as Record<string, unknown>;
  const nextObj = nextRaw as Record<string, unknown>;

  const prevMsg = prevObj.message as Record<string, unknown> | undefined;
  const nextMsg = nextObj.message as Record<string, unknown> | undefined;

  const prevBlocks: unknown[] = Array.isArray(prevMsg?.content)
    ? (prevMsg.content as unknown[])
    : Array.isArray(prevObj.content)
      ? (prevObj.content as unknown[])
      : [];

  const nextBlocks: unknown[] = Array.isArray(nextMsg?.content)
    ? (nextMsg.content as unknown[])
    : Array.isArray(nextObj.content)
      ? (nextObj.content as unknown[])
      : [];

  if (nextBlocks.length === 0) return nextRaw;

  let prevTextLikeIdx = 0;
  let changed = false;

  const mergedBlocks = nextBlocks.map((nextBlock) => {
    if (!isTextLikeBlock(nextBlock)) return nextBlock;

    // Advance to the next text-like block in prev
    while (prevTextLikeIdx < prevBlocks.length && !isTextLikeBlock(prevBlocks[prevTextLikeIdx])) {
      prevTextLikeIdx += 1;
    }

    const prevBlock = prevBlocks[prevTextLikeIdx] as Record<string, unknown> | undefined;
    prevTextLikeIdx += 1;

    if (!prevBlock) return nextBlock;

    const prevLen = getTextLikeLength(prevBlock);
    const nextLen = getTextLikeLength(nextBlock);
    if (prevLen <= nextLen) return nextBlock; // next is at least as long — keep it

    // prev is longer: use prev content, keep next block type and other fields
    changed = true;
    const prevContent = getTextLikeContent(prevBlock);
    if (nextBlock.type === 'thinking') {
      return { ...nextBlock, thinking: prevContent, text: prevContent };
    }
    return { ...nextBlock, text: prevContent };
  });

  if (!changed) return nextRaw;

  if (nextMsg !== undefined) {
    return { ...nextObj, message: { ...nextMsg, content: mergedBlocks } };
  }
  return { ...nextObj, content: mergedBlocks };
};

/**
 * When streaming is active, prevent the backend from replacing the streamed
 * content with a shorter (stale) snapshot.
 *
 * Guards both the top-level .content string AND .raw.message.content blocks:
 * - .content: protected when prev/buffered content is longer than backend's
 * - .raw blocks: text/thinking blocks are protected via mergeRawBlocksDuringStreaming
 *   regardless of .content string length, since MarkdownBlock renders from blocks.
 */
export const preserveStreamingAssistantContent = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  isStreamingRef: MutableRefObject<boolean>,
  streamingContentRef: MutableRefObject<string>,
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number,
  patchAssistantForStreaming: (msg: ClaudeMessage) => ClaudeMessage,
): ClaudeMessage[] => {
  if (!isStreamingRef.current) return nextList;

  const prevAssistantIdx = findLastAssistantIndex(prevList);
  const nextAssistantIdx = findLastAssistantIndex(nextList);
  if (prevAssistantIdx < 0 || nextAssistantIdx < 0) return nextList;

  const prevAssistant = prevList[prevAssistantIdx];
  const nextAssistant = nextList[nextAssistantIdx];
  if (prevAssistant.type !== 'assistant' || nextAssistant.type !== 'assistant') {
    return nextList;
  }

  // Guard: do not merge content across different streaming turns
  // Block when either side has __turnId and they differ
  if ((prevAssistant.__turnId !== undefined || nextAssistant.__turnId !== undefined) &&
      prevAssistant.__turnId !== nextAssistant.__turnId) {
    return nextList;
  }

  const previousContent = prevAssistant.content || '';
  const bufferedContent = streamingContentRef.current || '';
  const preferredContent =
    bufferedContent.length > previousContent.length ? bufferedContent : previousContent;
  const nextContent = nextAssistant.content || '';

  // Always protect raw blocks: text/thinking blocks use the longer value from prev,
  // structural blocks (tool_use etc.) always come from backend.
  const mergedRaw = mergeRawBlocksDuringStreaming(prevAssistant.raw, nextAssistant.raw);
  const rawChanged = mergedRaw !== nextAssistant.raw;

  if (!preferredContent || preferredContent.length <= nextContent.length) {
    // Content string doesn't need protection, but raw blocks might still be stale
    if (!rawChanged) return nextList;
    const copy = [...nextList];
    copy[nextAssistantIdx] = { ...nextAssistant, raw: mergedRaw as ClaudeMessage['raw'] };
    return copy;
  }

  const copy = [...nextList];
  // NOTE: patchAssistantForStreaming internally does content = max(delta, backend).
  // Here backend = preferredContent = max(streamingRef, prevContent), so the final
  // result is max(streamingRef, prevContent, nextContent) — content never goes backwards.
  copy[nextAssistantIdx] = patchAssistantForStreaming({
    ...nextAssistant,
    content: preferredContent,
    raw: mergedRaw as ClaudeMessage['raw'],
    isStreaming: true,
  });
  return copy;
};

const getMessageContentArray = (message: ClaudeMessage): ClaudeContentOrResultBlock[] => {
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') return [];

  const content = Array.isArray(raw.message?.content)
    ? raw.message.content
    : Array.isArray(raw.content)
      ? raw.content
      : [];

  return content.filter((entry): entry is ClaudeContentOrResultBlock => Boolean(entry) && typeof entry === 'object');
};

const getToolEventKey = (block: ClaudeContentOrResultBlock): string | null => {
  if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
    return `tool_use:${block.id}`;
  }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
    return `tool_result:${block.tool_use_id}`;
  }
  return null;
};

const getMessageToolEventKeys = (message: ClaudeMessage): string[] => {
  const keys = new Set<string>();
  for (const block of getMessageContentArray(message)) {
    const key = getToolEventKey(block);
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
};

const isToolOnlyMessage = (message: ClaudeMessage): boolean => {
  if (typeof message.content === 'string' && message.content.trim()) {
    return false;
  }
  const blocks = getMessageContentArray(message);
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_use' || block.type === 'tool_result');
};

export const stripDuplicateTrailingToolMessages = (
  nextList: ClaudeMessage[],
  provider: string,
): ClaudeMessage[] => {
  if (provider !== 'codex') return nextList;
  if (nextList.length === 0) return nextList;

  // Pre-compute keys per message once, then use a reference-count map so we
  // can walk backwards from the tail in O(n) total instead of rebuilding a
  // Set on every iteration.
  const allKeys = nextList.map((msg) => getMessageToolEventKeys(msg));
  const keyCounts = new Map<string, number>();
  for (const keys of allKeys) {
    for (const key of keys) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }

  let endIndex = nextList.length;
  while (endIndex > 0) {
    const lastMessage = nextList[endIndex - 1];
    if (!isToolOnlyMessage(lastMessage)) break;

    const candidateKeys = allKeys[endIndex - 1];
    if (candidateKeys.length === 0) break;

    // A key is duplicated if it appears more than once across all remaining messages.
    if (!candidateKeys.every((key) => (keyCounts.get(key) ?? 0) > 1)) {
      break;
    }

    // Decrement counts for the removed message's keys.
    for (const key of candidateKeys) {
      const count = keyCounts.get(key) ?? 0;
      if (count <= 1) {
        keyCounts.delete(key);
      } else {
        keyCounts.set(key, count - 1);
      }
    }

    endIndex--;
  }

  return endIndex === nextList.length ? nextList : nextList.slice(0, endIndex);
};

/**
 * When backend snapshots briefly shrink (e.g., Codex compaction or Claude
 * conversation summarization), preserve the newest in-memory turn locally
 * until the backend catches up, instead of wiping it from the UI.
 *
 * KEY FIX: Applies to all providers (not just Codex), and filters out
 * optimistic messages if nextList already contains a matching user message.
 * This prevents duplicate display after compact operation.
 */
export const preserveLatestMessagesOnShrink = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  provider: string,
): ClaudeMessage[] => {
  // Always check for shrink regardless of provider
  if (nextList.length >= prevList.length) return nextList;
  if (prevList.length === 0 || nextList.length === 0) return nextList;

  const preservedTail = prevList.slice(nextList.length);
  if (preservedTail.length === 0) return nextList;

  // Check if the preserved tail contains streaming/recent assistant messages
  const hasStreamingTail = preservedTail.some((msg) => msg.type === 'assistant' && (msg.isStreaming || !!msg.__turnId));
  const hasUserTail = preservedTail.some((msg) => msg.type === 'user');

  // Codex: always preserve shrink tail (handles compaction/summarization)
  // Other providers: only preserve if tail contains streaming/recent messages
  if (provider !== 'codex' && !hasStreamingTail && !hasUserTail) {
    return nextList;
  }

  // FIX: Filter out optimistic messages from preservedTail if nextList already
  // has a matching user message. This prevents duplicate display when compact
  // sends a shorter list but includes the backend version of the optimistic.
  const nextListUserTexts = new Set<string>();
  for (const msg of nextList) {
    if (msg.type === 'user') {
      const text = getUserMessageComparableContent(msg);
      if (text) nextListUserTexts.add(text);
    }
  }

  const filteredTail = preservedTail.filter((msg) => {
    // Always preserve assistant and other non-user messages
    if (msg.type !== 'user') return true;
    // Don't preserve optimistic if nextList has matching content
    if (msg.isOptimistic) {
      const optimisticText = getUserMessageComparableContent(msg);
      if (optimisticText && nextListUserTexts.has(optimisticText)) {
        return false; // Skip this optimistic to avoid duplicate
      }
    }
    return true;
  });

  if (filteredTail.length === 0) return nextList;
  return [...nextList, ...filteredTail];
};

// ---------------------------------------------------------------------------
// Streaming assistant preservation
// ---------------------------------------------------------------------------

/**
 * Ensure a streaming assistant message is not lost when updateMessages replaces
 * the entire message list.  Returns the (possibly amended) result list and the
 * index of the streaming assistant inside it.
 *
 * The function has two paths:
 * 1. Primary — refs are valid (normal streaming).
 * 2. Fallback — refs already cleared (race condition). Uses message-level
 *    `isStreaming` + `__turnId` markers to recover.
 */
export const ensureStreamingAssistantInList = (
  prevList: ClaudeMessage[],
  resultList: ClaudeMessage[],
  isStreaming: boolean,
  streamingTurnId: number,
): { list: ClaudeMessage[]; streamingIndex: number } => {
  // Primary path: refs are still valid
  if (isStreaming && streamingTurnId > 0) {
    const existingIdx = resultList.findIndex(
      (m) => m.__turnId === streamingTurnId && m.type === 'assistant',
    );
    if (existingIdx >= 0) {
      return { list: resultList, streamingIndex: existingIdx };
    }

    let streamingAssistant: ClaudeMessage | undefined;
    for (let i = prevList.length - 1; i >= 0; i--) {
      if (prevList[i].__turnId === streamingTurnId && prevList[i].type === 'assistant') {
        streamingAssistant = prevList[i];
        break;
      }
    }

    if (streamingAssistant) {
      const result = [...resultList, streamingAssistant];
      return { list: result, streamingIndex: result.length - 1 };
    }

    return { list: resultList, streamingIndex: -1 };
  }

  // Fallback path: refs already cleared (race condition).
  // Only consider the most recent streaming assistant in prevList.
  for (let i = prevList.length - 1; i >= 0; i--) {
    const msg = prevList[i];
    if (msg.type === 'assistant' && msg.isStreaming && msg.__turnId && msg.__turnId > 0) {
      const alreadyPresent = resultList.some((m) => {
        if (m.type !== 'assistant') return false;
        if (m.__turnId === msg.__turnId) return true;
        if (msg.timestamp && m.timestamp === msg.timestamp) return true;
        return false;
      });
      const assistantAlreadyAtOrAfterPosition =
        i < resultList.length && resultList.slice(i).some((m) => m.type === 'assistant');

      if (!alreadyPresent && !assistantAlreadyAtOrAfterPosition) {
        const result = [...resultList, msg];
        return { list: result, streamingIndex: result.length - 1 };
      }
      // Already in resultList — no recovery needed
      break;
    }
  }

  return { list: resultList, streamingIndex: -1 };
};

// ---------------------------------------------------------------------------
// Re-export ClaudeRawMessage so callers can use it without an extra import
// ---------------------------------------------------------------------------
export type { ClaudeRawMessage };
