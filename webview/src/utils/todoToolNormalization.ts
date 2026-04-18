import type { ClaudeContentBlock, TodoItem, ToolInput } from '../types';
import { normalizeToolName } from './toolConstants';
import { normalizeTodoStatus } from './todoShared';
import type { RawTodoItem } from './todoShared';

function getTodoContent(item: RawTodoItem): string | null {
  const candidates = [item.content, item.step, item.title, item.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function normalizeTodoItem(item: RawTodoItem): TodoItem | null {
  const content = getTodoContent(item);
  if (!content) {
    return null;
  }

  const normalized: TodoItem = {
    content,
    status: normalizeTodoStatus(item.status),
  };

  if (typeof item.id === 'string' || typeof item.id === 'number') {
    normalized.id = String(item.id);
  }

  return normalized;
}

export function extractTodosFromToolUse(block: ClaudeContentBlock): TodoItem[] | null {
  if (block.type !== 'tool_use') {
    return null;
  }

  const toolName = normalizeToolName(block.name ?? '');
  const input = (block.input ?? {}) as ToolInput;

  if (toolName === 'todowrite') {
    if (!Array.isArray(input.todos)) {
      return null;
    }
    return input.todos
      .map((item) => (item && typeof item === 'object' ? normalizeTodoItem(item as RawTodoItem) : null))
      .filter((item): item is TodoItem => item !== null);
  }

  if (toolName === 'update_plan') {
    if (!Array.isArray(input.plan)) {
      return null;
    }
    return input.plan
      .map((item) => (item && typeof item === 'object' ? normalizeTodoItem(item as RawTodoItem) : null))
      .filter((item): item is TodoItem => item !== null);
  }

  return null;
}
