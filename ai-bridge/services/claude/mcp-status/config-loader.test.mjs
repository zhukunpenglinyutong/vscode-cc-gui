import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect HOME to a temp dir BEFORE the first call to getRealHomeDir().
// path-utils caches the resolved home on first invocation, so we lock in the
// override here and share the same temp HOME across all tests in this file.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomeRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-mcp-config-'));
const tempHome = fs.realpathSync(tempHomeRaw);
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { loadMcpServersConfigAsRecord, loadMcpServersConfig } = await import('./config-loader.js');

const claudeJsonPath = path.join(tempHome, '.claude.json');

function writeConfig(obj) {
  fs.writeFileSync(claudeJsonPath, JSON.stringify(obj));
}

function clearConfig() {
  try { fs.unlinkSync(claudeJsonPath); } catch { /* not present */ }
}

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('loadMcpServersConfigAsRecord returns null when ~/.claude.json is missing', async () => {
  clearConfig();
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null when mcpServers is absent or empty', async () => {
  writeConfig({});
  assert.equal(await loadMcpServersConfigAsRecord(), null);

  writeConfig({ mcpServers: {} });
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null when every server is disabled', async () => {
  writeConfig({
    mcpServers: { foo: { command: 'node', args: ['s.js'] } },
    disabledMcpServers: ['foo']
  });
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null on invalid JSON', async () => {
  fs.writeFileSync(claudeJsonPath, '{ this is not valid json');
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns Record<name, config> for enabled servers', async () => {
  writeConfig({
    mcpServers: {
      stdio: { command: 'node', args: ['server.js'] },
      http: { url: 'http://localhost:3000' }
    }
  });
  const result = await loadMcpServersConfigAsRecord();
  assert.ok(result, 'expected a non-null record');
  assert.deepEqual(Object.keys(result).sort(), ['http', 'stdio']);
  assert.deepEqual(result.stdio, { command: 'node', args: ['server.js'] });
  assert.deepEqual(result.http, { url: 'http://localhost:3000' });
});

test('loadMcpServersConfigAsRecord skips invalid server configs but keeps valid ones', async () => {
  writeConfig({
    mcpServers: {
      good: { command: 'node' },
      noCommandOrUrl: { foo: 'bar' },
      badArgs: { command: 'node', args: 'not-an-array' }
    }
  });
  const result = await loadMcpServersConfigAsRecord();
  assert.ok(result, 'expected a non-null record');
  assert.deepEqual(Object.keys(result), ['good']);
});

test('loadMcpServersConfig still returns an array (empty on missing config)', async () => {
  clearConfig();
  const list = await loadMcpServersConfig();
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 0);
});

test('merges global (user) and project (local) scopes, project wins on clash', async () => {
  const cwd = '/tmp/proj-a';
  writeConfig({
    mcpServers: {
      global: { command: 'g' },
      shared: { command: 'from-global' }
    },
    projects: {
      [cwd]: {
        mcpServers: {
          local: { command: 'l' },
          shared: { command: 'from-project' }
        }
      }
    }
  });
  const record = await loadMcpServersConfigAsRecord(cwd);
  assert.deepEqual(Object.keys(record).sort(), ['global', 'local', 'shared']);
  assert.equal(record.shared.command, 'from-project'); // local overrides user
});

test('project-scoped disabled name hides a global server for that project', async () => {
  const cwd = '/tmp/proj-b';
  writeConfig({
    mcpServers: { keep: { command: 'k' }, gone: { command: 'x' } },
    projects: { [cwd]: { disabledMcpServers: ['gone'] } }
  });
  const record = await loadMcpServersConfigAsRecord(cwd);
  assert.deepEqual(Object.keys(record), ['keep']);
});
