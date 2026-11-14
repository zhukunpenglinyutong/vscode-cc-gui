const getTextBlockText = (block: unknown): string | null => {
  if (!block || typeof block !== 'object') return null;
  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : null;
};

/**
 * Some streams re-send the whole text block on every snapshot, leaving adjacent
 * text blocks like "A", "AB", "ABC" in raw content. A text block that starts with
 * the immediately preceding text block is treated as a newer snapshot of it, so
 * only the newest one is kept. Blocks separated by any non-text block are never
 * merged, and whitespace-only blocks never count as a snapshot prefix.
 */
export function collapseCumulativeTextSnapshots<T>(blocks: readonly T[]): T[] {
  return blocks.reduce<T[]>((result, block) => {
    const previousText = getTextBlockText(result[result.length - 1]);
    const nextText = getTextBlockText(block);
    const isNewerSnapshot = previousText !== null
      && nextText !== null
      && previousText.trim().length > 0
      && nextText.startsWith(previousText);
    return isNewerSnapshot ? [...result.slice(0, -1), block] : [...result, block];
  }, []);
}
