/**
 * codexLiveInsert.ts
 *
 * Pure helpers for rendering tool cards *live* during a streaming turn.
 *
 * Both Codex and Claude deliver a turn as a sequence of `[MESSAGE]` events
 * (surfaced to the webview as `onMessage`): interleaved assistant-text,
 * assistant-tool_use, and user-tool_result messages. The running answer text
 * arrives via `content_delta` into a single streaming assistant slot, while the
 * structured tool_use / tool_result blocks only get materialised into the list
 * at the end of the turn (`onTurnMessages`). That is why, before this helper, the
 * process looked like one paragraph of text (or, for tool-only turns, an empty
 * panel) and only "snapped" into tool cards once the turn finished.
 *
 * The Codex/Claude shapes differ in one way that matters here: Codex sends
 * tool_use in its own message, whereas Claude packs narration text and tool_use
 * into the same assistant message. `applyCodexLiveMessage` accounts for that when
 * deciding whether the tool card should carry text (see the `slotHasText`
 * policy).
 *
 * `applyCodexLiveMessage` inserts each tool_use / tool_result message as soon as
 * it arrives, freezing the current text segment on a tool boundary and opening a
 * fresh streaming slot for the next segment — so the ordering matches what
 * `onTurnMessages` reconstructs at end-of-turn, but progressively.
 *
 * The function is pure: it never mutates its inputs and never touches refs. The
 * caller wires the returned index / reset flags back into streaming refs.
 */

import type {
  ClaudeMessage,
  ClaudeRawMessage,
  ClaudeContentOrResultBlock,
} from '../types';

export interface CodexLiveInsertResult {
  /** New message list (a fresh array; inputs are never mutated). */
  messages: ClaudeMessage[];
  /** New streaming slot index — where subsequent content deltas should land. */
  streamingIndex: number;
  /** True when the message list actually changed. */
  changed: boolean;
  /**
   * True when a fresh (empty) streaming slot was opened for the next text
   * segment. The caller should clear the accumulated streaming content buffer
   * so the new slot starts empty.
   */
  openedFreshSlot: boolean;
}

function getBlocks(raw: ClaudeRawMessage | string | undefined): ClaudeContentOrResultBlock[] {
  if (!raw) return [];
  const obj: ClaudeRawMessage | undefined =
    typeof raw === 'string' ? safeParse(raw) : raw;
  if (!obj) return [];
  const content = obj.message?.content ?? obj.content;
  return Array.isArray(content) ? content : [];
}

function safeParse(raw: string): ClaudeRawMessage | undefined {
  try {
    return JSON.parse(raw) as ClaudeRawMessage;
  } catch {
    return undefined;
  }
}

/** True if any message already carries a tool_use block with this id. */
function hasToolUseId(messages: ClaudeMessage[], id: string): boolean {
  return messages.some((m) =>
    getBlocks(m.raw).some((b) => b?.type === 'tool_use' && (b as { id?: string }).id === id));
}

/** True if any message already carries a tool_result block for this tool id. */
function hasToolResultId(messages: ClaudeMessage[], toolUseId: string): boolean {
  return messages.some((m) =>
    getBlocks(m.raw).some(
      (b) => b?.type === 'tool_result' && (b as { tool_use_id?: string }).tool_use_id === toolUseId));
}

function extractText(blocks: ClaudeContentOrResultBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } =>
      b?.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function toolUseIds(blocks: ClaudeContentOrResultBlock[]): string[] {
  return blocks
    .filter((b): b is { type: 'tool_use'; id: string } =>
      b?.type === 'tool_use' && typeof (b as { id?: unknown }).id === 'string')
    .map((b) => b.id);
}

function toolResultIds(blocks: ClaudeContentOrResultBlock[]): string[] {
  return blocks
    .filter((b): b is { type: 'tool_result'; tool_use_id: string } =>
      b?.type === 'tool_result' && typeof (b as { tool_use_id?: unknown }).tool_use_id === 'string')
    .map((b) => b.tool_use_id);
}

