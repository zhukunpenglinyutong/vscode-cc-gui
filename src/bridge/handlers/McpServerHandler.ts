import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction, parseJson, postJson } from './helpers';

/**
 * MCP server management, backed by each provider's NATIVE config file:
 *   - Claude  -> ~/.claude.json  (global `mcpServers` + `disabledMcpServers[]`)
 *   - Codex   -> ~/.codex/config.toml  (via the `codex mcp` CLI, run in the daemon)
 *
 * There is no separate GUI store any more: what the panel shows, adds, edits,
 * toggles and deletes is exactly what a Claude/Codex session loads. Claude JSON
 * is edited here directly (a safe parse/stringify round-trip preserves every
 * other key). Codex TOML is owned by the `codex mcp` CLI, so all Codex writes
 * are routed to the daemon, which shells out to that CLI and streams back the
 * refreshed list tagged as `[MCP_SERVER_LIST]`.
 */
export class McpServerHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_mcp_servers',
    'get_codex_mcp_servers',
    'get_mcp_server_status',
    'get_codex_mcp_server_status',
    'get_mcp_server_tools',
    'get_codex_mcp_server_tools',
    'add_mcp_server',
    'add_codex_mcp_server',
    'update_mcp_server',
    'update_codex_mcp_server',
    'delete_mcp_server',
    'delete_codex_mcp_server',
    'toggle_mcp_server',
    'toggle_codex_mcp_server',
    'validate_mcp_server',
    'validate_codex_mcp_server',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  handle({ event, content, webview }: BridgeMessage): boolean {
    const isCodex = event.includes('codex');
    switch (event) {
      case 'get_mcp_servers':
        postJson(webview, 'update_mcp_servers', this.readClaudeServers());
        return true;
      case 'get_codex_mcp_servers':
        this.context.callbacks.sendDaemonRequest(event, 'codex.mcpList', {}, webview);
        return true;

      case 'get_mcp_server_status':
        this.context.callbacks.sendDaemonRequest(event, 'claude.getMcpServerStatus', {
          cwd: this.context.getWorkspacePath() || undefined,
        }, webview);
        return true;
      case 'get_codex_mcp_server_status':
        // Reuse the native list; the daemon tags it `[MCP_SERVER_LIST]` and the
        // extension maps it to a status payload for this request event.
        this.context.callbacks.sendDaemonRequest(event, 'codex.mcpList', {}, webview);
        return true;

      case 'get_mcp_server_tools':
      case 'get_codex_mcp_server_tools': {
        const { serverId } = parseJson<any>(content, {});
        if (!serverId) {
          callWindowFunction(webview, 'updateMcpServerTools', { serverId: '', tools: [], error: 'Missing serverId' });
          return true;
        }
        if (isCodex) {
          // The daemon resolves the server config from ~/.codex/config.toml.
          this.context.callbacks.sendDaemonRequest(event, 'codex.getMcpServerTools', { serverId }, webview);
        } else {
          this.context.callbacks.sendDaemonRequest(event, 'claude.getMcpServerTools', {
            serverId,
            cwd: this.context.getWorkspacePath() || undefined,
          }, webview);
        }
        return true;
      }

      case 'add_mcp_server':
      case 'update_mcp_server':
        this.upsertClaudeServer(content);
        postJson(webview, 'update_mcp_servers', this.readClaudeServers());
        return true;
      case 'delete_mcp_server':
        this.deleteClaudeServer(content);
        postJson(webview, 'update_mcp_servers', this.readClaudeServers());
        return true;
      case 'toggle_mcp_server':
        this.toggleClaudeServer(content);
        postJson(webview, 'update_mcp_servers', this.readClaudeServers());
        return true;

      case 'add_codex_mcp_server':
      case 'update_codex_mcp_server': {
        const payload = parseJson<any>(content, {});
        const name = payload.id || payload.name;
        const server = payload.server || {
          command: payload.command,
          args: payload.args,
          env: payload.env,
          url: payload.url,
          type: payload.type,
        };
        this.context.callbacks.sendDaemonRequest(event, 'codex.mcpAdd', { name, config: server }, webview);
        return true;
      }
      case 'delete_codex_mcp_server': {
        const { id, name } = parseJson<any>(content, {});
        this.context.callbacks.sendDaemonRequest(event, 'codex.mcpRemove', { name: id || name }, webview);
        return true;
      }
      case 'toggle_codex_mcp_server': {
        const payload = parseJson<any>(content, {});
        this.context.callbacks.sendDaemonRequest(event, 'codex.mcpSetEnabled', {
          name: payload.id || payload.name,
          enabled: payload.enabled !== false,
        }, webview);
        return true;
      }

      case 'validate_mcp_server':
      case 'validate_codex_mcp_server':
        callWindowFunction(webview, isCodex ? 'codexMcpValidateResult' : 'mcpValidateResult', { success: true });
        return true;
      default:
        return false;
    }
  }

  // ─── Claude: ~/.claude.json (native) ────────────────────────────────────────

  private claudeConfigPath(): string {
    return path.join(homedir(), '.claude.json');
  }

  private readClaudeJson(): any {
    try {
      return JSON.parse(fs.readFileSync(this.claudeConfigPath(), 'utf8'));
    } catch {
      return {};
    }
  }

  private writeClaudeJson(config: any): void {
    const file = this.claudeConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  }

  private projectPath(): string | undefined {
    return this.context.getWorkspacePath() || undefined;
  }

  /**
   * List Claude servers from both scopes: `user` (global `mcpServers`) and
   * `local` (this project's `projects[cwd].mcpServers`). On a name clash the
   * project entry wins, mirroring how Claude itself resolves scopes. Each entry
   * carries its `scope` so edits/deletes can target the right map.
   */
  private readClaudeServers(): any[] {
    const config = this.readClaudeJson();
    const disabled = new Set<string>(Array.isArray(config.disabledMcpServers) ? config.disabledMcpServers : []);
    const cwd = this.projectPath();
    const projectServers: Record<string, any> = cwd ? (config.projects?.[cwd]?.mcpServers ?? {}) : {};

    const byId = new Map<string, any>();
    for (const [id, server] of Object.entries((config.mcpServers ?? {}) as Record<string, any>)) {
      byId.set(id, { id, name: id, server, enabled: !disabled.has(id), scope: 'user' });
    }
    for (const [id, server] of Object.entries(projectServers)) {
      byId.set(id, { id, name: id, server, enabled: !disabled.has(id), scope: 'local' });
    }
    return [...byId.values()];
  }

  private upsertClaudeServer(content: string): void {
    const payload = parseJson<any>(content, {});
    const id = payload.id || payload.name;
    if (!id) return;
    const server = payload.server || {
      command: payload.command,
      args: payload.args || [],
      env: payload.env || {},
      url: payload.url,
      type: payload.type,
    };
    const cwd = this.projectPath();
    // `local` needs a project; without one, fall back to global so the server
    // is still saved somewhere a session will read.
    const scope = payload.scope === 'local' && cwd ? 'local' : 'user';

    const config = this.readClaudeJson();
    // Drop any prior copy from BOTH scopes so a scope change never leaves a dup.
    const globalServers = { ...(config.mcpServers ?? {}) };
    delete globalServers[id];
    const projects = { ...(config.projects ?? {}) };
    if (cwd && projects[cwd]?.mcpServers) {
      projects[cwd] = { ...projects[cwd], mcpServers: { ...projects[cwd].mcpServers } };
      delete projects[cwd].mcpServers[id];
    }
    const disabled = (Array.isArray(config.disabledMcpServers) ? config.disabledMcpServers : []).filter((n: string) => n !== id);

    if (scope === 'local' && cwd) {
      const existing = projects[cwd] ?? {};
      projects[cwd] = { ...existing, mcpServers: { ...(existing.mcpServers ?? {}), [id]: server } };
    } else {
      globalServers[id] = server;
    }
    this.writeClaudeJson({ ...config, mcpServers: globalServers, projects, disabledMcpServers: disabled });
  }

  private deleteClaudeServer(content: string): void {
    const { id, name } = parseJson<any>(content, {});
    const key = id || name;
    if (!key) return;
    const config = this.readClaudeJson();
    // Scope-agnostic: remove from global, this project, and the disabled list.
    const { [key]: _removed, ...globalServers } = (config.mcpServers ?? {}) as Record<string, any>;
    const cwd = this.projectPath();
    const projects = { ...(config.projects ?? {}) };
    if (cwd && projects[cwd]?.mcpServers) {
      const { [key]: _drop, ...rest } = projects[cwd].mcpServers as Record<string, any>;
      projects[cwd] = { ...projects[cwd], mcpServers: rest };
    }
    const disabled = (Array.isArray(config.disabledMcpServers) ? config.disabledMcpServers : []).filter((n: string) => n !== key);
    this.writeClaudeJson({ ...config, mcpServers: globalServers, projects, disabledMcpServers: disabled });
  }

  private toggleClaudeServer(content: string): void {
    const payload = parseJson<any>(content, {});
    const id = payload.id || payload.name;
    if (!id) return;
    const config = this.readClaudeJson();
    const current = new Set<string>(Array.isArray(config.disabledMcpServers) ? config.disabledMcpServers : []);
    if (payload.enabled === false) {
      current.add(id);
    } else {
      current.delete(id);
    }
    this.writeClaudeJson({ ...config, disabledMcpServers: [...current] });
  }
}
