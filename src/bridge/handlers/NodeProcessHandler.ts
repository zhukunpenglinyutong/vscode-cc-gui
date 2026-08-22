import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction, parseJson } from './helpers';

interface ProcessSnapshotRow {
  pid: number;
  ppid: number;
  command: string;
}

const OWNED_PROCESS_HINTS = ['daemon.js', 'channel-manager.js'];

export class NodeProcessHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_node_processes',
    'kill_node_process',
    'kill_all_orphans',
    'restart_node_daemon',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'get_node_processes':
        await this.pushSnapshot(webview);
        return true;
      case 'kill_node_process':
        await this.killProcess(content, webview, false);
        return true;
      case 'kill_all_orphans':
        await this.killAllOrphans(webview);
        return true;
      case 'restart_node_daemon':
        await this.killProcess(content, webview, true);
        this.context.callbacks.restartBridgeDaemon();
        await this.delay(500);
        await this.pushSnapshot(webview);
        return true;
      default:
        return false;
    }
  }

  private async pushSnapshot(webview: vscode.Webview): Promise<void> {
    const processes = await this.snapshot();
    callWindowFunction(webview, 'updateNodeProcesses', this.buildSnapshot(processes));
  }

  private async killProcess(content: string, webview: vscode.Webview, restart: boolean): Promise<void> {
    const payload = parseJson<{ pid?: number; id?: string }>(content, {});
    const pid = Number(payload.pid);
    let success = false;
    let error: string | undefined;
    if (Number.isFinite(pid) && pid > 0 && this.canKillPid(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        success = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    } else {
      error = 'Invalid or unmanaged PID';
    }

    callWindowFunction(webview, 'nodeProcessKillResult', {
      pid,
      id: payload.id,
      success,
      restart,
      error,
    });
    await this.delay(200);
    await this.pushSnapshot(webview);
  }

  private async killAllOrphans(webview: vscode.Webview): Promise<void> {
    const processes = await this.snapshot();
    let killed = 0;
    let error: string | undefined;
    for (const proc of processes.filter((item) => this.classify(item) === 'ORPHAN')) {
      if (!this.canKillPid(proc.pid)) continue;
      try {
        process.kill(proc.pid, 'SIGTERM');
        killed++;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    callWindowFunction(webview, 'nodeProcessKillResult', { killed, success: error === undefined, error });
    await this.delay(200);
    await this.pushSnapshot(webview);
  }

  private async snapshot(): Promise<ProcessSnapshotRow[]> {
    if (process.platform === 'win32') {
      return [];
    }

    const result = await this.runProcess('ps', ['-axo', 'pid=,ppid=,command=']);
    const rows = result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): ProcessSnapshotRow | null => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) return null;
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const command = match[3] ?? '';
        if (!Number.isFinite(pid) || !command.includes('node')) return null;
        return { pid, ppid, command };
      })
      .filter(Boolean) as ProcessSnapshotRow[];

    return rows.filter((row) => this.isRelevantProcess(row, rows));
  }

  private buildSnapshot(rows: ProcessSnapshotRow[]): Record<string, unknown> {
    const now = Date.now();
    let daemon = 0;
    let channel = 0;
    let orphan = 0;
    const processes = rows.map((row) => {
      const kind = this.classify(row);
      if (kind === 'DAEMON') daemon++;
      else if (kind === 'CHANNEL') channel++;
      else orphan++;
      return {
        id: `${kind.toLowerCase()}-${row.pid}`,
        kind,
        provider: this.providerForCommand(row.command),
        pid: row.pid,
        ppid: row.ppid,
        alive: true,
        startedAt: 0,
        uptimeMs: 0,
        command: row.command,
        workspacePath: this.context.getWorkspacePath(),
      };
    });

    return {
      snapshotAt: now,
      totals: {
        daemon,
        channel,
        orphan,
        all: processes.length,
      },
      processes,
    };
  }

  private classify(row: ProcessSnapshotRow): 'DAEMON' | 'CHANNEL' | 'ORPHAN' {
    if (row.pid === this.context.callbacks.getBridgeProcessPid()) {
      return 'DAEMON';
    }
    if (row.command.includes('channel-manager.js')) {
      return 'CHANNEL';
    }
    return 'ORPHAN';
  }

  private providerForCommand(command: string): string | undefined {
    if (command.includes('codex')) return 'codex';
    if (command.includes('claude')) return 'claude';
    if (command.includes('grok')) return 'grok';
    if (command.includes('kimi')) return 'kimi';
    if (command.includes('opencode')) return 'opencode';
    if (/\bpi\b/.test(command) || command.includes(' pi ')) return 'pi';
    return undefined;
  }

  private isRelevantProcess(row: ProcessSnapshotRow, rows: ProcessSnapshotRow[]): boolean {
    const bridgePid = this.context.callbacks.getBridgeProcessPid();
    if (bridgePid && row.pid === bridgePid) return true;
    if (!this.looksLikeOwnedProcess(row.command)) return false;

    const owners = [process.pid, bridgePid].filter((pid): pid is number => Number.isFinite(pid ?? NaN) && !!pid && pid > 0);
    if (owners.includes(row.ppid)) return true;
    return this.hasAncestorPid(row.pid, rows, owners);
  }

  private looksLikeOwnedProcess(command: string): boolean {
    const lower = command.toLowerCase();
    return OWNED_PROCESS_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
  }

  private hasAncestorPid(pid: number, rows: ProcessSnapshotRow[], owners: number[]): boolean {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const visited = new Set<number>();
    let current = byPid.get(pid);
    while (current && current.ppid > 0 && !visited.has(current.ppid)) {
      if (owners.includes(current.ppid)) return true;
      visited.add(current.ppid);
      current = byPid.get(current.ppid);
    }
    return false;
  }

  private canKillPid(pid: number): boolean {
    if (pid <= 0 || pid === process.pid) return false;
    return true;
  }

  private runProcess(command: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
      const proc = require('child_process').spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.on('error', () => resolve(''));
      proc.on('close', () => resolve(stdout));
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
