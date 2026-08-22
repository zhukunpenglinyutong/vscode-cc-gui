import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, ClaudeContentBlock, ToolResultBlock, SubagentHistoryResponse, SubagentInfo, SubagentStatus, TaskEvent, TaskEventMap } from '../types';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { normalizeToolName } from '../utils/toolConstants';
import { extractResultText, isAsyncAgentInput } from '../utils/subagentResult';
import { useTaskEvents } from '../contexts/SubagentContext';

type GetToolResultRawFn = (toolUseId: string) => ClaudeRawMessage | null;

interface UseSubagentsParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;
  subagentHistories?: Record<string, SubagentHistoryResponse>;
}

/**
 * Determine subagent status.
 *
 * Async agents (Agent/Task tool invoked with run_in_background:true) only
 * receive a launch acknowledgment tool_result, not a completion signal. The
 * terminal status arrives later via a task_notification event, so while no
 * event has landed the agent is still running.
 *
 * Sync agents (task/agent without run_in_background) run inline: a tool_result
 * means the agent is done.
 */
function determineStatus(
  result: ToolResultBlock | null,
  isAsync: boolean,
  taskEvent: TaskEvent | undefined,
): SubagentStatus {
  if (isAsync) {
    if (taskEvent) {
      return taskEvent.status === 'failed' || taskEvent.status === 'stopped' ? 'error' : 'completed';
    }
    // A failed launch (validation error before the background task was
    // registered) returns an is_error tool_result and never emits a
    // task_notification - surface it as an error instead of staying stuck on
    // "running" forever.
    if (result?.is_error) {
      return 'error';
    }
    return 'running';
  }
  if (!result) {
    return 'running';
  }
  if (result.is_error) {
    return 'error';
  }
  return 'completed';
}

function extractResultMetadata(
  result: ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  toolUseId: string,
  taskEvent: TaskEvent | undefined,
): Partial<SubagentInfo> {
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;

  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const toolStats = record?.toolStats && typeof record.toolStats === 'object' && !Array.isArray(record.toolStats)
    ? Object.fromEntries(
      Object.entries(record.toolStats as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    )
    : undefined;

  // task_notification wins over toolUseResult: for async agents the launch
  // tool_result carries no usage, so the event is the only source of truth.
  return {
    agentId: taskEvent?.agentId ?? getString(record?.agentId),
    totalDurationMs: taskEvent?.totalDurationMs ?? getNumber(record?.totalDurationMs),
    totalTokens: taskEvent?.totalTokens ?? getNumber(record?.totalTokens),
    totalToolUseCount: taskEvent?.totalToolUseCount ?? getNumber(record?.totalToolUseCount),
    toolStats,
    resultText: taskEvent?.summary ?? extractResultText(result),
  };
}

export function extractSubagentsFromMessages(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  taskEvents: TaskEventMap = {},
): SubagentInfo[] {
  const subagents: SubagentInfo[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.type !== 'assistant') return;

    const blocks = getContentBlocks(message);

    blocks.forEach((block) => {
      if (block.type !== 'tool_use') return;

      const toolName = normalizeToolName(block.name ?? '');

      // Only process task/agent-style subagent tool calls.
      if (toolName !== 'task' && toolName !== 'agent' && toolName !== 'spawn_agent') return;

      const rawInput = block.input as Record<string, unknown> | undefined;
      const input = rawInput ? normalizeToolInput(block.name, rawInput) as Record<string, unknown> : undefined;
      if (!input) return;

      // Defensive: ensure all string values are actually strings
      const id = String(block.id ?? `task-${messageIndex}-${subagents.length}`);
      const subagentType = String((input.subagent_type as string) ?? (input.subagentType as string) ?? 'Unknown');
      const description = String((input.description as string) ?? '');
      const prompt = String((input.prompt as string) ?? '');

      // Check tool result to determine status
      const toolUseId = block.id ?? '';
      const result = findToolResult(toolUseId, messageIndex);
      const taskEvent = taskEvents[toolUseId];
      // isAsync is read via the shared isAsyncAgentInput helper so the
      // StatusPanel list and the inline Agent cards stay in lockstep.
      const isAsync = isAsyncAgentInput(input);
      const status = determineStatus(result, isAsync, taskEvent);
      const resultMetadata = extractResultMetadata(result, getToolResultRaw, toolUseId, taskEvent);

      subagents.push({
        id,
        type: subagentType,
        description,
        prompt,
        status,
        isAsync,
        messageIndex,
        ...resultMetadata,
      });
    });
  });

  return subagents;
}

export function applySubagentHistoryCompletion(
  subagents: SubagentInfo[],
  subagentHistories: Record<string, SubagentHistoryResponse>,
): SubagentInfo[] {
  return subagents.map((subagent) => {
    if (!subagent.isAsync || subagent.status !== 'running') return subagent;
    const history = subagentHistories[subagent.id]
      ?? (subagent.agentId ? subagentHistories[subagent.agentId] : undefined);
    return history?.completed ? { ...subagent, status: 'completed' as const } : subagent;
  });
}

/**
 * Hook to extract subagent information from Task tool calls.
 */
export function useSubagents({
  messages,
  getContentBlocks,
  findToolResult,
  getToolResultRaw,
  subagentHistories = {},
}: UseSubagentsParams): SubagentInfo[] {
  const taskEvents = useTaskEvents();
  return useMemo(() => {
    const extracted = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult,
      getToolResultRaw,
      taskEvents,
    );
    return applySubagentHistoryCompletion(extracted, subagentHistories);
  }, [messages, getContentBlocks, findToolResult, getToolResultRaw, taskEvents, subagentHistories]);
}
