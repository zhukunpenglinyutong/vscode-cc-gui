const MAX_TAB_TITLE_LENGTH = 15;
const TAB_TITLE_ELLIPSIS = '...';
const TITLE_UPDATE_EVENTS = new Set(['update_title', 'update_history_title']);

export type BridgeMessage = { type?: string; payload?: unknown } | null | undefined;

export function nextTabName(counter: number): string {
  return `AI${counter}`;
}

export function resolveTabTitle(rawTitle: string | undefined, counter: number): string {
  const trimmed = rawTitle?.trim();
  if (trimmed) {
    return clampTitle(trimmed);
  }
  return nextTabName(counter);
}

export function clampTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length > MAX_TAB_TITLE_LENGTH
    ? `${chars.slice(0, MAX_TAB_TITLE_LENGTH).join('')}${TAB_TITLE_ELLIPSIS}`
    : title;
}

export function parseBridgeEvent(message: BridgeMessage): { event: string; payload: string } | null {
  if (!message || message.type !== 'bridge' || typeof message.payload !== 'string') {
    return null;
  }
  const colonIdx = message.payload.indexOf(':');
  const event = colonIdx >= 0 ? message.payload.slice(0, colonIdx) : message.payload;
  const payload = colonIdx >= 0 ? message.payload.slice(colonIdx + 1) : '';
  return { event, payload };
}

export function isBridgeEvent(message: BridgeMessage, expectedEvent: string): boolean {
  const parsed = parseBridgeEvent(message);
  return parsed !== null && parsed.event === expectedEvent;
}

export function extractTitleUpdate(message: BridgeMessage): string | null {
  const parsed = parseBridgeEvent(message);
  if (!parsed || !TITLE_UPDATE_EVENTS.has(parsed.event)) {
    return null;
  }
  try {
    const payload = JSON.parse(parsed.payload);
    const title = String(payload?.title ?? payload?.newTitle ?? '').trim();
    return title ? clampTitle(title) : null;
  } catch {
    return null;
  }
}
