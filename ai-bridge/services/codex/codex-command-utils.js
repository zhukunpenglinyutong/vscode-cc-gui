/**
 * Command classification and utility functions for Codex.
 * Stateless helpers extracted from sendMessage closures.
 */

import { resolve, sep } from 'path';
import { RAW_EVENT_LOG_MAX_CHARS, logWarn } from './codex-utils.js';

export function truncateForDisplay(text, maxChars) {
  if (typeof text !== 'string') {
    return String(text ?? '');
  }
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const head = Math.max(0, Math.floor(maxChars * 0.65));
  const tail = Math.max(0, maxChars - head);
  const prefix = text.slice(0, head);
  const suffix = tail > 0 ? text.slice(Math.max(0, text.length - tail)) : '';
  return `${prefix}\n...\n(truncated, original length: ${text.length} chars)\n...\n${suffix}`;
}

export function getStableItemId(item) {
  if (!item || typeof item !== 'object') return null;
  const candidate = item.id ?? item.item_id ?? item.uuid;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

export function extractCommand(item) {
  const cmd = item?.command;
  return typeof cmd === 'string' ? cmd : '';
}

export function extractActualCommand(command) {
  if (!command || typeof command !== 'string') {
    return command;
  }

  let cmd = command.trim();

  // Extract from /bin/zsh -lc '...' or /bin/bash -c '...'
  const shellWrapperMatch = cmd.match(/^\/bin\/(zsh|bash)\s+(?:-lc|-c)\s+['"](.+)['"]$/);
  if (shellWrapperMatch) {
    cmd = shellWrapperMatch[2];
  }

  // Remove 'cd dir &&' prefix if present
  const cdPrefixMatch = cmd.match(/^cd\s+\S+\s+&&\s+(.+)$/);
  if (cdPrefixMatch) {
    cmd = cdPrefixMatch[1];
  }

  return cmd.trim();
}

/**
 * Smart tool name conversion - matches HistoryHandler.java logic
 * Converts shell commands to more specific tool types based on command pattern
 */
export function smartToolName(command) {
  if (!command || typeof command !== 'string') {
    return 'bash';
  }

  // Extract actual command from shell wrapper
  const actualCmd = extractActualCommand(command);

  // List/find commands -> glob
  if (/^(ls|find|tree)\b/.test(actualCmd)) {
    return 'glob';
  }

  // File viewing commands -> read
  if (/^(pwd|cat|head|tail|file|stat)\b/.test(actualCmd)) {
    return 'read';
  }

  // sed -n (read-only mode for viewing specific lines) -> read
  // Example: sed -n '700,780p' file.txt
  if (/^sed\s+-n\s+/.test(actualCmd)) {
    return 'read';
  }

  // Search commands -> glob (collapsible)
  if (/^(grep|rg|ack|ag)\b/.test(actualCmd)) {
    return 'glob';
  }

  // Other commands stay as bash
  return 'bash';
}

/**
 * Generate smart description based on command pattern
 * Provides more meaningful descriptions than generic "Codex command execution"
 */
export function smartDescription(command) {
  if (!command || typeof command !== 'string') {
    return 'Execute command';
  }

  // Extract actual command from shell wrapper
  const actualCmd = extractActualCommand(command);
  const firstWord = actualCmd.split(/\s+/)[0];

  // File viewing commands
  if (/^ls\b/.test(actualCmd)) return 'List directory contents';
  if (/^pwd\b/.test(actualCmd)) return 'Show current directory';
  if (/^cat\b/.test(actualCmd)) return 'Read file contents';
  if (/^head\b/.test(actualCmd)) return 'Read first lines';
  if (/^tail\b/.test(actualCmd)) return 'Read last lines';
  if (/^find\b/.test(actualCmd)) return 'Find files';
  if (/^tree\b/.test(actualCmd)) return 'Show directory tree';

  // sed -n for reading specific lines
  if (/^sed\s+-n\s+/.test(actualCmd)) return 'Read file lines';

  // Search commands
  if (/^(grep|rg|ack|ag)\b/.test(actualCmd)) return 'Search in files';

  // Git commands
  if (/^git\s+status\b/.test(actualCmd)) return 'Check git status';
  if (/^git\s+diff\b/.test(actualCmd)) return 'Show git diff';
  if (/^git\s+log\b/.test(actualCmd)) return 'Show git log';
  if (/^git\s+add\b/.test(actualCmd)) return 'Stage changes';
  if (/^git\s+commit\b/.test(actualCmd)) return 'Commit changes';
  if (/^git\s+push\b/.test(actualCmd)) return 'Push to remote';
  if (/^git\s+pull\b/.test(actualCmd)) return 'Pull from remote';
  if (/^git\s+/.test(actualCmd)) return `Run git ${actualCmd.substring(4).split(/\s+/)[0]}`;

  // Build/Package commands
  if (/^npm\s+install\b/.test(actualCmd)) return 'Install npm packages';
  if (/^npm\s+run\b/.test(actualCmd)) return 'Run npm script';
  if (/^npm\s+/.test(actualCmd)) return `Run npm ${actualCmd.substring(4).split(/\s+/)[0]}`;
  if (/^(yarn|pnpm)\s+/.test(actualCmd)) return `Run ${firstWord} command`;
  if (/^(gradle|mvn|make)\b/.test(actualCmd)) return `Run ${firstWord} build`;

  // Default: use command as-is for short commands, or first word for long ones
  return actualCmd.length <= 30 ? actualCmd : `Run ${firstWord}`;
}

export function mapCommandToolNameToPermissionToolName(toolName) {
  if (toolName === 'read') return 'Read';
  if (toolName === 'glob') return 'Glob';
  return 'Bash';
}

export function resolveFilePath(filePath, cwd) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return '';
  }
  // Resolve to absolute path against the working directory
  const resolved = filePath.startsWith('/')
    ? resolve(filePath)
    : (cwd && typeof cwd === 'string' && cwd.trim())
      ? resolve(cwd, filePath)
      : filePath;
  // Guard against path traversal: resolved path must stay within cwd
  if (cwd && typeof cwd === 'string' && cwd.trim()) {
    const normalizedCwd = resolve(cwd);
    const normalizedResolved = resolve(resolved);
    if (normalizedResolved !== normalizedCwd && !normalizedResolved.startsWith(normalizedCwd + sep)) {
      logWarn('PERM_DEBUG', `Path traversal blocked: ${filePath} resolved to ${normalizedResolved} (cwd=${normalizedCwd})`);
      return '';
    }
  }
  return resolved;
}

export function stringifyRawEvent(event) {
  try {
    const json = JSON.stringify(event);
    if (!json) return '';
    if (json.length > RAW_EVENT_LOG_MAX_CHARS) {
      return `${json.slice(0, RAW_EVENT_LOG_MAX_CHARS)}...<truncated ${json.length - RAW_EVENT_LOG_MAX_CHARS} chars>`;
    }
    return json;
  } catch (error) {
    return `<stringify failed: ${error?.message || error}>`;
  }
}

export function isApprovalRelatedRawEvent(rawEventJson) {
  if (typeof rawEventJson !== 'string' || !rawEventJson) return false;
  return /approval|approve|permission|ask_user|ask-user|confirm|consent|tool_approval|requires_approval|plan_approval/i.test(rawEventJson);
}
