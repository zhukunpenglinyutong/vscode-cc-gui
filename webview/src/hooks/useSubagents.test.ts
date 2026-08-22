import { describe, expect, it } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage, SubagentInfo, TaskEventMap, ToolResultBlock } from '../types';
import { applySubagentHistoryCompletion, extractSubagentsFromMessages } from './useSubagents';
import { finalizeSubagentsForSettledTurn } from '../utils/turnScope';

const assistantWithAgent = (
  toolUseId: string,
  options?: { runInBackground?: boolean; description?: string },
): ClaudeMessage => ({
  type: 'assistant',
  content: '',
  raw: {
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: {
            subagent_type: 'research',
            description: options?.description ?? '分析后端历史索引服务的设计模式',
            prompt: '分析 ClaudeHistoryIndexService',
            ...(options?.runInBackground ? { run_in_background: true } : {}),
          },
        },
      ],
    },
  },
});

const toolResultMessage = (
  toolUseId: string,
  options?: { isError?: boolean; content?: string; withUsage?: boolean },
): ClaudeMessage => ({
  type: 'user',
  content: '',
  raw: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: options?.isError,
        content: [{ type: 'text', text: options?.content ?? 'final report' }],
      },
    ],
    toolUseResult: options?.withUsage === false
      ? { agentId: 'agent-launch-ack' }
      : {
        status: 'completed',
        agentId: 'af5a83aa15ca39691',
        agentType: 'research',
        totalDurationMs: 62629,
        totalTokens: 110586,
        totalToolUseCount: 4,
        toolStats: { readCount: 4, searchCount: 0 },
      },
  } as any,
});

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] => {
  const raw = message.raw;
  if (!raw || typeof raw === 'string') return [];
  const content = raw.message?.content ?? raw.content;
  return Array.isArray(content) ? content.filter((block): block is ClaudeContentBlock => block.type === 'tool_use') : [];
};

const findToolResult = (messages: ClaudeMessage[]) => (toolUseId?: string): ToolResultBlock | null => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (!Array.isArray(content)) continue;
    const result = content.find((block): block is ToolResultBlock => block.type === 'tool_result' && block.tool_use_id === toolUseId);
    if (result) return result;
  }
  return null;
};

const getToolResultRaw = (messages: ClaudeMessage[]) => (toolUseId: string) => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (Array.isArray(content) && content.some((block) => block.type === 'tool_result' && (block as ToolResultBlock).tool_use_id === toolUseId)) {
      return raw as Record<string, unknown>;
    }
  }
  return null;
};

