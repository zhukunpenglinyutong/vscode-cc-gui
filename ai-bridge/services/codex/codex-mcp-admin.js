/**
 * Codex MCP admin — read/write ~/.codex/config.toml through the `codex mcp` CLI.
 *
 * The CLI owns the TOML format (escaping, arg arrays, env tables), so add/remove
 * go through it rather than hand-writing TOML. The one thing the CLI has no
 * subcommand for is the persistent `enabled` flag, so enable/disable is applied
 * as a single, bounded line edit inside the target `[mcp_servers.<name>]`
 * section (see setMcpEnabledInToml) — everything else in config.toml is left
 * untouched.
 *
 * Every mutating call ends by printing the refreshed list tagged
 * `[MCP_SERVER_LIST]` so the extension can update the panel from one code path.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { getCodexCliEntrypoint } from '../../utils/sdk-loader.js';

function codexConfigPath() {
  return join(homedir(), '.codex', 'config.toml');
}

function runCodexMcp(args) {
  return new Promise((resolve) => {
    let wrapperPath;
    try {
      ({ wrapperPath } = getCodexCliEntrypoint());
    } catch (error) {
      resolve({ code: 1, stdout: '', stderr: error.message });
      return;
    }
    const child = spawn(process.execPath, [wrapperPath, 'mcp', ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.once('error', (error) => resolve({ code: 1, stdout, stderr: stderr || error.message }));
    child.once('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * Map a `codex mcp list --json` entry to the panel's server shape
 * `{ id, name, server, enabled }`.
 */
function toPanelServer(entry) {
  const transport = entry?.transport ?? {};
  const server = {};
  if (transport.type === 'stdio') {
    server.type = 'stdio';
    if (transport.command) server.command = transport.command;
    if (Array.isArray(transport.args) && transport.args.length > 0) server.args = transport.args;
    if (transport.env && typeof transport.env === 'object') server.env = transport.env;
  } else {
    // streamable_http / sse / http — surface the url for display.
    server.type = transport.type || 'http';
    if (transport.url) server.url = transport.url;
  }
  return {
    id: entry.name,
    name: entry.name,
    server,
    enabled: entry.enabled !== false,
  };
}

async function readServerList() {
  const result = await runCodexMcp(['list', '--json']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `codex mcp list exited with code ${result.code}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim() || '[]');
  } catch (error) {
    throw new Error(`Failed to parse codex mcp list output: ${error.message}`);
  }
  return Array.isArray(parsed) ? parsed.map(toPanelServer) : [];
}

function printServerList(servers) {
  console.log('[MCP_SERVER_LIST]' + JSON.stringify(servers));
}

/**
 * Resolve a single server's config from the native config.toml, or null.
 * Used when probing tools without a config supplied by the caller.
 */
export async function resolveCodexMcpServerConfig(name) {
  if (!name) return null;
  const servers = await readServerList();
  const found = servers.find((s) => s.name === name || s.id === name);
  return found ? found.server : null;
}

/** List Codex MCP servers and emit them for the panel. */
export async function listCodexMcpServers() {
  try {
    printServerList(await readServerList());
  } catch (error) {
    console.error('[CODEX_MCP_LIST_ERROR]', error.message);
    printServerList([]);
  }
}

function buildAddArgs(name, config) {
  const args = [name];
  const hasCommand = typeof config?.command === 'string' && config.command.length > 0;
  const hasUrl = typeof config?.url === 'string' && config.url.length > 0;

  if (hasCommand) {
    if (config.env && typeof config.env === 'object') {
      for (const [key, value] of Object.entries(config.env)) {
        args.push('--env', `${key}=${value}`);
      }
    }
    args.push('--', config.command);
    if (Array.isArray(config.args)) {
      for (const a of config.args) args.push(String(a));
    }
  } else if (hasUrl) {
    args.push('--url', config.url);
  } else {
    throw new Error('MCP server config needs either a command (stdio) or a url (http)');
  }
  return args;
}

/** Add/update a Codex MCP server, then emit the refreshed list. */
export async function addCodexMcpServer(name, config) {
  try {
    if (!name) throw new Error('Missing server name');
    // `codex mcp add` errors if the name already exists; replace by removing first.
    await runCodexMcp(['remove', name]);
    const result = await runCodexMcp(['add', ...buildAddArgs(name, config)]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `codex mcp add exited with code ${result.code}`);
    }
    printServerList(await readServerList());
  } catch (error) {
    console.error('[CODEX_MCP_ADD_ERROR]', error.message);
    await listCodexMcpServers();
  }
}

/** Remove a Codex MCP server, then emit the refreshed list. */
export async function removeCodexMcpServer(name) {
  try {
    if (!name) throw new Error('Missing server name');
    const result = await runCodexMcp(['remove', name]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `codex mcp remove exited with code ${result.code}`);
    }
    printServerList(await readServerList());
  } catch (error) {
    console.error('[CODEX_MCP_REMOVE_ERROR]', error.message);
    await listCodexMcpServers();
  }
}

/**
 * Toggle a Codex MCP server's persistent `enabled` flag by editing config.toml
 * in place, then emit the refreshed list. The CLI has no enable/disable command,
 * so this is the only native way to persist the state.
 */
export async function setCodexMcpServerEnabled(name, enabled) {
  try {
    if (!name) throw new Error('Missing server name');
    const file = codexConfigPath();
    if (!existsSync(file)) throw new Error(`Codex config not found: ${file}`);
    const original = readFileSync(file, 'utf8');
    const updated = setMcpEnabledInToml(original, name, enabled);
    if (updated !== original) {
      writeConfigAtomically(file, updated);
    }
    printServerList(await readServerList());
  } catch (error) {
    console.error('[CODEX_MCP_TOGGLE_ERROR]', error.message);
    await listCodexMcpServers();
  }
}

function writeConfigAtomically(file, content) {
  const tmp = join(dirname(file), `${basename(file)}-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

/**
 * Return `toml` with the `enabled` flag of `[mcp_servers.<name>]` set to
 * `enabled`. Only that one section is touched; if the section is missing the
 * input is returned unchanged. Exported for unit testing.
 * @param {string} toml
 * @param {string} name
 * @param {boolean} enabled
 * @returns {string}
 */
export function setMcpEnabledInToml(toml, name, enabled) {
  const lines = toml.split('\n');
  const headerCandidates = new Set([
    `[mcp_servers.${name}]`,
    `[mcp_servers."${name}"]`,
  ]);
  const headerIndex = lines.findIndex((line) => headerCandidates.has(line.trim()));
  if (headerIndex < 0) return toml;

  // Section spans until the next table header or end of file.
  let sectionEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('[')) {
      sectionEnd = i;
      break;
    }
  }

  const enabledLine = `enabled = ${enabled ? 'true' : 'false'}`;
  const existingIndex = lines
    .slice(headerIndex + 1, sectionEnd)
    .findIndex((line) => /^\s*enabled\s*=/.test(line));

  const next = [...lines];
  if (existingIndex >= 0) {
    next[headerIndex + 1 + existingIndex] = enabledLine;
  } else {
    next.splice(headerIndex + 1, 0, enabledLine);
  }
  return next.join('\n');
}
