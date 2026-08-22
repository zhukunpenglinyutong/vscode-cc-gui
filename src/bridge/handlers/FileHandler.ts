import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { callWindowFunction, parseJson, postJson } from './helpers';

export class FileHandler implements BridgeHandler {
  readonly supportedEvents = [
    'open_file',
    'open_browser',
    'save_json',
    'save_markdown',
    'refresh_file',
    'get_workspace_path',
    'list_files',
    'resolve_file_path',
    'resolve_drop_paths',
    'get_linkify_capabilities',
    'open_class',
  ] as const;

  constructor(private readonly context: BridgeContext) {}

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'open_file':
        await this.openFile(content);
        return true;
      case 'open_browser':
        await vscode.env.openExternal(vscode.Uri.parse(content));
        return true;
      case 'save_json':
        await this.saveFile(content, 'json', webview);
        return true;
      case 'save_markdown':
        await this.saveFile(content, 'md', webview);
        return true;
      case 'refresh_file':
        await this.refreshFile(content);
        return true;
      case 'get_workspace_path':
        postJson(webview, 'workspace_path', this.context.getWorkspacePath());
        return true;
      case 'list_files':
        postJson(webview, 'file_list_result', await this.listFiles(content));
        return true;
      case 'resolve_file_path':
        callWindowFunction(webview, 'onFilePathResolved', {
          path: content,
          resolvedPath: this.resolveDisplayPath(content),
        });
        return true;
      case 'resolve_drop_paths': {
        const payload = parseJson<{
          requestId?: string;
          uris?: string[];
          names?: string[];
          texts?: string[];
          absolutePaths?: string[];
        }>(content, {});
        const paths = await this.resolveDropPaths(payload);
        callWindowFunction(webview, 'onDropPathsResolved', {
          requestId: payload.requestId ?? '',
          paths,
        });
        return true;
      }
      case 'get_linkify_capabilities':
        callWindowFunction(webview, 'updateLinkifyCapabilities', {
          openFile: true,
          openClass: true,
          resolveFilePath: true,
        });
        return true;
      case 'open_class':
        await this.openClass(content);
        return true;
      default:
        return false;
    }
  }

  private async openFile(pathWithLine: string): Promise<void> {
    const parsed = parseJson<any>(pathWithLine, null);
    const rawPath = parsed?.filePath ?? parsed?.path ?? pathWithLine;
    const line = parsed?.line ?? this.extractLine(rawPath);
    const filePath = String(rawPath).replace(/#L\d+(-\d+)?$/, '').split(':')[0];
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (line) {
      const pos = new vscode.Position(Math.max(0, Number(line) - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async refreshFile(content: string): Promise<void> {
    const data = parseJson<any>(content, { filePath: content });
    const filePath = data.filePath ?? content;
    const doc = vscode.workspace.textDocuments.find((item) => item.uri.fsPath === filePath);
    if (doc) {
      await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
    }
  }

  private async saveFile(content: string, extension: 'json' | 'md', webview: vscode.Webview): Promise<void> {
    try {
      const payload = parseJson<any>(content, {});
      const fileContent = String(payload.content ?? '');
      const baseName = String(payload.filename ?? `export.${extension}`);
      const filename = baseName.toLowerCase().endsWith(`.${extension}`) ? baseName : `${baseName}.${extension}`;
      const uri = await vscode.window.showSaveDialog({
        title: extension === 'json' ? 'Save JSON' : 'Save Markdown',
        filters: extension === 'json' ? { JSON: ['json'] } : { Markdown: ['md', 'markdown'] },
        defaultUri: vscode.Uri.file(path.join(this.context.getWorkspacePath() || process.cwd(), filename)),
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(fileContent, 'utf8'));
      this.addToast(webview, 'File saved', 'success');
    } catch (error) {
      this.addToast(webview, error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private addToast(webview: vscode.Webview, message: string, type: 'success' | 'error'): void {
    webview.postMessage({
      type: 'js_eval',
      content: `window.addToast && window.addToast(${JSON.stringify(message)}, ${JSON.stringify(type)})`,
    });
  }

  private async listFiles(content: string): Promise<{ files: any[]; root: string }> {
    const workspacePath = this.context.getWorkspacePath();
    const root = workspacePath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const params = parseJson<any>(content, {});
    const query = String(params.query ?? '').toLowerCase();
    const files: any[] = this.context.callbacks.listRuntimeContextItems(query);
    if (!root || !fs.existsSync(root)) {
      this.context.log.appendLine(`[FILE] list_files skipped: missing root query="${query}" currentPath="${String(params.currentPath ?? '')}"`);
      return { files, root };
    }

    const scanRoot = this.resolveScanRoot(root, params.currentPath);
    const basePrefix = path.relative(root, scanRoot).replace(/\\/g, '/');
    const ignore = this.buildIgnoreFilter(root);
    const max = 2000;
    const seen = new Set(files.map((item) => String(item.path ?? item.absolutePath ?? '')));

    this.context.log.appendLine(
      `[FILE] list_files root="${root}" scanRoot="${scanRoot}" query="${query}" currentPath="${String(params.currentPath ?? '')}"`,
    );

    const pushFileItem = (item: any): void => {
      const key = String(item.path ?? item.absolutePath ?? '');
      if (!key || seen.has(key) || files.length >= max) {
        return;
      }
      seen.add(key);
      files.push(item);
    };

    const addDirectoryEntries = (dir: string, rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= max) return;
        if (entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const isDir = entry.isDirectory();
        if (ignore(relPath, isDir)) continue;
        if (query && !relPath.toLowerCase().includes(query) && !entry.name.toLowerCase().includes(query)) continue;
        pushFileItem({
          name: entry.name,
          path: relPath,
          absolutePath: full,
          type: isDir ? 'directory' : 'file',
          extension: isDir ? '' : path.extname(entry.name).replace('.', ''),
        });
      }
    };

    addDirectoryEntries(scanRoot, basePrefix);

    const relativeRoot = basePrefix ? `${basePrefix}/` : '';
    const includeGlob = query
      ? new vscode.RelativePattern(root, `${relativeRoot}**/*${this.escapeGlobFragment(query)}*`)
      : new vscode.RelativePattern(scanRoot, '**/*');

    try {
      const found = await vscode.workspace.findFiles(includeGlob, this.buildFindFilesExcludeGlob(root), Math.max(0, max - files.length));
      for (const uri of found) {
        if (files.length >= max) break;
        const full = uri.fsPath;
        const relPath = path.relative(root, full).replace(/\\/g, '/');
        if (!relPath) {
          continue;
        }
        if (ignore(relPath, false)) continue;
        pushFileItem({
          name: path.basename(full),
          path: relPath,
          absolutePath: full,
          type: 'file',
          extension: path.extname(full).replace('.', ''),
        });
      }
    } catch (error) {
      this.context.log.appendLine(`[FILE] list_files findFiles failed: ${error instanceof Error ? error.message : String(error)}`);
    };

    files.sort((left, right) => {
      const typeOrder = (item: any) => item.type === 'directory' ? 0 : 1;
      return typeOrder(left) - typeOrder(right)
        || String(left.path ?? '').localeCompare(String(right.path ?? ''));
    });

    this.context.log.appendLine(`[FILE] list_files result count=${files.length}`);
    return { files, root };
  }

  private resolveScanRoot(root: string, requestedPath: unknown): string {
    const requested = String(requestedPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!requested) return root;
    const candidate = path.resolve(root, requested);
    const normalizedRoot = path.resolve(root);
    if ((candidate === normalizedRoot || candidate.startsWith(normalizedRoot + path.sep)) && fs.existsSync(candidate)) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        return root;
      }
    }
    return root;
  }

  private resolveDisplayPath(filePath: string): string | null {
    const workspacePath = this.context.getWorkspacePath();
    if (!filePath) return null;
    if (workspacePath && filePath.startsWith(workspacePath)) {
      return path.relative(workspacePath, filePath).replace(/\\/g, '/');
    }
    return filePath;
  }

  /**
   * Resolve drag-drop candidates to absolute OS paths.
   * Uses vscode.Uri.fsPath so Mac (`/Users/...`) and Windows (`C:\...`) stay correct.
   */
  private async resolveDropPaths(payload: {
    uris?: string[];
    names?: string[];
    texts?: string[];
    absolutePaths?: string[];
  }): Promise<string[]> {
    const out: string[] = [];
    const push = (value: string | undefined | null) => {
      const p = String(value ?? '').trim();
      if (!p) return;
      // Prefer native separators from path.normalize
      const normalized = path.normalize(p);
      if (!out.includes(normalized)) out.push(normalized);
    };

    for (const uri of payload.uris ?? []) {
      const fsPath = this.uriStringToFsPath(uri);
      if (fsPath) push(fsPath);
    }

    for (const abs of payload.absolutePaths ?? []) {
      const fsPath = this.uriStringToFsPath(abs) ?? abs;
      if (path.isAbsolute(fsPath) || /^[A-Za-z]:[\\/]/.test(fsPath)) {
        push(fsPath);
      }
    }

    for (const text of payload.texts ?? []) {
      const t = String(text ?? '').trim();
      if (!t) continue;
      if (t.startsWith('file:') || t.includes('://')) {
        const fsPath = this.uriStringToFsPath(t);
        if (fsPath) push(fsPath);
        continue;
      }
      if (path.isAbsolute(t) || /^[A-Za-z]:[\\/]/.test(t)) {
        push(t);
        continue;
      }
      // Relative path under workspace
      const workspacePath = this.context.getWorkspacePath();
      if (workspacePath) {
        const candidate = path.resolve(workspacePath, t);
        if (fs.existsSync(candidate)) {
          push(candidate);
          continue;
        }
      }
      // Fall through as bare-ish name for findFiles
      const base = path.basename(t);
      if (base) {
        const found = await this.findWorkspacePathByName(base);
        if (found) push(found);
      }
    }

    for (const name of payload.names ?? []) {
      const n = String(name ?? '').trim();
      if (!n) continue;
      if (path.isAbsolute(n) || /^[A-Za-z]:[\\/]/.test(n) || n.startsWith('file:')) {
        const fsPath = this.uriStringToFsPath(n) ?? n;
        push(fsPath);
        continue;
      }
      const found = await this.findWorkspacePathByName(n);
      if (found) {
        push(found);
      } else {
        // Last resort: workspace-relative join (may not exist — still better than bare name alone)
        const workspacePath = this.context.getWorkspacePath();
        if (workspacePath) {
          push(path.join(workspacePath, n));
        }
      }
    }

    this.context.log.appendLine(
      `[FILE] resolve_drop_paths in uris=${(payload.uris ?? []).length} names=${(payload.names ?? []).length} ` +
        `texts=${(payload.texts ?? []).length} abs=${(payload.absolutePaths ?? []).length} → ${out.length} path(s)`,
    );
    return out;
  }

  private uriStringToFsPath(value: string): string | null {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    try {
      if (raw.startsWith('file:') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
        const uri = vscode.Uri.parse(raw);
        if (uri.scheme === 'file') return uri.fsPath;
        // vscode-remote / other schemes: still surface fsPath when available
        if (uri.fsPath) return uri.fsPath;
      }
    } catch {
      // fall through
    }
    if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
      return raw;
    }
    return null;
  }

  private async findWorkspacePathByName(fileName: string): Promise<string | null> {
    const base = path.basename(fileName);
    if (!base || base === '.' || base === '..') return null;
    const workspacePath = this.context.getWorkspacePath();
    if (!workspacePath) return null;

    // Exact path under workspace root
    const direct = path.join(workspacePath, base);
    if (fs.existsSync(direct)) return direct;

    try {
      // Escape glob special chars in the file name
      const escaped = base.replace(/([{}[\]*?\\])/g, '[$1]');
      const found = await vscode.workspace.findFiles(
        `**/${escaped}`,
        '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}',
        10,
      );
      if (found.length === 0) return null;
      if (found.length === 1) return found[0].fsPath;

      // Prefer shortest path under workspace (closest match)
      found.sort((a, b) => a.fsPath.length - b.fsPath.length);
      return found[0].fsPath;
    } catch (error) {
      this.context.log.appendLine(
        `[FILE] findWorkspacePathByName failed name="${base}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async openClass(content: string): Promise<void> {
    const payload = parseJson<any>(content, {});
    const query = String(payload.className ?? payload.name ?? content).trim();
    if (!query) return;
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
    const target = symbols?.[0];
    if (target?.location?.uri) {
      await vscode.window.showTextDocument(target.location.uri, { selection: target.location.range });
    }
  }

  private extractLine(filePath: string): number | undefined {
    const hash = filePath.match(/#L(\d+)/);
    if (hash) return Number(hash[1]);
    const colon = filePath.match(/:(\d+)$/);
    return colon ? Number(colon[1]) : undefined;
  }

  private buildIgnoreFilter(root: string): (relPath: string, isDir: boolean) => boolean {
    const defaults = new Set(['node_modules', 'dist', 'out', 'build', '.cache', '.next', '.nuxt']);
    const gitignore = path.join(root, '.gitignore');
    const patterns: string[] = [];
    try {
      if (fs.existsSync(gitignore)) {
        patterns.push(...fs.readFileSync(gitignore, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
      }
    } catch { /* ignore */ }
    return (relPath, isDir) => {
      const parts = relPath.split('/');
      if (parts.some((part) => defaults.has(part))) return true;
      if (!patterns.length) return false;
      return patterns.some((pattern) => {
        const clean = pattern.replace(/\/$/, '');
        if (!clean) return false;
        if (pattern.endsWith('/') && !isDir) return false;
        return relPath === clean || relPath.startsWith(`${clean}/`) || parts.includes(clean);
      });
    };
  }

  private buildFindFilesExcludeGlob(root: string): string {
    const defaults = ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**', '**/.cache/**', '**/.next/**', '**/.nuxt/**'];
    const gitignore = path.join(root, '.gitignore');
    const patterns: string[] = [];
    try {
      if (fs.existsSync(gitignore)) {
        patterns.push(
          ...fs.readFileSync(gitignore, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
            .map((line) => line.replace(/\/+$/g, ''))
            .map((line) => line.includes('*') ? `**/${line}` : `**/${line}/**`),
        );
      }
    } catch {
      // Ignore .gitignore parse failures; defaults still apply.
    }
    return `{${[...defaults, ...patterns].join(',')}}`;
  }

  private escapeGlobFragment(value: string): string {
    return value.replace(/([{}[\]*?\\])/g, '[$1]');
  }
}
