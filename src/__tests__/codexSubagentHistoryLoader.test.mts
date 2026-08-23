import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CodexSubagentHistoryLoader,
  type SubagentStatusRequest,
} from '../bridge/services/codexSubagentHistoryLoader.ts';

type Json = Record<string, any>;

function object(...properties: string[]): Json {
  const result: Json = {};
  for (let i = 0; i < properties.length; i += 2) {
    result[properties[i]] = properties[i + 1];
  }
  return result;
}

function record(type: string, payload: Json): Json {
  return { type, payload };
}

function sessionMeta(id: string, parentId: string, agentPath: string): Json {
  return record('session_meta', {
    id,
    source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: agentPath } } },
  });
}

function turnContext(turnId: string): Json {
  return record('turn_context', { turn_id: turnId });
}

function event(type: string, ...properties: string[]): Json {
  return record('event_msg', { ...object(...properties), type });
}

function responseMessage(role: string, text: string): Json {
  return record('response_item', {
    type: 'message',
    role,
    content: [{ type: 'output_text', text }],
  });
}

function writeRollout(filePath: string, ...records: Json[]): void {
  fs.writeFileSync(filePath, records.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
}

function makeSessionsDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('CodexSubagentHistoryLoader', () => {
  it('loads child by parent activity and skips forked parent turn', () => {
    const sessionsDir = makeSessionsDir('codex-subagent-sessions-');
    const parentId = '019fa70f-0653-73e2-a613-1fb0a9e83a2b';
    const childId = '019fb0fe-c344-7da0-9d10-20659f884100';
    writeRollout(path.join(sessionsDir, `rollout-parent-${parentId}.jsonl`),
      event('sub_agent_activity', 'event_id', 'call-123',
        'agent_thread_id', childId, 'agent_path', '/root/audit_ui'));
    writeRollout(path.join(sessionsDir, `rollout-child-${childId}.jsonl`),
      event('task_started', 'turn_id', 'forked-turn'),
      turnContext('forked-turn'),
      sessionMeta(childId, parentId, '/root/audit_ui'),
      event('task_started', 'turn_id', 'child-turn'),
      responseMessage('assistant', 'child output'),
      turnContext('child-turn'),
      event('task_complete', 'turn_id', 'child-turn'));

    const result = new CodexSubagentHistoryLoader(sessionsDir).load(parentId, 'call-123', 'audit_ui');

    assert.equal(result.agentThreadId, childId);
    assert.equal(result.agentPath, '/root/audit_ui');
    assert.equal(result.status, 'completed');
    assert.ok(JSON.stringify(result.messages).includes('child output'));
    assert.ok(!JSON.stringify(result.messages).includes('forked-turn'));
  });

  it('reports running until the matching child turn completes', () => {
    const rollout = [
      sessionMeta('child', 'parent', '/root/audit_ui'),
      event('task_started', 'turn_id', 'child-turn'),
      turnContext('child-turn'),
    ];

    const result = CodexSubagentHistoryLoader.extractInitialSubagentTurn(rollout);

    assert.equal(result.status, 'running');
    assert.equal(result.messages.length, 2);
  });

  it('reports an aborted matching child turn as error', () => {
    const rollout = [
      sessionMeta('child', 'parent', '/root/audit_ui'),
      event('task_started', 'turn_id', 'child-turn'),
      turnContext('child-turn'),
      event('turn_aborted', 'turn_id', 'child-turn'),
    ];

    const result = CodexSubagentHistoryLoader.extractInitialSubagentTurn(rollout);

    assert.equal(result.status, 'error');
    assert.equal(result.error, 'Codex subagent turn was aborted');
  });

  it('loads multiple statuses from one parent activity map', () => {
    const sessionsDir = makeSessionsDir('codex-subagent-status-');
    const parentId = '019fa70f-0653-73e2-a613-1fb0a9e83a2b';
    const completedChildId = '019fb0fe-c344-7da0-9d10-20659f884100';
    const runningChildId = '019fb0fe-c344-7da0-9d10-20659f884101';
    writeRollout(path.join(sessionsDir, `rollout-parent-${parentId}.jsonl`),
      event('sub_agent_activity', 'event_id', 'call-completed',
        'agent_thread_id', completedChildId, 'agent_path', '/root/completed'),
      event('sub_agent_activity', 'event_id', 'call-running',
        'agent_thread_id', runningChildId, 'agent_path', '/root/running'));
    writeRollout(path.join(sessionsDir, `rollout-child-${completedChildId}.jsonl`),
      sessionMeta(completedChildId, parentId, '/root/completed'),
      event('task_started', 'turn_id', 'completed-turn'),
      turnContext('completed-turn'),
      responseMessage('assistant', 'large transcript must not be returned'),
      event('task_complete', 'turn_id', 'completed-turn'));
    writeRollout(path.join(sessionsDir, `rollout-child-${runningChildId}.jsonl`),
      sessionMeta(runningChildId, parentId, '/root/running'),
      event('task_started', 'turn_id', 'running-turn'),
      turnContext('running-turn'),
      responseMessage('assistant', 'still working'));

    const requests: SubagentStatusRequest[] = [
      { toolUseId: 'call-completed', agentPath: '/root/completed' },
      { toolUseId: 'call-running', agentPath: '/root/running' },
    ];
    const results = new CodexSubagentHistoryLoader(sessionsDir).loadStatuses(parentId, requests);

    assert.equal(results.length, 2);
    assert.equal(results[0].success, true);
    assert.equal(results[0].agentId, completedChildId);
    assert.equal(results[0].status, 'completed');
    assert.equal(results[1].success, true);
    assert.equal(results[1].agentId, runningChildId);
    assert.equal(results[1].status, 'running');
  });

  it('keeps a missing activity pending', () => {
    const sessionsDir = makeSessionsDir('codex-subagent-pending-');
    const parentId = '019fa70f-0653-73e2-a613-1fb0a9e83a2b';
    writeRollout(path.join(sessionsDir, `rollout-parent-${parentId}.jsonl`), event('noop'));

    const results = new CodexSubagentHistoryLoader(sessionsDir).loadStatuses(parentId, [
      { toolUseId: 'call-pending' },
    ]);

    assert.equal(results.length, 1);
    assert.equal(results[0].success, false);
    assert.equal(results[0].status, 'running');
    assert.equal(results[0].error, 'Codex subagent activity not found yet');
  });

  it('keeps unreadable child metadata pending instead of a permanent error', () => {
    // Regression test: a child rollout that exists but has no readable
    // session_meta yet (slow disk, file mid-write) must stay retryable.
    // Previously this surfaced as a terminal "does not belong to parent
    // session" error, which the frontend then locked in forever.
    const sessionsDir = makeSessionsDir('codex-subagent-unreadable-');
    const parentId = '019fa70f-0653-73e2-a613-1fb0a9e83a2b';
    const childId = '019fb0fe-c344-7da0-9d10-20659f884100';
    writeRollout(path.join(sessionsDir, `rollout-parent-${parentId}.jsonl`), event('noop'));
    writeRollout(path.join(sessionsDir, `rollout-child-${childId}.jsonl`),
      event('task_started', 'turn_id', 'child-turn'),
      turnContext('child-turn'));

    const results = new CodexSubagentHistoryLoader(sessionsDir).loadStatuses(parentId, [
      { agentId: childId },
    ]);

    assert.equal(results.length, 1);
    assert.equal(results[0].success, false);
    assert.equal(results[0].status, 'running');
  });

  it('rejects an agentPath with a ".." segment', () => {
    const sessionsDir = makeSessionsDir('codex-subagent-traversal-');
    const parentId = '019fa70f-0653-73e2-a613-1fb0a9e83a2b';
    assert.throws(
      () => new CodexSubagentHistoryLoader(sessionsDir).loadStatuses(parentId, [
        { agentPath: '/root/../evil' },
      ]),
      (error: unknown) => error instanceof Error && error.message === 'Invalid agentPath',
    );
  });
});
