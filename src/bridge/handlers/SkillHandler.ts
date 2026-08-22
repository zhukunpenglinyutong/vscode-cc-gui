import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import * as vscode from 'vscode';
import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { parseJson, postJson } from './helpers';
import { ProviderStore } from '../services/ProviderStore';

type SkillScope = 'global' | 'local' | 'user' | 'repo';

interface SkillMetadata {
  name: string;
  description?: string;
  userInvocable?: boolean;
  skillPath?: string;
}

const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_CODEX_REPO_SCAN_LEVELS = 3;

export class SkillHandler implements BridgeHandler {
  readonly supportedEvents = [
    'get_all_skills',
    'import_skill',
    'delete_skill',
    'toggle_skill',
    'open_skill',
  ] as const;

  private readonly providerStore: ProviderStore;

  constructor(private readonly context: BridgeContext) {
    this.providerStore = new ProviderStore(context.extensionContext, {
      syncProviderToDisk: () => {},
    });
  }

  async handle({ event, content, webview }: BridgeMessage): Promise<boolean> {
    switch (event) {
      case 'get_all_skills':
        postJson(webview, 'update_skills', this.getAllSkills());
        return true;
      case 'import_skill':
        await this.importSkill(content, webview);
        return true;
      case 'delete_skill': {
        const result = this.deleteSkill(content);
        postJson(webview, 'skill_delete_result', result);
        postJson(webview, 'update_skills', this.getAllSkills());
        return true;
      }
      case 'toggle_skill': {
        const result = this.toggleSkill(content);
        postJson(webview, 'skill_toggle_result', result);
        postJson(webview, 'update_skills', this.getAllSkills());
        return true;
      }
      case 'open_skill': {
        const { path: skillPath } = parseJson<any>(content, {});
        if (skillPath) {
          const target = this.resolveOpenTarget(skillPath);
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
        }
        return true;
      }
      default:
        return false;
    }
  }

  private getAllSkills(): any {
    const workspacePath = this.context.getWorkspacePath();
    const globalEnabled = path.join(homedir(), '.claude', 'skills');
    const globalDisabled = path.join(homedir(), '.codemoss', 'skills', 'global');
    const localEnabled = workspacePath ? path.join(workspacePath, '.claude', 'skills') : '';
    const localDisabled = workspacePath ? path.join(homedir(), '.codemoss', 'skills', Buffer.from(workspacePath).toString('hex').slice(0, 16)) : '';
    return {
      global: {
        ...this.readSkillsFromDir(globalEnabled, 'global', true),
        ...this.readSkillsFromDir(globalDisabled, 'global', false),
      },
      local: {
        ...this.readSkillsFromDir(localEnabled, 'local', true),
        ...this.readSkillsFromDir(localDisabled, 'local', false),
      },
      ...this.getAllCodexSkills(workspacePath),
    };
  }

