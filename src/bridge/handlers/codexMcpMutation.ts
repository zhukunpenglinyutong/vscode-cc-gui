/**
 * Codex MCP mutation planning (vscode-free, unit-testable).
 *
 * Mirrors the JetBrains `CodexMcpServerHandler` authorization gate: every Codex
 * config write (add/update/delete/toggle, and rename via `oldId`) requires the
 * user-granted "Codex local config" authorization. Unlike the Java side, which
 * edits config.toml directly, writes here are routed to the daemon's
 * `codex mcp*` CLI ops — this module only decides WHICH daemon op (if any) a
 * webview request maps to, so the handler stays a thin adapter.
 */

export const CODEX_CONFIG_NOT_AUTHORIZED_ERROR =
  'Codex local config access is not authorized. Enable local config access for Codex in Settings before managing MCP servers.';

export type CodexMcpMutationEvent =
  | 'add_codex_mcp_server'
  | 'update_codex_mcp_server'
  | 'delete_codex_mcp_server'
  | 'toggle_codex_mcp_server';

export type CodexMcpMutationDecision =
  | { kind: 'daemon'; method: string; params: Record<string, unknown> }
  | { kind: 'denied'; error: string };

function serverConfigFromPayload(payload: any): Record<string, unknown> {
  return payload?.server || {
    command: payload?.command,
    args: payload?.args,
    env: payload?.env,
    url: payload?.url,
    type: payload?.type,
  };
}

/**
 * Map a Codex MCP mutation request to a daemon op. `op` tags the request so the
 * daemon can report the mutation outcome ([MCP_SERVER_MUTATED]) with the same
 * granularity the JetBrains side had (added/updated/deleted/toggled).
 *
 * Rename mirrors `CodexMcpServerManager.renameMcpServer`: the webview sends the
 * updated server plus `oldId`; when `oldId` differs from the new id the update
 * becomes a single rename op instead of a delete+add pair.
 */
export function planCodexMcpMutation(
  event: CodexMcpMutationEvent,
  payload: any,
  isConfigManagementAllowed: boolean,
): CodexMcpMutationDecision {
  if (!isConfigManagementAllowed) {
    return { kind: 'denied', error: CODEX_CONFIG_NOT_AUTHORIZED_ERROR };
  }

  switch (event) {
    case 'add_codex_mcp_server':
      return {
        kind: 'daemon',
        method: 'codex.mcpAdd',
        params: {
          name: payload?.id || payload?.name,
          config: serverConfigFromPayload(payload),
          op: 'add',
        },
      };
    case 'update_codex_mcp_server': {
      const name = payload?.id || payload?.name;
      const config = serverConfigFromPayload(payload);
      const oldId = typeof payload?.oldId === 'string' && payload.oldId ? payload.oldId : null;
      if (oldId && oldId !== name) {
        return {
          kind: 'daemon',
          method: 'codex.mcpRename',
          params: { oldName: oldId, name, config, op: 'rename' },
        };
      }
      return {
        kind: 'daemon',
        method: 'codex.mcpAdd',
        params: { name, config, op: 'update' },
      };
    }
    case 'delete_codex_mcp_server':
      return {
        kind: 'daemon',
        method: 'codex.mcpRemove',
        params: { name: payload?.id || payload?.name, op: 'remove' },
      };
    case 'toggle_codex_mcp_server':
      return {
        kind: 'daemon',
        method: 'codex.mcpSetEnabled',
        params: {
          name: payload?.id || payload?.name,
          enabled: payload?.enabled !== false,
          op: 'toggle',
        },
      };
  }
}
