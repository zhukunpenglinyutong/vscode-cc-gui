import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface SlashCommand {
  name: string;
  description: string;
  source: string;
}

const CLAUDE_BUILTIN_COMMANDS: SlashCommand[] = [
  { name: '/compact', description: 'Summarize conversation to free context', source: 'builtin' },
  { name: '/context', description: 'Visualize current context usage as a colored grid', source: 'builtin' },
  { name: '/goal', description: 'Keep working across turns until the goal condition is met', source: 'builtin' },
  { name: '/init', description: 'Initialize a new CLAUDE.md file with codebase documentation', source: 'builtin' },
  { name: '/plan', description: 'Switch to plan mode', source: 'builtin' },
  { name: '/resume', description: 'Resume a previous conversation', source: 'builtin' },
  { name: '/review', description: 'Review a pull request', source: 'builtin' },
  { name: '/batch', description: 'Execute large-scale changes in parallel across isolated worktrees', source: 'bundled' },
  { name: '/claude-api', description: 'Build apps with the Claude API or Anthropic SDK', source: 'bundled' },
  { name: '/debug', description: 'Enable debug logging and diagnose session issues', source: 'bundled' },
  { name: '/loop', description: 'Run a prompt or command on a recurring interval', source: 'bundled' },
  { name: '/simplify', description: 'Review changed code for reuse, quality, and efficiency', source: 'bundled' },
  { name: '/update-config', description: 'Configure settings.json (hooks, permissions, env vars)', source: 'bundled' },
];

const CODEX_BUILTIN_COMMANDS: SlashCommand[] = [
  { name: '/compact', description: 'Summarize conversation to free tokens', source: 'builtin' },
  { name: '/diff', description: 'Show pending changes diff including untracked files', source: 'builtin' },
  { name: '/init', description: 'Generate an AGENTS.md scaffold', source: 'builtin' },
  { name: '/plan', description: 'Switch to plan mode', source: 'builtin' },
  { name: '/review', description: 'Review working tree changes', source: 'builtin' },
];

const CLAUDE_CLI_BUILTINS = new Set([
  ...CLAUDE_BUILTIN_COMMANDS.map((command) => command.name),
  '/bug',
  '/clear',
  '/config',
  '/cost',
  '/doctor',
  '/help',
  '/login',
  '/logout',
  '/memory',
  '/model',
  '/pr-comments',
  '/status',
  '/terminal',
  '/vim',
]);

const MAX_COMMAND_SCAN_DEPTH = 10;
const MAX_CODEX_REPO_SCAN_LEVELS = 3;

export class SlashCommandService {
  constructor(
    private readonly getWorkspacePath: () => string,
    private readonly getActiveProvider: () => 'claude' | 'codex',
    private readonly log: vscode.OutputChannel,
    private readonly isCodexLocalConfigAuthorized: () => boolean = () => false,
  ) {}

  refresh(webview: vscode.Webview): void {
    const provider = this.getActiveProvider();
    const workspacePath = this.getWorkspacePath();
    const activeFile = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : '';
    const commands = this.getCommands(provider, workspacePath, activeFile);

    webview.postMessage({ type: 'update_slash_commands', content: JSON.stringify(commands) });

    if (provider === 'codex') {
      const codexSkills = this.getCodexSkills(workspacePath);
      webview.postMessage({ type: 'update_dollar_commands', content: JSON.stringify(codexSkills) });
      this.log.appendLine(`[BRIDGE] Slash commands refreshed: ${commands.length}; Codex skills: ${codexSkills.length}`);
    } else {
      webview.postMessage({ type: 'update_dollar_commands', content: JSON.stringify([]) });
      this.log.appendLine(`[BRIDGE] Slash commands refreshed: ${commands.length}`);
    }
  }

  expandSkillCommand(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    const commandName = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const userArgs = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    if (CLAUDE_CLI_BUILTINS.has(commandName)) return null;

    for (const dir of this.getSkillsScanDirs(this.getWorkspacePath())) {
      const skillDir = path.join(dir, commandName.slice(1));
      const skillMd = this.findSkillMarkdown(skillDir);
      if (!skillMd) continue;

      try {
        const body = this.expandMarkdownBody(fs.readFileSync(skillMd, 'utf8'), userArgs);
        this.log.appendLine(`[BRIDGE] Skill expanded: ${commandName} -> ${body.length} chars`);
        return body;
      } catch {
        // Try the next scan directory.
      }
    }

    return null;
  }

  private getCommands(provider: 'claude' | 'codex', cwd: string, currentFilePath: string): SlashCommand[] {
    if (provider === 'codex') {
      return this.mergeCommands(
        CODEX_BUILTIN_COMMANDS,
        this.scanCodexPromptsAsCommands(),
      );
    }

    const commandDirs = this.getCommandScanDirs(cwd);
    const skillDirs = this.getSkillsScanDirs(cwd);
    const commands = this.mergeCommands(
      CLAUDE_BUILTIN_COMMANDS,
      ...commandDirs.map((dir) => this.scanCommandsAsCommands(dir, 'local')),
      ...skillDirs.map((dir) => this.scanSkillsAsCommands(dir, 'local', currentFilePath)),
    );
    return commands;
  }

