/**
 * Grok CLI message service (MVP).
 *
 * Spawns the local `grok` binary in headless mode and maps streaming-json
 * NDJSON events onto the shared bridge marker protocol used by Claude/Codex:
 *
 *   [MESSAGE_START]
 *   [STREAM_START]
 *   [CONTENT_DELTA] "<json-string>"
 *   [THINKING_DELTA] "<json-string>"
 *   [SESSION_ID] <uuid>
 *   [USAGE] { ... }
 *   [STREAM_END]
 *   [MESSAGE_END]
 *   [SEND_ERROR] { "error": "..." }
 *
 * CLI (aligned with desktop-cc-gui):
 *   grok -p "<prompt>" --output-format streaming-json --always-approve
 *        [-m <model>] [--reasoning-effort low|medium|high]
 *        (-s <new-uuid> | -r <existing-uuid>)
 *
 * Live tools: stdout has no tool events — poll chat_history.jsonl and emit
 * Claude-compatible [MESSAGE] tool_use / tool_result markers.
 * Auth/config comes from ~/.grok (CLI native).
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { readFile } from 'fs/promises';
import { resolveGrokCliPath } from '../../utils/grok-cli-path.js';
import { registerCliProcess } from '../../utils/cli-process-registry.js';
import {
  createToolTailState,
  emitToolSignals,
  pollChatHistoryToolSignals,
  resolveChatHistoryPath,
} from './history-tools.js';
import {
  buildGrokPromptBlocksJson,
  cleanupGrokPromptFile,
  collectImageAttachments,
  writeGrokPromptFile,
} from './grok-image-prompt.js';

const GROK_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function logDebug(...args) {
  console.error('[DEBUG][Grok]', ...args);
}

function logWarn(...args) {
  console.error('[WARN][Grok]', ...args);
}

function emitJsonStringMarker(tag, text) {
  process.stdout.write(`${tag} ${JSON.stringify(text)}\n`);
}

function emitSendError(message) {
  console.log(`[SEND_ERROR] ${JSON.stringify({ error: String(message || 'Unknown Grok error') })}`);
}

/**
 * Actionable hint when CLI hits official proxy without credentials — almost
 * always means `-m` used an upstream model id instead of a config profile name.
 */
function enrichGrokAuthError(message) {
  const text = String(message || '');
  if (!/cli-chat-proxy\.grok\.com|auth_kind=none|Unauthorized \(401\)/i.test(text)) {
    return text;
  }
  return (
    text
    + '\n\nHint: Grok CLI used official cli-chat-proxy instead of your ~/.grok/config.toml profile. '
    + 'Pass the profile name with -m (e.g. `grok` for [model."grok"]), or omit -m so '
    + '[models].default is used. Do NOT pass the nested upstream id alone (e.g. grok-4.5) '
    + 'unless that name is also a configured [model."..."] profile.'
  );
}

function normalizeEffort(effort) {
  if (typeof effort !== 'string') return null;
  const trimmed = effort.trim().toLowerCase();
  return GROK_REASONING_EFFORTS.has(trimmed) ? trimmed : null;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function safePromptArg(text) {
  // Avoid argv option-injection when user text starts with '-'.
  if (typeof text === 'string' && text.startsWith('-')) {
    return ` ${text}`;
  }
  return text ?? '';
}

function parseStreamLine(line) {
  if (!line || !line.trim()) return { kind: 'other' };
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'other' };
  }
  if (!value || typeof value !== 'object') return { kind: 'other' };

  const type = typeof value.type === 'string' ? value.type : '';
  switch (type) {
    case 'text': {
      const data = typeof value.data === 'string' ? value.data : '';
      return data ? { kind: 'text', data } : { kind: 'other' };
    }
    case 'thought': {
      const data = typeof value.data === 'string' ? value.data : '';
      return data ? { kind: 'thought', data } : { kind: 'other' };
    }
    case 'end': {
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
      return {
        kind: 'end',
        sessionId: sessionId || null,
        usage: value.usage && typeof value.usage === 'object' ? value.usage : null,
      };
    }
    case 'error': {
      const message = typeof value.message === 'string' ? value.message.trim() : '';
      return message ? { kind: 'error', message: enrichGrokAuthError(message) } : { kind: 'other' };
    }
    default:
      return { kind: 'other' };
  }
}

/**
 * Default config profile name in ~/.grok/config.toml ([models].default / [model."grok"]).
 * This is NOT the upstream API model id field (which is often "grok-4.5").
 */
const GROK_DEFAULT_PROFILE_ID = 'grok';

/**
 * Resolve CLI `-m` value.
 *
 * - empty / config-default sentinel → omit -m (CLI uses [models].default)
 * - legacy UI value "grok-4.5" (upstream id) → remap to profile "grok"
 * - otherwise pass through as profile name
 *
 * @returns {string|null} null means omit `-m`
 */
