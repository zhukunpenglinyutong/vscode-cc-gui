import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterDeadBranchEntries,
  isClaudeNoResponsePlaceholder,
} from '../bridge/services/claudeConversationChain.ts';

/** Build parsed entries from a JSONL fixture, mirroring readClaudeSessionFile's line parsing. */
function parseJsonl(jsonl: string): any[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function visibleUuids(jsonl: string): string[] {
  return filterDeadBranchEntries(parseJsonl(jsonl))
    .map((entry) => entry.uuid)
    .filter(Boolean);
}

function userRow(uuid: string, parentUuid: string | null, timestamp: string, text: string, extra: Record<string, unknown> = {}) {
  return { type: 'user', uuid, parentUuid, timestamp, message: { role: 'user', content: text }, ...extra };
}

function assistantRow(uuid: string, parentUuid: string | null, timestamp: string, text: string, messageId: string) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp,
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function toJsonl(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

describe('filterDeadBranchEntries', () => {
  it('hides the rewound dead branch and keeps the live fork in line order', () => {
    // u1 -> a1 -> u2 -> a2 (rewound away), then u2b -> a2b forked off a1 later.
    const jsonl = toJsonl([
      userRow('u1', null, '2026-01-01T00:00:01Z', 'first question'),
      assistantRow('a1', 'u1', '2026-01-01T00:00:02Z', 'first answer', 'msg_1'),
      userRow('u2', 'a1', '2026-01-01T00:00:03Z', 'dead question'),
      assistantRow('a2', 'u2', '2026-01-01T00:00:04Z', 'dead answer', 'msg_2'),
      userRow('u2b', 'a1', '2026-01-01T00:00:05Z', 'rewound question'),
      assistantRow('a2b', 'u2b', '2026-01-01T00:00:06Z', 'live answer', 'msg_3'),
    ]);

    assert.deepEqual(visibleUuids(jsonl), ['u1', 'a1', 'u2b', 'a2b']);
  });

  it('keeps everything when the transcript has no parentUuid chain model', () => {
    const jsonl = toJsonl([
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'q' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:02Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'a' }] } },
    ]);

    assert.deepEqual(visibleUuids(jsonl), ['u1', 'a1']);
  });

  it('keeps pre-compact history visible across a compact boundary', () => {
    const jsonl = toJsonl([
      userRow('c1', null, '2026-01-01T00:00:01Z', 'before compact'),
      assistantRow('c2', 'c1', '2026-01-01T00:00:02Z', 'pre-compact answer', 'msg_c'),
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'b1',
        parentUuid: null,
        timestamp: '2026-01-01T00:00:03Z',
        compactMetadata: { preservedSegment: { headUuid: 'c2', tailUuid: 'c2' } },
      },
      userRow('s1', 'b1', '2026-01-01T00:00:04Z', 'compact summary', { isCompactSummary: true }),
      userRow('c3', 's1', '2026-01-01T00:00:05Z', 'after compact'),
      assistantRow('c4', 'c3', '2026-01-01T00:00:06Z', 'post-compact answer', 'msg_d'),
    ]);

    assert.deepEqual(visibleUuids(jsonl), ['c1', 'c2', 'b1', 's1', 'c3', 'c4']);
  });

  it('still hides a dead fork that sits before the compact boundary', () => {
    const jsonl = toJsonl([
      userRow('c1', null, '2026-01-01T00:00:01Z', 'before compact'),
      assistantRow('c2', 'c1', '2026-01-01T00:00:02Z', 'pre-compact answer', 'msg_c'),
      // Dead fork off c2, abandoned before the compact happened.
      userRow('d1', 'c2', '2026-01-01T00:00:02Z', 'dead pre-compact fork'),
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'b1',
        parentUuid: null,
        timestamp: '2026-01-01T00:00:03Z',
        compactMetadata: { preservedSegment: { headUuid: 'c2', tailUuid: 'c2' } },
      },
      userRow('s1', 'b1', '2026-01-01T00:00:04Z', 'compact summary', { isCompactSummary: true }),
      assistantRow('c3', 's1', '2026-01-01T00:00:05Z', 'post-compact answer', 'msg_d'),
    ]);

    assert.deepEqual(visibleUuids(jsonl), ['c1', 'c2', 'b1', 's1', 'c3']);
  });

  it('recovers parallel tool_use siblings and their tool results the parent walk orphans', () => {
    const toolResultRow = (uuid: string, parentUuid: string, timestamp: string) => ({
      type: 'user',
      uuid,
      parentUuid,
      timestamp,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tool_${uuid}`, content: 'ok' }],
      },
    });
    const jsonl = toJsonl([
      userRow('p1', null, '2026-01-01T00:00:01Z', 'run two tools'),
      // Two parallel tool_use rows share message.id; the chain keeps only one.
      {
        type: 'assistant',
        uuid: 'pa1',
        parentUuid: 'p1',
        timestamp: '2026-01-01T00:00:02Z',
        message: { id: 'msg_p', role: 'assistant', content: [{ type: 'tool_use', id: 'tool_a', name: 'Read', input: {} }] },
      },
      {
        type: 'assistant',
        uuid: 'pa2',
        parentUuid: 'p1',
        timestamp: '2026-01-01T00:00:02Z',
        message: { id: 'msg_p', role: 'assistant', content: [{ type: 'tool_use', id: 'tool_b', name: 'Bash', input: {} }] },
      },
      toolResultRow('pr1', 'pa1', '2026-01-01T00:00:03Z'),
      toolResultRow('pr2', 'pa2', '2026-01-01T00:00:03Z'),
      userRow('p2', 'pr1', '2026-01-01T00:00:04Z', 'next question'),
      assistantRow('p3', 'p2', '2026-01-01T00:00:05Z', 'next answer', 'msg_q'),
    ]);

    assert.deepEqual(visibleUuids(jsonl), ['p1', 'pa1', 'pa2', 'pr1', 'pr2', 'p2', 'p3']);
  });

  it('keeps thinking and tool blocks on the live chain untouched', () => {
    const jsonl = toJsonl([
      userRow('t1', null, '2026-01-01T00:00:01Z', 'think then act'),
      {
        type: 'assistant',
        uuid: 't2',
        parentUuid: 't1',
        timestamp: '2026-01-01T00:00:02Z',
        message: {
          id: 'msg_t',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'answer' },
          ],
        },
      },
    ]);

    const filtered = filterDeadBranchEntries(parseJsonl(jsonl));
    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered[1].message.content[0], { type: 'thinking', thinking: 'hmm' });
  });

  it('keeps sidechain rows untouched even when they hang off a dead branch', () => {
    const jsonl = toJsonl([
      userRow('u1', null, '2026-01-01T00:00:01Z', 'question'),
      assistantRow('a1', 'u1', '2026-01-01T00:00:02Z', 'answer', 'msg_1'),
      userRow('u2', 'a1', '2026-01-01T00:00:03Z', 'dead question'),
      { ...assistantRow('a2', 'u2', '2026-01-01T00:00:04Z', 'dead answer', 'msg_2'), isSidechain: true },
      userRow('u2b', 'a1', '2026-01-01T00:00:05Z', 'rewound question'),
      assistantRow('a2b', 'u2b', '2026-01-01T00:00:06Z', 'live answer', 'msg_3'),
    ]);

    // u2 (dead main-branch row) is hidden; the sidechain row keeps its existing handling.
    assert.deepEqual(visibleUuids(jsonl), ['u1', 'a1', 'a2', 'u2b', 'a2b']);
  });

  it('returns all-sidechain transcripts unchanged (subagent files have no main-thread leaf)', () => {
    const jsonl = toJsonl([
      { ...userRow('s1', null, '2026-01-01T00:00:01Z', 'agent prompt'), isSidechain: true },
      { ...assistantRow('s2', 's1', '2026-01-01T00:00:02Z', 'agent answer', 'msg_s'), isSidechain: true },
    ]);

    assert.deepEqual(visibleUuids(jsonl), ['s1', 's2']);
  });

  it('keeps rows without a uuid and survives malformed input', () => {
    const entries = parseJsonl(toJsonl([
      userRow('u1', null, '2026-01-01T00:00:01Z', 'question'),
      assistantRow('a1', 'u1', '2026-01-01T00:00:02Z', 'answer', 'msg_1'),
      userRow('u2', 'a1', '2026-01-01T00:00:03Z', 'dead question'),
      userRow('u2b', 'a1', '2026-01-01T00:00:04Z', 'rewound question'),
      assistantRow('a2b', 'u2b', '2026-01-01T00:00:05Z', 'live answer', 'msg_3'),
    ]));
    entries.splice(2, 0, { type: 'summary', summary: 'no uuid row' });

    const filtered = filterDeadBranchEntries(entries);
    assert.equal(filtered[2].type, 'summary');
    assert.deepEqual(filtered.filter((e) => e.uuid).map((e) => e.uuid), ['u1', 'a1', 'u2b', 'a2b']);

    assert.deepEqual(filterDeadBranchEntries([]), []);
    assert.deepEqual(filterDeadBranchEntries(null as any), null);
  });
});

describe('isClaudeNoResponsePlaceholder', () => {
  it('matches the assistant compact placeholder', () => {
    assert.equal(isClaudeNoResponsePlaceholder('assistant', 'No response requested.'), true);
    assert.equal(isClaudeNoResponsePlaceholder('assistant', '  No response requested.\n'), true);
  });

  it('does not match user messages or other assistant text', () => {
    assert.equal(isClaudeNoResponsePlaceholder('user', 'No response requested.'), false);
    assert.equal(isClaudeNoResponsePlaceholder('assistant', 'No response requested. Just kidding.'), false);
    assert.equal(isClaudeNoResponsePlaceholder('assistant', ''), false);
  });
});
