/**
 * Codex Message Service — Slim Coordinator
 *
 * Handles message sending through the installed Codex CLI JSONL transport.
 * Provides unified interface that matches Claude's message service.
 *
 * Key Differences from Claude:
 * - Uses threadId instead of sessionId
 * - Permission model: skipGitRepoCheck + sandbox (not permissionMode string)
 * - Events: thread.*, turn.*, item.* (not system/assistant/user/result)
 * - Supports images via local_image type (requires file paths)
 *
 * All event-processing logic lives in codex-event-handler.js.
 * Utility functions are split across codex-utils.js, codex-agents-loader.js,
 * codex-patch-parser.js, and codex-command-utils.js.
 *
 * @author Crafted with geek spirit
 */

import { CodexPermissionMapper } from '../../utils/permission-mapper.js';
import { getMcpServerTools as getMcpServerToolsImpl } from '../claude/mcp-status/index.js';
import {
  logDebug, logInfo, logWarn,
  ensureCodexSdk,
  normalizeCodexPermissionMode,
  normalizeCodexStreamingFlag,
  normalizeRequestedSandboxMode,
  resolveSandboxModeOverride,
  resolveApprovalPolicyOverride,
  buildCodexCliEnvironment,
  withCodexProxyEnvSuppressed,
  buildErrorPayload
} from './codex-utils.js';
import { collectAgentsInstructions } from './codex-agents-loader.js';
import { createInitialEventState, processCodexEventStream } from './codex-event-handler.js';
import { buildContextAppend } from '../context-append.js';
import { runCodexCliStream } from './codex-cli-runner.js';
import { runCodexAppServerTurn } from './codex-app-server-runner.js';
import { resolveCodexMcpServerConfig } from './codex-mcp-admin.js';
import { saveImageToTemp } from '../claude/attachment-service.js';
import { getRequestId } from '../../utils/request-context.js';

const CODEX_MODEL_FALLBACKS = new Map([
  ['gpt-5.3-codex', 'gpt-5.5'],
  ['gpt-5.3-codex-spark', 'gpt-5.5'],
]);

/** Active Codex turns keyed by daemon request id (multi-window concurrent runs). */
const activeCodexAbortControllers = new Map();

/**
 * Abort one or more Codex turns.
 * @param {string[]|undefined|null} targetRequestIds
 *   - `undefined` / `null`: abort all (legacy unscoped)
 *   - `[]` or list: abort only those request ids (scoped; empty = abort none)
 */
export async function abortCurrentCodexTurn(targetRequestIds) {
  const ids = Array.isArray(targetRequestIds)
    ? targetRequestIds.map(String).filter(Boolean)
    : [...activeCodexAbortControllers.keys()];
  console.error(
    '[CCG_DEBUG] abortCurrentCodexTurn',
    JSON.stringify({
      mode: Array.isArray(targetRequestIds) ? 'scoped' : 'all',
      targets: ids,
      active: [...activeCodexAbortControllers.keys()],
    }),
  );
  for (const id of ids) {
    const controller = activeCodexAbortControllers.get(id);
    if (controller && !controller.signal.aborted) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
  }
}

async function normalizeCodexAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const normalized = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      continue;
    }

    if (attachment.type === 'local_image' && typeof attachment.path === 'string' && attachment.path) {
      normalized.push(attachment);
      continue;
    }

    const mediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : '';
    const base64Data = typeof attachment.data === 'string' ? attachment.data : '';
    if (mediaType.startsWith('image/') && base64Data) {
      const tempPath = await saveImageToTemp(base64Data, mediaType, attachment.fileName);
      if (tempPath) {
        normalized.push({ type: 'local_image', path: tempPath });
      } else {
        logWarn('Codex', `Failed to materialize image attachment: ${attachment.fileName || '(unnamed)'}`);
      }
    }
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