function resolveGrokModelFlag(model) {
  if (model == null) return null;
  // Claude-only long-context marker must never reach Grok CLI `-m`.
  // e.g. webview once sent "grok[1m]" when longContext was left on from Claude.
  const trimmed = String(model).trim().replace(/\[1m\]$/i, '');
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower === '__config_default__'
    || lower === 'auto'
    || lower === 'default'
    || lower === '(default)'
    || lower === 'config-default'
    || lower === 'config_default'
  ) {
    return null;
  }
  // Common mistake: UI showed "Grok 4.5" and stored upstream id as model.
  // User's BYOK profile is almost always named "grok".
  if (lower === 'grok-4.5' || lower === 'grok-4' || lower === 'grok-4.5-build') {
    return GROK_DEFAULT_PROFILE_ID;
  }
  return trimmed;
}

/**
 * Build headless grok argv.
 * - Text-only: `-p <prompt>`
 * - With images: `--prompt-file <staging.json>` (ACP blocks; avoids ARG_MAX)
 *
 * @param {{ message: string, sessionId: string, model: string, reasoningEffort: string, promptFile?: string|null }} opts
 */
function buildGrokArgs({ message, sessionId, model, reasoningEffort, promptFile = null }) {
  const args = [
    '--output-format', 'streaming-json',
    '--always-approve',
  ];

  if (promptFile) {
    args.push('--prompt-file', promptFile);
  } else {
    args.push('-p', safePromptArg(message));
  }

  const modelFlag = resolveGrokModelFlag(model);
  if (modelFlag) {
    args.push('-m', modelFlag);
  }

  const effort = normalizeEffort(reasoningEffort);
  if (effort) {
    args.push('--reasoning-effort', effort);
  }

  const existingId = isUuid(sessionId) ? sessionId.trim() : null;
  if (existingId) {
    // Resume multi-turn conversation.
    args.push('-r', existingId);
  } else {
    // Pre-assign UUID so the GUI can resume subsequent turns.
    const newId = randomUUID();
    args.push('-s', newId);
  }

  return args;
}

function killChildTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      child.kill();
    } else {
      // Kill process group when possible (spawned with detached:true + new group).
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch (error) {
    logWarn('Failed to kill grok child:', error?.message || error);
  }
}



/**
 * Send a message via Grok CLI and stream markers to stdout.
 *
 * @param {string} message
 * @param {string} sessionId  Existing UUID to resume, or empty for a new session
 * @param {string} cwd
 * @param {string} model  Config profile name for `-m` (default: omit → [models].default)
 * @param {string} reasoningEffort  low|medium|high
 * @param {Array} [attachments]  Optional image attachments from the webview
 */
