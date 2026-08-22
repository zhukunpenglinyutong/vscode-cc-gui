import * as fs from 'fs';
import * as path from 'path';

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const CONVERTIBLE_ENTRYPOINTS = new Set(['sdk-cli', 'claude-vscode']);
const VSCODE_ENTRYPOINT = 'claude-vscode';

export type EntrypointConversionResult = {
  success: boolean;
  sessionId: string;
  errorCode?: 'INVALID_SESSION_ID' | 'SESSION_NOT_FOUND' | 'FILE_NOT_EXIST' | 'NOT_SDK_SESSION' | 'CONVERSION_FAILED';
  infoCode?: 'ALREADY_CLI_SESSION';
  error?: string;
};

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(String(sessionId || '').trim());
}

/** Matches the Claude CLI's own project-directory naming: every non-alphanumeric char becomes `-`. */
export function sanitizeProjectPath(workspacePath: string): string {
  return String(workspacePath || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Backslash → forward-slash, strip trailing slash. Matches jetbrains-cc-gui's CodexHistoryReader.normalizePath(). */
export function normalizeHistoryCwd(cwd: string | undefined | null): string {
  let normalized = String(cwd || '').replace(/\\/g, '/');
  while (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** True iff `sessionCwd` is the project itself or a subdirectory of it. Empty `sessionCwd` never matches. */
export function cwdMatchesProject(sessionCwd: string | undefined | null, projectPath: string): boolean {
  const normalizedCwd = normalizeHistoryCwd(sessionCwd);
  if (!normalizedCwd) return false;
  const normalizedProject = normalizeHistoryCwd(projectPath);
  if (!normalizedProject) return false;
  return normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}/`);
}

export function shouldIncludeClaudeHistorySession(entrypoint: string | undefined, trackedByPlugin: boolean): boolean {
  const normalizedEntrypoint = String(entrypoint || '').trim();
  if (normalizedEntrypoint === VSCODE_ENTRYPOINT) {
    return true;
  }
  if (!normalizedEntrypoint && trackedByPlugin) {
    return true;
  }
  return false;
}

export function findClaudeSessionFile(projectsDir: string, sessionId: string): string | null {
  if (!fs.existsSync(projectsDir)) return null;
  for (const projectDir of fs.readdirSync(projectsDir)) {
    const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

export function convertClaudeSessionEntrypoint(
  sessionId: string,
  projectsDir: string,
): EntrypointConversionResult {
  if (!isValidSessionId(sessionId)) {
    return { success: false, sessionId, errorCode: 'INVALID_SESSION_ID' };
  }

  const sessionFile = findClaudeSessionFile(projectsDir, sessionId);
  if (!sessionFile) {
    return { success: false, sessionId, errorCode: 'SESSION_NOT_FOUND' };
  }
  if (!fs.existsSync(sessionFile)) {
    return { success: false, sessionId, errorCode: 'FILE_NOT_EXIST' };
  }

  const dir = path.dirname(sessionFile);
  const backupFile = path.join(dir, `${sessionId}.jsonl.backup.${Date.now()}.tmp`);
  const tempFile = path.join(dir, `${sessionId}.jsonl.convert.${Date.now()}.tmp`);

  try {
    fs.copyFileSync(sessionFile, backupFile);
    const lines = fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/);
    let modifiedCount = 0;
    let hasCliEntrypoint = false;
    const converted = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const row = JSON.parse(line);
        const entrypoint = typeof row?.entrypoint === 'string' ? row.entrypoint : '';
        if (!entrypoint) return line;
        if (entrypoint === 'cli') {
          hasCliEntrypoint = true;
          return line;
        }
        if (!CONVERTIBLE_ENTRYPOINTS.has(entrypoint)) {
          return line;
        }
        row.entrypoint = 'cli';
        modifiedCount += 1;
        return JSON.stringify(row);
      } catch {
        return line;
      }
    });

    if (modifiedCount === 0) {
      deleteIfExists(tempFile);
      deleteIfExists(backupFile);
      return {
        success: hasCliEntrypoint,
        sessionId,
        ...(hasCliEntrypoint ? { infoCode: 'ALREADY_CLI_SESSION' as const } : { errorCode: 'NOT_SDK_SESSION' as const }),
      };
    }

    fs.writeFileSync(tempFile, converted.join('\n'), 'utf8');
    fs.renameSync(tempFile, sessionFile);
    deleteIfExists(backupFile);
    return { success: true, sessionId };
  } catch (error) {
    try {
      if (fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, sessionFile);
      }
    } catch { /* ignore restore errors */ }
    return {
      success: false,
      sessionId,
      errorCode: 'CONVERSION_FAILED',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deleteIfExists(tempFile);
    deleteIfExists(backupFile);
  }
}

function deleteIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch { /* ignore cleanup errors */ }
}