  private getCommandScanDirs(cwd: string): string[] {
    return this.unique([
      ...this.walkWorkspaceAncestors(cwd).map((dir) => path.join(dir, '.claude', 'commands')),
      path.join(os.homedir(), '.claude', 'commands'),
    ]).filter((dir) => fs.existsSync(dir));
  }

  private getSkillsScanDirs(cwd: string): string[] {
    return this.unique([
      ...this.walkWorkspaceAncestors(cwd).map((dir) => path.join(dir, '.claude', 'skills')),
      path.join(os.homedir(), '.claude', 'skills'),
    ]).filter((dir) => fs.existsSync(dir));
  }

  private walkWorkspaceAncestors(cwd: string): string[] {
    const dirs: string[] = [];
    const home = path.resolve(os.homedir());
    let current = path.resolve(cwd || this.getWorkspacePath() || home);
    while (current && !dirs.includes(current)) {
      dirs.push(current);
      if (current === home || path.dirname(current) === current) {
        break;
      }
      current = path.dirname(current);
    }
    return dirs;
  }

  private scanCommandsAsCommands(dir: string, source: string): SlashCommand[] {
    const commands: SlashCommand[] = [];
    if (!fs.existsSync(dir)) return commands;
    this.scanCommandsRecursive(dir, dir, source, commands, 0);
    return commands;
  }