export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  reasoningEffort = 'medium',
  attachments = [],
) {
  let streamStarted = false;
  let streamEnded = false;
  let hadError = false;
  let resolvedSessionId = isUuid(sessionId) ? sessionId.trim() : null;
  let promptFilePath = null;

  const emitStreamEndOnce = () => {
    if (!streamStarted || streamEnded) return;
    streamEnded = true;
    console.log('[STREAM_END]');
    console.log('[MESSAGE_END]');
  };

  console.log('[MESSAGE_START]');
  console.log('[STREAM_START]');
  streamStarted = true;

  const workCwdEarly = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();

  // Materialise path-only attachments to base64 so buildGrokPromptBlocksJson can encode them.
  let resolvedAttachments = attachments;
  try {
    resolvedAttachments = await materializePathAttachments(attachments);
  } catch (error) {
    hadError = true;
    emitSendError(`Failed to load image attachments: ${error?.message || error}`);
    emitStreamEndOnce();
    return;
  }

  try {
    const multimodal = buildGrokPromptBlocksJson(message, resolvedAttachments);
    if (multimodal) {
      promptFilePath = await writeGrokPromptFile(multimodal.json, workCwdEarly);
      logDebug(`multimodal prompt-file images=${multimodal.imageCount} path=${promptFilePath}`);
    }
  } catch (error) {
    hadError = true;
    emitSendError(error?.message || String(error));
    emitStreamEndOnce();
    await cleanupGrokPromptFile(promptFilePath);
    return;
  }

  const bin = resolveGrokCliPath();
  const args = buildGrokArgs({
    message,
    sessionId,
    model,
    reasoningEffort,
    promptFile: promptFilePath,
  });

  // If we pre-assigned a new session id via -s, surface it immediately.
  const sessionFlagIndex = args.indexOf('-s');
  if (sessionFlagIndex >= 0 && args[sessionFlagIndex + 1]) {
    resolvedSessionId = args[sessionFlagIndex + 1];
    console.log(`[SESSION_ID] ${resolvedSessionId}`);
  } else if (resolvedSessionId) {
    console.log(`[SESSION_ID] ${resolvedSessionId}`);
  }

  logDebug('spawn', bin, args.filter((_, i) => {
    // Avoid dumping the full prompt into logs.
    return !(args[i - 1] === '-p');
  }).join(' '), `promptLen=${String(message || '').length} images=${collectImageAttachments(resolvedAttachments).length}`);

  const env = {
    ...process.env,
    GROK_DISABLE_AUTOUPDATER: process.env.GROK_DISABLE_AUTOUPDATER || '1',
  };

  // Ensure ~/.grok/bin is searchable even when IDE PATH is sparse.
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      const grokBin = `${home}/.grok/bin`;
      const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
      const current = env[pathKey] || env.PATH || '';
      if (!current.split(process.platform === 'win32' ? ';' : ':').includes(grokBin)) {
        env[pathKey] = `${grokBin}${process.platform === 'win32' ? ';' : ':'}${current}`;
      }
    }
  } catch {
    // ignore PATH enrichment failures
  }

  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();
  const resumeSession = isUuid(sessionId);
  const toolTail = createToolTailState({ resumeSession });
  let toolPollTimer = null;
  let historyPath = resolvedSessionId
    ? resolveChatHistoryPath(workCwd, resolvedSessionId)
    : null;

  const pollToolsOnce = () => {
    if (!resolvedSessionId) return;
    if (!historyPath) {
      historyPath = resolveChatHistoryPath(workCwd, resolvedSessionId);
    }
    if (!historyPath) return;
    try {
      const signals = pollChatHistoryToolSignals(historyPath, toolTail);
      if (signals.length > 0) {
        emitToolSignals(signals);
      }
    } catch (error) {
      logWarn('tool poll failed:', error?.message || error);
    }
  };

  await new Promise((resolve) => {
    let child;
    /** @type {(() => void)|null} */
    let unregisterCli = null;
    try {
      child = spawn(bin, args, {
        cwd: workCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // New process group so interrupt can kill the whole tree on Unix.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      hadError = true;
      emitSendError(`Failed to spawn Grok CLI (${bin}): ${error?.message || error}`);
      emitStreamEndOnce();
      resolve();
      return;
    }

    // Stop button / interrupt_session → daemon abort kills this Grok CLI child.
    unregisterCli = registerCliProcess(() => killChildTree(child), 'Grok');

    const onParentSignal = () => killChildTree(child);
    process.once('SIGTERM', onParentSignal);
    process.once('SIGINT', onParentSignal);
    process.once('SIGHUP', onParentSignal);

    // Poll chat_history for tools while the turn runs (stdout has no tool events).
    toolPollTimer = setInterval(pollToolsOnce, 300);
    // Immediate poll in case file already exists (resume).
    pollToolsOnce();

    const stdoutRl = createInterface({ input: child.stdout });
    // Rolling tail only — never accumulate the child's full stderr.
    let stderrTail = '';

    stdoutRl.on('line', (line) => {
      const event = parseStreamLine(line);
      switch (event.kind) {
        case 'text':
          emitJsonStringMarker('[CONTENT_DELTA]', event.data);
          break;
        case 'thought':
          emitJsonStringMarker('[THINKING_DELTA]', event.data);
          break;
        case 'end':
          if (event.sessionId) {
            resolvedSessionId = event.sessionId;
            historyPath = resolveChatHistoryPath(workCwd, resolvedSessionId);
            console.log(`[SESSION_ID] ${event.sessionId}`);
          }
          if (event.usage) {
            console.log(`[USAGE] ${JSON.stringify(event.usage)}`);
          }
          // Final tool drain before stream end.
          pollToolsOnce();
          break;
        case 'error':
          hadError = true;
          emitSendError(event.message);
          break;
        default:
          // Unknown ACP lines ignored; tools come from history poll.
          break;
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      // Keep stderr visible for diagnostics without treating it as content.
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      hadError = true;
      const hint = error?.code === 'ENOENT'
        ? 'Grok CLI not found. Install Grok CLI and ensure `grok` is on PATH (or set GROK_BIN).'
        : (error?.message || String(error));
      emitSendError(hint);
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
      if (toolPollTimer) {
        clearInterval(toolPollTimer);
        toolPollTimer = null;
      }
      // Drain any trailing tool_result lines after process exit.
      pollToolsOnce();

      if (!hadError && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        const tail = stderrTail.trim().slice(-800);
        emitSendError(
          `Grok CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}`
          + (tail ? `\n${tail}` : '')
        );
      }

      emitStreamEndOnce();
      resolve();
    });
  });

  await cleanupGrokPromptFile(promptFilePath);
}

/**
 * Expand path-only / local_image attachments into base64 so prompt builder can
 * encode ACP image blocks without re-reading later.
 * @param {unknown} attachments
 */
async function materializePathAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const out = [];
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue;
    const a = /** @type {Record<string, unknown>} */ (item);
    if (typeof a.data === 'string' && a.data.length > 0) {
      out.push(a);
      continue;
    }
    const filePath =
      (typeof a.path === 'string' && a.path)
      || (a.type === 'local_image' && typeof a.path === 'string' ? a.path : null);
    if (!filePath) {
      out.push(a);
      continue;
    }
    try {
      const buf = await readFile(String(filePath));
      const ext = String(filePath).split('.').pop()?.toLowerCase() || 'png';
      const mediaType =
        (typeof a.mediaType === 'string' && a.mediaType.startsWith('image/')
          ? a.mediaType
          : null)
        || (ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'webp'
              ? 'image/webp'
              : 'image/png');
      out.push({
        ...a,
        mediaType,
        data: buf.toString('base64'),
      });
    } catch (error) {
      logWarn(`Failed to read image attachment path=${filePath}:`, error?.message || error);
      out.push(a);
    }
  }
  return out;
}
