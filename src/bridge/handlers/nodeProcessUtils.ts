/**
 * Pure helpers for NodeProcessHandler process classification — no `vscode`
 * import so they stay unit-testable under `node --test` (see
 * src/__tests__/nodeProcessUtils.test.mts).
 */

export interface ProcessSnapshotRow {
  pid: number;
  ppid: number;
  command: string;
}

export type ProcessKind = 'DAEMON' | 'CHANNEL' | 'ORPHAN';

/**
 * Provider names are matched on word boundaries for grok, not as a bare
 * substring: a coincidental path segment (username "grokky") must not mislabel
 * an unrelated process in the Node process panel. `\b` sits between [a-z0-9_]
 * and anything else, so "grok-agent" and ".antig-grok" still match while
 * "grokky" does not.
 */
export function providerForCommand(command: string): string | undefined {
  if (command.includes('codex')) return 'codex';
  if (command.includes('claude')) return 'claude';
  if (/\bgrok\b/i.test(command)) return 'grok';
  if (command.includes('kimi')) return 'kimi';
  if (command.includes('opencode')) return 'opencode';
  if (/\bpi\b/.test(command) || command.includes(' pi ')) return 'pi';
  if (/\bomp\b/.test(command)) return 'omp';
  return undefined;
}

/**
 * Pids that must survive "kill all orphans" sweeps: the bridge daemon's own
 * pid plus every descendant of the daemon and of any channel-manager process.
 * Their CLI children (persistent `grok agent stdio`, Claude CLI) carry live
 * multi-turn state — labeling them ORPHAN would let a sweep tear down the
 * persistent Grok ACP runtime mid-session.
 */
export function collectProtectedPids(
  rows: ProcessSnapshotRow[],
  bridgePid: number | undefined,
): Set<number> {
  const roots = rows
    .filter((row) => row.pid === bridgePid || row.command.includes('channel-manager.js'))
    .map((row) => row.pid);
  const protectedPids = new Set<number>();
  const childrenByPpid = new Map<number, number[]>();
  for (const row of rows) {
    const list = childrenByPpid.get(row.ppid) ?? [];
    list.push(row.pid);
    childrenByPpid.set(row.ppid, list);
  }
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (protectedPids.has(pid)) continue;
    protectedPids.add(pid);
    for (const child of childrenByPpid.get(pid) ?? []) {
      stack.push(child);
    }
  }
  return protectedPids;
}

export function classifyProcess(
  row: ProcessSnapshotRow,
  bridgePid: number | undefined,
  protectedPids: ReadonlySet<number>,
): ProcessKind {
  if (row.pid === bridgePid) {
    return 'DAEMON';
  }
  if (protectedPids.has(row.pid)) {
    return 'CHANNEL';
  }
  if (row.command.includes('channel-manager.js')) {
    return 'CHANNEL';
  }
  return 'ORPHAN';
}
