import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NodeDetector } from '../../nodeDetector';
import { getDshSettings } from './DshSettingsStore';

const CHANNEL_SCRIPT = 'channel-manager.js';
const MAX_OUTPUT_CHARS = 4_000_000;
// stderr is drained and only the tail is kept, for diagnostics on
// timeout/failure — it must never block the child process.
const MAX_STDERR_CHARS = 8_192;

export interface DshCommandOptions {
  /** Extra stdin payload fields (e.g. cwd / sessionId). */
  payload?: Record<string, unknown>;
  timeoutMs: number;
  maxOutputChars?: number;
}

export interface DshCommandResult {
  payload: Record<string, any> | null;
  error?: string;
}

/**
 * Run one read-only-or-lifecycle `dsh` channel command through a one-shot
 * channel-manager process and return its last JSON stdout object.
 *
 * DSH connection settings are passed as explicit stdin fields (dshBin /
 * dshHost / dshPort / dshAutoStart) — never via process.env — so the values
 * the user saved in the settings card are honored on every path.
 */
export async function runDshBridgeCommand(
  context: vscode.ExtensionContext,
  command: string,
  options: DshCommandOptions,
): Promise<DshCommandResult> {
  const node = NodeDetector.find(context);
  if (!node) {
    return { payload: null, error: 'Node.js executable not found' };
  }
  const bridgeDir = path.join(context.extensionPath, 'ai-bridge');
  const script = path.join(bridgeDir, CHANNEL_SCRIPT);
  if (!fs.existsSync(script)) {
    return { payload: null, error: 'channel-manager.js not found' };
  }

  const settings = getDshSettings();
  const stdinPayload = {
    dshBin: settings.bin,
    dshHost: settings.host,
    dshPort: settings.port,
    dshAutoStart: settings.autoStart,
    ...(options.payload ?? {}),
  };

  const maxOutput = options.maxOutputChars ?? MAX_OUTPUT_CHARS;

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let stderrTail = '';
    const child = cp.spawn(node, [script, 'dsh', command], {
      cwd: bridgeDir,
      env: { ...process.env, DSH_USE_STDIN: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrSuffix = () => {
      const tail = stderrTail.trim();
      return tail ? ` (stderr: ${tail})` : '';
    };
    const finish = (result: DshCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && !child.killed) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ payload: null, error: `Timed out running dsh ${command}${stderrSuffix()}` });
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (output.length < maxOutput) {
        output += chunk.toString();
        if (output.length > maxOutput) output = output.slice(0, maxOutput);
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > MAX_STDERR_CHARS) {
        stderrTail = stderrTail.slice(-MAX_STDERR_CHARS);
      }
    });
    child.on('error', (error) => {
      finish({ payload: null, error: error.message });
    });
    child.on('close', () => {
      const payload = extractJsonObject(output);
      if (!payload) {
        finish({ payload: null, error: `No JSON output from dsh ${command}${stderrSuffix()}` });
        return;
      }
      finish({ payload });
    });

    child.stdin?.on('error', () => { /* child gone before stdin flush */ });
    child.stdin?.write(JSON.stringify(stdinPayload) + '\n');
    child.stdin?.end();
  });
}

/**
 * Extract the last well-formed JSON object from stdout lines (the channel
 * prints diagnostic lines before the result).
 */
export function extractJsonObject(raw: string): Record<string, any> | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        return obj;
      }
    } catch {
      // skip non-JSON output line
    }
  }
  return null;
}