/**
 * Send message to Codex (with optional thread resumption)
 *
 * @param {string} message - User message to send
 * @param {string} threadId - Thread ID to resume (optional)
 * @param {string} cwd - Working directory (optional)
 * @param {string} permissionMode - Unified permission mode (optional)
 * @param {string} model - Model name (optional)
 * @param {string} baseUrl - API base URL (optional, for custom endpoints)
 * @param {string} apiKey - API key (optional, for custom auth)
 * @param {string} reasoningEffort - Reasoning effort level (optional)
 * @param {string} serviceTier - Codex service tier; "fast" matches Codex CLI /fast (optional)
 * @param {Array} attachments - Image attachments in local_image format (optional)
 * @param {object} openedFiles - IDE/opened file context (optional)
 * @param {Array} fileTags - Explicit @file/@terminal/@service tags (optional)
 * @param {string} agentPrompt - Agent prompt (optional)
 * @param {string} requestedSandboxMode - Explicit Codex sandbox mode from settings (optional)
 * @param {boolean|string|null} streaming - UI streaming toggle; when true emit [CONTENT_DELTA]/[THINKING_DELTA]
 */
export async function sendMessage(
  message,
  threadId = null,
  cwd = null,
  permissionMode = null,
  model = null,
  baseUrl = null,
  apiKey = null,
  reasoningEffort = 'medium',
  serviceTier = null,
  attachments = [],
  openedFiles = null,
  fileTags = null,
  agentPrompt = null,
  requestedSandboxMode = null,
  streaming = null
) {
  let streamStarted = false;
  let streamEnded = false;
  /** @type {AbortController|null} */
  let turnAbortController = null;
  /** Daemon request id for scoped multi-window abort (from AsyncLocalStorage). */
  const requestId = getRequestId() || `codex-local-${Date.now()}`;
  const emitStreamEndOnce = () => {
    if (!streamStarted || streamEnded) {
      return;
    }
    streamEnded = true;
    console.log('[STREAM_END]');
  };

  try {
    const normalizedPermissionMode = normalizeCodexPermissionMode(permissionMode || 'default');
    // Default ON when omitted so historical callers keep progressive UI path.
    const streamingEnabled = normalizeCodexStreamingFlag(streaming);

    const requestedModel = typeof model === 'string' ? model.trim() : '';
    const effectiveModel = CODEX_MODEL_FALLBACKS.get(requestedModel) || requestedModel;
    if (requestedModel && effectiveModel !== requestedModel) {
      console.warn(`[Codex] Model fallback: requested=${requestedModel} effective=${effectiveModel}`);
    }

    console.log('[DEBUG] Codex sendMessage called with params:', {
      threadId,
      cwd,
      permissionMode: normalizedPermissionMode,
      model: effectiveModel || model,
      requestedModel: requestedModel || undefined,
      reasoningEffort,
      serviceTier,
      streaming,
      streamingEnabled,
      hasBaseUrl: !!baseUrl,
      hasApiKey: !!apiKey,
      attachmentsCount: attachments?.length || 0,
      hasOpenedFiles: !!openedFiles,
      fileTagsCount: Array.isArray(fileTags) ? fileTags.length : 0,
      hasAgentPrompt: !!agentPrompt,
      requestedSandboxMode: requestedSandboxMode || ''
    });
    console.log('[CCG_DEBUG] Codex streaming flag:', JSON.stringify({
      raw: streaming,
      streamingEnabled,
    }));

    console.log('[MESSAGE_START]');

    // ============================================================
    // 1. Validate installed Codex runtime and prepare CLI options
    // ============================================================

    await ensureCodexSdk();

    const codexOptions = {};

    if (baseUrl) {
      codexOptions.baseUrl = baseUrl;
    }
    if (apiKey) {
      codexOptions.apiKey = apiKey;
    }
    if (serviceTier && serviceTier.trim() !== '') {
      const sdkServiceTier = serviceTier.trim();
      codexOptions.config = {
        features: {
          fast_mode: true
        },
        service_tier: sdkServiceTier
      };
      logDebug('Codex', 'Service tier:', sdkServiceTier, 'with fast_mode feature enabled');
    }

    // Pass a sanitized env to the CLI runner to avoid inherited CODEX_* pollution
    const { cliEnv, removedKeys } = buildCodexCliEnvironment(process.env);
    codexOptions.env = cliEnv;
    logDebug('PERM_DEBUG', 'Codex CLI env isolation:', JSON.stringify({
      removedKeys,
      removedCount: removedKeys.length
    }));
    // ============================================================
    // 2. Map Unified Permission Mode to Codex Format
    // ============================================================

    const permissionConfig = CodexPermissionMapper.toProvider(normalizedPermissionMode);

    logDebug('PERM_DEBUG', 'Codex permission config:', JSON.stringify(permissionConfig));
    logDebug('PERM_DEBUG', 'Raw env permission overrides:', JSON.stringify({
      CODEX_SANDBOX_MODE: process.env.CODEX_SANDBOX_MODE || '',
      CODEX_APPROVAL_POLICY: process.env.CODEX_APPROVAL_POLICY || ''
    }));

    // Allow Java side to force sandbox mapping override via env vars
    const sandboxOverride = resolveSandboxModeOverride();
    if (sandboxOverride) {
      permissionConfig.sandbox = sandboxOverride;
      logDebug('PERM_DEBUG', 'Sandbox override from env CODEX_SANDBOX_MODE:', sandboxOverride);
    }
    const approvalPolicyOverride = resolveApprovalPolicyOverride();
    if (approvalPolicyOverride) {
      permissionConfig.approvalPolicy = approvalPolicyOverride;
      logDebug('PERM_DEBUG', 'Approval override from env CODEX_APPROVAL_POLICY:', approvalPolicyOverride);
    }
    const explicitSandboxMode = normalizeRequestedSandboxMode(requestedSandboxMode);
    if (explicitSandboxMode) {
      permissionConfig.sandbox = explicitSandboxMode;
      logDebug('PERM_DEBUG', 'Sandbox override from request:', explicitSandboxMode);
    }

    // ============================================================
    // 3. Build Thread Options
    // ============================================================

    const threadOptions = {
      skipGitRepoCheck: permissionConfig.skipGitRepoCheck,
      maxTurns: 200
    };

    if (reasoningEffort && reasoningEffort.trim() !== '') {
      threadOptions.modelReasoningEffort = reasoningEffort;
      console.log('[DEBUG] Reasoning effort:', reasoningEffort);
    }

    if (permissionConfig.approvalPolicy) {
      threadOptions.approvalPolicy = permissionConfig.approvalPolicy;
    }

    // CRITICAL: Only set working directory for NEW threads
    const isResumingThread = threadId && threadId.trim() !== '';
    console.log('[CCG_DEBUG] Codex thread mode:', JSON.stringify({
      isResumingThread,
      threadId: isResumingThread ? threadId : '',
      cwd: cwd || '',
    }));

    if (!isResumingThread) {
      if (cwd && cwd.trim() !== '') {
        threadOptions.workingDirectory = cwd;
        console.log('[DEBUG] Working directory:', cwd);
      }
    } else {
      console.log('[DEBUG] Resuming thread - skipping workingDirectory to allow session lookup');
    }

    if (effectiveModel) {
      threadOptions.model = effectiveModel;
      console.log('[DEBUG] Model:', effectiveModel);
    }

    if (permissionConfig.sandbox) {
      threadOptions.sandboxMode = permissionConfig.sandbox;
      console.log('[DEBUG] Sandbox mode:', permissionConfig.sandbox);
    }

    logDebug('PERM_DEBUG', 'Final Codex threadOptions:', JSON.stringify({
      permissionMode: normalizedPermissionMode,
      workingDirectory: threadOptions.workingDirectory,
      sandboxMode: threadOptions.sandboxMode,
      approvalPolicy: threadOptions.approvalPolicy,
      skipGitRepoCheck: threadOptions.skipGitRepoCheck
    }));

    // ============================================================
    console.log(isResumingThread ? '[DEBUG] Resuming thread:' : '[DEBUG] Starting new thread', isResumingThread ? threadId : '');

    // ============================================================
    // 5. Collect AGENTS.md Instructions (only for new threads)
    // ============================================================

    let finalMessage = message;
    if (!isResumingThread && cwd) {
      const agentsInstructions = collectAgentsInstructions(cwd);
      if (agentsInstructions) {
        finalMessage = `<agents-instructions>\n${agentsInstructions}\n</agents-instructions>\n\n${message}`;
        logDebug('AGENTS.md', `Prepended ${agentsInstructions.length} chars of instructions to message`);
      }
    }
    const contextAppend = buildContextAppend(openedFiles, fileTags);
    if (contextAppend) {
      finalMessage = `${finalMessage}${contextAppend}`;
      logDebug('Codex', `Appended ${contextAppend.length} chars of IDE context to message`);
    }
    if (agentPrompt && typeof agentPrompt === 'string' && agentPrompt.trim() !== '') {
      finalMessage = `${finalMessage}\n\n## Agent Role and Instructions\n\n${agentPrompt.trim()}`;
      logDebug('Codex', `Appended ${agentPrompt.length} chars of agent prompt to message`);
    }

    // ============================================================
    // 6. Build Input and Start Streaming
    // ============================================================

    const normalizedAttachments = await normalizeCodexAttachments(attachments);

    let runInput;
    if (normalizedAttachments.length > 0) {
      runInput = [{ type: 'text', text: finalMessage }];
      for (const attachment of normalizedAttachments) {
        if (attachment && attachment.type === 'local_image' && attachment.path) {
          runInput.push({ type: 'local_image', path: attachment.path });
          console.log('[DEBUG] Added local_image attachment:', attachment.path);
        }
      }
      console.log('[DEBUG] Using array input format with', runInput.length, 'entries');
    } else {
      runInput = finalMessage;
      console.log('[DEBUG] Using string input format');
    }

    const workingDirectory = cwd && cwd.trim() !== '' ? cwd : undefined;
    turnAbortController = new AbortController();
    activeCodexAbortControllers.set(requestId, turnAbortController);
    console.log('[CCG_DEBUG] Codex turn registered for abort:', JSON.stringify({ requestId }));

    const emitMessage = (msg) => {
      console.log('[MESSAGE]', JSON.stringify(msg));
    };

    const state = createInitialEventState(emitMessage);

    // Prefer app-server for progressive text when streaming is on (Codex-only).
    // On failure, fall back to exec --json so behavior stays reliable.
    let usedTransport = 'exec-json';
    let appServerResult = null;

    console.log('[STREAM_START]');
    streamStarted = true;

    if (streamingEnabled) {
      let appServerDeltaEmitted = false;
      try {
        console.log('[CCG_DEBUG] Codex transport: trying app-server for progressive deltas');
        appServerResult = await withCodexProxyEnvSuppressed(async () =>
          runCodexAppServerTurn({
            input: runInput,
            threadId: isResumingThread ? threadId : '',
            cwd: workingDirectory,
            model: effectiveModel || undefined,
            effort: reasoningEffort || undefined,
            approvalPolicy: threadOptions.approvalPolicy || 'never',
            sandboxMode: threadOptions.sandboxMode || undefined,
            cliEnv: codexOptions.env,
            signal: turnAbortController.signal,
            onThreadId: (tid) => {
              state.currentThreadId = tid;
              console.log('[THREAD_ID]', tid);
            },
            onContentDelta: (delta) => {
              if (!delta) return;
              appServerDeltaEmitted = true;
              state.assistantText += delta;
              state.finalResponse = state.assistantText;
              process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
            },
            onThinkingDelta: (delta) => {
              if (!delta) return;
              state.reasoningObserved = true;
              process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
            },
            onMessage: (msg) => {
              emitMessage(msg);
            },
            onUsage: (usage) => {
              const totalInput = usage.input_tokens || usage.inputTokens || 0;
              const cached = usage.cached_input_tokens || usage.cachedInputTokens || 0;
              const claudeUsage = {
                input_tokens: Math.max(0, totalInput - cached),
                output_tokens: usage.output_tokens || usage.outputTokens || 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: cached,
              };
              emitMessage({
                type: 'result',
                subtype: 'usage',
                is_error: false,
                usage: claudeUsage,
                session_id: state.currentThreadId,
              });
            },
          })
        );
        usedTransport = 'app-server';
        if (appServerResult?.threadId) {
          state.currentThreadId = appServerResult.threadId;
        }
        if (appServerResult?.finalText) {
          state.finalResponse = appServerResult.finalText;
          if (!state.assistantText) {
            state.assistantText = appServerResult.finalText;
          }
        }
        console.log('[CCG_DEBUG] Codex app-server turn ok:', JSON.stringify({
          deltaCount: appServerResult?.deltaCount ?? 0,
          textLen: (appServerResult?.finalText || '').length,
          threadId: state.currentThreadId || '',
        }));
      } catch (appServerError) {
        if (appServerDeltaEmitted) {
          // Already streamed partial text to the UI — do not restart on exec path.
          throw appServerError;
        }
        console.warn(
          '[CCG_DEBUG] Codex app-server failed before first delta, falling back to exec-json:',
          appServerError?.message || appServerError,
        );
        usedTransport = 'exec-json-fallback';
        state.assistantText = '';
        state.finalResponse = '';
        state.assistantTextCache.clear();
      }
    }

    if (usedTransport !== 'app-server') {
      // ============================================================
      // 7. exec --json event stream (default / fallback)
      // ============================================================
      console.log('[CCG_DEBUG] Codex transport:', usedTransport);
      const events = await withCodexProxyEnvSuppressed(async () =>
        runCodexCliStream(runInput, codexOptions, threadOptions, {
          threadId: isResumingThread ? threadId : '',
          signal: turnAbortController.signal,
          cwd: workingDirectory,
        })
      );

      const config = {
        cwd: workingDirectory,
        threadId,
        threadOptions,
        normalizedPermissionMode,
        turnAbortController,
        streamingEnabled,
        onTurnCompleted: emitStreamEndOnce,
        onTurnFailed: emitStreamEndOnce,
      };

      console.log('[CCG_DEBUG] Codex event stream config:', JSON.stringify({
        streamingEnabled: config.streamingEnabled,
        hasThreadId: !!config.threadId,
        transport: usedTransport,
      }));

      await processCodexEventStream(events, state, config);
    }

    emitStreamEndOnce();

    // ============================================================
    // 8. Completion Phase
    // ============================================================

    if (!state.reasoningObserved && usedTransport !== 'app-server') {
      console.warn('[THINKING_HINT]', 'Codex did not return reasoning items. If you still cannot see the thinking process, please refer to docs/codex/docs/config.md for hide_agent_reasoning/show_raw_agent_reasoning settings, and ensure your OpenAI account has been verified.');
    }

    if (!state.suppressNoResponseFallback && state.assistantText.length === 0) {
      const noResponseMsg = [
        '\n[WARNING] Codex completed tool executions but did not generate a text response.',
        'This may happen when:',
        '- The task was purely about gathering information',
        '- Codex reached maxTurns limit (200 turns)',
        '- The query required only command execution',
        '\nPlease try:',
        '- Asking a more specific question',
        '- Requesting explicit analysis or explanation',
        '- Checking the command outputs above for your answer'
      ].join('\n');

      if (streamingEnabled) {
        process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(noResponseMsg)}\n`);
      }
      emitMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: noResponseMsg }]
        }
      });
      state.finalResponse = noResponseMsg;
      state.assistantText = noResponseMsg;
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      threadId: state.currentThreadId,
      result: state.finalResponse,
      transport: usedTransport,
    }));

  } catch (error) {
    const rawError = error?.message || String(error);
    const errorName = error?.name || '';
    // User clicked Stop → AbortController throws "Aborted". That is not a config/network failure.
    const isUserAbort =
      errorName === 'AbortError'
      || rawError === 'Aborted'
      || rawError === 'User interrupted'
      || /operation was aborted/i.test(rawError);

    if (isUserAbort) {
      console.error('[DEBUG] Codex turn aborted by user (no SEND_ERROR)');
      // Graceful finish: stream ends cleanly so the UI stops loading without an ERROR bubble.
      console.log(JSON.stringify({
        success: false,
        error: 'User interrupted',
        transport: 'aborted',
      }));
      emitStreamEndOnce();
    } else {
      console.error('[DEBUG] Error:', rawError);
      console.error('[DEBUG] Error stack:', error?.stack);

      const errorPayload = buildErrorPayload(error);
      // Mirror Claude: stderr for diagnostics, stdout [SEND_ERROR] for UI, bare JSON for demux.
      // IMPORTANT: emit SEND_ERROR *before* STREAM_END. The bridge drops request-scoped
      // webview mapping on stream_end, so a late send_error never reaches the chat UI.
      const serialized = JSON.stringify(errorPayload);
      console.error('[SEND_ERROR]', serialized);
      console.log(`[SEND_ERROR] ${serialized}`);
      console.log(serialized);
      emitStreamEndOnce();
    }
  } finally {
    activeCodexAbortControllers.delete(requestId);
  }
}

// ---------------------------------------------------------------------------
// getMcpServerTools
// ---------------------------------------------------------------------------

/**
 * Gets the tools list for a Codex MCP server.
 * Reuses mcp-status-service probing logic to avoid duplicate handshake implementation.
 *
 * @param {string} serverId
 * @param {Object} rawServerConfig
 */
export async function getMcpServerTools(serverId, rawServerConfig) {
  try {
    if (!serverId) {
      const invalid = {
        success: false,
        serverId: '',
        error: 'Missing serverId',
        tools: []
      };
      console.log('[MCP_SERVER_TOOLS]' + JSON.stringify(invalid));
      console.log(JSON.stringify(invalid));
      return;
    }

    // The panel now sends only a serverId; resolve the config from the native
    // ~/.codex/config.toml when the caller did not supply one.
    let effectiveConfig = rawServerConfig;
    if (!effectiveConfig || typeof effectiveConfig !== 'object') {
      effectiveConfig = await resolveCodexMcpServerConfig(serverId);
    }

    if (!effectiveConfig || typeof effectiveConfig !== 'object') {
      const invalid = {
        success: false,
        serverId,
        error: 'Missing serverConfig',
        tools: []
      };
      console.log('[MCP_SERVER_TOOLS]' + JSON.stringify(invalid));
      console.log(JSON.stringify(invalid));
      return;
    }

    const serverConfig = normalizeCodexMcpConfig(effectiveConfig);
    const toolsResult = await getMcpServerToolsImpl(serverId, serverConfig);
    const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
    const hasError = !!toolsResult?.error;

    const result = {
      success: !hasError || tools.length > 0,
      serverId,
      serverName: toolsResult?.name || serverId,
      tools,
      error: toolsResult?.error || null
    };

    const resultJson = JSON.stringify(result);
    console.log('[MCP_SERVER_TOOLS]' + resultJson);
    console.log(resultJson);
  } catch (error) {
    const errorResult = {
      success: false,
      serverId: serverId || '',
      error: error?.message || String(error),
      tools: []
    };
    const resultJson = JSON.stringify(errorResult);
    console.log('[MCP_SERVER_TOOLS]' + resultJson);
    console.log(resultJson);
  }
}

// ---------------------------------------------------------------------------
// normalizeCodexMcpConfig (internal)
// ---------------------------------------------------------------------------

/**
 * Converts Codex config field names to a format recognized by mcp-status-service.
 *
 * @param {Object} raw
 * @returns {Object}
 */
function normalizeCodexMcpConfig(raw) {
  const normalized = { ...raw };
  const type = normalized.type || (normalized.url ? 'http' : 'stdio');
  normalized.type = type;

  // Codex: http_headers -> mcp-status: headers
  if (!normalized.headers && normalized.http_headers && typeof normalized.http_headers === 'object') {
    normalized.headers = { ...normalized.http_headers };
  }

  // Codex: env_http_headers (values are env var names) -> headers (resolved values)
  if (normalized.env_http_headers && typeof normalized.env_http_headers === 'object') {
    const fromEnv = {};
    for (const [headerName, envName] of Object.entries(normalized.env_http_headers)) {
      if (typeof envName === 'string') {
        const envValue = process.env[envName];
        if (envValue) {
          fromEnv[headerName] = envValue;
        }
      }
    }
    normalized.headers = { ...(normalized.headers || {}), ...fromEnv };
  }

  // Codex: bearer_token_env_var -> Authorization header
  if (normalized.bearer_token_env_var && typeof normalized.bearer_token_env_var === 'string') {
    const token = process.env[normalized.bearer_token_env_var];
    if (token && !(normalized.headers && normalized.headers.Authorization)) {
      normalized.headers = { ...(normalized.headers || {}), Authorization: `Bearer ${token}` };
    }
  }

  return normalized;
}
