import { describe, expect, it } from 'vitest';
import type { SubagentHistoryResponse } from '../types';
import {
  collectFileOperationsFromSubagentHistories,
  findSidechainToolResult,
} from './useFileChanges';

function sidechainHistory(messages: unknown[]): SubagentHistoryResponse {
  return {
    success: true,
    completed: true,
    toolUseId: 'parent-tool-1',
    agentId: 'abc123',
    messages,
  };
}

describe('findSidechainToolResult', () => {
  it('finds tool_result in history-style raw.message.content rows', () => {
    const messages = [
      {
        type: 'assistant',
        raw: {
          message: {
            content: [
              { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: '/a.txt', content: 'hi' } },
            ],
          },
        },
      },
      {
        type: 'user',
        raw: {
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'write-1', content: 'ok' },
            ],
          },
        },
      },
    ];

    const result = findSidechainToolResult(messages, 'write-1');
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'write-1' });
  });
});

describe('collectFileOperationsFromSubagentHistories', () => {
  it('collects Write tools from background agent sidechains', () => {
    const histories = {
      'parent-tool-1': sidechainHistory([
        {
          type: 'assistant',
          raw: {
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'write-a',
                  name: 'Write',
                  input: {
                    file_path: '/Users/me/project/subagent-a.txt',
                    content: '来自子代理A',
                  },
                },
              ],
            },
          },
        },
        {
          type: 'user',
          raw: {
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'write-a', content: 'Wrote file' },
              ],
            },
          },
        },
      ]),
    };

    const map = collectFileOperationsFromSubagentHistories(histories);
    expect(map.size).toBe(1);
    expect(map.has('/Users/me/project/subagent-a.txt')).toBe(true);
    const ops = map.get('/Users/me/project/subagent-a.txt')!;
    expect(ops).toHaveLength(1);
    expect(ops[0].toolName).toBe('write');
    expect(ops[0].newString).toBe('来自子代理A');
    expect(ops[0].additions).toBeGreaterThan(0);
  });

  it('skips failed writes and empty histories', () => {
    const histories = {
      empty: { success: true, messages: [] } satisfies SubagentHistoryResponse,
      failed: sidechainHistory([
        {
          type: 'assistant',
          raw: {
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'write-fail',
                  name: 'Write',
                  input: { file_path: '/x.txt', content: 'nope' },
                },
              ],
            },
          },
        },
        {
          type: 'user',
          raw: {
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'write-fail', is_error: true, content: 'denied' },
              ],
            },
          },
        },
      ]),
    };

    const map = collectFileOperationsFromSubagentHistories(histories);
    expect(map.size).toBe(0);
  });

  it('merges multiple subagent writes into one map', () => {
    const histories = {
      a: sidechainHistory([
        {
          type: 'assistant',
          raw: {
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'w1',
                  name: 'Write',
                  input: { file_path: '/subagent-a.txt', content: 'A' },
                },
              ],
            },
          },
        },
        {
          type: 'user',
          raw: {
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }],
            },
          },
        },
      ]),
      b: sidechainHistory([
        {
          type: 'assistant',
          raw: {
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'w2',
                  name: 'Write',
                  input: { file_path: '/subagent-b.txt', content: 'B' },
                },
              ],
            },
          },
        },
        {
          type: 'user',
          raw: {
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'w2', content: 'ok' }],
            },
          },
        },
      ]),
    };

    const map = collectFileOperationsFromSubagentHistories(histories);
    expect([...map.keys()].sort()).toEqual(['/subagent-a.txt', '/subagent-b.txt']);
  });
});
