/**
 * Parse send_error payloads from the bridge into display text.
 *
 * Accepts:
 * - JSON: `{ success: false, error: "..." }` (Codex/Claude)
 * - JSON string: `"plain error"`
 * - raw text
 */
export function parseSendErrorPayload(payload: string | undefined | null): string {
  if (payload == null) return 'Unknown error';
  const raw = String(payload).trim();
  if (!raw) return 'Unknown error';

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') {
      return parsed.trim() || 'Unknown error';
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { error?: unknown; message?: unknown };
      if (typeof obj.error === 'string' && obj.error.trim()) {
        return obj.error;
      }
      if (typeof obj.message === 'string' && obj.message.trim()) {
        return obj.message;
      }
    }
  } catch {
    // not JSON — use raw
  }

  return raw;
}

/**
 * True when a trailing assistant bubble is empty and only a streaming placeholder
 * (no useful content / tool cards), so it should be removed when showing an error.
 */
export function isEmptyAssistantPlaceholder(message: {
  type?: string;
  content?: string;
  raw?: unknown;
  isStreaming?: boolean;
}): boolean {
  if (message?.type !== 'assistant') return false;
  if (typeof message.content === 'string' && message.content.trim().length > 0) {
    return false;
  }

  const raw = message.raw;
  if (raw == null) return true;

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw.trim().length === 0;
    }
  }

  if (!parsed || typeof parsed !== 'object') return true;
  const content =
    (parsed as { content?: unknown }).content ??
    (parsed as { message?: { content?: unknown } }).message?.content;

  if (!Array.isArray(content) || content.length === 0) return true;

  return !content.some((block) => {
    if (!block || typeof block !== 'object') return false;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text') return typeof b.text === 'string' && b.text.trim().length > 0;
    if (b.type === 'thinking') return false;
    // tool_use / image / etc. count as non-empty
    return Boolean(b.type);
  });
}
