import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
  isWithinOrEqualTolerant,
  relativePathInside,
  resolveFilePathAgainstBase,
} from '../pathUtils';

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
  /**
   * @param getBaseDir Effective working directory the AI daemon operates in
   * (may differ from workspaceFolders[0] when the user configured a custom
   * working directory). Used to resolve relative paths and as git cwd.
   */
  constructor(
    private readonly getBaseDir: () => string,
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
   * View AI file changes — Trae / Source-Control semantics:
   * - Right side = real workspace file (never copied into the repo)
   * - Left side  = session "before" reconstructed by reverse-applying the
   *   recorded edit ops (works for untracked files); falls back to git HEAD.
   *
   * Do NOT write `.ccg-before/.ccg-after` next to project files (pollutes git U).
   */
  async showFileChangeDiff(content: string): Promise<void> {
    const data = this.safeJson<any>(content, {});
    const rawPath = String(data.filePath ?? '');
    if (!rawPath) return;
    const filePath = this.resolveTargetPath(rawPath);
    const base = path.basename(filePath);

    try {
      const status = String(data.status ?? 'M');
      const operations: UndoOperation[] = Array.isArray(data.operations) ? data.operations : [];
      const fileUri = vscode.Uri.file(filePath);

      if (!fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`无法显示 ${base} 的变更对比：文件已不存在`);
        return;
      }

      // New file created by AI: left = empty, right = real file.
      if (status === 'A') {
        const oldUri = await this.writeTempDiffFile(filePath, 'before', '');
        await vscode.commands.executeCommand('vscode.diff', oldUri, fileUri, `${base} (新建文件)`);
        return;
      }

      // 1) Session-scoped "before": reverse-apply the recorded edit ops on the
      // real file. This matches Trae/Source-Control semantics — only the AI's
      // session changes are shown, not the user's own uncommitted edits, and
      // it works for files that are untracked in git (where git.openChange
      // renders a misleading all-additions diff).
      const current = await this.readFileIfExists(filePath);
      const reversed = this.applyReverseOperations(current, operations);
      if (reversed !== current) {
        const oldUri = await this.writeTempDiffFile(filePath, 'before', reversed);
        await vscode.commands.executeCommand(
          'vscode.diff',
          oldUri,
          fileUri,
          `${base} (改动前 ↔ 当前)`,
        );
        return;
      }

      // 2) Git's own change view (working tree ↔ HEAD), identical to clicking
      // the file in the Source Control list — for tracked files when the op
      // payloads are stats-only and cannot be reverse-applied.
      try {
        await vscode.commands.executeCommand('git.openChange', fileUri);
        return;
      } catch {
        // Git extension unavailable or file untracked — fall through.
      }

      // 3) HEAD content as the left side via the git CLI.
      const gitBefore = await this.gitShowHeadFile(filePath);
      if (gitBefore != null && gitBefore !== current) {
        const oldUri = await this.writeTempDiffFile(filePath, 'before', gitBefore);
        await vscode.commands.executeCommand(
          'vscode.diff',
          oldUri,
          fileUri,
          `${base} (HEAD ↔ 当前)`,
        );
        return;
      }

      vscode.window.showWarningMessage(`无法显示 ${base} 的变更对比：没有可对比的历史内容`);
    } catch (error) {
      // Never fail silently — issue #3: clicking the diff icon gave no feedback.
      vscode.window.showWarningMessage(
        `无法显示 ${base} 的变更对比: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const rawPath = String(request?.filePath ?? '');
    const status = String(request?.status ?? '');
    if (!rawPath) throw new Error('File path is required');
    const filePath = this.resolveTargetPath(rawPath);
    this.assertPathAllowed(filePath);

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
    const baseDir = this.baseDir();
    if (!baseDir) return null;
    // Tolerate case-only differences (Windows drive letter, macOS FS) — a
    // case-sensitive path.relative would report the file as outside the base.
    const rel = relativePathInside(baseDir, filePath);
    if (!rel) return null;
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: baseDir,
        timeout: 10_000,
      });
      const { stdout } = await execFileAsync('git', ['show', `HEAD:${rel.replace(/\\/g, '/')}`], {
        cwd: baseDir,
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
    const baseDir = this.baseDir();
    if (!baseDir) return false;

    const rel = relativePathInside(baseDir, filePath);
    if (!rel) return false;

    // Must be inside a git work tree
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: baseDir,
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
        { cwd: baseDir, timeout: 30_000 },
      );
      return true;
    } catch {
      try {
        await execFileAsync('git', ['checkout', 'HEAD', '--', rel], {
          cwd: baseDir,
          timeout: 30_000,
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Effective working directory of the daemon, falling back to workspace folder[0]. */
  private baseDir(): string {
    const dir = this.getBaseDir() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    return dir ? path.resolve(dir) : '';
  }

  /**
   * Resolve a path from the webview to an absolute filesystem path. Relative
   * paths (Codex apply_patch) resolve against the daemon's working directory,
   * never the extension-host process cwd.
   */
  private resolveTargetPath(filePath: string): string {
    return resolveFilePathAgainstBase(filePath, this.baseDir());
  }

  /**
   * Mutation guard for undo: the target must live under the daemon's working
   * directory or any workspace folder. Comparison tolerates case-only
   * differences — issue #3: undo failed with "path must be inside the
   * workspace" whenever the CLI-reported casing differed from VS Code's
   * normalized fsPath (Windows drive letter, macOS) or a custom working
   * directory was configured.
   */
  private assertPathAllowed(filePath: string): void {
    const resolved = path.resolve(filePath);
    const roots: string[] = [];
    const base = this.baseDir();
    if (base) roots.push(base);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.push(path.resolve(folder.uri.fsPath));
    }
    if (roots.length === 0) throw new Error('Workspace path is not available');
    if (roots.some((root) => isWithinOrEqualTolerant(resolved, root))) {
      return;
    }
    throw new Error('Invalid file path: path must be inside the workspace');
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
    // Original filename LAST so the extension survives for syntax highlighting
    // (previously `.ccg-diff` was the final extension → no language mode).
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempName = `ccg-${role}-${stamp}-${base}`;
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
