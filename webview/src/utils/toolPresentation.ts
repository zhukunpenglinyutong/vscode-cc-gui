import type { ToolInput } from '../types';
import { getFileName, truncate } from './helpers';
import { extractFilePathFromCommand, isCommandToolName, unwrapShellCommand } from './toolCommandPath';

const SPECIAL_FILES = new Set([
  'makefile', 'dockerfile', 'jenkinsfile', 'vagrantfile',
  'gemfile', 'rakefile', 'procfile', 'guardfile',
  'license', 'licence', 'readme', 'changelog',
  'gradlew', 'cname', 'authors', 'contributors',
]);

const stripLineSuffix = (filePath: string): string => filePath.replace(/:\d+(-\d+)?$/, '');

const parseLineSuffix = (filePath?: string): { start?: number; end?: number } => {
  if (!filePath) {
    return {};
  }

  const match = filePath.match(/:(\d+)(?:-(\d+))?$/);
  if (!match) {
    return {};
  }

  return {
    start: Number(match[1]),
    end: match[2] ? Number(match[2]) : undefined,
  };
};

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
};

const relativizeDisplayPath = (filePath: string, workdir?: string): string => {
  const cleanPath = stripLineSuffix(filePath);

  // If absolute path with workdir, try to relativize
  if (workdir && cleanPath.startsWith('/') && workdir.startsWith('/')) {
    if (cleanPath === workdir) {
      return filePath.startsWith(cleanPath) ? './' : '.';
    }

    const normalizedWorkdir = workdir.endsWith('/') ? workdir : `${workdir}/`;
    if (cleanPath.startsWith(normalizedWorkdir)) {
      const relativePath = cleanPath.slice(normalizedWorkdir.length);
      const lineSuffix = filePath.slice(cleanPath.length);
      return `${relativePath}${lineSuffix}`;
    }
  }

  // For relative paths or paths that cannot be relativized, just return the file name
  return getFileName(filePath);
};

const detectDirectory = (filePath: string): boolean => {
  if (filePath === '.' || filePath === '..' || filePath.endsWith('/')) {
    return true;
  }

  const cleanFileName = getFileName(stripLineSuffix(filePath));
  return !cleanFileName.includes('.') && !SPECIAL_FILES.has(cleanFileName.toLowerCase());
};

/**
 * Extract file paths from apply_patch input
 */
export const extractPathsFromPatch = (patchContent: string): string[] => {
  const paths: string[] = [];
  const lines = patchContent.split('\n');

  for (const line of lines) {
    // Match "*** Add File: /path/to/file" or "*** Update File: /path/to/file"
    const match = line.match(/^\*\*\* (?:Add|Update) File:\s*(.+)$/);
    if (match) {
      paths.push(match[1].trim());
    }
  }

  return paths;
};

export interface ToolTargetInfo {
  rawPath: string;
  openPath: string;
  displayPath: string;
  fileName: string;
  cleanFileName: string;
  isDirectory: boolean;
  isFile: boolean;
  lineStart?: number;
  lineEnd?: number;
}

export const resolveToolTarget = (input: ToolInput, name?: string): ToolTargetInfo | undefined => {
  const workdir = typeof input.workdir === 'string' ? input.workdir : undefined;
  const standardPath =
    (typeof input.file_path === 'string' ? input.file_path : undefined) ??
    (typeof input.path === 'string' ? input.path : undefined) ??
    (typeof input.target_file === 'string' ? input.target_file : undefined) ??
    (typeof input.notebook_path === 'string' ? input.notebook_path : undefined);

  const lowerName = (name ?? '').toLowerCase();

  // Handle apply_patch tool - extract file path from patch content
  if (lowerName === 'apply_patch') {
    const patchContent = (typeof input.input === 'string' ? input.input : undefined) ??
      (typeof input.patch === 'string' ? input.patch : undefined) ??
      (typeof input.content === 'string' ? input.content : undefined);

    if (patchContent) {
      const paths = extractPathsFromPatch(patchContent);
      if (paths.length > 0) {
        const rawPath = paths[0];
        const { start, end } = parseLineSuffix(rawPath);
        const openPath = stripLineSuffix(rawPath);
        const displayPath = relativizeDisplayPath(rawPath, workdir);
        const fileName = getFileName(displayPath);
        const cleanFileName = getFileName(stripLineSuffix(displayPath));
        const isDirectory = detectDirectory(rawPath);

        return {
          rawPath,
          openPath,
          displayPath: paths.length > 1 ? `${cleanFileName} (+${paths.length - 1} more)` : displayPath,
          fileName,
          cleanFileName,
          isDirectory,
          isFile: !isDirectory,
          lineStart: start,
          lineEnd: end,
        };
      }
    }
  }

  // Command-executing tools that may contain file paths
  const isCommandTool = lowerName === 'read' ||
    lowerName === 'write' ||
    isCommandToolName(lowerName);

  // Codex uses 'cmd', others use 'command'
  const commandStr = (typeof input.command === 'string' ? input.command : undefined) ??
    (typeof input.cmd === 'string' ? input.cmd : undefined);

  const rawPath = standardPath ??
    ((isCommandTool && commandStr)
      ? extractFilePathFromCommand(commandStr, workdir)
      : undefined);

  if (!rawPath) {
    return undefined;
  }

  const { start, end } = parseLineSuffix(rawPath);
  const openPath = stripLineSuffix(rawPath);
  const displayPath = relativizeDisplayPath(rawPath, workdir);
  const fileName = getFileName(displayPath);
  const cleanFileName = getFileName(stripLineSuffix(displayPath));
  const isDirectory = detectDirectory(rawPath);

  return {
    rawPath,
    openPath,
    displayPath,
    fileName,
    cleanFileName,
    isDirectory,
    isFile: !isDirectory,
    lineStart: start,
    lineEnd: end,
  };
};

export const getToolLineInfo = (input: ToolInput, target?: ToolTargetInfo): { start?: number; end?: number } => {
  const offset = parseNumber(input.offset);
  const limit = parseNumber(input.limit);
  if (offset !== undefined && limit !== undefined) {
    return {
      start: offset + 1,
      end: offset + limit,
    };
  }

  const line = input.line ?? input.lines;
  const lineNum = parseNumber(line);
  if (lineNum !== undefined) {
    return { start: lineNum };
  }

  const startLine = parseNumber(input.start_line);
  const endLine = parseNumber(input.end_line);
  if (startLine !== undefined) {
    return { start: startLine, end: endLine };
  }

  return {
    start: target?.lineStart,
    end: target?.lineEnd,
  };
};

export const summarizeToolCommand = (command?: string): string | undefined => {
  if (!command || typeof command !== 'string') {
    return undefined;
  }

  const strippedCommand = unwrapShellCommand(command);
  const firstLine = strippedCommand.split('\n')[0]?.trim() ?? '';
  if (!firstLine) {
    return undefined;
  }

  const summary = strippedCommand.includes('\n') ? `${firstLine} ...` : firstLine;
  return truncate(summary, 80);
};
