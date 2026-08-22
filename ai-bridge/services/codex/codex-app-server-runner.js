/**
 * Codex app-server transport (Codex-only).
 *
 * Spawns `codex app-server --stdio` and speaks JSON-RPC to receive true
 * progressive text via `item/agentMessage/delta` notifications.
 *
 * This module is intentionally isolated from Claude/Grok/Kimi channels.
 * Callers map callbacks onto the shared bridge marker protocol
 * ([CONTENT_DELTA], [THREAD_ID], …).
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { getCodexCliEntrypoint } from '../../utils/sdk-loader.js';
import { emitFileChangeItemAsTools } from './codex-file-change-emit.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function logDebug(...args) {
  console.error('[DEBUG][CodexAppServer]', ...args);
}

/**
 * @param {object} options
 * @param {string|Array} options.input - string prompt or [{type:'text'|'local_image',...}]
 * @param {string} [options.threadId] - resume existing thread
 * @param {string} [options.cwd]
 * @param {string} [options.model]
 * @param {string} [options.effort] - reasoning effort
 * @param {string} [options.approvalPolicy] - e.g. never | on-request | untrusted
 * @param {string} [options.sandboxMode]
 * @param {object} [options.cliEnv]
 * @param {AbortSignal} [options.signal]
 * @param {(delta: string) => void} [options.onContentDelta]
 * @param {(delta: string) => void} [options.onThinkingDelta]
 * @param {(threadId: string) => void} [options.onThreadId]
 * @param {(msg: object) => void} [options.onMessage]
 * @param {(usage: object) => void} [options.onUsage]
 * @param {(info: object) => void} [options.onItemCompleted]
 * @returns {Promise<{ threadId: string|null, finalText: string, deltaCount: number }>}
 */
