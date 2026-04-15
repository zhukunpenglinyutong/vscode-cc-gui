const stripWrappingQuotes = (value: string): string => {
  if (value.length < 2) {
    return value;
  }

  const firstChar = value[0];
  const lastChar = value[value.length - 1];
  if ((firstChar === '"' && lastChar === '"') || (firstChar === '\'' && lastChar === '\'')) {
    return value.slice(1, -1);
  }

  return value;
};

const stripOuterGrouping = (value: string): string => {
  let current = value.trim();

  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let isBalanced = true;

    for (let index = 0; index < current.length; index += 1) {
      const char = current[index];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0 && index < current.length - 1) {
          isBalanced = false;
          break;
        }
      }

      if (depth < 0) {
        isBalanced = false;
        break;
      }
    }

    if (!isBalanced || depth !== 0) {
      break;
    }

    current = current.slice(1, -1).trim();
  }

  return current;
};

const splitTopLevelSegments = (command: string): string[] => {
  const segments: string[] = [];
  let current = '';
  let quoteChar: '"' | '\'' | null = null;
  let escapeNext = false;
  let parenthesesDepth = 0;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const nextChar = command[index + 1];

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escapeNext = true;
      continue;
    }

    if (quoteChar) {
      current += char;
      if (char === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      current += char;
      quoteChar = char;
      continue;
    }

    if (char === '(') {
      parenthesesDepth += 1;
      current += char;
      continue;
    }

    if (char === ')' && parenthesesDepth > 0) {
      parenthesesDepth -= 1;
      current += char;
      continue;
    }

    const hasTwoCharSeparator = (char === '&' && nextChar === '&') ||
      (char === '|' && nextChar === '|');
    const hasOneCharSeparator = char === ';' || (char === '|' && nextChar !== '|');

    if (parenthesesDepth === 0 && (hasTwoCharSeparator || hasOneCharSeparator)) {
      const trimmedSegment = current.trim();
      if (trimmedSegment) {
        segments.push(stripOuterGrouping(trimmedSegment));
      }
      current = '';
      if (hasTwoCharSeparator) {
        index += 1;
      }
      continue;
    }

    current += char;
  }

  const trimmedSegment = current.trim();
  if (trimmedSegment) {
    segments.push(stripOuterGrouping(trimmedSegment));
  }

  return segments;
};

