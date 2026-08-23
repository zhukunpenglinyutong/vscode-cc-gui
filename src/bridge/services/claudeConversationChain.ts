/**
 * Effective-chain selection for Claude session JSONL transcripts (history panel).
 *
 * Lightweight TypeScript port of ai-bridge/services/claude/conversation-chain.js
 * (jetbrains-cc-gui v0.5.3), reduced to what the linear history reader needs:
 * the set of entry UUIDs that belong to the effective conversation.
 *
 * The CLI never deletes rewound messages from the transcript. Rewinding forks
 * the conversation in place: subsequent messages get parentUuid pointing past
 * the rewound span, so the discarded branch stays on disk as a dead chain.
 * Reading the file line-by-line renders those dead branches as if they were
 * live conversation. Membership here mirrors the source chain walk — pick the
 * newest non-sidechain leaf, walk parentUuid back to the root — plus the two
 * recoveries the GUI-visible transcript needs:
 *
 *   - pre-compact history: a compact boundary starts a new parentUuid root, so
 *     the tip walk never reaches the messages that led to the compact summary.
 *     The linear reader always showed them; keep them via the boundary's
 *     preserved-segment/preserved-uuids carriers (nested boundaries included).
 *   - parallel-tool siblings and their tool results: N parallel tool_uses
 *     stream as N assistant rows sharing one message.id; the single-parent
 *     walk keeps only one branch of that DAG.
 *
 * Ordering stays line order — this module only filters, never reorders.
 */

const NO_RESPONSE_REQUESTED = 'No response requested.';

/**
 * Claude Code writes this assistant placeholder for commands that do not need
 * a response (e.g. compact). Mirrors MessageParser in jetbrains-cc-gui v0.5.3.
 */
export function isClaudeNoResponsePlaceholder(type: unknown, text: string): boolean {
  return type === 'assistant' && String(text).trim() === NO_RESPONSE_REQUESTED;
}

/**
 * Drop entries that belong to rewound dead branches. Entries that cannot be
 * placed in the chain graph (no uuid, sidechain rows) are kept untouched, as
 * is the whole transcript when it carries no parentUuid chain model at all
 * (the plugin's direct-API fallback writer omits those fields).
 */
export function filterDeadBranchEntries(entries: any[]): any[] {
  if (!Array.isArray(entries) || entries.length === 0) return entries;
  const visible = selectVisibleUuids(entries);
  if (!visible) return entries;
  return entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return true;
    if (typeof entry.uuid !== 'string') return true;
    if (entry.isSidechain) return true;
    return visible.has(entry.uuid);
  });
}

function selectVisibleUuids(entries: any[]): Set<string> | null {
  const byUuid = new Map<string, any>();
  for (const entry of entries) {
    if (entry && typeof entry.uuid === 'string') {
      byUuid.set(entry.uuid, entry);
    }
  }
  if (byUuid.size === 0) return null;

  // The CLI writes parentUuid on every row (null for the root). If no row
  // carries the field, this transcript was not written by the chain model and
  // line order is the only meaningful order.
  let hasParentField = false;
  for (const entry of byUuid.values()) {
    if ('parentUuid' in entry) {
      hasParentField = true;
      break;
    }
  }
  if (!hasParentField) return null;

  // A row can lack the parentUuid KEY entirely: SDK-written roots, and rows
  // the plugin's direct-API fallback appends to a CLI-written file. A missing
  // key inherits the previous uuid-carrying mainline row as its parent so a
  // hybrid transcript keeps its line-order continuity instead of collapsing
  // the walk at the first such row. Sidechain rows never become the implicit
  // parent: their parent chain runs into the sidechain branch.
  let prevUuid: string | null = null;
  for (const entry of byUuid.values()) {
    if (entry.isSidechain) {
      continue;
    }
    if (!('parentUuid' in entry) && prevUuid !== null) {
      byUuid.set(entry.uuid, { ...entry, parentUuid: prevUuid });
    }
    prevUuid = entry.uuid;
  }

  const leaf = selectNewestLeaf(byUuid);
  if (!leaf) return null;

  const keep = walkParentChainUuids(byUuid, leaf);
  if (keep.size === 0) return null;

  recoverCompactPrefixes(byUuid, keep);
  recoverOrphanedParallelToolRows(byUuid, keep);
  return keep;
}