/** Build a raw assistant message carrying a single text block. */
function synthTextRaw(text: string): ClaudeRawMessage {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

/**
 * Return a copy of `raw` with its `text` blocks removed, preserving where the
 * content array lives (message.content vs top-level content). Used when the
 * narration text was already frozen into its own slot, so the tool card must not
 * carry (and re-render) the same text. For Codex this is a no-op — its tool_use
 * messages contain no text blocks.
 */
function stripTextBlocks(raw: ClaudeRawMessage): ClaudeRawMessage {
  const msgContent = raw.message?.content;
  if (Array.isArray(msgContent)) {
    return {
      ...raw,
      message: { ...raw.message, content: msgContent.filter((b) => b?.type !== 'text') },
    };
  }
  const topContent = (raw as { content?: unknown }).content;
  if (Array.isArray(topContent)) {
    return { ...raw, content: topContent.filter((b) => (b as { type?: string })?.type !== 'text') };
  }
  return raw;
}

/**
 * Apply a single incoming Codex message to the message list during streaming.
 *
 * Dedup is derived from the message list itself (not an external set) so the
 * function stays a pure function of its inputs — safe to call inside a
 * `setMessages` updater that React StrictMode double-invokes.
 *
 * @param messages       current message list (not mutated)
 * @param streamingIndex index of the live streaming assistant slot
 * @param incoming       the raw `[MESSAGE]` payload ({ type, message: { content } })
 * @param slotText       authoritative text currently accumulated in the slot
 *                       (from the streaming content buffer), used when freezing
 * @param turnId         current streaming turn id, stamped on new messages
 */
export function applyCodexLiveMessage(
  messages: ClaudeMessage[],
  streamingIndex: number,
  incoming: ClaudeRawMessage,
  slotText: string,
  turnId: number | undefined,
): CodexLiveInsertResult {
  const unchanged: CodexLiveInsertResult = {
    messages,
    streamingIndex,
    changed: false,
    openedFreshSlot: false,
  };

  if (streamingIndex < 0 || streamingIndex >= messages.length) return unchanged;
  const slot = messages[streamingIndex];
  if (!slot || slot.type !== 'assistant') return unchanged;

  const blocks = getBlocks(incoming);
  if (blocks.length === 0) return unchanged;

  const now = new Date().toISOString();
  const isUser = incoming.type === 'user';

  // ── Case A: assistant message carrying tool_use blocks ──────────────────────
  const tuIds = isUser ? [] : toolUseIds(blocks);
  if (tuIds.length > 0) {
    if (tuIds.every((id) => hasToolUseId(messages, id))) return unchanged;

    const slotHasText = slotText.trim().length > 0;
    // Card text policy: Codex delivers tool_use in its own message (no text), so
    // extractText is empty and stripTextBlocks a no-op. Claude instead packs
    // narration text AND tool_use into a single assistant message, and that text
    // has already been streamed into the slot via content_delta. When the slot
    // already holds text we freeze it below (which renders that text from its raw
    // blocks), so the card must carry NEITHER the text content NOR the text blocks
    // in its raw, or the same paragraph renders twice. Only when the slot is empty
    // (nothing streamed) do we keep the text so it is not lost.
    const toolMsg: ClaudeMessage = {
      type: 'assistant',
      content: slotHasText ? '' : extractText(blocks),
      raw: slotHasText ? stripTextBlocks(incoming) : incoming,
      timestamp: now,
      __turnId: turnId,
    };

    if (!slotHasText) {
      // Slot is empty (e.g. back-to-back tools) — reuse it: drop the tool card in
      // just before the still-streaming slot, no freeze needed.
      const next = [
        ...messages.slice(0, streamingIndex),
        toolMsg,
        ...messages.slice(streamingIndex),
      ];
      return {
        messages: next,
        streamingIndex: streamingIndex + 1,
        changed: true,
        openedFreshSlot: false,
      };
    }

    // Freeze the current text segment, place the tool card after it, then open a
    // fresh streaming slot for whatever text comes next.
    const frozen: ClaudeMessage = {
      ...slot,
      content: slotText,
      raw: synthTextRaw(slotText),
      isStreaming: false,
    };
    const freshSlot: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      timestamp: now,
      __turnId: turnId,
    };
    const next = [
      ...messages.slice(0, streamingIndex),
      frozen,
      toolMsg,
      freshSlot,
      ...messages.slice(streamingIndex + 1),
    ];
    return {
      messages: next,
      streamingIndex: streamingIndex + 2,
      changed: true,
      openedFreshSlot: true,
    };
  }

  // ── Case B: user message carrying tool_result blocks ────────────────────────
  const trIds = isUser ? toolResultIds(blocks) : [];
  if (trIds.length > 0) {
    if (trIds.every((id) => hasToolResultId(messages, id))) return unchanged;

    const resultMsg: ClaudeMessage = {
      type: 'user',
      content: '[tool_result]',
      raw: incoming,
      timestamp: now,
    };
    const next = [
      ...messages.slice(0, streamingIndex),
      resultMsg,
      ...messages.slice(streamingIndex),
    ];
    return {
      messages: next,
      streamingIndex: streamingIndex + 1,
      changed: true,
      openedFreshSlot: false,
    };
  }

  // ── Case C: assistant text-only (or anything else) ──────────────────────────
  // The streaming slot already shows this text via content deltas; the final
  // raw blocks are patched by onTurnMessages at end-of-turn. Nothing to do.
  return unchanged;
}