export const unwrapShellCommand = (command: string): string => {
  let current = command.trim();
  const shellWrapperMatch = current.match(/^\/bin\/(?:zsh|bash|sh)\s+(?:-lc|-c)\s+([\s\S]+)$/);
  if (shellWrapperMatch) {
    current = stripWrappingQuotes(shellWrapperMatch[1].trim());
    current = current.replace(/'\\''/g, '\'');
    current = current.replace(/'"'"'/g, '\'');
  }

  return stripOuterGrouping(current);
};

const normalizePathToken = (pathToken: string): string => stripWrappingQuotes(pathToken.trim());

const parseSegmentPath = (segment: string, workdir?: string): string | undefined => {
  if (/^pwd\s*$/.test(segment)) {
    return workdir ? `${workdir}/` : undefined;
  }

  if (/^ls(?:\s+-[a-zA-Z]+)*\s*$/.test(segment)) {
    return workdir ? `${workdir}/` : undefined;
  }

  const lsMatch = segment.match(/^ls\s+(?:-[a-zA-Z]+\s+)*(.+)$/);
  if (lsMatch) {
    const path = normalizePathToken(lsMatch[1]);
    return path.endsWith('/') ? path : `${path}/`;
  }

  if (/^tree(?:\s+-[a-zA-Z]+)*\s*$/.test(segment)) {
    return workdir ? `${workdir}/` : undefined;
  }

  const treeMatch = segment.match(/^tree\s+(?:-[a-zA-Z]+\s+)*(.+)$/);
  if (treeMatch) {
    const path = normalizePathToken(treeMatch[1]);
    return path.endsWith('/') ? path : `${path}/`;
  }

  const sedMatch = segment.match(/^sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+(.+)$/);
  if (sedMatch) {
    const startLine = sedMatch[1];
    const endLine = sedMatch[2];
    const path = normalizePathToken(sedMatch[3]);
    return endLine ? `${path}:${startLine}-${endLine}` : `${path}:${startLine}`;
  }

  // cat with optional flags (e.g., cat -n file.txt)
  const catMatch = segment.match(/^cat\s+(?:-[a-zA-Z]+\s+)*(\S+)$/);
  if (catMatch) {
    const token = normalizePathToken(catMatch[1]);
    // Ensure it's not a flag
    if (!token.startsWith('-')) {
      return token;
    }
  }

  // head/tail: extract the last non-flag token as the file path
  const headTailMatch = segment.match(/^(head|tail)\s+.*\s+(\S+)$/);
  if (headTailMatch) {
    const lastToken = normalizePathToken(headTailMatch[2]);
    // Only treat as path if it doesn't start with '-'
    if (!lastToken.startsWith('-')) {
      return lastToken;
    }
  }

  // nl -ba file | sed -n '1,100p' - extract file from nl command
  const nlMatch = segment.match(/^nl\s+(?:-[a-zA-Z]+\s+)*(\S+)$/);
  if (nlMatch) {
    return normalizePathToken(nlMatch[1]);
  }

  // Write commands: cat > file, tee file, echo/printf > file
  const catRedirectMatch = segment.match(/^cat\s*>\s*(.+)$/);
  if (catRedirectMatch) {
    return normalizePathToken(catRedirectMatch[1]);
  }

  const teeMatch = segment.match(/^tee\s+(?:-[a-zA-Z]+\s+)*(.+)$/);
  if (teeMatch) {
    return normalizePathToken(teeMatch[1]);
  }

  const redirectMatch = segment.match(/^(?:echo|printf)\s+.+\s*>\s*(.+)$/);
  if (redirectMatch) {
    return normalizePathToken(redirectMatch[1]);
  }

  return undefined;
};

/**
 * Extract file path from a pipeline command like "nl -ba file | sed -n '1,100p'"
 */
const extractPathFromPipeline = (pipeline: string): string | undefined => {
  // Split by pipe, but be careful about nested commands
  const pipeParts = pipeline.split('|').map(p => p.trim());

  for (const part of pipeParts) {
    // Try to extract path from each part
    const path = parseSegmentPath(part);
    if (path) {
      return path;
    }
  }

  return undefined;
};

export const extractFilePathFromCommand = (command: string | undefined, workdir?: string): string | undefined => {
  if (!command || typeof command !== 'string') {
    return undefined;
  }

  const normalizedCommand = unwrapShellCommand(command);

  // First, try to handle pipeline commands (nl -ba file | sed -n ...)
  // Split by && and ; first, then check for pipes in each segment
  const segments = splitTopLevelSegments(normalizedCommand);
  const executableSegments = segments.filter((segment, index) => !(index === 0 && /^cd\s+.+$/.test(segment)));

  for (const segment of executableSegments) {
    // Check if this segment contains a pipe
    if (segment.includes('|')) {
      const path = extractPathFromPipeline(segment);
      if (path) {
        return path;
      }
    } else {
      const path = parseSegmentPath(segment, workdir);
      if (path) {
        return path;
      }
    }
  }

  return undefined;
};

export const isFileViewingCommand = (command?: string): boolean => {
  if (!command || typeof command !== 'string') {
    return false;
  }

  return extractFilePathFromCommand(command) !== undefined;
};

export type ParsedCommandType = 'read' | 'list' | 'search' | 'unknown';

export interface ParsedCommandInfo {
  type: ParsedCommandType;
  displayText: string;
  path?: string;
}

/** Tool names that execute shell commands (shared across components). */
export const COMMAND_TOOL_NAMES = new Set([
  'shell_command', 'exec_command', 'execute_command',
  'executecommand', 'bash', 'run_terminal_cmd',
]);

/** Check if a tool name represents a command-executing tool. */
export const isCommandToolName = (name: string): boolean =>
  COMMAND_TOOL_NAMES.has(name.toLowerCase());

// sed is handled separately - only 'sed -n' (print mode) counts as read
const READ_COMMANDS = ['cat', 'head', 'tail', 'less', 'more', 'nl', 'bat'];
const LIST_COMMANDS = ['ls', 'tree', 'find', 'git ls-files', 'git ls-tree'];
const SEARCH_COMMANDS = ['grep', 'rg', 'git grep', 'ag', 'ack'];

export const parseCommandType = (command: string | undefined): ParsedCommandInfo => {
  if (!command || typeof command !== 'string') {
    return { type: 'unknown', displayText: '' };
  }

  const normalizedCommand = unwrapShellCommand(command);
  const firstSegment = normalizedCommand.split('\n')[0]?.trim() ?? '';

  const lowerCommand = firstSegment.toLowerCase();

  // Handle sed specially: only 'sed -n' (print mode) is a read command
  if (/^sed\s+-n\s+/.test(lowerCommand)) {
    const path = extractFilePathFromCommand(command);
    return {
      type: 'read',
      displayText: path ?? firstSegment,
      path,
    };
  }

  for (const cmd of READ_COMMANDS) {
    if (lowerCommand.startsWith(cmd + ' ') || lowerCommand === cmd) {
      const path = extractFilePathFromCommand(command);
      return {
        type: 'read',
        displayText: path ?? firstSegment,
        path,
      };
    }
  }

  for (const cmd of LIST_COMMANDS) {
    if (lowerCommand.startsWith(cmd + ' ') || lowerCommand === cmd) {
      const path = extractFilePathFromCommand(command);
      return {
        type: 'list',
        displayText: path ?? firstSegment,
        path,
      };
    }
  }

  for (const cmd of SEARCH_COMMANDS) {
    if (lowerCommand.startsWith(cmd + ' ') || lowerCommand === cmd) {
      return {
        type: 'search',
        displayText: firstSegment,
      };
    }
  }

  if (/^git\s+(status|diff|log|branch)/.test(lowerCommand)) {
    return {
      type: 'unknown',
      displayText: firstSegment,
    };
  }

  return {
    type: 'unknown',
    displayText: firstSegment,
  };
};
