/**
 * Tool name/input normalization and invocation tracking utilities.
 *
 * Extracted from codex-event-handler.js to reduce file size and improve
 * separation of concerns.  These functions normalize Codex SDK tool calls
 * (MCP tools, function calls, plan updates) into a consistent format
 * consumed by the frontend message protocol.
 */

// ── MCP Tool Normalization ──

export function normalizeMcpToolName(server, tool) {
  const serverName = String(server || '').toLowerCase();
  const toolName = String(tool || '').toLowerCase();

  if (serverName === 'filesystem') {
    if (toolName === 'edit_file') return 'edit_file';
    if (toolName === 'write_file') return 'write_to_file';
    if (toolName === 'read_text_file' || toolName === 'read_multiple_files') return 'read_file';
    if (toolName === 'search_files') return 'search';
  }

  return `mcp__${server}__${tool}`;
}

export function normalizeMcpToolInput(server, tool, args) {
  const serverName = String(server || '').toLowerCase();
  const toolName = String(tool || '').toLowerCase();
  const input = (args && typeof args === 'object') ? { ...args } : {};

  if (serverName !== 'filesystem') {
    return input;
  }

  if (typeof input.path === 'string') {
    input.file_path = input.path;
  }

  if (toolName === 'edit_file') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const firstEdit = edits[0] && typeof edits[0] === 'object' ? edits[0] : null;
    if (firstEdit) {
      if (typeof firstEdit.oldText === 'string') input.old_string = firstEdit.oldText;
      if (typeof firstEdit.newText === 'string') input.new_string = firstEdit.newText;
      if (typeof firstEdit.oldText === 'string') input.oldString = firstEdit.oldText;
      if (typeof firstEdit.newText === 'string') input.newString = firstEdit.newText;
    }
  } else if (toolName === 'write_file' && typeof input.content === 'string') {
    input.old_string = '';
    input.new_string = input.content;
    input.oldString = '';
    input.newString = input.content;
  }

  return input;
}

// ── JSON & Object Helpers ──

export function safeJsonParse(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isObjectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ── Plan Normalization ──

export function normalizePlanStatus(status) {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (value === 'completed' || value === 'done') return 'completed';
  if (value === 'in_progress' || value === 'in-progress' || value === 'active' || value === 'running') return 'in_progress';
  return 'pending';
}

export function normalizeUpdatePlanInput(input) {
  const normalized = isObjectRecord(input) ? { ...input } : {};
  const plan = Array.isArray(normalized.plan) ? normalized.plan : [];
  normalized.plan = plan
    .map((item) => {
      if (!isObjectRecord(item)) return null;
      const content =
        (typeof item.content === 'string' && item.content.trim()) ? item.content.trim() :
        (typeof item.step === 'string' && item.step.trim()) ? item.step.trim() :
        (typeof item.title === 'string' && item.title.trim()) ? item.title.trim() :
        (typeof item.text === 'string' && item.text.trim()) ? item.text.trim() :
        '';
      if (!content) return null;
      return {
        ...item,
        content,
        step: content,
        status: normalizePlanStatus(item.status),
      };
    })
    .filter(Boolean);
  return normalized;
}

// ── Function Call Normalization ──

export function parseFunctionCallArguments(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (isObjectRecord(payload.arguments)) return payload.arguments;
  return safeJsonParse(payload.arguments);
}

export function normalizeFunctionCallTool(toolName, parsedArguments) {
  if (typeof toolName !== 'string' || !toolName) {
    return { name: toolName, input: isObjectRecord(parsedArguments) ? parsedArguments : {} };
  }

  const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
  if (mcpMatch) {
    const [, server, tool] = mcpMatch;
    const normalizedInput = normalizeMcpToolInput(server, tool, isObjectRecord(parsedArguments) ? parsedArguments : {});
    return {
      name: normalizeMcpToolName(server, tool),
      input: normalizedInput,
    };
  }

  return {
    name: toolName,
    input: toolName === 'update_plan'
      ? normalizeUpdatePlanInput(parsedArguments)
      : (isObjectRecord(parsedArguments) ? parsedArguments : {}),
  };
}

// ── Stable Serialization & Invocation Tracking ──

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildToolInvocationSignature(name, input) {
  if (typeof name !== 'string' || !name) return '';
  return `${name}::${stableStringify(input && typeof input === 'object' ? input : {})}`;
}

export function rememberToolInvocation(state, toolUseId, toolName, toolInput) {
  const signature = buildToolInvocationSignature(toolName, toolInput);
  if (!signature) return '';
  state.toolCallSignatureById.set(toolUseId, signature);
  if (!state.toolUseIdBySignature.has(signature)) {
    state.toolUseIdBySignature.set(signature, toolUseId);
  }
  return signature;
}

export function findMatchingToolUseId(state, toolName, toolInput) {
  const signature = buildToolInvocationSignature(toolName, toolInput);
  if (!signature) return null;
  return state.toolUseIdBySignature.get(signature) ?? null;
}
