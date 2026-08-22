import { describe, expect, it } from 'vitest';
import type { SubagentInfo, TodoItem } from '../types';
import {
  finalizeSubagentsForSettledTurn,
  finalizeTodosForSettledTurn,
} from './turnScope';

const todo = (status: TodoItem['status']): TodoItem => ({
  content: 'work',
  status,
});

const subagent = (
  status: SubagentInfo['status'],
  isAsync?: boolean,
): SubagentInfo => ({
  id: `tool-${status}-${isAsync ? 'async' : 'sync'}`,
  type: 'general-purpose',
  description: 'do work',
  status,
  isAsync,
  messageIndex: 0,
});

describe('finalizeTodosForSettledTurn', () => {
  it('leaves todos unchanged while streaming', () => {
    const todos = [todo('in_progress'), todo('pending')];
    expect(finalizeTodosForSettledTurn(todos, true)).toEqual(todos);
  });

  it('promotes in_progress todos to completed once the turn settles', () => {
    const result = finalizeTodosForSettledTurn(
      [todo('in_progress'), todo('pending'), todo('completed')],
      false,
    );
    expect(result.map((item) => item.status)).toEqual([
      'completed',
      'pending',
      'completed',
    ]);
  });
});

describe('finalizeSubagentsForSettledTurn', () => {
  it('leaves subagents unchanged while streaming', () => {
    const agents = [subagent('running', true), subagent('running', false)];
    expect(finalizeSubagentsForSettledTurn(agents, true)).toEqual(agents);
  });

  it('force-completes only sync running agents when the parent turn settles', () => {
    const result = finalizeSubagentsForSettledTurn(
      [
        subagent('running', false),
        subagent('completed', false),
        subagent('error', false),
      ],
      false,
    );
    expect(result.map((item) => item.status)).toEqual([
      'completed',
      'completed',
      'error',
    ]);
  });

  it('keeps async running agents running after the parent turn settles', () => {
    const result = finalizeSubagentsForSettledTurn(
      [
        subagent('running', true),
        subagent('running', false),
        subagent('completed', true),
      ],
      false,
    );
    expect(result.map((item) => item.status)).toEqual([
      'running',
      'completed',
      'completed',
    ]);
  });

  it('treats missing isAsync as sync (force-complete when settled)', () => {
    const result = finalizeSubagentsForSettledTurn(
      [subagent('running')],
      false,
    );
    expect(result[0].status).toBe('completed');
  });
});
