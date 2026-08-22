/**
 * Merge streamed text chunks into a single string.
 *
 * Two producer styles are supported:
 * - **incremental deltas**: each chunk is a new fragment (including spaces) → join as-is
 * - **cumulative snapshots**: each chunk is the full text so far → take the last chunk
 *
 * Important: do **not** trim individual chunks. Trimming drops space-only tokens and
 * leading/trailing spaces that mark word boundaries, which previously produced broken
 * commit messages like `chore:Refreshcommentsandeditorstate-...`.
 */
export function dedupeTextChunks(chunks: string[]): string {
  const parts = chunks.filter((chunk): chunk is string => typeof chunk === 'string' && chunk.length > 0);
  if (parts.length === 0) {
    return '';
  }
  if (parts.length === 1) {
    return parts[0];
  }

  // Prefer cumulative snapshot when most steps are extensions of the previous chunk.
  let extensionSteps = 0;
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1];
    const cur = parts[i];
    if (cur.startsWith(prev) || prev.startsWith(cur)) {
      extensionSteps += 1;
    }
  }
  if (extensionSteps >= Math.ceil((parts.length - 1) * 0.6)) {
    // Longest chunk is the best snapshot (usually the last).
    return parts.reduce((best, chunk) => (chunk.length >= best.length ? chunk : best), parts[0]);
  }

  const last = parts[parts.length - 1];
  const withoutLast = parts.slice(0, -1).join('');
  if (withoutLast && (last.startsWith(withoutLast) || last.includes(withoutLast))) {
    return last;
  }

  return parts.join('');
}
