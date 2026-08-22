/**
 * Map Codex app-server fileChange items to Claude-style tool_use / tool_result
 * messages so the webview Edit tab (useFileChanges) can aggregate them.
 */

/**
 * Count added/removed lines in a unified diff (excludes +++ / --- headers).
 * This is what the Edit tab footer should show (+N -M).
 * @param {string} diff
 * @returns {{ additions: number, deletions: number }}
 */
export function countUnifiedDiffLineStats(diff) {
  if (typeof diff !== 'string' || !diff.trim()) {
    return { additions: 0, deletions: 0 };
  }
  let additions = 0;
  let deletions = 0;
  for (const rawLine of diff.split('\n')) {
    const line = rawLine ?? '';
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Parse a unified diff into old/new strings for edit/write tool inputs.
 *
 * Important: useFileChanges computes +/− from LCS(old_string, new_string).
 * Including context lines in BOTH sides often collapses to +0 −0 when the
 * only real edits are sparse. So we put:
 *   - old_string = removed lines only (−)
 *   - new_string = added lines only (+)
 * with context omitted (context does not affect line-change totals).
 *
 * @param {string} diff
 * @returns {{ oldString: string, newString: string, additions: number, deletions: number }}
 */
export function parseUnifiedDiffToStrings(diff) {
  if (typeof diff !== 'string' || !diff.trim()) {
    return { oldString: '', newString: '', additions: 0, deletions: 0 };
  }

  const removedLines = [];
  const addedLines = [];
  let additions = 0;
  let deletions = 0;

  for (const rawLine of diff.split('\n')) {
    const line = rawLine ?? '';
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@')
    ) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
      addedLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-')) {
      deletions += 1;
      removedLines.push(line.slice(1));
      continue;
    }
    // Context lines intentionally omitted for stats-oriented old/new strings.
  }

  return {
    oldString: removedLines.join('\n'),
    newString: addedLines.join('\n'),
    additions,
    deletions,
  };
}

function kindTypeOf(kind) {
  if (!kind) return 'update';
  if (typeof kind === 'string') return kind;
  if (typeof kind === 'object' && typeof kind.type === 'string') return kind.type;
  return 'update';
}

/**
 * @param {object} change - FileUpdateChange { path, kind, diff }
 * @returns {{ toolName: string, input: object }|null}
 */
export function fileUpdateChangeToTool(change) {
  if (!change || typeof change !== 'object') return null;
  const filePath = typeof change.path === 'string' ? change.path.trim() : '';
  if (!filePath) return null;

  const kind = kindTypeOf(change.kind);
  const diffText = typeof change.diff === 'string' ? change.diff : '';
  const { oldString, newString, additions, deletions } = parseUnifiedDiffToStrings(diffText);

  if (kind === 'add') {
    const content = newString;
    // Never emit 0/0 for a real add — empty diff body still means "file created".
    const addCount = Math.max(
      1,
      additions > 0 ? additions : (content ? content.split('\n').length : 1),
    );
    return {
      toolName: 'write',
      input: {
        file_path: filePath,
        content: content || ' ',
        old_string: '',
        new_string: content || ' ',
        additions: addCount,
        deletions: 0,
      },
    };
  }

  if (kind === 'delete') {
    const deleted = oldString || newString;
    const delCount = Math.max(
      1,
      deletions > 0 ? deletions : (deleted ? deleted.split('\n').length : 1),
    );
    return {
      toolName: 'edit',
      input: {
        file_path: filePath,
        old_string: deleted || ' ',
        new_string: '',
        replace_all: false,
        additions: 0,
        deletions: delCount,
      },
    };
  }

  // update — ensure non-zero stats so the Edit footer never shows +0 −0
  const addCount = Math.max(additions, newString ? newString.split('\n').filter(Boolean).length : 0, additions === 0 && deletions === 0 ? 1 : 0);
  const delCount = Math.max(deletions, oldString ? oldString.split('\n').filter(Boolean).length : 0, 0);
  const safeAdd = addCount > 0 || delCount > 0 ? addCount : 1;
  const safeDel = addCount > 0 || delCount > 0 ? delCount : 0;
  return {
    toolName: 'edit',
    input: {
      file_path: filePath,
      old_string: oldString || (safeDel > 0 ? ' ' : ''),
      new_string: newString || (safeAdd > 0 ? ' ' : ''),
      replace_all: false,
      additions: safeAdd,
      deletions: safeDel,
    },
  };
}

/**
 * Emit Claude-compatible tool messages for a fileChange thread item.
 *
 * @param {object} item - { id, type: 'fileChange', changes, status }
 * @param {(msg: object) => void} onMessage
 * @param {Set<string>} [emittedIds] - dedupe by tool use id
 * @returns {number} number of file ops emitted
 */
export function emitFileChangeItemAsTools(item, onMessage, emittedIds = null) {
  if (!item || typeof onMessage !== 'function') return 0;
  const type = item.type;
  if (type !== 'fileChange' && type !== 'file_change') return 0;

  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) return 0;

  const status = item.status;
  const isError =
    status === 'failed' ||
    status === 'error' ||
    (typeof status === 'object' && status?.type === 'failed');

  const itemId = typeof item.id === 'string' && item.id ? item.id : `fc_${Date.now()}`;
  let emitted = 0;

  changes.forEach((change, index) => {
    const tool = fileUpdateChangeToTool(change);
    if (!tool) return;

    const toolUseId = `codex_fc_${itemId}_${index}`;
    if (emittedIds instanceof Set) {
      if (emittedIds.has(toolUseId)) return;
      emittedIds.add(toolUseId);
    }

    onMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: tool.toolName,
            input: tool.input,
          },
        ],
      },
    });

    onMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: !!isError,
            content: isError ? 'Patch apply failed' : 'Patch applied',
          },
        ],
      },
    });

    emitted += 1;
  });

  return emitted;
}
