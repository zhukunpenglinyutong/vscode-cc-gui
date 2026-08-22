import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopilotMcpConfig } from '../bridge/services/copilotMcpImport.ts';

describe('parseCopilotMcpConfig', () => {
  it('parses a stdio server, defaulting name to the server id', () => {
    const raw = JSON.stringify({
      servers: {
        myserver: { command: 'npx', args: ['-y', 'some-pkg'], env: { API_KEY: 'x' } },
      },
    });
    const result = parseCopilotMcpConfig(raw, false);
    assert.equal(result.error, undefined);
    assert.equal(result.servers.length, 1);
    const server = result.servers[0];
    assert.equal(server.id, 'myserver');
    assert.equal(server.name, 'myserver');
    assert.deepEqual(server.server, { command: 'npx', args: ['-y', 'some-pkg'], env: { API_KEY: 'x' }, type: 'stdio' });
    assert.deepEqual(server.apps, { claude: true, codex: false, gemini: false });
    assert.equal(server.enabled, true);
  });

  it('uses the entry name field when present instead of the id', () => {
    const raw = JSON.stringify({ servers: { srv1: { command: 'npx', name: 'Friendly Name' } } });
    const result = parseCopilotMcpConfig(raw);
    assert.equal(result.servers[0].name, 'Friendly Name');
  });

  it('sets apps.codex=true and apps.claude=false when isCodexMode is true', () => {
    const raw = JSON.stringify({ servers: { srv1: { command: 'npx' } } });
    const result = parseCopilotMcpConfig(raw, true);
    assert.deepEqual(result.servers[0].apps, { claude: false, codex: true, gemini: false });
  });

  it('infers type sse from a /sse URL, http from any other URL, stdio when a command is present', () => {
    const raw = JSON.stringify({
      servers: {
        sseServer: { url: 'https://example.com/sse' },
        httpServer: { url: 'https://example.com/mcp' },
        stdioServer: { command: 'node' },
        noHintServer: {},
      },
    });
    const result = parseCopilotMcpConfig(raw);
    const byId = Object.fromEntries(result.servers.map((s) => [s.id, s.server]));
    assert.equal(byId.sseServer.type, 'sse');
    assert.equal(byId.httpServer.type, 'http');
    assert.equal(byId.stdioServer.type, 'stdio');
    assert.equal(byId.noHintServer.type, 'stdio');
  });

  it('preserves an explicit type field instead of inferring one', () => {
    const raw = JSON.stringify({ servers: { srv1: { url: 'https://example.com/mcp', type: 'sse' } } });
    const result = parseCopilotMcpConfig(raw);
    assert.equal(result.servers[0].server.type, 'sse');
  });

  it('merges requestInit.headers with direct headers, direct wins on conflict, drops null values', () => {
    const raw = JSON.stringify({
      servers: {
        srv1: {
          url: 'https://example.com/mcp',
          requestInit: { headers: { 'X-From-Init': 'init-value', 'X-Conflict': 'from-init', 'X-Null-In-Init': null } },
          headers: { 'X-Conflict': 'from-direct', 'X-Direct-Only': 'direct-value', 'X-Null-Direct': null },
        },
      },
    });
    const result = parseCopilotMcpConfig(raw);
    assert.deepEqual(result.servers[0].server.headers, {
      'X-From-Init': 'init-value',
      'X-Conflict': 'from-direct',
      'X-Direct-Only': 'direct-value',
    });
  });

  it('omits the headers key entirely when there are no headers to merge', () => {
    const raw = JSON.stringify({ servers: { srv1: { command: 'npx' } } });
    const result = parseCopilotMcpConfig(raw);
    assert.equal('headers' in result.servers[0].server, false);
  });

  it('copies only the whitelisted pass-through fields, including x-metadata', () => {
    const raw = JSON.stringify({
      servers: {
        srv1: {
          command: 'npx',
          args: ['-y', 'pkg'],
          env: { A: '1' },
          url: 'https://example.com',
          type: 'http',
          'x-metadata': { source: 'copilot' },
          someUnrelatedField: 'should not be copied',
        },
      },
    });
    const result = parseCopilotMcpConfig(raw);
    const spec = result.servers[0].server;
    assert.deepEqual(spec, {
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
      url: 'https://example.com',
      type: 'http',
      'x-metadata': { source: 'copilot' },
    });
    assert.equal('someUnrelatedField' in spec, false);
  });

  it('returns an empty-servers error when the config has no "servers" key', () => {
    const result = parseCopilotMcpConfig(JSON.stringify({ mcpServers: { foo: {} } }));
    assert.deepEqual(result.servers, []);
    assert.equal(result.error, 'No servers found in config');
  });

  it('returns an empty-servers error when "servers" is an empty object', () => {
    const result = parseCopilotMcpConfig(JSON.stringify({ servers: {} }));
    assert.deepEqual(result.servers, []);
    assert.equal(result.error, 'No servers found in config');
  });

  it('returns an empty-servers error when "servers" is an array instead of an object', () => {
    const result = parseCopilotMcpConfig(JSON.stringify({ servers: [{ command: 'npx' }] }));
    assert.deepEqual(result.servers, []);
    assert.equal(result.error, 'No servers found in config');
  });

  it('returns a parse error (without throwing) for invalid JSON', () => {
    const result = parseCopilotMcpConfig('{not valid json');
    assert.deepEqual(result.servers, []);
    assert.ok(result.error && result.error.length > 0);
  });
});
