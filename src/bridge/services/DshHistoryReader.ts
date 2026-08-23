import * as vscode from 'vscode';
import { runDshBridgeCommand } from './DshBridgeCommand';

const HISTORY_TIMEOUT_MS = 45_000;

export interface DshSessionListResult {
  success: boolean;
  sessions: any[];
  total?: number;
  sessionCount?: number;
  error?: string;
}

/**
 * Reads DSH session history through the Node bridge (channel-manager.js
 * `dsh listSessions|loadSession|deleteSession`).
 *
 * Unlike the other CLI readers, DSH history is not on the local filesystem —
 * the persistent `dsh web` host owns it and answers over Host RPC. The Node
 * side attaches read-only (never spawns a host for history). Deletion is
 * `workspace.archiveSession` — a host-side archive, not a physical delete.
 */
export class DshHistoryReader {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Sessions for one project, shaped like the other CLI readers. */
  async getSessionsForProject(projectPath: string): Promise<DshSessionListResult> {
    const result = await runDshBridgeCommand(this.context, 'listSessions', {
      payload: { cwd: projectPath || '' },
      timeoutMs: HISTORY_TIMEOUT_MS,
    });
    if (!result.payload) {
      return {
        success: false,
        sessions: [],
        error: result.error || 'DSH bridge returned no session list',
      };
    }
    const payload = result.payload;
    return {
      success: payload.success === true,
      sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
      total: typeof payload.total === 'number' ? payload.total : undefined,
      sessionCount: typeof payload.sessionCount === 'number' ? payload.sessionCount : undefined,
      error: typeof payload.error === 'string' ? payload.error : undefined,
    };
  }

  /** One session's messages in the Claude-shaped JSON object list. */
  async getSessionMessages(sessionId: string): Promise<any[]> {
    const id = String(sessionId || '').trim();
    if (!id) {
      return [];
    }
    const result = await runDshBridgeCommand(this.context, 'loadSession', {
      payload: { sessionId: id },
      timeoutMs: HISTORY_TIMEOUT_MS,
    });
    const payload = result.payload;
    if (!payload || payload.success !== true || !Array.isArray(payload.messages)) {
      return [];
    }
    return payload.messages.filter((message: any) => message && typeof message === 'object');
  }

  /**
   * Archive a session (the DSH "delete" — host-side archive, not a physical
   * log delete). Returns true when the host accepted the archive.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const id = String(sessionId || '').trim();
    if (!id) {
      return false;
    }
    const result = await runDshBridgeCommand(this.context, 'deleteSession', {
      payload: { sessionId: id },
      timeoutMs: HISTORY_TIMEOUT_MS,
    });
    return result.payload?.success === true;
  }
}
