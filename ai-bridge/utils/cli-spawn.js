/**
 * Shared headless CLI spawn + stream loop for Grok / Kimi / OpenCode.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { emitSendError, endStream } from './marker-protocol.js';
import { isWindowsCmdShim } from './cli-path.js';
import { registerCliProcess } from './cli-process-registry.js';

function killChildTree(child, label) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      child.kill();
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch (error) {
    console.error(`[WARN][${label}] Failed to kill child:`, error?.message || error);
  }
}

/**
 * Spawn a CLI, stream stdout lines, map stderr for diagnostics.
 *
 * @param {object} options
 * @param {string} options.bin
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} options.label - log / error label
 * @param {(line: string) => void} options.onLine
 * @param {() => void} [options.onCloseBeforeEnd] - called before endStream once
 * @returns {Promise<{ code: number|null, signal: NodeJS.Signals|null, hadError: boolean }>}
 */
export function runCliStreaming({
  bin,
  args,
  cwd,
  env = process.env,
  label,
  onLine,
  onCloseBeforeEnd,
}) {
  return new Promise((resolve) => {
    let hadError = false;
    let streamEnded = false;
    const finish = (payload) => {
      if (streamEnded) return;
      streamEnded = true;
      try {
        onCloseBeforeEnd?.();
      } catch (error) {
        console.error(`[WARN][${label}] onCloseBeforeEnd failed:`, error?.message || error);
      }
      endStream();
      resolve(payload);
    };

    let child;
    /** @type {(() => void)|null} */
    let unregisterCli = null;
    try {
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        // Windows npm `.cmd`/`.bat` shims cannot be spawned without a shell
        // (Node >= 18.20 / 20.12, CVE-2024-27980).
        shell: isWindowsCmdShim(bin),
      });
    } catch (error) {
      hadError = true;
      emitSendError(`Failed to spawn ${label} CLI (${bin}): ${error?.message || error}`, label);
      finish({ code: null, signal: null, hadError });
      return;
    }

    // Register for Stop / interrupt_session so daemon abort can kill this child.
    unregisterCli = registerCliProcess(() => killChildTree(child, label), label);

    const onParentSignal = () => killChildTree(child, label);
    process.once('SIGTERM', onParentSignal);
    process.once('SIGINT', onParentSignal);
    process.once('SIGHUP', onParentSignal);

    const stdoutRl = createInterface({ input: child.stdout });
    // Rolling tail only — never accumulate the child's full stderr.
    let stderrTail = '';

    stdoutRl.on('line', (line) => {
      try {
        onLine(line);
      } catch (error) {
        console.error(`[WARN][${label}] onLine failed:`, error?.message || error);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      hadError = true;
      const hint = error?.code === 'ENOENT'
        ? `${label} CLI not found. Install it and ensure \`${bin}\` is on PATH.`
        : (error?.message || String(error));
      emitSendError(hint, label);
    });

    child.on('close', (code, signal) => {
      process.off('SIGTERM', onParentSignal);
      process.off('SIGINT', onParentSignal);
      process.off('SIGHUP', onParentSignal);
      try {
        unregisterCli?.();
      } catch {
        // ignore
      }
      unregisterCli = null;

      if (!hadError && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        const tail = stderrTail.trim().slice(-800);
        emitSendError(
          `${label} CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}`
          + (tail ? `\n${tail}` : ''),
          label
        );
        hadError = true;
      }

      finish({ code, signal, hadError });
    });
  });
}
