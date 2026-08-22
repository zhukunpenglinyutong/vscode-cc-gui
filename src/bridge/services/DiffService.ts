import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

/** Temp dir for diff buffers — never write .ccg-* into the workspace (pollutes git). */
const CCG_DIFF_TEMP_DIR = path.join(os.tmpdir(), 'cc-gui-diff');

type CallWebviewJson = (webview: vscode.Webview, functionName: string, payload: unknown) => void;

interface UndoOperation {
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
}

interface UndoFileRequest {
  filePath?: string;
  status?: string;
  operations?: UndoOperation[];
}

export class DiffService {
  constructor(
    private readonly getWorkspacePath: () => string,
    private readonly callWebviewJson: CallWebviewJson,
  ) {}

  async showDiff(content: string): Promise<void> {
    try {
      const data = this.safeJson<any>(content, {});
      const filePath = String(data.filePath ?? '');
      const oldContent = data.oldContent ?? '';
      const newContent = data.newContent ?? '';
      const title = data.title ?? path.basename(filePath);

      const oldUri = await this.writeTempDiffFile(filePath, 'old', oldContent);
      const newUri = await this.writeTempDiffFile(filePath, 'new', newContent);
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
    } catch {
      // Diff preview is best-effort; ai-bridge keeps the source file-change data.
    }
  }

  /**
   * View AI file changes — same idea as Source Control / `git diff`:
   * - Right side = real workspace file (never copy into the repo)
   * - Left side  = HEAD (via git.openChange) or reconstructed "before" in OS temp
   *
   * Do NOT write `.ccg-before/.ccg-after` next to project files (pollutes git U).
   */
  async showFileChangeDiff(content: string): Promise<void> {
    try {
      const data = this.safeJson<any>(content, {});
      const filePath = String(data.filePath ?? '');
      if (!filePath) return;
      this.assertPathInWorkspace(filePath);

      const status = String(data.status ?? 'M');
      const operations: UndoOperation[] = Array.isArray(data.operations) ? data.operations : [];
      const fileUri = vscode.Uri.file(filePath);
      const base = path.basename(filePath);

      // Modified tracked file: use Git's own change view (working tree ↔ HEAD),
      // identical to clicking the file in the Source Control list.
      if (status !== 'A') {
        try {
          await vscode.commands.executeCommand('git.openChange', fileUri);
          return;
        } catch {
          // Git extension unavailable or file untracked — fall through.
        }
      }

      // Fallback / new file: left = before (OS temp only), right = real file URI
      const current = await this.readFileIfExists(filePath);
      let before = '';
      if (status === 'A') {
        before = '';
      } else {
        const reversed = this.applyReverseOperations(current, operations);
        if (reversed !== current) {
          before = reversed;
        } else {
          const gitBefore = await this.gitShowHeadFile(filePath);
          before = gitBefore != null ? gitBefore : current;
        }
      }

      const oldUri = await this.writeTempDiffFile(filePath, 'before', before);
      await vscode.commands.executeCommand(
        'vscode.diff',
        oldUri,
        fileUri,
        `${base} (改动前 ↔ 当前)`,
      );
    } catch {
      // Diff preview is best-effort.
    }
  }