/**
 * A leaf is the nearest real user/assistant ancestor of any childless message
 * (attachments and local command metadata can trail a conversation message
 * without continuing the chain). The newest non-sidechain leaf is the tip of
 * the live branch; leaves of rewound branches are older by timestamp.
 */
function selectNewestLeaf(byUuid: Map<string, any>): any | null {
  // A sidechain child hides its main-thread parent from the full graph's leaf
  // set. Exclude sidechains before finding leaves so a dead main branch cannot
  // win merely because the live branch ends in a sidechain row.
  const mainThread = new Map<string, any>();
  for (const entry of byUuid.values()) {
    if (!entry.isSidechain) {
      mainThread.set(entry.uuid, entry);
    }
  }
  return newestNonSidechainLeaf(byUuid, mainThread) ?? newestNonSidechainLeaf(byUuid, byUuid);
}

function newestNonSidechainLeaf(byUuid: Map<string, any>, graph: Map<string, any>): any | null {
  const parentUuids = new Set<string>();
  for (const entry of graph.values()) {
    if (entry.parentUuid) {
      parentUuids.add(entry.parentUuid);
    }
  }

  const leafUuids = new Set<string>();
  for (const entry of graph.values()) {
    if (parentUuids.has(entry.uuid)) {
      continue;
    }
    let current: any = entry;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.uuid)) {
        break;
      }
      seen.add(current.uuid);
      if ((current.type === 'user' || current.type === 'assistant')
          && !isSyntheticUserMessage(current)) {
        leafUuids.add(current.uuid);
        break;
      }
      current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
    }
  }

  let tip: any = null;
  let tipTime = 0;
  for (const uuid of leafUuids) {
    const entry = byUuid.get(uuid);
    if (!entry || entry.isSidechain) {
      continue;
    }
    const time = Date.parse(entry.timestamp ?? '') || 0;
    if (time > tipTime) {
      tipTime = time;
      tip = entry;
    }
  }
  return tip;
}

/**
 * Local command caveats and stdout are CLI metadata, not conversation turns.
 * They may be written after compacting while still pointing to the pre-compact
 * branch, so they must not hide a newer compact summary leaf.
 */
function isSyntheticUserMessage(entry: any): boolean {
  if (entry.type !== 'user' || typeof entry.message?.content !== 'string') {
    return false;
  }
  const content = entry.message.content;
  return content.includes('<local-command-caveat>')
      || content.includes('<local-command-stdout>')
      || content.includes('<command-name>');
}

function walkParentChainUuids(byUuid: Map<string, any>, tip: any): Set<string> {
  const uuids = new Set<string>();
  let current: any = tip;
  while (current) {
    if (uuids.has(current.uuid)) {
      break;
    }
    uuids.add(current.uuid);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
  }
  return uuids;
}

/**
 * Keep the effective pre-compact conversation visible. A compact boundary is a
 * new parentUuid root, so the tip walk stops there; the messages that led to
 * the compact summary are recovered through the boundary's preserved-segment
 * (or preserved-uuids) carriers. Runs to a fixpoint so nested boundaries
 * (sessions compacted more than once) expand their own older prefix too.
 */
