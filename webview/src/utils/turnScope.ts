import type { ClaudeMessage, TodoItem, SubagentInfo } from '../types';

export function isToolResultOnlyUserMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;
  if ((message.content ?? '').trim() === '[tool_result]') return true;

  const raw = message.raw;
  if (!raw || typeof raw === 'string') return false;

  const content = raw.content ?? raw.message?.content;
  if (!Array.isArray(content)) return false;

  return content.some((block) =>
    block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result',
  );
}

export function findLatestConversationTurnStart(messages: ClaudeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user') continue;
    if (isToolResultOnlyUserMessage(message)) continue;
    return i;
  }
  return -1;
}

export function sliceLatestConversationTurn(messages: ClaudeMessage[]): ClaudeMessage[] {
  const start = findLatestConversationTurnStart(messages);
  return start >= 0 ? messages.slice(start) : [];
}

/**
 * When the parent turn settles, promote stuck in_progress todos to completed.
 * Todos do not outlive the turn the way background agents do — an unfinished
 * in_progress item after end_turn is almost always a missed TodoWrite update.
 */
export function finalizeTodosForSettledTurn(todos: TodoItem[], isStreaming: boolean): TodoItem[] {
  if (isStreaming) return todos;
  return todos.map((todo) => (
    todo.status === 'in_progress'
      ? { ...todo, status: 'completed' }
      : todo
  ));
}

/**
 * When the parent turn settles, only force-complete *sync* subagents that are
 * still marked running (orphan tool_use without a tool_result).
 *
 * Async agents (run_in_background:true) intentionally outlive the parent turn:
 * their launch tool_result is only an ACK, and terminal status arrives later
 * via task_notification / sidechain history. Force-completing them here made
 * StatusPanel show "2/2 completed" while the inline cards were still spinning.
 */
export function finalizeSubagentsForSettledTurn(subagents: SubagentInfo[], isStreaming: boolean): SubagentInfo[] {
  if (isStreaming) return subagents;
  return subagents.map((subagent) => (
    subagent.status === 'running' && !subagent.isAsync
      ? { ...subagent, status: 'completed' }
      : subagent
  ));
}
