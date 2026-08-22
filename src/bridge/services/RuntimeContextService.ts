import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface RuntimeFileItem {
  name: string;
  path: string;
  absolutePath: string;
  type: 'terminal' | 'service';
  extension: string;
  priority: number;
}

interface FileTagInfo {
  displayPath?: string;
  absolutePath?: string;
}

interface ReferencedFileContext {
  path: string;
  displayPath: string;
  language: string;
  content: string;
  truncated: boolean;
}

interface RuntimeContextBlock {
  type: 'terminal' | 'service';
  name: string;
  path: string;
  content: string;
  captured: boolean;
}

interface OpenedFilesContext {
  active?: string;
  selection?: {
    startLine: number;
    endLine: number;
    selectedText: string;
  };
  others?: string[];
  workspaceRoot?: string;
  isWorkspace?: boolean;
  subprojects?: Array<{ name: string; path: string; type: string; loaded: boolean }>;
  referencedFiles?: ReferencedFileContext[];
  runtimeContexts?: RuntimeContextBlock[];
}

interface EnrichSendParamsOptions {
  includeEditorContext?: boolean;
}

interface TerminalSnapshot {
  name: string;
  path: string;
  commandLine?: string;
  cwd?: string;
  output: string;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  captured: boolean;
}

const MAX_REFERENCE_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 160 * 1024;
const MAX_TERMINAL_CAPTURE_CHARS = 40 * 1024;
const MAX_RUNTIME_CONTEXT_CHARS = 24 * 1024;