  private readSkillsFromDir(dir: string, scope: 'global' | 'local', enabled: boolean): Record<string, any> {
    const result: Record<string, any> = {};
    if (!dir || !fs.existsSync(dir)) return result;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      let name = entry.name;
      let type: 'file' | 'directory' = 'file';
      let mdPath = fullPath;
      if (entry.isDirectory()) {
        type = 'directory';
        mdPath = ['SKILL.md', 'skill.md', 'Skill.md'].map((file) => path.join(fullPath, file)).find((file) => fs.existsSync(file)) ?? '';
        if (!mdPath) continue;
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        name = entry.name.replace(/\.md$/, '');
      } else {
        continue;
      }
      let stat: fs.Stats | undefined;
      try { stat = fs.statSync(fullPath); } catch { /* ignore */ }
      const id = `${scope}-${name}${enabled ? '' : '-disabled'}`;
      result[id] = {
        id,
        name,
        type,
        scope,
        path: fullPath,
        enabled,
        description: this.extractDescription(mdPath),
        createdAt: stat?.birthtime?.toISOString(),
        modifiedAt: stat?.mtime?.toISOString(),
      };
    }
    return result;
  }

  private extractDescription(mdPath: string): string | undefined {
    try {
      const content = fs.readFileSync(mdPath, 'utf8');
      const inline = content.match(/^description:\s*(.+)$/m);
      if (inline) return inline[1].trim();
      return content.replace(/^---[\s\S]*?---\n?/, '').split('\n').map((line) => line.trim()).find(Boolean)?.replace(/^#+\s*/, '').slice(0, 200);
    } catch {
      return undefined;
    }
  }

  private async importSkill(content: string, webview: vscode.Webview): Promise<void> {
    const requestedScope = parseJson<any>(content, {}).scope as SkillScope;
    if (requestedScope === 'user' || requestedScope === 'repo') {
      await this.importCodexSkill(requestedScope, webview);
      return;
    }

    const scope = requestedScope === 'local' ? 'local' : 'global';
    const targetDir = scope === 'global'
      ? path.join(homedir(), '.claude', 'skills')
      : path.join(this.context.getWorkspacePath(), '.claude', 'skills');
    if (!targetDir) {
      postJson(webview, 'skill_import_result', { success: false, error: 'No workspace open' });
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      filters: { Markdown: ['md'] },
      title: 'Import Skill(s)',
    });
    if (!uris?.length) {
      postJson(webview, 'skill_import_result', { success: false, error: 'No file selected' });
      return;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    let count = 0;
    for (const uri of uris) {
      const dest = path.join(targetDir, path.basename(uri.fsPath));
      try {
        const stat = fs.statSync(uri.fsPath);
        if (stat.isDirectory()) {
          fs.cpSync(uri.fsPath, dest, { recursive: true });
        } else {
          fs.copyFileSync(uri.fsPath, dest);
        }
        count += 1;
      } catch { /* ignore */ }
    }
    postJson(webview, 'skill_import_result', { success: true, count, total: uris.length });
    postJson(webview, 'update_skills', this.getAllSkills());
  }

  private deleteSkill(content: string): Record<string, unknown> {
    const payload = parseJson<any>(content, {});
    if (payload.scope === 'user' || payload.scope === 'repo') {
      return this.deleteCodexSkill(payload);
    }

    const baseDir = this.skillBaseDir(payload.scope, payload.enabled);
    for (const candidate of [path.join(baseDir, `${payload.name}.md`), path.join(baseDir, payload.name)]) {
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) fs.rmSync(candidate, { recursive: true, force: true });
      else fs.unlinkSync(candidate);
      return { success: true, name: payload.name };
    }
    return { success: false, name: payload.name, error: 'Skill not found' };
  }

  private toggleSkill(content: string): Record<string, unknown> {
    const payload = parseJson<any>(content, {});
    if (payload.scope === 'user' || payload.scope === 'repo') {
      return this.toggleCodexSkill(payload);
    }

    const srcDir = this.skillBaseDir(payload.scope, payload.enabled);
    const dstDir = this.skillBaseDir(payload.scope, !payload.enabled);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const name of [`${payload.name}.md`, payload.name]) {
      const src = path.join(srcDir, name);
      if (!fs.existsSync(src)) continue;
      fs.renameSync(src, path.join(dstDir, name));
      return { success: true, name: payload.name, enabled: !payload.enabled };
    }
    return { success: false, name: payload.name, error: 'Skill not found' };
  }

  private skillBaseDir(scope: 'global' | 'local', enabled: boolean): string {
    const workspacePath = this.context.getWorkspacePath();
    if (enabled) {
      return scope === 'local' ? path.join(workspacePath, '.claude', 'skills') : path.join(homedir(), '.claude', 'skills');
    }
    return scope === 'local'
      ? path.join(homedir(), '.codemoss', 'skills', Buffer.from(workspacePath).toString('hex').slice(0, 16))
      : path.join(homedir(), '.codemoss', 'skills', 'global');
  }

  private getAllCodexSkills(workspacePath: string): { user: Record<string, any>; repo: Record<string, any> } {
    const disabled = this.readDisabledCodexSkillPaths();
    const result: { user: Record<string, any>; repo: Record<string, any> } = { user: {}, repo: {} };
    const seen = { user: new Set<string>(), repo: new Set<string>() };

    for (const scanDir of this.getCodexSkillScanDirs(workspacePath)) {
      const bucket = scanDir.scope === 'user' ? result.user : result.repo;
      const seenNames = scanDir.scope === 'user' ? seen.user : seen.repo;
      for (const [id, skill] of Object.entries(this.readCodexSkillsFromDir(scanDir.path, scanDir.scope, disabled))) {
        const entryName = path.basename(String(skill.path ?? id));
        if (seenNames.has(entryName)) continue;
        seenNames.add(entryName);
        bucket[id] = skill;
      }
    }

    return result;
  }

  private getCodexSkillScanDirs(workspacePath: string): Array<{ path: string; scope: 'user' | 'repo' }> {
    const dirs: Array<{ path: string; scope: 'user' | 'repo' }> = [];
    const seen = new Set<string>();
    const add = (dirPath: string, scope: 'user' | 'repo') => {
      if (!dirPath) return;
      const normalized = this.normalizePath(dirPath);
      if (!fs.existsSync(normalized) || seen.has(normalized)) return;
      seen.add(normalized);
      dirs.push({ path: normalized, scope });
    };

    if (workspacePath) {
      const repoRoot = this.findRepoRoot(workspacePath);
      let current = path.resolve(workspacePath);
      const fsRoot = path.parse(current).root;
      let level = 0;
      while (level < MAX_CODEX_REPO_SCAN_LEVELS && current && current !== fsRoot) {
        add(path.join(current, '.agents', 'skills'), 'repo');
        if (repoRoot && current === repoRoot) break;
        current = path.dirname(current);
        level += 1;
      }
      if (repoRoot) {
        add(path.join(repoRoot, '.agents', 'skills'), 'repo');
      }
    }

    add(path.join(homedir(), '.agents', 'skills'), 'user');
    if (this.isCodexLocalConfigAuthorized()) {
      add(path.join(homedir(), '.codex', 'skills'), 'user');
      add(path.join(homedir(), '.codex', 'skills', '.system'), 'user');
    }
    return dirs;
  }

  /**
   * Nested Codex skill discovery (v0.4.9): recursively finds skill packages under
   * collections/subdirs with safety bounds on depth, visited nodes, and count.
   * A directory containing SKILL.md is a skill package (scan stops there).
   */
  private readCodexSkillsFromDir(
    dir: string,
    scope: 'user' | 'repo',
    disabledSkillPaths: Set<string>,
  ): Record<string, any> {
    const result: Record<string, any> = {};
    const rootDir = path.resolve(dir);
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return result;
    }

    const MAX_DEPTH = 8;
    const MAX_NODES = 10_000;
    const MAX_SKILLS = 1_000;
    const SKIP_DIRS = new Set(['node_modules', 'build', 'target', 'dist', 'out', 'coverage']);

    let visited = 0;
    let limitReached = false;
    const skillDirs: string[] = [];

    const walk = (current: string, depth: number): void => {
      if (limitReached || depth > MAX_DEPTH) return;
      visited += 1;
      if (visited > MAX_NODES) {
        limitReached = true;
        return;
      }

      if (current !== rootDir) {
        const base = path.basename(current);
        if (base.startsWith('.') || SKIP_DIRS.has(base.toLowerCase())) {
          return;
        }
        // Skill package boundary: directory with SKILL.md — record and do not descend
        const skillMd = this.findSkillMarkdown(current, { noFollowSymlink: true });
        if (skillMd) {
          if (skillDirs.length >= MAX_SKILLS) {
            limitReached = true;
            return;
          }
          skillDirs.push(current);
          return;
        }
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (limitReached) break;
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(path.join(current, entry.name), depth + 1);
      }
    };

    walk(rootDir, 0);
    if (limitReached) {
      this.context.log.appendLine(`[SkillHandler] Codex skill scan limit reached under ${dir}`);
    }

    for (const skillDir of skillDirs) {
      const skillMd = this.findSkillMarkdown(skillDir, { noFollowSymlink: true });
      const metadata = this.readSkillMetadata(skillDir);
      const normalizedPath = this.normalizePath(skillDir);
      const skillPath = skillMd ? this.normalizePath(skillMd) : undefined;
      let stat: fs.Stats | undefined;
      try { stat = fs.statSync(skillDir); } catch { /* ignore */ }
      const id = `${scope}:${normalizedPath}`;
      result[id] = {
        id,
        name: metadata?.name || path.basename(skillDir),
        type: 'directory',
        scope,
        path: skillDir,
        enabled: skillPath ? !disabledSkillPaths.has(skillPath) : true,
        description: metadata?.description,
        userInvocable: metadata?.userInvocable,
        warning: metadata ? undefined : 'invalid_frontmatter',
        skillPath,
        createdAt: stat?.birthtime?.toISOString(),
        modifiedAt: stat?.mtime?.toISOString(),
      };
    }
    return result;
  }

  private async importCodexSkill(scope: 'user' | 'repo', webview: vscode.Webview): Promise<void> {
    const workspacePath = this.context.getWorkspacePath();
    const targetDir = scope === 'user'
      ? path.join(homedir(), '.agents', 'skills')
      : workspacePath ? path.join(workspacePath, '.agents', 'skills') : '';
    if (!targetDir) {
      postJson(webview, 'skill_import_result', { success: false, error: 'No workspace open' });
      return;
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      title: 'Import Codex Skill(s)',
    });
    if (!uris?.length) {
      postJson(webview, 'skill_import_result', { success: false, error: 'No folder selected' });
      return;
    }

    fs.mkdirSync(targetDir, { recursive: true });
    let count = 0;
    const errors: Array<{ path: string; error: string }> = [];
    for (const uri of uris) {
      const sourcePath = uri.fsPath;
      const name = path.basename(sourcePath);
      try {
        const stat = fs.statSync(sourcePath);
        if (!stat.isDirectory()) {
          errors.push({ path: sourcePath, error: 'Codex skill must be a directory containing SKILL.md' });
          continue;
        }
        if (!this.isSafeSkillName(name)) {
          errors.push({ path: sourcePath, error: `Invalid skill name: ${name}` });
          continue;
        }
        if (!this.findSkillMarkdown(sourcePath)) {
          errors.push({ path: sourcePath, error: 'Missing SKILL.md' });
          continue;
        }
        const dest = path.join(targetDir, name);
        if (!this.isPathInside(dest, targetDir)) {
          errors.push({ path: sourcePath, error: 'Target path escapes skills directory' });
          continue;
        }
        if (fs.existsSync(dest)) {
          errors.push({ path: sourcePath, error: `Skill already exists: ${name}` });
          continue;
        }
        fs.cpSync(sourcePath, dest, { recursive: true, dereference: false });
        count += 1;
      } catch (error) {
        errors.push({ path: sourcePath, error: error instanceof Error ? error.message : String(error) });
      }
    }

    postJson(webview, 'skill_import_result', { success: count > 0, count, total: uris.length, errors });
    postJson(webview, 'update_skills', this.getAllSkills());
  }

  private deleteCodexSkill(payload: any): Record<string, unknown> {
    const name = String(payload.name ?? '');
    const skillDir = this.resolveCodexSkillDir(payload);
    if (!skillDir) {
      return { success: false, name, error: 'Skill directory not found' };
    }
    if (!this.isPathInsideAny(skillDir, this.validCodexSkillBaseDirs())) {
      return { success: false, name, error: 'Skill directory is not inside a valid skills directory' };
    }

    const skillPath = this.findSkillMarkdown(skillDir);
    try {
      fs.rmSync(skillDir, { recursive: true, force: true });
      if (skillPath) {
        this.removeCodexSkillConfigEntry(skillPath);
      }
      return { success: true, name };
    } catch (error) {
      return { success: false, name, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private toggleCodexSkill(payload: any): Record<string, unknown> {
    const name = String(payload.name ?? '');
    const currentEnabled = payload.enabled === true;
    const skillPath = typeof payload.skillPath === 'string'
      ? payload.skillPath
      : this.resolveCodexSkillDir(payload)
        ? this.findSkillMarkdown(this.resolveCodexSkillDir(payload)!)
        : '';

    if (!skillPath) {
      return { success: false, name, error: 'Skill path is required for toggle operation' };
    }
    if (!this.isCodexLocalConfigAuthorized()) {
      return { success: false, name, error: 'Codex local config access is not authorized' };
    }
    if (!this.isSkillMarkdownPath(skillPath)) {
      return { success: false, name, error: 'Skill path must point to a SKILL.md file' };
    }
    if (!this.isPathInsideAny(path.dirname(skillPath), this.validCodexSkillBaseDirs())) {
      return { success: false, name, error: 'Skill path is not inside a valid skills directory' };
    }

    try {
      if (currentEnabled) {
        this.disableCodexSkill(skillPath);
      } else {
        this.removeCodexSkillConfigEntry(skillPath);
      }
      return { success: true, name, enabled: !currentEnabled };
    } catch (error) {
      return { success: false, name, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private resolveCodexSkillDir(payload: any): string | null {
    if (typeof payload.skillPath === 'string' && this.isSkillMarkdownPath(payload.skillPath)) {
      return path.dirname(payload.skillPath);
    }
    const name = String(payload.name ?? '');
    if (!this.isSafeSkillName(name)) return null;
    const scope = payload.scope === 'repo' ? 'repo' : 'user';
    const base = scope === 'repo'
      ? path.join(this.context.getWorkspacePath(), '.agents', 'skills')
      : path.join(homedir(), '.agents', 'skills');
    const candidate = path.join(base, name);
    return fs.existsSync(candidate) ? candidate : null;
  }

  private readDisabledCodexSkillPaths(): Set<string> {
    const disabled = new Set<string>();
    if (!this.isCodexLocalConfigAuthorized()) return disabled;
    const configPath = this.codexConfigTomlPath();
    if (!fs.existsSync(configPath)) return disabled;

    const content = fs.readFileSync(configPath, 'utf8');
    for (const block of this.codexSkillConfigBlocks(content)) {
      const skillPath = this.extractTomlString(block.text, 'path');
      const enabled = this.extractTomlBoolean(block.text, 'enabled');
      if (skillPath && enabled === false) {
        disabled.add(this.normalizePath(skillPath));
      }
    }
    return disabled;
  }

  private disableCodexSkill(skillPath: string): void {
    const configPath = this.codexConfigTomlPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const normalizedSkillPath = this.normalizePath(skillPath);
    const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const withoutExisting = this.removeCodexSkillConfigBlock(content, normalizedSkillPath);
    const next = `${withoutExisting.trimEnd()}\n\n[[skills.config]]\npath = "${this.escapeTomlString(normalizedSkillPath)}"\nenabled = false\n`;
    fs.writeFileSync(configPath, next.trimStart(), 'utf8');
  }

  private removeCodexSkillConfigEntry(skillPath: string): void {
    const configPath = this.codexConfigTomlPath();
    if (!fs.existsSync(configPath)) return;
    const content = fs.readFileSync(configPath, 'utf8');
    const next = this.removeCodexSkillConfigBlock(content, this.normalizePath(skillPath));
    fs.writeFileSync(configPath, next.trim() ? `${next.trimEnd()}\n` : '', 'utf8');
  }

  private removeCodexSkillConfigBlock(content: string, normalizedSkillPath: string): string {
    const blocks = this.codexSkillConfigBlocks(content);
    let result = '';
    let lastIndex = 0;
    for (const block of blocks) {
      result += content.slice(lastIndex, block.start);
      const blockPath = this.extractTomlString(block.text, 'path');
      if (!blockPath || this.normalizePath(blockPath) !== normalizedSkillPath) {
        result += block.text;
      }
      lastIndex = block.end;
    }
    result += content.slice(lastIndex);
    return result.replace(/\n{3,}/g, '\n\n');
  }

  private codexSkillConfigBlocks(content: string): Array<{ text: string; start: number; end: number }> {
    const blocks: Array<{ text: string; start: number; end: number }> = [];
    const regex = /(^|\n)\[\[skills\.config\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      blocks.push({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    return blocks;
  }

  private extractTomlString(block: string, key: string): string | null {
    const match = block.match(new RegExp(`^\\s*${key}\\s*=\\s*(['"])(.*?)\\1\\s*$`, 'm'));
    return match ? match[2] : null;
  }

  private extractTomlBoolean(block: string, key: string): boolean | null {
    const match = block.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, 'm'));
    return match ? match[1] === 'true' : null;
  }

  private escapeTomlString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private codexConfigTomlPath(): string {
    return path.join(homedir(), '.codex', 'config.toml');
  }

  private isCodexLocalConfigAuthorized(): boolean {
    return this.providerStore.isCodexLocalConfigAuthorized();
  }

  private validCodexSkillBaseDirs(): string[] {
    const workspacePath = this.context.getWorkspacePath();
    const dirs = [
      path.join(homedir(), '.agents', 'skills'),
      path.join(homedir(), '.codex', 'skills'),
      path.join(homedir(), '.codex', 'skills', '.system'),
      workspacePath ? path.join(workspacePath, '.agents', 'skills') : '',
      ...this.getCodexSkillScanDirs(workspacePath).map((item) => item.path),
    ].filter(Boolean);
    return Array.from(new Set(dirs.map((dir) => this.normalizePath(dir))));
  }

  private findRepoRoot(cwd: string): string | null {
    let current = path.resolve(cwd);
    const fsRoot = path.parse(current).root;
    while (current && current !== fsRoot) {
      if (fs.existsSync(path.join(current, '.git'))) return current;
      current = path.dirname(current);
    }
    return null;
  }

  private readSkillMetadata(skillDir: string): SkillMetadata | null {
    const skillMd = this.findSkillMarkdown(skillDir);
    if (!skillMd) return null;
    try {
      const content = fs.readFileSync(skillMd, 'utf8');
      const frontmatter = this.extractFrontmatter(content);
      return {
        name: this.frontmatterString(frontmatter, 'name') || path.basename(skillDir),
        description: this.frontmatterString(frontmatter, 'description') || this.extractDescription(skillMd),
        userInvocable: this.frontmatterString(frontmatter, 'userInvocable') !== 'false',
        skillPath: skillMd,
      };
    } catch {
      return null;
    }
  }

  private extractFrontmatter(content: string): string {
    if (!content.startsWith('---')) return '';
    const end = content.indexOf('\n---', 3);
    return end === -1 ? '' : content.slice(3, end);
  }

  private frontmatterString(frontmatter: string, key: string): string | null {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
  }

  private findSkillMarkdown(
    skillDir: string,
    options?: { noFollowSymlink?: boolean },
  ): string | null {
    for (const name of ['SKILL.md', 'skill.md', 'Skill.md']) {
      const candidate = path.join(skillDir, name);
      try {
        if (options?.noFollowSymlink) {
          // Do not follow symlink SKILL.md (v0.4.9 nested-scan safety).
          const st = fs.lstatSync(candidate);
          if (st.isFile() && !st.isSymbolicLink()) return candidate;
        } else if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // missing entry
      }
    }
    return null;
  }

  private resolveOpenTarget(skillPath: string): string {
    try {
      if (fs.statSync(skillPath).isDirectory()) {
        return this.findSkillMarkdown(skillPath) ?? skillPath;
      }
    } catch {
      // Fall back to the requested target.
    }
    return skillPath;
  }

  private isSkillMarkdownPath(filePath: string): boolean {
    const lower = path.basename(filePath).toLowerCase();
    return lower === 'skill.md';
  }

  private isSafeSkillName(name: string): boolean {
    return SAFE_SKILL_NAME.test(name) && !name.includes('..') && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
  }

  private isPathInside(child: string, parent: string): boolean {
    const normalizedChild = this.normalizePath(child);
    const normalizedParent = this.normalizePath(parent);
    return normalizedChild !== normalizedParent && normalizedChild.startsWith(normalizedParent + path.sep);
  }

  private isPathInsideAny(child: string, parents: string[]): boolean {
    return parents.some((parent) => this.isPathInside(child, parent));
  }

  private normalizePath(filePath: string): string {
    return path.resolve(filePath);
  }
}