describe('extractSubagentsFromMessages', () => {
  it('attaches completed Agent result metadata including stable agent id', () => {
    const messages = [assistantWithAgent('tooluse_backend'), toolResultMessage('tooluse_backend')];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tooluse_backend',
      agentId: 'af5a83aa15ca39691',
      type: 'research',
      description: '分析后端历史索引服务的设计模式',
      status: 'completed',
      isAsync: false,
      totalDurationMs: 62629,
      totalTokens: 110586,
      totalToolUseCount: 4,
    });
    expect(subagents[0].toolStats).toMatchObject({ readCount: 4 });
  });

  it('keeps async agents running after launch ack until task_notification arrives', () => {
    const messages = [
      assistantWithAgent('tooluse_async', { runInBackground: true, description: '写文件A' }),
      toolResultMessage('tooluse_async', { content: 'launched', withUsage: false }),
    ];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tooluse_async',
      status: 'running',
      isAsync: true,
      description: '写文件A',
    });
  });

  it('completes async agents when a task_notification event lands', () => {
    const messages = [
      assistantWithAgent('tooluse_async', { runInBackground: true }),
      toolResultMessage('tooluse_async', { content: 'launched', withUsage: false }),
    ];
    const taskEvents: TaskEventMap = {
      tooluse_async: {
        toolUseId: 'tooluse_async',
        status: 'completed',
        summary: 'done writing file',
        agentId: 'bg-agent-1',
        totalTokens: 1200,
        totalToolUseCount: 3,
        totalDurationMs: 4000,
      },
    };

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages), taskEvents,
    );

    expect(subagents[0]).toMatchObject({
      status: 'completed',
      isAsync: true,
      agentId: 'bg-agent-1',
      resultText: 'done writing file',
      totalTokens: 1200,
      totalToolUseCount: 3,
      totalDurationMs: 4000,
    });
  });

  it('marks async launch failures as error without waiting for task_notification', () => {
    const messages = [
      assistantWithAgent('tooluse_async', { runInBackground: true }),
      toolResultMessage('tooluse_async', { isError: true, content: 'validation failed', withUsage: false }),
    ];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    expect(subagents[0]).toMatchObject({
      status: 'error',
      isAsync: true,
    });
  });

  it('StatusPanel progress stays partial after parent turn settles while async agents run', () => {
    const messages = [
      assistantWithAgent('tool-a', { runInBackground: true, description: '写文件A' }),
      assistantWithAgent('tool-b', { runInBackground: true, description: '写文件B' }),
      toolResultMessage('tool-a', { content: 'launched', withUsage: false }),
      toolResultMessage('tool-b', { content: 'launched', withUsage: false }),
    ];

    const extracted = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );
    // Parent stream ended — must NOT flip background agents to completed.
    const settled = finalizeSubagentsForSettledTurn(extracted, false);

    expect(settled).toHaveLength(2);
    expect(settled.every((item) => item.status === 'running')).toBe(true);
    expect(settled.filter((item) => item.status === 'completed')).toHaveLength(0);
  });

  it('flips async agents to completed once a sidechain history reports completion', () => {
    const messages = [
      assistantWithAgent('tool-a', { runInBackground: true, description: '写文件A' }),
      toolResultMessage('tool-a', { content: 'launched', withUsage: false }),
    ];

    const extracted = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );
    // No task_notification landed yet (delayed/missed), but the sidechain
    // transcript has already ended — the recovered history is the only signal.
    const completed = applySubagentHistoryCompletion(extracted, {
      'tool-a': { success: true, completed: true },
    });

    expect(completed[0].status).toBe('completed');
  });

  it('leaves async agents running when the sidechain history is not yet terminal', () => {
    const messages = [
      assistantWithAgent('tool-a', { runInBackground: true, description: '写文件A' }),
      toolResultMessage('tool-a', { content: 'launched', withUsage: false }),
    ];

    const extracted = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    const stillRunning = applySubagentHistoryCompletion(extracted, {
      'tool-a': { success: true, completed: false },
    });
    expect(stillRunning[0].status).toBe('running');

    const noHistory = applySubagentHistoryCompletion(extracted, {});
    expect(noHistory[0].status).toBe('running');
  });

  it('resolves sidechain completion by agentId when keyed under the runtime id', () => {
    const messages = [
      assistantWithAgent('tool-a', { runInBackground: true, description: '写文件A' }),
      toolResultMessage('tool-a', { content: 'launched', withUsage: false }),
    ];
    const extracted = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );
    // The launch ACK carries a stable agentId; simulate history stored under
    // that runtime id instead of the tool_use_id.
    const agentId = extracted[0].agentId;
    const completed = applySubagentHistoryCompletion(extracted, {
      [agentId as string]: { success: true, completed: true, agentId },
    });

    expect(completed[0].status).toBe('completed');
  });

  it('ignores sidechain history for sync agents and non-running agents', () => {
    const sync: SubagentInfo = {
      id: 'tool-sync',
      type: 'general-purpose',
      description: 'inline',
      status: 'running',
      isAsync: false,
      messageIndex: 0,
    };
    const alreadyDone: SubagentInfo = {
      id: 'tool-done',
      type: 'general-purpose',
      description: 'async done',
      status: 'completed',
      isAsync: true,
      messageIndex: 0,
    };

    const result = applySubagentHistoryCompletion([sync, alreadyDone], {
      'tool-sync': { success: true, completed: true },
      'tool-done': { success: true, completed: true },
    });

    // Sync agents never complete via sidechain; completed agents stay put.
    expect(result[0].status).toBe('running');
    expect(result[1].status).toBe('completed');
  });
});