export class RuntimeContextService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly terminalSnapshots = new Map<string, TerminalSnapshot>();
  private readonly terminalKeys = new WeakMap<vscode.Terminal, string>();
  private readonly terminalKeyCounts = new Map<string, number>();
  private readonly activeTasks = new Map<string, vscode.TaskExecution>();
  private readonly debugSessions = new Map<string, vscode.DebugSession>();

  constructor(
    private readonly getWorkspacePath: () => string,
    private readonly log: vscode.OutputChannel,
  ) {
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        this.keyForTerminal(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.terminalKeys.delete(terminal);
      }),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        void this.captureTerminalExecution(event);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const key = this.keyForTerminal(event.terminal);
        const snapshot = this.terminalSnapshots.get(key);
        if (snapshot) {
          snapshot.exitCode = event.exitCode;
          snapshot.endedAt = Date.now();
        }
      }),
      vscode.tasks.onDidStartTask((event) => {
        this.activeTasks.set(this.serviceKey(event.execution.task.name), event.execution);
      }),
      vscode.tasks.onDidEndTask((event) => {
        this.activeTasks.delete(this.serviceKey(event.execution.task.name));
      }),
      vscode.debug.onDidStartDebugSession((session) => {
        this.debugSessions.set(this.serviceKey(`Debug: ${session.name}`), session);
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.debugSessions.delete(this.serviceKey(`Debug: ${session.name}`));
      }),
    );

    for (const terminal of vscode.window.terminals) {
      this.keyForTerminal(terminal);
    }
    for (const execution of vscode.tasks.taskExecutions) {
      this.activeTasks.set(this.serviceKey(execution.task.name), execution);
    }
    if (vscode.debug.activeDebugSession) {
      this.debugSessions.set(
        this.serviceKey(`Debug: ${vscode.debug.activeDebugSession.name}`),
        vscode.debug.activeDebugSession,
      );
    }
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.activeTasks.clear();
    this.debugSessions.clear();
    this.terminalSnapshots.clear();
    this.terminalKeyCounts.clear();
  }

  listItems(query = ''): RuntimeFileItem[] {
    const normalizedQuery = query.trim().toLowerCase();
    const items: RuntimeFileItem[] = [];

    for (const terminal of vscode.window.terminals) {
      const terminalPath = `terminal://${this.keyForTerminal(terminal)}`;
      items.push({
        name: `Terminal: ${terminal.name}`,
        path: terminalPath,
        absolutePath: terminalPath,
        type: 'terminal',
        extension: 'terminal',
        priority: 0,
      });
    }

    for (const execution of vscode.tasks.taskExecutions) {
      const servicePath = `service://${this.serviceKey(execution.task.name)}`;
      items.push({
        name: `Service: ${execution.task.name}`,
        path: servicePath,
        absolutePath: servicePath,
        type: 'service',
        extension: 'service',
        priority: 0,
      });
    }

    const debugSession = vscode.debug.activeDebugSession;
    if (debugSession) {
      const servicePath = `service://${this.serviceKey(`Debug: ${debugSession.name}`)}`;
      items.push({
        name: `Service: Debug: ${debugSession.name}`,
        path: servicePath,
        absolutePath: servicePath,
        type: 'service',
        extension: 'debug',
        priority: 0,
      });
    }

    return items.filter((item) => {
      if (!normalizedQuery) return true;
      return item.name.toLowerCase().includes(normalizedQuery) ||
        item.path.toLowerCase().includes(normalizedQuery);
    });
  }

  enrichSendParams(params: Record<string, any>, options: EnrichSendParamsOptions = {}): void {
    const fileTags = Array.isArray(params.fileTags) ? params.fileTags as FileTagInfo[] : [];
    const includeEditorContext = options.includeEditorContext ?? true;
    const contextBarFile = typeof params.contextBarFile === 'string'
      ? params.contextBarFile.trim()
      : '';
    if (includeEditorContext || fileTags.length > 0) {
      const generated = this.buildOpenedFilesContext(fileTags, {
        includeEditorContext,
        contextBarFile: contextBarFile || undefined,
      });
      params.openedFiles = this.mergeOpenedFiles(params.openedFiles, generated);
    }

    if (!params.agentPrompt && params.agent?.prompt) {
      params.agentPrompt = String(params.agent.prompt);
    }

    if (params.codexFastMode === 'fast' && !params.serviceTier) {
      params.serviceTier = 'fast';
    }
  }

  private buildOpenedFilesContext(
    fileTags: FileTagInfo[],
    options: { includeEditorContext: boolean; contextBarFile?: string },
  ): OpenedFilesContext {
    const workspaceRoot = this.getWorkspacePath() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const context: OpenedFilesContext = options.includeEditorContext
      ? {
          workspaceRoot,
          isWorkspace: (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
          subprojects: this.workspaceSubprojects(),
        }
      : {};

    if (options.includeEditorContext) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor?.document.uri.scheme === 'file') {
        const filePath = activeEditor.document.uri.fsPath;
        const selection = activeEditor.selection;
        if (!selection.isEmpty) {
          const startLine = selection.start.line + 1;
          const endLine = selection.end.line + 1;
          context.active = startLine === endLine
            ? `${filePath}#L${startLine}`
            : `${filePath}#L${startLine}-${endLine}`;
          context.selection = {
            startLine,
            endLine,
            selectedText: activeEditor.document.getText(selection),
          };
        } else {
          context.active = filePath;
        }
      } else if (options.contextBarFile) {
        // Webview focus can clear activeTextEditor; ContextBar chip is the user's
        // visible "selected for AI" file and must still reach the model.
        context.active = options.contextBarFile.replace(/^@/, '');
      }

      const otherFiles = new Set<string>();
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme !== 'file') continue;
        const filePath = document.uri.fsPath;
        if (filePath && filePath !== context.active?.replace(/#L\d+(-\d+)?$/, '')) {
          otherFiles.add(filePath);
        }
      }
      context.others = Array.from(otherFiles).slice(0, 80);
    }

    const referencedFiles: ReferencedFileContext[] = [];
    const runtimeContexts: RuntimeContextBlock[] = [];
    let totalReferenceBytes = 0;

    for (const tag of fileTags) {
      const tagPath = this.normalizeTagPath(tag);
      if (!tagPath) continue;

      if (this.isRuntimePath(tagPath)) {
        const runtimeContext = this.runtimeContextForTag(tagPath, tag.displayPath);
        if (runtimeContext) {
          runtimeContexts.push(runtimeContext);
        }
        continue;
      }

      const resolvedPath = this.resolveWorkspaceFilePath(tagPath, workspaceRoot);
      if (!resolvedPath) continue;

      if (totalReferenceBytes >= MAX_TOTAL_REFERENCE_BYTES) continue;
      const fileContext = this.readReferencedFile(resolvedPath, tag.displayPath || tagPath, MAX_TOTAL_REFERENCE_BYTES - totalReferenceBytes);
      if (fileContext) {
        referencedFiles.push(fileContext);
        totalReferenceBytes += Buffer.byteLength(fileContext.content, 'utf8');
      }
    }

    if (referencedFiles.length > 0) {
      context.referencedFiles = referencedFiles;
    }
    if (runtimeContexts.length > 0) {
      context.runtimeContexts = runtimeContexts;
    }

    return context;
  }

  private mergeOpenedFiles(existing: any, generated: OpenedFilesContext): OpenedFilesContext {
    const base = existing && typeof existing === 'object' ? { ...existing } : {};
    const merged: OpenedFilesContext = {
      ...generated,
      ...base,
    };

    if (!merged.active && generated.active) {
      merged.active = generated.active;
    }
    if (!merged.selection && generated.selection) {
      merged.selection = generated.selection;
    }
    if (!merged.workspaceRoot && generated.workspaceRoot) {
      merged.workspaceRoot = generated.workspaceRoot;
    }
    if (merged.isWorkspace === undefined) {
      merged.isWorkspace = generated.isWorkspace;
    }
    if (!Array.isArray(merged.subprojects) || merged.subprojects.length === 0) {
      merged.subprojects = generated.subprojects;
    }

    merged.others = this.mergeStringArrays(base.others, generated.others);
    merged.referencedFiles = this.mergeObjectArrays(base.referencedFiles, generated.referencedFiles, 'path');
    merged.runtimeContexts = this.mergeObjectArrays(base.runtimeContexts, generated.runtimeContexts, 'path');
    return merged;
  }

  private workspaceSubprojects(): Array<{ name: string; path: string; type: string; loaded: boolean }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
      type: 'vscode-workspace-folder',
      loaded: true,
    }));
  }

  private normalizeTagPath(tag: FileTagInfo): string {
    const value = tag.absolutePath || tag.displayPath || '';
    return String(value).trim();
  }

  private isRuntimePath(value: string): boolean {
    return value.startsWith('terminal://') || value.startsWith('service://');
  }

  private resolveWorkspaceFilePath(value: string, workspaceRoot: string): string | null {
    if (!value || this.isRuntimePath(value)) return null;
    const clean = value.replace(/#L\d+(-\d+)?$/, '');
    const candidate = path.isAbsolute(clean) ? clean : path.resolve(workspaceRoot || process.cwd(), clean);
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        return null;
      }
      return candidate;
    } catch {
      return null;
    }
  }

  private readReferencedFile(filePath: string, displayPath: string, remainingBudget: number): ReferencedFileContext | null {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size <= 0 || remainingBudget <= 0) return null;
      const readBytes = Math.max(0, Math.min(MAX_REFERENCE_FILE_BYTES, remainingBudget, stat.size));
      if (readBytes === 0) return null;
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(readBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, readBytes, 0);
        const content = buffer.subarray(0, bytesRead).toString('utf8');
        return {
          path: filePath,
          displayPath,
          language: path.extname(filePath).replace('.', ''),
          content,
          truncated: stat.size > bytesRead,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  private runtimeContextForTag(tagPath: string, displayPath?: string): RuntimeContextBlock | null {
    if (tagPath.startsWith('terminal://')) {
      const key = tagPath.slice('terminal://'.length);
      const snapshot = this.terminalSnapshots.get(key);
      const terminal = vscode.window.terminals.find((item) => this.keyForTerminal(item) === key);
      const name = snapshot?.name || terminal?.name || displayPath || key;
      const chunks = [
        `Terminal: ${name}`,
        snapshot?.cwd ? `CWD: ${snapshot.cwd}` : '',
        snapshot?.commandLine ? `Last command: ${snapshot.commandLine}` : '',
        snapshot?.exitCode !== undefined ? `Exit code: ${snapshot.exitCode}` : '',
        snapshot?.output ? `Output:\n${this.tail(snapshot.output, MAX_RUNTIME_CONTEXT_CHARS)}` : 'Output is not available yet. VS Code only exposes terminal output captured after shell integration starts while this extension is active.',
      ].filter(Boolean);
      return {
        type: 'terminal',
        name,
        path: tagPath,
        content: chunks.join('\n'),
        captured: !!snapshot?.output,
      };
    }

    if (tagPath.startsWith('service://')) {
      const key = tagPath.slice('service://'.length);
      const task = this.activeTasks.get(key);
      const debugSession = this.debugSessions.get(key) || (vscode.debug.activeDebugSession && this.serviceKey(`Debug: ${vscode.debug.activeDebugSession.name}`) === key
        ? vscode.debug.activeDebugSession
        : undefined);
      const name = task?.task.name || debugSession?.name || displayPath || key;
      const details = task
        ? [
            `Service: ${task.task.name}`,
            `Source: ${task.task.source}`,
            `Scope: ${typeof task.task.scope === 'number' ? task.task.scope : task.task.scope?.name || 'workspace'}`,
            'Output is not available through the stable VS Code task API.',
          ]
        : debugSession
          ? [
              `Debug Session: ${debugSession.name}`,
              `Type: ${debugSession.type}`,
              `Workspace: ${debugSession.workspaceFolder?.uri.fsPath || ''}`,
              'Debug console output is not available through the stable VS Code API.',
            ]
          : [
              `Service: ${name}`,
              'The referenced service is not currently active or has no readable output through the stable VS Code API.',
            ];
      return {
        type: 'service',
        name,
        path: tagPath,
        content: details.filter(Boolean).join('\n'),
        captured: !!task || !!debugSession,
      };
    }

    return null;
  }

  private async captureTerminalExecution(event: vscode.TerminalShellExecutionStartEvent): Promise<void> {
    const key = this.keyForTerminal(event.terminal);
    const snapshot: TerminalSnapshot = {
      name: event.terminal.name,
      path: `terminal://${key}`,
      commandLine: event.execution.commandLine.value,
      cwd: event.execution.cwd?.fsPath,
      output: '',
      startedAt: Date.now(),
      captured: true,
    };
    this.terminalSnapshots.set(key, snapshot);

    try {
      for await (const chunk of event.execution.read()) {
        snapshot.output = this.tail(snapshot.output + chunk, MAX_TERMINAL_CAPTURE_CHARS);
      }
    } catch (error) {
      this.log.appendLine(`[BRIDGE] Terminal capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private serviceKey(name: string): string {
    return this.safeKey(name || 'Service');
  }

  private keyForTerminal(terminal: vscode.Terminal): string {
    const existing = this.terminalKeys.get(terminal);
    if (existing) return existing;
    const base = this.safeKey(terminal.name || 'Terminal');
    const count = (this.terminalKeyCounts.get(base) ?? 0) + 1;
    this.terminalKeyCounts.set(base, count);
    const key = count > 1 ? `${base}_${count}` : base;
    this.terminalKeys.set(terminal, key);
    return key;
  }

  private safeKey(value: string): string {
    const safe = value
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    return safe || 'runtime';
  }

  private tail(value: string, maxChars: number): string {
    return value.length <= maxChars ? value : value.slice(value.length - maxChars);
  }

  private mergeStringArrays(first: unknown, second: unknown): string[] {
    const merged = new Set<string>();
    for (const source of [first, second]) {
      if (!Array.isArray(source)) continue;
      for (const item of source) {
        if (typeof item === 'string' && item.trim()) {
          merged.add(item);
        }
      }
    }
    return Array.from(merged);
  }

  private mergeObjectArrays<T extends Record<string, any>>(first: unknown, second: unknown, key: keyof T): T[] {
    const merged = new Map<string, T>();
    for (const source of [first, second]) {
      if (!Array.isArray(source)) continue;
      for (const item of source) {
        if (!item || typeof item !== 'object') continue;
        const id = String((item as T)[key] ?? '');
        if (id && !merged.has(id)) {
          merged.set(id, item as T);
        }
      }
    }
    return Array.from(merged.values());
  }
}