export async function runCodexAppServerTurn(options = {}) {
  const {
    input,
    threadId: resumeThreadId = '',
    cwd,
    model,
    effort,
    approvalPolicy = 'never',
    sandboxMode,
    cliEnv,
    signal,
    onContentDelta,
    onThinkingDelta,
    onThreadId,
    onMessage,
    onUsage,
    onItemCompleted,
  } = options;

  const { wrapperPath } = getCodexCliEntrypoint();
  const env = { ...(cliEnv || process.env) };

  const child = spawn(process.execPath, [wrapperPath, 'app-server', '--stdio'], {
    env,
    cwd: typeof cwd === 'string' && cwd.trim() ? cwd : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  const pending = new Map();
  let closed = false;
  let currentThreadId = null;
  let finalText = '';
  let deltaCount = 0;
  let turnCompleted = false;
  let turnFailedError = null;
  let lastHeartbeatAt = 0;
  /** Track agent message item ids so multi-step turns do not corrupt finalText. */
  let activeAgentItemId = null;
  /** Dedupe fileChange → tool_use emissions (patchUpdated + completed). */
  const emittedFileChangeToolIds = new Set();

  const emitStreamHeartbeat = (force = false) => {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < 5000) return;
    lastHeartbeatAt = now;
    // Keep frontend stall watchdog alive during long tool phases (no text deltas).
    process.stdout.write('[STREAM_HEARTBEAT]\n');
  };

  const killChild = () => {
    if (closed) return;
    closed = true;
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch {
      // ignore
    }
  };

  const onAbort = () => {
    // Best-effort interrupt then kill
    if (currentThreadId) {
      try {
        const id = nextId++;
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'turn/interrupt',
            params: { threadId: currentThreadId },
          }) + '\n',
        );
      } catch {
        // ignore
      }
    }
    killChild();
    for (const [, p] of pending) {
      p.reject(new Error('Aborted'));
    }
    pending.clear();
  };

  if (signal) {
    if (signal.aborted) {
      killChild();
      throw new Error('Aborted');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  function sendRequest(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    if (!child.stdin.writable) {
      return Promise.reject(new Error('app-server stdin not writable'));
    }
    child.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`app-server timeout: ${method}`));
        }
      }, DEFAULT_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
    });
  }

  function sendNotification(method, params = {}) {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  function replyServerRequest(id, result) {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  function autoApproveServerRequest(msg) {
    // Server-to-client requests use the same envelope with method + id.
    const method = msg.method || '';
    if (
      method.includes('Approval') ||
      method.includes('requestApproval') ||
      method === 'applyPatchApproval' ||
      method === 'execCommandApproval' ||
      method.endsWith('/requestApproval')
    ) {
      replyServerRequest(msg.id, { decision: 'approved' });
      logDebug('auto-approved server request', method);
      return true;
    }
    if (method === 'currentTime/read') {
      replyServerRequest(msg.id, { iso8601: new Date().toISOString() });
      return true;
    }
    // Unknown reverse request: deny carefully with empty error to unblock
    if (msg.id != null && msg.method) {
      logDebug('unhandled server request, rejecting', method);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `Unhandled server request: ${method}` },
        }) + '\n',
      );
      return true;
    }
    return false;
  }

  const stderrChunks = [];
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
      // Keep stderr out of protocol stdout; optional debug
      const text = chunk.toString();
      if (text.includes('ERROR') || text.includes('error')) {
        logDebug('stderr', text.slice(0, 300));
      }
    });
  }

  child.on('error', (err) => {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const lineHandler = (line) => {
    if (!line || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      logDebug('non-json line', line.slice(0, 120));
      return;
    }

    // Response to our request
    if (msg.id != null && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Server → client request (approval etc.)
    if (msg.id != null && msg.method && msg.result === undefined && msg.error === undefined) {
      autoApproveServerRequest(msg);
      return;
    }

    // Notifications
    if (!msg.method) return;
    const method = msg.method;
    const params = msg.params || {};

    if (method === 'thread/started') {
      const tid = params.thread?.id || params.threadId || params.id;
      if (tid) {
        currentThreadId = tid;
        onThreadId?.(tid);
      }
      return;
    }

    // Any item/turn activity means the agent is still working — bump heartbeat
    // so the webview stall watchdog does not force stream_end mid-turn.
    if (
      method === 'item/started' ||
      method === 'item/completed' ||
      method === 'turn/started' ||
      method.startsWith('item/commandExecution/') ||
      method.startsWith('item/fileChange/') ||
      method.startsWith('item/mcpToolCall/')
    ) {
      emitStreamHeartbeat();
    }

    if (method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : null;
      // New agent message after tools: visual paragraph break between segments.
      if (itemId && itemId !== activeAgentItemId) {
        if (activeAgentItemId != null && finalText) {
          finalText += '\n\n';
          onContentDelta?.('\n\n');
        }
        activeAgentItemId = itemId;
      }
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        deltaCount += 1;
        finalText += delta;
        onContentDelta?.(delta);
        emitStreamHeartbeat(true);
      }
      return;
    }

    if (
      method === 'item/reasoning/summaryTextDelta' ||
      method === 'item/reasoning/textDelta'
    ) {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        onThinkingDelta?.(delta);
        emitStreamHeartbeat(true);
      }
      return;
    }

    // Live file patch updates (may arrive before item/completed).
    if (method === 'item/fileChange/patchUpdated') {
      emitStreamHeartbeat();
      const itemId = typeof params.itemId === 'string' ? params.itemId : `fc_${Date.now()}`;
      const changes = Array.isArray(params.changes) ? params.changes : [];
      if (changes.length > 0 && typeof onMessage === 'function') {
        const n = emitFileChangeItemAsTools(
          { id: itemId, type: 'fileChange', status: 'completed', changes },
          onMessage,
          emittedFileChangeToolIds,
        );
        if (n > 0) {
          logDebug(`emitted ${n} file change tool(s) from patchUpdated itemId=${itemId}`);
        }
      }
      return;
    }

    if (method === 'item/completed') {
      const item = params.item;
      onItemCompleted?.(item);
      emitStreamHeartbeat();
      // Map fileChange items → edit/write tool_use for the Edit tab.
      if (item && (item.type === 'fileChange' || item.type === 'file_change')) {
        if (typeof onMessage === 'function') {
          const n = emitFileChangeItemAsTools(item, onMessage, emittedFileChangeToolIds);
          if (n > 0) {
            logDebug(`emitted ${n} file change tool(s) from item/completed id=${item.id}`);
          }
        }
        return;
      }
      // Text already streamed via CONTENT_DELTA; skip text-only [MESSAGE]
      // snapshots (they can open a second empty slot if the stall watchdog
      // already forced stream_end).
      return;
    }

    if (method === 'turn/completed') {
      turnCompleted = true;
      const usage = params.turn?.usage || params.usage;
      if (usage && typeof usage === 'object') {
        onUsage?.(usage);
      }
      return;
    }

    if (method === 'error' || method === 'turn/failed') {
      const message = params.message || params.error?.message || JSON.stringify(params);
      turnFailedError = new Error(message);
      turnCompleted = true;
    }
  };

  rl.on('line', lineHandler);

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, sig) => resolve({ code, sig }));
  });

  try {
    await sendRequest('initialize', {
      clientInfo: { name: 'vscode-cc-gui', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    sendNotification('initialized', {});

    const isResume = typeof resumeThreadId === 'string' && resumeThreadId.trim() !== '';
    if (isResume) {
      const resumed = await sendRequest('thread/resume', {
        threadId: resumeThreadId.trim(),
      });
      currentThreadId =
        resumed?.thread?.id || resumed?.threadId || resumeThreadId.trim();
      onThreadId?.(currentThreadId);
    } else {
      const startParams = {
        cwd: cwd || null,
        approvalPolicy: approvalPolicy || 'never',
      };
      if (model) startParams.model = model;
      // Prefer sandbox via config override when provided
      if (sandboxMode) {
        startParams.config = {
          sandbox_mode: sandboxMode,
        };
      }
      const started = await sendRequest('thread/start', startParams);
      currentThreadId =
        started?.thread?.id || started?.threadId || started?.id || currentThreadId;
      if (currentThreadId) onThreadId?.(currentThreadId);
    }

    if (!currentThreadId) {
      throw new Error('app-server did not return a thread id');
    }

    const userInput = normalizeUserInput(input);
    const turnParams = {
      threadId: currentThreadId,
      input: userInput,
    };
    if (model) turnParams.model = model;
    if (effort) turnParams.effort = effort;
    if (cwd) turnParams.cwd = cwd;
    if (approvalPolicy) turnParams.approvalPolicy = approvalPolicy;

    await sendRequest('turn/start', turnParams);

    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    while (!turnCompleted && Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Aborted');
      await new Promise((r) => setTimeout(r, 50));
    }

    if (turnFailedError) throw turnFailedError;
    if (!turnCompleted) throw new Error('app-server turn timed out');

    return {
      threadId: currentThreadId,
      finalText,
      deltaCount,
    };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    rl.close();
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    killChild();
    await Promise.race([
      exitPromise,
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  }
}

function normalizeUserInput(input) {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input }];
  }
  if (!Array.isArray(input)) {
    return [{ type: 'text', text: String(input ?? '') }];
  }
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      out.push({ type: 'text', text: item.text });
    } else if (item.type === 'local_image' && typeof item.path === 'string') {
      out.push({ type: 'localImage', path: item.path });
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}
