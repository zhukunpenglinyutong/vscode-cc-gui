import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { SubagentHistoryResponse } from '../types';
import { useFileChanges } from './useFileChanges';

function sidechainHistory(messages: unknown[]): SubagentHistoryResponse {
  return {
    success: true,
    completed: true,
    toolUseId: 'parent-tool-1',
    agentId: 'abc123',
    messages,
  };
}

function getContentBlocks(message: ClaudeMessage): ClaudeContentBlock[] {
  const raw = message.raw;
  if (!raw || typeof raw === 'string') return [];
  const content = (raw as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ClaudeContentBlock[]) : [];
}

function makeFindToolResult(messages: ClaudeMessage[]) {
  return (toolUseId?: string): ToolResultBlock | null => {
    if (!toolUseId) return null;
    for (const msg of messages) {
      const raw = msg.raw;
      if (!raw || typeof raw === 'string') continue;
      const content = (raw as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;
      const hit = content.find(
        (b): b is ToolResultBlock =>
          Boolean(b)
          && (b as ToolResultBlock).type === 'tool_result'
          && (b as ToolResultBlock).tool_use_id === toolUseId,
      );
      if (hit) return hit;
    }
    return null;
  };
}

function writeToolUseRaw(id: string, filePath: string, content: string) {
  return {
    type: 'assistant',
    raw: {
      message: {
        content: [
          { type: 'tool_use', id, name: 'Write', input: { file_path: filePath, content } },
        ],
      },
    },
  };
}

function toolResultRaw(toolUseId: string, isError = false) {
  return {
    type: 'user',
    raw: {
      message: {
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: isError ? 'denied' : 'ok' },
        ],
      },
    },
  };
}

describe('useFileChanges with subagent sidechain histories', () => {
  it('finds tool_use/tool_result in history-style raw.message.content rows', () => {
    const subagentHistories: Record<string, SubagentHistoryResponse> = {
      'parent-tool-1': sidechainHistory([
        writeToolUseRaw('write-1', '/a.txt', 'hi'),
        toolResultRaw('write-1'),
      ]),
    };

    const { result } = renderHook(() =>
      useFileChanges({
        messages: [],
        getContentBlocks,
        findToolResult: makeFindToolResult([]),
        subagentHistories,
      }),
    );

    expect(result.current).toHaveLength(1);
    expect(result.current[0].filePath).toBe('/a.txt');
  });

  it('collects Write tools from background agent sidechains', () => {
    const subagentHistories: Record<string, SubagentHistoryResponse> = {
      'parent-tool-1': sidechainHistory([
        writeToolUseRaw('write-a', '/Users/me/project/subagent-a.txt', '来自子代理A'),
        toolResultRaw('write-a'),
      ]),
    };

    const { result } = renderHook(() =>
      useFileChanges({
        messages: [],
        getContentBlocks,
        findToolResult: makeFindToolResult([]),
        subagentHistories,
      }),
    );

    expect(result.current).toHaveLength(1);
    const file = result.current[0];
    expect(file.filePath).toBe('/Users/me/project/subagent-a.txt');
    expect(file.operations).toHaveLength(1);
    expect(file.operations[0].toolName).toBe('write');
    expect(file.operations[0].newString).toBe('来自子代理A');
    expect(file.additions).toBeGreaterThan(0);
  });

  it('skips failed writes and empty histories', () => {
    const subagentHistories: Record<string, SubagentHistoryResponse> = {
      empty: { success: true, messages: [] },
      failed: sidechainHistory([
        writeToolUseRaw('write-fail', '/x.txt', 'nope'),
        toolResultRaw('write-fail', true),
      ]),
    };

    const { result } = renderHook(() =>
      useFileChanges({
        messages: [],
        getContentBlocks,
        findToolResult: makeFindToolResult([]),
        subagentHistories,
      }),
    );

    expect(result.current).toHaveLength(0);
  });

  it('merges writes from multiple subagents', () => {
    const subagentHistories: Record<string, SubagentHistoryResponse> = {
      a: sidechainHistory([
        writeToolUseRaw('w1', '/subagent-a.txt', 'A'),
        toolResultRaw('w1'),
      ]),
      b: sidechainHistory([
        writeToolUseRaw('w2', '/subagent-b.txt', 'B'),
        toolResultRaw('w2'),
      ]),
    };

    const { result } = renderHook(() =>
      useFileChanges({
        messages: [],
        getContentBlocks,
        findToolResult: makeFindToolResult([]),
        subagentHistories,
      }),
    );

    expect(result.current.map((f) => f.filePath).sort()).toEqual([
      '/subagent-a.txt',
      '/subagent-b.txt',
    ]);
  });
});