  async showInteractiveDiff(content: string, webview: vscode.Webview): Promise<void> {
    try {
      const data = this.safeJson<any>(content, {});
      const filePath = String(data.filePath ?? '');
      const newContents = String(data.newFileContents ?? data.newContent ?? '');
      const isNewFile = data.isNewFile === true;
      const title = data.tabName ?? `${path.basename(filePath)} (proposed)`;

      if (isNewFile) {
        const action = await vscode.window.showInformationMessage(
          `AI wants to create: ${path.basename(filePath)}`,
          'Create File',
          'Cancel',
        );
        if (action === 'Create File') {
          await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newContents, 'utf8'));
          await vscode.window.showTextDocument(vscode.Uri.file(filePath));
          webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: true }) });
        }
        return;
      }

      // Left = real file on disk; right = proposed content in OS temp (not workspace)
      const oldUri = vscode.Uri.file(filePath);
      const newUri = await this.writeTempDiffFile(filePath, 'proposed', newContents);

      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);

      const action = await vscode.window.showInformationMessage(
        `Apply changes to ${path.basename(filePath)}?`,
        'Apply',
        'Reject',
      );

      try {
        await vscode.workspace.fs.delete(newUri, { useTrash: false });
      } catch {
        // Ignore cleanup failures for temporary diff buffers.
      }

      if (action === 'Apply') {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(newContents, 'utf8'));
        webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: true }) });
      } else {
        webview.postMessage({ type: 'diff_applied', content: JSON.stringify({ filePath, applied: false }) });
      }
    } catch {
      // Keep the legacy behavior: failed preview generation should not interrupt streaming.
    }
  }

  async showEditDiff(_event: string, content: string): Promise<void> {
    try {
      const data = this.safeJson<any>(content, {});
      const filePath = String(data.filePath ?? '');
      const originalContent = await this.readFileIfExists(filePath);

      let newContent = originalContent;
      const edits: UndoOperation[] = Array.isArray(data.edits)
        ? data.edits
        : data.oldString !== undefined
          ? [{ oldString: data.oldString, newString: data.newString, replaceAll: data.replaceAll }]
          : [];

      for (const edit of edits) {
        const oldString = typeof edit.oldString === 'string' ? edit.oldString : '';
        const newString = typeof edit.newString === 'string' ? edit.newString : '';
        if (edit.replaceAll) {
          newContent = newContent.split(oldString).join(newString);
        } else {
          newContent = newContent.replace(oldString, newString);
        }
      }

      const title = data.title ?? `${path.basename(filePath)} (edit preview)`;
      // Left = current file; right = preview after ops (temp outside workspace)
      const oldUri = vscode.Uri.file(filePath);
      const newUri = await this.writeTempDiffFile(filePath, 'preview', newContent);
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
    } catch {
      // Keep edit previews non-fatal, matching the IDEA bridge behavior.
    }
  }

  async undoFileChanges(content: string, webview: vscode.Webview): Promise<void> {
    const request = this.safeJson<UndoFileRequest>(content, {});
    const filePath = String(request.filePath ?? '');
    try {
      await this.applyUndoFileChange(request);
      this.callWebviewJson(webview, 'onUndoFileResult', { success: true, filePath });
    } catch (error) {
      this.callWebviewJson(webview, 'onUndoFileResult', {
        success: false,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async undoAllFileChanges(content: string, webview: vscode.Webview): Promise<void> {
    const request = this.safeJson<any>(content, {});
    const files = Array.isArray(request.files) ? request.files : [];
    if (files.length === 0) {
      this.callWebviewJson(webview, 'onUndoAllFileResult', { success: false, error: 'No files to undo' });
      return;
    }

    let count = 0;
    const errors: string[] = [];

    for (const file of files) {
      try {
        await this.applyUndoFileChange(file);
        count += 1;
      } catch (error) {
        const filePath = String(file?.filePath ?? '');
        errors.push(`${filePath || 'unknown'}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0 && count === 0) {
      this.callWebviewJson(webview, 'onUndoAllFileResult', { success: false, error: errors.join('; ') });
      return;
    }

    this.callWebviewJson(webview, 'onUndoAllFileResult', {
      success: true,
      count,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    });
  }

  private async applyUndoFileChange(request: UndoFileRequest): Promise<void> {
    const filePath = String(request?.filePath ?? '');
    const status = String(request?.status ?? '');
    if (!filePath) throw new Error('File path is required');
    this.assertPathInWorkspace(filePath);

    // Only delete on undo when this was a true create (status A from Write tool).
    // Modified files (M) must reverse-patch content — never delete.
    if (status === 'A') {
      const uri = vscode.Uri.file(filePath);
      try {
        // Prefer trash so "undo create" does not permanently destroy the file.
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
      } catch (error: any) {
        // Fallback if trash is unavailable on the platform.
        try {
          await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        } catch (error2: any) {
          if (error2?.code !== 'FileNotFound' && error?.code !== 'FileNotFound') {
            throw error2 ?? error;
          }
        }
      }
      return;
    }

    if (status !== 'M') {
      throw new Error(`Unknown file status: ${status}`);
    }

    const operations = Array.isArray(request?.operations) ? request.operations : [];
    const uri = vscode.Uri.file(filePath);

    // 1) Prefer reverse string replace when we have real patch payloads.
    if (operations.length > 0) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        let text = Buffer.from(bytes).toString('utf8');
        let applied = 0;

        for (let i = operations.length - 1; i >= 0; i -= 1) {
          const op = operations[i] ?? {};
          const oldString = typeof op.oldString === 'string' ? op.oldString : '';
          const newString = typeof op.newString === 'string' ? op.newString : '';
          const replaceAll = op.replaceAll === true;
          // Skip empty / placeholder-only payloads (Codex stats-only tools).
          if (!newString || newString === ' ') continue;
          if (oldString === ' ' && newString === ' ') continue;
          if (replaceAll) {
            if (!text.includes(newString)) continue;
            text = text.split(newString).join(oldString);
            applied += 1;
          } else {
            const index = text.lastIndexOf(newString);
            if (index >= 0) {
              text = text.slice(0, index) + oldString + text.slice(index + newString.length);
              applied += 1;
            }
          }
        }

        if (applied > 0) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
          return;
        }
      } catch (error: any) {
        // Fall through to git restore — common when file was never fully read
        // or payload is stats-only.
        if (error?.code === 'FileNotFound') {
          throw error;
        }
      }
    }

    // 2) Fallback: git restore to HEAD (works when the file is tracked and the
    // AI edit is uncommitted). This is the reliable path for Codex streaming
    // tools that only ship file_path + line stats without reverse-able strings.
    const restored = await this.gitRestoreWorktreeFile(filePath);
    if (restored) {
      return;
    }

    throw new Error(
      'Could not reverse edit: no usable undo payload and git restore failed. '
      + 'Restore the file with Source Control / local history, or re-run the task.',
    );
  }

  /** Reverse edit operations on text (new → old). Returns original text if nothing applied. */
  private applyReverseOperations(text: string, operations: UndoOperation[]): string {
    if (!operations.length) return text;
    let next = text;
    let applied = 0;
    for (let i = operations.length - 1; i >= 0; i -= 1) {
      const op = operations[i] ?? {};
      const oldString = typeof op.oldString === 'string' ? op.oldString : '';
      const newString = typeof op.newString === 'string' ? op.newString : '';
      if (!newString || newString === ' ') continue;
      if (oldString === ' ' && newString === ' ') continue;
      if (op.replaceAll === true) {
        if (!next.includes(newString)) continue;
        next = next.split(newString).join(oldString);
        applied += 1;
      } else {
        const index = next.lastIndexOf(newString);
        if (index >= 0) {
          next = next.slice(0, index) + oldString + next.slice(index + newString.length);
          applied += 1;
        }
      }
    }
    return applied > 0 ? next : text;
  }

  /** Read file content at HEAD, or null if unavailable. */
  private async gitShowHeadFile(filePath: string): Promise<string | null> {
    const workspacePath = path.resolve(
      this.getWorkspacePath() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
    );
    if (!workspacePath) return null;
    const resolved = path.resolve(filePath);
    let rel: string;
    try {
      rel = path.relative(workspacePath, resolved);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    } catch {
      return null;
    }
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: workspacePath,
        timeout: 10_000,
      });
      const { stdout } = await execFileAsync('git', ['show', `HEAD:${rel.replace(/\\/g, '/')}`], {
        cwd: workspacePath,
        timeout: 30_000,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'utf8',
      });
      return typeof stdout === 'string' ? stdout : String(stdout ?? '');
    } catch {
      return null;
    }
  }

  /**
   * Restore a tracked file to HEAD in the workspace. Returns true on success.
   */
  private async gitRestoreWorktreeFile(filePath: string): Promise<boolean> {
    const workspacePath = path.resolve(
      this.getWorkspacePath() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
    );
    if (!workspacePath) return false;

    const resolved = path.resolve(filePath);
    let rel: string;
    try {
      rel = path.relative(workspacePath, resolved);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    } catch {
      return false;
    }

    // Must be inside a git work tree
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: workspacePath,
        timeout: 10_000,
      });
    } catch {
      return false;
    }

    // Prefer `git restore` (modern); fall back to `git checkout HEAD --`.
    try {
      await execFileAsync(
        'git',
        ['restore', '--source=HEAD', '--worktree', '--', rel],
        { cwd: workspacePath, timeout: 30_000 },
      );
      return true;
    } catch {
      try {
        await execFileAsync('git', ['checkout', 'HEAD', '--', rel], {
          cwd: workspacePath,
          timeout: 30_000,
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  private assertPathInWorkspace(filePath: string): void {
    const workspacePath = path.resolve(this.getWorkspacePath() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
    if (!workspacePath) throw new Error('Workspace path is not available');
    const resolved = path.resolve(filePath);
    if (resolved !== workspacePath && !resolved.startsWith(workspacePath + path.sep)) {
      throw new Error('Invalid file path: path must be inside the workspace');
    }
  }

  /**
   * Write a diff buffer under the OS temp directory (not the workspace).
   * Previous implementation wrote `${filePath}.ccg-before/after` inside the
   * project, which appeared as untracked files in Source Control.
   */
  private async writeTempDiffFile(
    sourceFilePath: string,
    role: string,
    content: string,
  ): Promise<vscode.Uri> {
    await fs.promises.mkdir(CCG_DIFF_TEMP_DIR, { recursive: true });
    const base = path.basename(sourceFilePath) || 'file';
    // Keep original extension for syntax highlighting (e.g. seed-topics.ts)
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempName = `${base}.${role}.${stamp}.ccg-diff`;
    const tempPath = path.join(CCG_DIFF_TEMP_DIR, tempName);
    const uri = vscode.Uri.file(tempPath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content ?? '', 'utf8'));
    return uri;
  }

  private async readFileIfExists(filePath: string): Promise<string> {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  }

  private safeJson<T>(content: string, fallback: T): T {
    try {
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }
}
