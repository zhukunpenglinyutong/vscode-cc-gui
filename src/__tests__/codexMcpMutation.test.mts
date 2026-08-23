import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { CODEX_CONFIG_NOT_AUTHORIZED_ERROR, planCodexMcpMutation } =
  await import('../bridge/handlers/codexMcpMutation.ts');

const MUTATION_EVENTS = [
  'add_codex_mcp_server',
  'update_codex_mcp_server',
  'delete_codex_mcp_server',
  'toggle_codex_mcp_server',
] as const;

describe('planCodexMcpMutation authorization gate', () => {
  it('denies every Codex mutation when config management is not allowed', () => {
    for (const event of MUTATION_EVENTS) {
      const decision = planCodexMcpMutation(event, { id: 'srv', enabled: false }, false);
      assert.equal(decision.kind, 'denied', event);
      assert.equal((decision as any).error, CODEX_CONFIG_NOT_AUTHORIZED_ERROR);
    }
  });

  it('never emits a daemon op while unauthorized, even for rename payloads', () => {
    const decision = planCodexMcpMutation(
      'update_codex_mcp_server',
      { id: 'new', oldId: 'old', server: { command: 'x' } },
      false,
    );
    assert.equal(decision.kind, 'denied');
  });
});

describe('planCodexMcpMutation daemon op mapping', () => {
  it('maps add to codex.mcpAdd with op=add', () => {
    const decision = planCodexMcpMutation(
      'add_codex_mcp_server',
      { id: 'srv', server: { command: 'npx', args: ['-y', 'pkg'] } },
      true,
    );
    assert.deepEqual(decision, {
      kind: 'daemon',
      method: 'codex.mcpAdd',
      params: { name: 'srv', config: { command: 'npx', args: ['-y', 'pkg'] }, op: 'add' },
    });
  });

  it('maps update without oldId to codex.mcpAdd with op=update', () => {
    const decision = planCodexMcpMutation(
      'update_codex_mcp_server',
      { id: 'srv', server: { url: 'http://localhost:1' } },
      true,
    );
    assert.deepEqual(decision, {
      kind: 'daemon',
      method: 'codex.mcpAdd',
      params: { name: 'srv', config: { url: 'http://localhost:1' }, op: 'update' },
    });
  });

  it('routes update with a differing oldId through codex.mcpRename', () => {
    const decision = planCodexMcpMutation(
      'update_codex_mcp_server',
      { id: 'new-name', oldId: 'old-name', server: { command: 'run' } },
      true,
    );
    assert.deepEqual(decision, {
      kind: 'daemon',
      method: 'codex.mcpRename',
      params: { oldName: 'old-name', name: 'new-name', config: { command: 'run' }, op: 'rename' },
    });
  });

  it('treats an oldId equal to the new id as a plain update', () => {
    const decision = planCodexMcpMutation(
      'update_codex_mcp_server',
      { id: 'same', oldId: 'same', server: { command: 'run' } },
      true,
    );
    assert.equal(decision.kind, 'daemon');
    assert.equal((decision as any).method, 'codex.mcpAdd');
  });

  it('maps delete to codex.mcpRemove with op=remove', () => {
    const decision = planCodexMcpMutation('delete_codex_mcp_server', { id: 'srv' }, true);
    assert.deepEqual(decision, {
      kind: 'daemon',
      method: 'codex.mcpRemove',
      params: { name: 'srv', op: 'remove' },
    });
  });

  it('maps toggle to codex.mcpSetEnabled preserving the enabled flag', () => {
    const off = planCodexMcpMutation('toggle_codex_mcp_server', { id: 'srv', enabled: false }, true);
    assert.deepEqual(off, {
      kind: 'daemon',
      method: 'codex.mcpSetEnabled',
      params: { name: 'srv', enabled: false, op: 'toggle' },
    });
    const on = planCodexMcpMutation('toggle_codex_mcp_server', { id: 'srv', enabled: true }, true);
    assert.deepEqual((on as any).params, { name: 'srv', enabled: true, op: 'toggle' });
  });
});