  private scanCommandsRecursive(
    dir: string,
    baseDir: string,
    source: string,
    commands: SlashCommand[],
    depth: number,
  ): void {
    if (depth > MAX_COMMAND_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasSkillMd = entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const namespace = this.commandNamespace(fullPath, baseDir);
        const baseName = entry.name.replace(/\.md$/i, '');
        const name = namespace ? `/${namespace}:${baseName}` : `/${baseName}`;
        commands.push({
          name,
          description: this.extractCommandDescription(fullPath),
          source,
        });
      } else if (entry.isDirectory() && !hasSkillMd) {
        this.scanCommandsRecursive(fullPath, baseDir, source, commands, depth + 1);
      }
    }
  }

  private scanSkillsAsCommands(
    dir: string,
    source: string,
    currentFilePath: string,
    prefix = '/',
    disabledSkillPaths = new Set<string>(),
  ): SlashCommand[] {
    const commands: SlashCommand[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return commands;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skillDir = path.join(dir, entry.name);
      const skillMd = this.findSkillMarkdown(skillDir);
      if (!skillMd) continue;
      if (disabledSkillPaths.has(path.resolve(skillMd))) continue;
      const metadata = this.parseSkillMetadata(skillMd);
      if (!metadata) continue;
      if (metadata.userInvocable === false) continue;
      if (!this.matchesAllowedTools(metadata.allowedTools, currentFilePath)) continue;
      commands.push({
        name: `${prefix}${metadata.name || entry.name}`,
        description: metadata.description || '',
        source,
      });
    }
    return commands;
  }

  private getCodexSkills(cwd: string): SlashCommand[] {
    const disabledSkillPaths = this.readDisabledCodexSkillPaths();
    const commands: SlashCommand[] = [];
    for (const dir of this.getCodexSkillScanDirs(cwd)) {
      commands.push(...this.scanSkillsAsCommands(dir, 'codex-skill', '', '$', disabledSkillPaths));
    }
    return this.mergeCommands(commands);
  }

  private getCodexSkillScanDirs(cwd: string): string[] {
    const dirs: string[] = [];
    const seen = new Set<string>();
    const add = (dirPath: string) => {
      if (!dirPath) return;
      const normalized = path.resolve(dirPath);
      if (!fs.existsSync(normalized) || seen.has(normalized)) return;
      seen.add(normalized);
      dirs.push(normalized);
    };

    if (cwd) {
      const repoRoot = this.findRepoRoot(cwd);
      let current = path.resolve(cwd);
      const fsRoot = path.parse(current).root;
      let level = 0;
      while (level < MAX_CODEX_REPO_SCAN_LEVELS && current && current !== fsRoot) {
        add(path.join(current, '.agents', 'skills'));
        if (repoRoot && current === repoRoot) break;
        current = path.dirname(current);
        level += 1;
      }
      if (repoRoot) {
        add(path.join(repoRoot, '.agents', 'skills'));
      }
    }

    add(path.join(os.homedir(), '.agents', 'skills'));
    if (this.isCodexLocalConfigAuthorized()) {
      add(path.join(os.homedir(), '.codex', 'skills'));
      add(path.join(os.homedir(), '.codex', 'skills', '.system'));
    }
    return dirs;
  }

  private readDisabledCodexSkillPaths(): Set<string> {
    const disabled = new Set<string>();
    if (!this.isCodexLocalConfigAuthorized()) return disabled;
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (!fs.existsSync(configPath)) return disabled;
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const blockRegex = /(^|\n)\[\[skills\.config\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g;
      let match: RegExpExecArray | null;
      while ((match = blockRegex.exec(content)) !== null) {
        const pathMatch = match[0].match(/^\s*path\s*=\s*(['"])(.*?)\1\s*$/m);
        const enabledMatch = match[0].match(/^\s*enabled\s*=\s*(true|false)\s*$/m);
        if (pathMatch && enabledMatch?.[1] === 'false') {
          disabled.add(path.resolve(pathMatch[2]));
        }
      }
    } catch {
      // Treat unreadable config as no disabled skills; the UI already exposes authorization state.
    }
    return disabled;
  }

  private scanCodexPromptsAsCommands(): SlashCommand[] {
    const dir = path.join(os.homedir(), '.codex', 'prompts');
    if (!fs.existsSync(dir)) return [];
    return this.scanCommandsAsCommands(dir, 'user');
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

  private findSkillMarkdown(skillDir: string): string | null {
    for (const name of ['SKILL.md', 'skill.md', 'Skill.md']) {
      const candidate = path.join(skillDir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private parseSkillMetadata(filePath: string): {
    name: string;
    description: string;
    userInvocable: boolean;
    allowedTools: string[];
  } | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const frontmatter = this.extractFrontmatter(raw);
      const name = this.frontmatterString(frontmatter, 'name') || path.basename(path.dirname(filePath));
      const description = this.frontmatterString(frontmatter, 'description') || this.firstBodyLine(raw);
      const userInvocableValue = this.frontmatterString(frontmatter, 'userInvocable');
      const allowedTools = this.frontmatterList(frontmatter, 'allowed-tools')
        || this.frontmatterList(frontmatter, 'allowedTools')
        || [];
      return {
        name,
        description,
        userInvocable: userInvocableValue == null ? true : userInvocableValue !== 'false',
        allowedTools,
      };
    } catch {
      return null;
    }
  }

  private expandMarkdownBody(raw: string, userArgs: string): string {
    let body = raw;
    if (raw.startsWith('---')) {
      const endFrontmatter = raw.indexOf('\n---', 3);
      if (endFrontmatter !== -1) {
        body = raw.slice(endFrontmatter + 4).trimStart();
      }
    }
    if (body.includes('$ARGUMENTS')) {
      return body.replace(/\$ARGUMENTS/g, userArgs);
    }
    return userArgs ? `${body}\n\n${userArgs}` : body;
  }

  private extractFrontmatter(raw: string): string {
    if (!raw.startsWith('---')) return '';
    const endFrontmatter = raw.indexOf('\n---', 3);
    if (endFrontmatter === -1) return '';
    return raw.slice(3, endFrontmatter);
  }

  private frontmatterString(frontmatter: string, key: string): string | null {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = frontmatter.match(new RegExp(`^${escapedKey}:\\s*(.+)$`, 'm'));
    if (!match) return null;
    return match[1].trim().replace(/^['"]|['"]$/g, '');
  }

  private frontmatterList(frontmatter: string, key: string): string[] | null {
    const inline = this.frontmatterString(frontmatter, key);
    if (inline) {
      if (inline.startsWith('[') && inline.endsWith(']')) {
        return inline.slice(1, -1).split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      }
      return inline.split(',').map((part) => part.trim()).filter(Boolean);
    }

    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockMatch = frontmatter.match(new RegExp(`^${escapedKey}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, 'm'));
    if (!blockMatch) return null;
    return blockMatch[1]
      .split('\n')
      .map((line) => line.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  private matchesAllowedTools(allowedTools: string[], currentFilePath: string): boolean {
    if (!currentFilePath || allowedTools.length === 0) return true;
    const normalized = currentFilePath.replace(/\\/g, '/');
    return allowedTools.every((pattern) => {
      const trimmed = pattern.trim();
      if (!trimmed || !trimmed.startsWith('file:')) return true;
      const glob = trimmed.slice('file:'.length).replace(/\\/g, '/');
      return this.globToRegex(glob).test(normalized);
    });
  }

  private globToRegex(glob: string): RegExp {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::DOUBLE_STAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::DOUBLE_STAR::/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  private extractCommandDescription(filePath: string): string {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const frontmatter = this.extractFrontmatter(raw);
      return this.frontmatterString(frontmatter, 'description')
        || this.frontmatterString(frontmatter, 'summary')
        || this.firstBodyLine(raw);
    } catch {
      return '';
    }
  }

  private firstBodyLine(raw: string): string {
    const body = raw.startsWith('---')
      ? raw.slice((raw.indexOf('\n---', 3) === -1 ? 0 : raw.indexOf('\n---', 3) + 4))
      : raw;
    return body
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? '';
  }

  private commandNamespace(filePath: string, baseDir: string): string | null {
    const parent = path.dirname(path.resolve(filePath));
    const relative = path.relative(path.resolve(baseDir), parent);
    if (!relative || relative.startsWith('..')) return null;
    return relative.split(path.sep).filter(Boolean).join(':') || null;
  }

  private mergeCommands(...groups: SlashCommand[][]): SlashCommand[] {
    const merged = new Map<string, SlashCommand>();
    for (const group of groups) {
      for (const command of group) {
        if (!merged.has(command.name)) {
          merged.set(command.name, command);
        }
      }
    }
    return Array.from(merged.values());
  }

  private unique(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean).map((value) => path.resolve(value))));
  }
}
