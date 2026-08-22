import * as path from 'path';

export type RememberedApproval = {
  toolName: string;
  command?: string;
  cwd?: string;
  path?: string;
};

export function buildRememberedApproval(
  toolName: string,
  inputs: Record<string, unknown>,
  cwd?: string,
  platform = process.platform,
): RememberedApproval {
  return {
    toolName,
    command: normalizeApprovalCommand(asTrimmedString(inputs.command), platform),
    cwd: normalizeApprovalPath(asTrimmedString(inputs.cwd) || asTrimmedString(cwd), platform),
    path: normalizeApprovalPath(
      asTrimmedString(inputs.file_path)
        || asTrimmedString(inputs.path)
        || asTrimmedString(inputs.target_file),
      platform,
    ),
  };
}

export function sameRememberedApproval(
  left: RememberedApproval,
  right: RememberedApproval,
  platform = process.platform,
): boolean {
  return left.toolName === right.toolName
    && normalizeApprovalCommand(left.command || '', platform) === normalizeApprovalCommand(right.command || '', platform)
    && normalizeApprovalPath(left.cwd || '', platform) === normalizeApprovalPath(right.cwd || '', platform)
    && normalizeApprovalPath(left.path || '', platform) === normalizeApprovalPath(right.path || '', platform);
}

export function normalizeApprovalCommand(command: string, platform = process.platform): string {
  let current = command.trim();
  if (!current) {
    return '';
  }

  current = unwrapShellCommand(current);
  if (platform === 'win32') {
    current = unwrapWindowsShellCommand(current);
  }

  return normalizeCommandWhitespace(current);
}

function unwrapShellCommand(command: string): string {
  const shellWrapperMatch = command.match(/^\/bin\/(?:zsh|bash|sh)\s+(?:-lc|-c)\s+([\s\S]+)$/);
  if (!shellWrapperMatch) {
    return stripOuterGrouping(command);
  }

  let current = stripWrappingQuotes(shellWrapperMatch[1].trim());
  current = current.replace(/'\\''/g, '\'');
  current = current.replace(/'"'"'/g, '\'');
  return stripOuterGrouping(current);
}

function unwrapWindowsShellCommand(command: string): string {
  const powershellMatch = command.match(/^(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|[^\s"']*(?:powershell|pwsh)(?:\.exe)?)\s+-(?:Command|c)\s+([\s\S]+)$/i);
  if (powershellMatch) {
    return stripOuterGrouping(stripWrappingQuotes(powershellMatch[1].trim()));
  }

  const cmdMatch = command.match(/^(?:"[^"]*cmd(?:\.exe)?"|[^\s"']*cmd(?:\.exe)?)\s+\/[cs]\s+([\s\S]+)$/i);
  if (cmdMatch) {
    return stripOuterGrouping(stripWrappingQuotes(cmdMatch[1].trim()));
  }

  return stripOuterGrouping(command);
}

function normalizeApprovalPath(value: string, platform = process.platform): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (platform === 'win32') {
    return path.win32.normalize(trimmed).toLowerCase();
  }
  return path.normalize(trimmed);
}

function normalizeCommandWhitespace(command: string): string {
  return command
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const firstChar = value[0];
  const lastChar = value[value.length - 1];
  if ((firstChar === '"' && lastChar === '"') || (firstChar === '\'' && lastChar === '\'')) {
    return value.slice(1, -1);
  }

  return value;
}

function stripOuterGrouping(value: string): string {
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
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
