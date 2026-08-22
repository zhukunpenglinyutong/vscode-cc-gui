import test from 'node:test';
import assert from 'node:assert/strict';
import { setMcpEnabledInToml } from './codex-mcp-admin.js';

const base = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.memory]',
  'command = "npx"',
  'args = ["-y", "@modelcontextprotocol/server-memory"]',
  '',
  '[mcp_servers.other]',
  'command = "foo"',
  '',
].join('\n');

test('inserts enabled = false right after the target section header', () => {
  const out = setMcpEnabledInToml(base, 'memory', false);
  const lines = out.split('\n');
  const header = lines.indexOf('[mcp_servers.memory]');
  assert.equal(lines[header + 1], 'enabled = false');
  // The other section is untouched.
  assert.ok(out.includes('[mcp_servers.other]\ncommand = "foo"'));
});

test('replaces an existing enabled line instead of duplicating it', () => {
  const disabled = setMcpEnabledInToml(base, 'memory', false);
  const reenabled = setMcpEnabledInToml(disabled, 'memory', true);
  const count = reenabled.split('\n').filter((l) => /^\s*enabled\s*=/.test(l)).length;
  assert.equal(count, 1);
  const lines = reenabled.split('\n');
  const header = lines.indexOf('[mcp_servers.memory]');
  assert.equal(lines[header + 1], 'enabled = true');
});

test('only touches the named section', () => {
  const out = setMcpEnabledInToml(base, 'other', false);
  const lines = out.split('\n');
  // memory section must not gain an enabled line
  const memHeader = lines.indexOf('[mcp_servers.memory]');
  assert.notEqual(lines[memHeader + 1], 'enabled = false');
  const otherHeader = lines.indexOf('[mcp_servers.other]');
  assert.equal(lines[otherHeader + 1], 'enabled = false');
});

test('returns input unchanged when the section is missing', () => {
  assert.equal(setMcpEnabledInToml(base, 'ghost', false), base);
});

test('handles a quoted section header', () => {
  const toml = '[mcp_servers."my-server"]\ncommand = "x"\n';
  const out = setMcpEnabledInToml(toml, 'my-server', false);
  assert.ok(out.includes('[mcp_servers."my-server"]\nenabled = false'));
});