function recoverCompactPrefixes(byUuid: Map<string, any>, keep: Set<string>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of byUuid.values()) {
      if (entry?.subtype !== 'compact_boundary') {
        continue;
      }
      const preservedUuids = getCompactPreservedUuids(byUuid, entry);
      const segment = entry.compactMetadata?.preservedSegment;
      const carriers = [entry.uuid, ...preservedUuids, segment?.headUuid, segment?.tailUuid];
      // Only expand boundaries the live chain actually passes through (or
      // continues from); a rewound-away compact branch stays hidden.
      if (!carriers.some((uuid) => typeof uuid === 'string' && keep.has(uuid))) {
        continue;
      }
      for (const uuid of preCompactPrefixUuids(byUuid, entry, preservedUuids)) {
        if (!keep.has(uuid)) {
          keep.add(uuid);
          changed = true;
        }
      }
    }
  }
}

function preCompactPrefixUuids(byUuid: Map<string, any>, boundary: any, preservedUuids: string[]): Set<string> {
  const segment = boundary.compactMetadata?.preservedSegment;
  const headUuid = segment?.headUuid ?? preservedUuids.find((uuid) => byUuid.has(uuid));
  const prefix = headUuid && byUuid.has(headUuid)
    ? walkParentChainUuids(byUuid, byUuid.get(headUuid))
    : findPreCompactChainUuids(byUuid, boundary.uuid);
  for (const uuid of preservedUuids) {
    if (byUuid.has(uuid)) {
      prefix.add(uuid);
    }
  }
  return prefix;
}

function getCompactPreservedUuids(byUuid: Map<string, any>, boundary: any): string[] {
  const preserved = boundary.compactMetadata?.preservedMessages;
  const segment = boundary.compactMetadata?.preservedSegment;
  let preservedUuids = Array.isArray(preserved?.allUuids)
    ? preserved.allUuids
    : preserved?.uuids;
  if (!Array.isArray(preservedUuids) && segment) {
    preservedUuids = walkPreservedSegmentUuids(byUuid, segment);
  }
  return Array.isArray(preservedUuids) ? preservedUuids : [];
}

function walkPreservedSegmentUuids(byUuid: Map<string, any>, segment: any): string[] | null {
  const uuids: string[] = [];
  const seen = new Set<string>();
  let current: any = byUuid.get(segment.tailUuid);
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    uuids.push(current.uuid);
    if (current.uuid === segment.headUuid) {
      return uuids;
    }
    current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
  }
  return null;
}

function findPreCompactChainUuids(byUuid: Map<string, any>, boundaryUuid: string): Set<string> {
  const beforeBoundary = new Map<string, any>();
  for (const [uuid, entry] of byUuid) {
    if (uuid === boundaryUuid) {
      break;
    }
    beforeBoundary.set(uuid, entry);
  }
  const leaf = selectNewestLeaf(beforeBoundary);
  return leaf ? walkParentChainUuids(beforeBoundary, leaf) : new Set<string>();
}

/**
 * Recover sibling assistant rows and tool results that the single-parent walk
 * orphaned. Siblings share message.id with an on-chain assistant; tool results
 * attach to their source assistant via parentUuid.
 */
function recoverOrphanedParallelToolRows(byUuid: Map<string, any>, keep: Set<string>): void {
  const keptAssistantMsgIds = new Set<string>();
  for (const entry of byUuid.values()) {
    if (keep.has(entry.uuid) && entry.type === 'assistant' && entry.message && entry.message.id) {
      keptAssistantMsgIds.add(entry.message.id);
    }
  }
  if (keptAssistantMsgIds.size === 0) {
    return;
  }

  for (const entry of byUuid.values()) {
    if (keep.has(entry.uuid)) {
      continue;
    }
    if (entry.type === 'assistant' && entry.message?.id && keptAssistantMsgIds.has(entry.message.id)) {
      keep.add(entry.uuid);
    }
  }

  for (const entry of byUuid.values()) {
    if (keep.has(entry.uuid)) {
      continue;
    }
    if (entry.type === 'user'
        && entry.parentUuid
        && keep.has(entry.parentUuid)
        && Array.isArray(entry.message?.content)
        && entry.message.content.some((block: any) => block && block.type === 'tool_result')) {
      keep.add(entry.uuid);
    }
  }
}
