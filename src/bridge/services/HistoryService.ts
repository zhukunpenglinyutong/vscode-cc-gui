import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { convertClaudeSessionEntrypoint, cwdMatchesProject, findClaudeSessionFile, isValidSessionId, sanitizeProjectPath, shouldIncludeClaudeHistorySession } from './historyEntrypoint';
import {
  isSubagentSidechainCompletedFromJsonl,
  resolveSubagentSidechainFile,
} from './subagentSidechain';
import { loadCodexHistoryRowsFromFile, summarizeCodexHistoryRows, transformCodexHistoryRows } from './codexHistoryTransform';
import { imageBlockFromLocalPath, restoreClaudeImageReferencesInContent } from './claudeImageRestore';
import { codemossConfigPath, readCodemossConfigFile, writeCodemossConfigFile } from './codemossJsonStore';
import { codexImageTagRegex, imagePathFromCodexImageTagMatch, stripCodexInlineImageTags as stripCodexInlineImageTagsText } from './codexImageTags';
import { GrokHistoryReader } from './GrokHistoryReader';
import { hasLocalHistorySupport, isCliOnlyProvider } from '../../cli/cliTools';

const USER_INPUT_BY_SESSION_KEY = 'ccg.userInputBySession';
/** Legacy migration source only — favorites now live in the shared FAVORITES_FILE. Never written to again. */
const FAVORITES_KEY = 'ccg.historyFavorites';
const FAVORITES_FILE = codemossConfigPath('favorites.json');
const CODEX_HISTORY_CACHE_KEY = 'ccg.codexHistoryCache';
/** Head/tail lite-read window (64KB), matching jetbrains-cc-gui's SessionLiteReader.LITE_READ_BUF_SIZE. */
const LITE_HEAD_BYTES = 65536;

type CallWebviewJson = (webview: vscode.Webview, functionName: string, payload: unknown) => void;
type CodexHistoryRole = 'user' | 'assistant';
type CodexHistorySource = 'user_input' | 'assistant_output' | 'system_context';

interface CodexHistoryMessage {
  type: CodexHistoryRole;
  content: string;
  displayContent: string;
  rawContent: string;
  contentSource: CodexHistorySource;
  timestamp: string;
  raw?: { message: { content: Array<Record<string, unknown>> } };
}

type CodexHistoryCacheEntry = {
  messages: any[];
  updatedAt: string;
  /** Always 'codex' for new writes; missing on legacy entries. */
  provider?: 'codex';
};

export class HistoryService {
  private readonly context: vscode.ExtensionContext;
  private readonly log: vscode.OutputChannel;
  private readonly callWebviewJson: CallWebviewJson;
  private readonly getWorkspacePath: () => string;

  constructor(
    context: vscode.ExtensionContext,
    log: vscode.OutputChannel,
    callWebviewJson: CallWebviewJson,
    getWorkspacePath: () => string = () => '',
  ) {
    this.context = context;
    this.log = log;
    this.callWebviewJson = callWebviewJson;
    this.getWorkspacePath = getWorkspacePath;
  }

  recordSessionId(sessionId: string): void {
    try {
      const dir = path.join(os.homedir(), '.codemoss');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = this.getSessionIndexFile();
      const index: Record<string, number> = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      if (!index[sessionId]) {
        index[sessionId] = Date.now();
        fs.writeFileSync(file, JSON.stringify(index, null, 2), 'utf8');
      }
    } catch { /* ignore */ }
  }

  appendCodexHistoryMessage(sessionId: string, role: 'user' | 'assistant', content: any, timestamp?: string): void {
    if (!sessionId) return;
    try {
      const normalizedText = this.extractCodexTextFromContent(content);
      const rawBlocks = this.extractCodexBlocksFromContent(content);
      const normalizedMessage = this.buildCodexHistoryMessage(
        role,
        normalizedText,
        timestamp ?? new Date().toISOString(),
        undefined,
        rawBlocks,
      );
      if (!normalizedMessage) {
        this.log.appendLine(`[HISTORY_DEBUG] appendCodexHistoryMessage dropped non-displayable ${role} content for sessionId="${sessionId}"`);
        return;
      }
      const cache = this.context.globalState.get<Record<string, CodexHistoryCacheEntry>>(CODEX_HISTORY_CACHE_KEY) ?? {};
      const storageKey = this.getScopedSessionStorageKey(sessionId);
      const existing = cache[storageKey] ?? { messages: [], updatedAt: new Date().toISOString(), provider: 'codex' };
      const nextMessages = [...existing.messages, normalizedMessage];
      existing.messages = nextMessages.slice(-400);
      existing.updatedAt = normalizedMessage.timestamp;
      existing.provider = 'codex';
      cache[storageKey] = existing;

      const entries = Object.entries(cache)
        .sort((a, b) => new Date(b[1].updatedAt).getTime() - new Date(a[1].updatedAt).getTime())
        .slice(0, 200);
      const trimmed: Record<string, CodexHistoryCacheEntry> = {};
      for (const [sid, data] of entries) trimmed[sid] = data;
      void this.context.globalState.update(CODEX_HISTORY_CACHE_KEY, trimmed);
    } catch { /* ignore */ }
  }

  extractCodexTextFromContent(content: any): string {
    if (typeof content === 'string') return this.stripCodexInlineImageTags(content).trim();
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if ((block.type === 'text' || block.type === 'output_text' || block.type === 'input_text') && typeof block.text === 'string') {
        const cleaned = this.stripCodexInlineImageTags(block.text).trim();
        if (cleaned) parts.push(cleaned);
      }
    }
    return parts.join('\n').trim();
  }

  extractCodexBlocksFromContent(content: any): Array<Record<string, unknown>> {
    if (typeof content === 'string') {
      return this.parseCodexBlocksFromText(content);
    }
    if (!Array.isArray(content)) return [];

    const blocks: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const candidate = block as Record<string, unknown>;
      const type = typeof candidate.type === 'string' ? candidate.type : '';
      if (type === 'text' || type === 'output_text' || type === 'input_text') {
        const text = typeof candidate.text === 'string' ? candidate.text : '';
        blocks.push(...this.parseCodexBlocksFromText(text));
        continue;
      }
      const normalizedImageBlock = this.normalizeCodexImageBlock(candidate);
      if (normalizedImageBlock) {
        blocks.push(normalizedImageBlock);
        continue;
      }
      const normalizedToolBlock = this.normalizeCodexToolBlock(candidate);
      if (normalizedToolBlock) {
        blocks.push(normalizedToolBlock);
      }
    }
    return blocks;
  }

  private normalizeCodexUserTextForHistory(text: string): string {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';

    // Codex auto-injects the project's AGENTS.md as a whole user turn at session
    // start (e.g. "# AGENTS.md instructions for <path>\n\n<INSTRUCTIONS>…"). It is
    // context, not something the user typed, so drop it entirely.
    if (/^#\s*AGENTS\.md instructions for\b/i.test(trimmed)) return '';

    let normalized = trimmed;
    // Handle both singular (<agent-instructions>) and plural (<agents-instructions>) forms.
    // See message-service.js — plural wraps AGENTS.md content, singular wraps agentPrompt.
    normalized = normalized.replace(/<agents?-instructions>[\s\S]*?<\/agents?-instructions>\s*/gi, '');
    normalized = normalized.replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/gi, '');
    normalized = normalized.replace(/<ide-context>[\s\S]*?<\/ide-context>\s*/gi, '');

    // Fallback for malformed/truncated wrapper blocks without explicit closing tags.
    normalized = normalized.replace(/<agents?-instructions>[\s\S]*$/i, '');
    normalized = normalized.replace(/<environment_context>[\s\S]*$/i, '');
    normalized = normalized.replace(/<ide-context>[\s\S]*$/i, '');

    // Codex rollout files store the fully augmented prompt (unlike Claude .jsonl),
    // so the appended markdown context blocks land here too. Mirror IDEA's
    // UserMessageSanitizer (CodexMessageConverter) and cut them off.
    normalized = this.stripAppendedContextMarkers(normalized);

    normalized = normalized.trim();
    if (normalized) return normalized;

    if (this.looksLikeCodexInjectedContext(trimmed)) {
      return '';
    }

    const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (
        line.startsWith('<') ||
        line.startsWith('### ') ||
        line.startsWith('Workspace folders:') ||
        line.startsWith('Root: ') ||
        line.startsWith('The following context was supplied by the IDE.')
      ) {
        continue;
      }
      return line;
    }
    return '';
  }

  // Ported from IDEA UserMessageSanitizer.APPENDED_CONTEXT_MARKERS: when the IDE
  // bridge appends a markdown context block after the user's text, cut from the
  // earliest marker so only the typed prompt remains.
  private static readonly APPENDED_CONTEXT_MARKERS: readonly string[] = [
    '\n\n## Agent Role and Instructions\n\n',
    '\n\n## Workspace Context\n\n',
    '\n\n## Project Modules\n\nThis project contains multiple modules:\n',
    '\n\n## Active Terminal Session\n\nThe user is working in the following terminal context:\n\n',
    '\n\n## Referenced Files\n\nThe following files were referenced by the user:\n\n',
    '\n\n## IDE Context\n\n',
    "\n\n## User's Current IDE Context\n\nThe user is viewing this file in their IDE.",
    "\n\n## User's Current IDE Context\n\nThe user is working in an IDE.",
    '\n\n## Runtime Context\n\n',
    '\n\n### Multi-Project Workspace Structure\n\n',
    '\n\n### Project Module Structure\n\nThis project contains multiple modules:\n',
  ];

  private stripAppendedContextMarkers(text: string): string {
    let cutIndex = -1;
    for (const marker of HistoryService.APPENDED_CONTEXT_MARKERS) {
      const idx = text.indexOf(marker);
      if (idx <= 0) continue;
      if (text.slice(0, idx).trim() === '') continue;
      if (cutIndex === -1 || idx < cutIndex) cutIndex = idx;
    }
    return cutIndex < 0 ? text : text.slice(0, cutIndex);
  }

  private looksLikeCodexInjectedContext(text: string): boolean {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    return (
      /^<environment_context>[\s\S]*<\/environment_context>$/i.test(trimmed) ||
      /^<ide-context>[\s\S]*<\/ide-context>$/i.test(trimmed) ||
      /^<agents?-instructions>[\s\S]*<\/agents?-instructions>$/i.test(trimmed) ||
      /^<environment_context>[\s\S]*$/i.test(trimmed) ||
      /^<ide-context>[\s\S]*$/i.test(trimmed) ||
      /^<agents?-instructions>[\s\S]*$/i.test(trimmed)
    );
  }

  private shouldApplyStoredCodexUserInput(text: string): boolean {
    return this.normalizeCodexUserTextForHistory(text).trim().length > 0;
  }

  private buildCodexHistoryMessage(
    role: CodexHistoryRole,
    rawText: string,
    timestamp: string,
    displayOverride?: string,
    rawBlocks?: Array<Record<string, unknown>>,
  ): CodexHistoryMessage | null {
    const normalizedRaw = String(rawText || '').trim();
    const normalizedBlocks = Array.isArray(rawBlocks) ? rawBlocks.filter(Boolean) : [];
    if (!normalizedRaw && normalizedBlocks.length === 0) return null;

    if (role === 'assistant') {
      return {
        type: 'assistant',
        content: normalizedRaw,
        displayContent: normalizedRaw,
        rawContent: normalizedRaw,
        contentSource: 'assistant_output',
        timestamp,
        ...(normalizedBlocks.length > 0 ? { raw: { message: { content: normalizedBlocks } } } : {}),
      };
    }

    const explicitDisplay = typeof displayOverride === 'string' ? displayOverride.trim() : '';
    const normalizedDisplay = explicitDisplay || this.normalizeCodexUserTextForHistory(normalizedRaw);
    const contentSource: CodexHistorySource = normalizedDisplay ? 'user_input' : 'system_context';
    if (!normalizedDisplay) return null;
    const normalizedUserBlocks = normalizedBlocks.length > 0
      ? this.normalizeCodexUserHistoryBlocks(normalizedBlocks, normalizedDisplay)
      : [];

    return {
      type: 'user',
      content: normalizedDisplay,
      displayContent: normalizedDisplay,
      rawContent: normalizedRaw,
      contentSource,
      timestamp,
      ...(normalizedUserBlocks.length > 0 ? { raw: { message: { content: normalizedUserBlocks } } } : {}),
    };
  }

  private materializeCodexHistoryMessages(messages: any[]): CodexHistoryMessage[] {
    const normalized: CodexHistoryMessage[] = [];
    let upgradedLegacyEntries = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
      const role = message?.type === 'assistant' ? 'assistant' : message?.type === 'user' ? 'user' : null;
      if (!role) continue;
      const timestamp = typeof message?.timestamp === 'string' && message.timestamp.trim()
        ? message.timestamp
        : new Date().toISOString();
      const isLegacyEntry = typeof message?.displayContent !== 'string' || typeof message?.rawContent !== 'string';
      const rawText = typeof message?.rawContent === 'string'
        ? message.rawContent
        : typeof message?.content === 'string'
          ? message.content
          : '';
      const displayOverride = typeof message?.displayContent === 'string' ? message.displayContent : undefined;
      const rawBlocks = Array.isArray(message?.raw?.message?.content)
        ? message.raw.message.content
        : undefined;
      const normalizedMessage = this.buildCodexHistoryMessage(role, rawText, timestamp, displayOverride, rawBlocks);
      if (normalizedMessage) {
        normalized.push(normalizedMessage);
        if (isLegacyEntry) {
          upgradedLegacyEntries += 1;
        }
      }
    }
    if (upgradedLegacyEntries > 0) {
      this.log.appendLine(`[HISTORY_DEBUG] materializeCodexHistoryMessages upgraded legacy entries=${upgradedLegacyEntries}/${Array.isArray(messages) ? messages.length : 0}`);
    }
    return normalized;
  }

  private getCodexMessageDisplayText(message: any): string {
    if (typeof message?.displayContent === 'string' && message.displayContent.trim()) {
      return message.displayContent.trim();
    }
    if (message?.type === 'user' && typeof message?.content === 'string') {
      return this.normalizeCodexUserTextForHistory(message.content);
    }
    if (typeof message?.content === 'string') {
      return message.content.trim();
    }
    return '';
  }

  private normalizeCodexUserHistoryBlocks(
    blocks: Array<Record<string, unknown>>,
    displayText: string,
  ): Array<Record<string, unknown>> {
    const nonTextBlocks = blocks.filter((block) => block?.type !== 'text');
    const trimmed = String(displayText || '').trim();
    return trimmed
      ? [{ type: 'text', text: trimmed }, ...nonTextBlocks]
      : nonTextBlocks;
  }

  private isFallbackSessionTitle(title: string | undefined, sessionId: string): boolean {
    const normalized = String(title || '').trim();
    if (!normalized) return true;
    return normalized === sessionId || normalized === sessionId.slice(0, 8);
  }

  private deduplicateHistorySessions(sessions: Array<Record<string, any>>): Array<Record<string, any>> {
    const deduplicated = new Map<string, Record<string, any>>();
    for (const session of sessions) {
      const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : '';
      if (!sessionId) continue;
      const provider = typeof session?.provider === 'string' && session.provider.trim()
        ? session.provider.trim()
        : 'unknown';
      const key = `${provider}::${sessionId}`;
      const existing = deduplicated.get(key);
      if (!existing) {
        deduplicated.set(key, session);
        continue;
      }

      const existingTs = new Date(existing.lastTimestamp || 0).getTime();
      const incomingTs = new Date(session.lastTimestamp || 0).getTime();
      const preferred = incomingTs >= existingTs ? session : existing;
      const fallback = preferred === session ? existing : session;

      deduplicated.set(key, {
        ...preferred,
        title: this.isFallbackSessionTitle(preferred.title, sessionId) && !this.isFallbackSessionTitle(fallback.title, sessionId)
          ? fallback.title
          : preferred.title || fallback.title,
        messageCount: Math.max(preferred.messageCount || 0, fallback.messageCount || 0),
        isFavorited: preferred.isFavorited || fallback.isFavorited,
        favoritedAt: Math.max(preferred.favoritedAt || 0, fallback.favoritedAt || 0) || undefined,
        entrypoint: preferred.entrypoint || fallback.entrypoint,
      });
    }
    return Array.from(deduplicated.values());
  }

  loadHistoryData(provider: string, webview: vscode.Webview): void {
    if (provider === 'codex') {
      this.loadCodexHistoryData(webview);
      return;
    }
    if (provider === 'grok') {
      this.loadGrokHistoryData(webview);
      return;
    }
    // Kimi / OpenCode / PI: chat works, but there is no local history reader yet.
    // Must not fall through to Claude's ~/.claude/projects scan — that incorrectly
    // shows Claude sessions under other CLI providers.
    if (isCliOnlyProvider(provider) && !hasLocalHistorySupport(provider)) {
      this.log.appendLine(`[HISTORY] loadHistoryData: provider="${provider}" has no local history support`);
      webview.postMessage({
        type: 'history_data',
        content: JSON.stringify({
          success: true,
          sessions: [],
          total: 0,
          favorites: this.getFavorites(),
          historyUnsupported: true,
          provider,
        }),
      });
      return;
    }
    const projectsDir = this.getClaudeProjectsDir();
    const favorites = this.getFavorites();

    let pluginSessionIds = new Set<string>();
    try {
      const indexFile = this.getSessionIndexFile();
      if (fs.existsSync(indexFile)) {
        const index: Record<string, number> = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        pluginSessionIds = new Set(Object.keys(index));
      }
    } catch { /* ignore */ }

    const usageStats = this.context.globalState.get<any>('ccg.usageStats') ?? { sessions: [] };
    for (const s of (usageStats.sessions ?? [])) {
      if (s.sessionId) pluginSessionIds.add(s.sessionId);
    }

    let codemossTitles: Record<string, { customTitle: string }> = {};
    try {
      const titlesFile = path.join(os.homedir(), '.codemoss', 'session-titles.json');
      if (fs.existsSync(titlesFile)) {
        codemossTitles = JSON.parse(fs.readFileSync(titlesFile, 'utf8'));
      }
    } catch { /* ignore */ }

    const vscTitles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};
    const sessions: any[] = [];

    try {
      if (!fs.existsSync(projectsDir)) {
        webview.postMessage({ type: 'history_data', content: JSON.stringify({ success: true, sessions: [], total: 0, favorites }) });
        return;
      }

      // Scope the scan to the current workspace's own project directory (matching the Claude
      // CLI's own naming), so sessions from unrelated projects never leak into this list. This
      // also lets us drop the entrypoint filter below: directory-scoping already guarantees
      // every session here belongs to this project, whether it was started via CLI or this GUI.
      const scopedProjectDir = sanitizeProjectPath(this.getWorkspacePath());
      const projectDirs = scopedProjectDir
        ? [scopedProjectDir]
        : fs.readdirSync(projectsDir);

      for (const projectDir of projectDirs) {
        const projectPath = path.join(projectsDir, projectDir);
        if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) continue;

        for (const file of fs.readdirSync(projectPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = file.replace(/\.jsonl$/, '');
          // When scoped to this workspace's own project dir, directory membership already guarantees
          // the session belongs here — matching jetbrains-cc-gui, we show every valid session,
          // including CLI-started ones the plugin never recorded. The plugin-id gate only applies in
          // the unscoped fallback (no workspace) to avoid leaking unrelated projects' sessions.
          if (!scopedProjectDir && pluginSessionIds.size > 0 && !pluginSessionIds.has(sessionId)) continue;

          const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
          try {
            const stat = fs.statSync(filePath);
            // Lite-read head/tail (64KB each) so session-list metadata matches jetbrains-cc-gui's
            // ClaudeSessionLiteReader exactly (counts + title priority), keeping the two panels consistent.
            const buf = fs.readFileSync(filePath);
            const head = buf.length <= LITE_HEAD_BYTES ? buf.toString('utf8') : buf.subarray(0, LITE_HEAD_BYTES).toString('utf8');
            const tail = buf.length <= LITE_HEAD_BYTES ? head : buf.subarray(buf.length - LITE_HEAD_BYTES).toString('utf8');

            // Skip whole session if the first line marks it as a sidechain.
            if (this.liteIsSidechainFirstLine(head)) continue;

            const entrypoint = this.liteExtractJsonStringField(head, 'entrypoint', false) ?? '';
            const messageCount = this.liteCountMessagesInHead(head);
            if (messageCount === 0) continue;

            // CLI-native title priority: customTitle > aiTitle (tail then head) > lastPrompt > summary > firstPrompt.
            const cliDerivedTitle =
              this.liteExtractJsonStringField(tail, 'customTitle', true) ??
              this.liteExtractJsonStringField(head, 'customTitle', true) ??
              this.liteExtractJsonStringField(tail, 'aiTitle', true) ??
              this.liteExtractJsonStringField(head, 'aiTitle', true) ??
              this.liteExtractJsonStringField(tail, 'lastPrompt', true) ??
              this.liteExtractJsonStringField(tail, 'summary', true) ??
              this.liteExtractFirstPromptFromHead(head) ??
              '';

            const localTitle = codemossTitles[sessionId]?.customTitle || vscTitles[sessionId] || '';
            // Metadata-only sessions (no derived title and no local override) are skipped, matching IDEA.
            if (!cliDerivedTitle && !localTitle) continue;

            const title = localTitle || cliDerivedTitle || sessionId.slice(0, 8);
            if (!this.liteIsValidSession(sessionId, cliDerivedTitle || title)) continue;

            if (!scopedProjectDir && !shouldIncludeClaudeHistorySession(entrypoint || undefined, pluginSessionIds.has(sessionId))) {
              continue;
            }
            sessions.push({
              sessionId,
              title,
              messageCount,
              lastTimestamp: stat.mtime.toISOString(),
              fileSize: stat.size,
              entrypoint: entrypoint || undefined,
              isFavorited: !!favorites[sessionId],
              favoritedAt: favorites[sessionId]?.favoritedAt,
              provider: 'claude',
            });
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }

    const deduplicatedSessions = this.deduplicateHistorySessions(sessions);
    deduplicatedSessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());
    webview.postMessage({
      type: 'history_data',
      content: JSON.stringify({ success: true, sessions: deduplicatedSessions, total: deduplicatedSessions.length, favorites }),
    });
  }

  deepSearchHistory(provider: string, webview: vscode.Webview): void {
    this.loadHistoryData(provider, webview);
  }

  private loadGrokHistoryData(webview: vscode.Webview): void {
    try {
      const favorites = this.getFavorites();
      const vscTitles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};
      const reader = new GrokHistoryReader();
      const workspace = this.getWorkspacePath();
      const result = reader.getSessionsForProject(workspace);
      const sessions = (result.sessions || []).map((session) => ({
        sessionId: session.sessionId,
        // Prefer user-renamed titles so list and chat header stay in sync.
        title: vscTitles[session.sessionId] || session.title,
        messageCount: session.messageCount,
        lastTimestamp: new Date(session.lastTimestamp).toISOString(),
        firstTimestamp: new Date(session.firstTimestamp).toISOString(),
        cwd: session.cwd,
        provider: 'grok',
        isFavorited: Boolean(favorites[session.sessionId]),
        fileSize: session.fileSize,
      }));
      webview.postMessage({
        type: 'history_data',
        content: JSON.stringify({
          success: result.success,
          sessions,
          total: sessions.length,
          favorites,
          error: result.error,
        }),
      });
    } catch (error: any) {
      this.log.appendLine(`[BRIDGE] loadGrokHistoryData error: ${error?.message || error}`);
      webview.postMessage({
        type: 'history_data',
        content: JSON.stringify({
          success: false,
          sessions: [],
          total: 0,
          error: String(error?.message || error),
        }),
      });
    }
  }

  loadSession(sessionId: string, provider: string | undefined, webview: vscode.Webview): void {
    if (!this.isValidSessionId(sessionId)) {
      this.log.appendLine(`[BRIDGE] loadSession rejected invalid sessionId="${sessionId}"`);
      webview.postMessage({ type: 'session_messages', content: JSON.stringify([]) });
      return;
    }

    const knownProviders = new Set(['claude', 'codex', 'grok', 'kimi', 'opencode', 'pi']);
    const normalizedProvider = provider && knownProviders.has(provider) ? provider : undefined;
    this.log.appendLine(`[BRIDGE] loadSession called: sessionId="${sessionId}" provider="${normalizedProvider ?? 'auto'}"`);

    if (normalizedProvider === 'grok') {
      try {
        const reader = new GrokHistoryReader();
        const messages = reader.getSessionMessages(sessionId, this.getWorkspacePath());
        this.log.appendLine(`[BRIDGE] loadSession: loaded ${messages.length} messages from grok history`);
        webview.postMessage({ type: 'session_messages', content: JSON.stringify(messages) });
        return;
      } catch (e: any) {
        this.log.appendLine(`[BRIDGE] loadSession grok error: ${e?.message || e}`);
        webview.postMessage({ type: 'session_messages', content: JSON.stringify([]) });
        return;
      }
    }

    // CLI providers without a history reader: do not probe Claude/Codex stores.
    if (normalizedProvider && isCliOnlyProvider(normalizedProvider) && !hasLocalHistorySupport(normalizedProvider)) {
      this.log.appendLine(`[BRIDGE] loadSession: provider="${normalizedProvider}" has no local history support`);
      webview.postMessage({ type: 'session_messages', content: JSON.stringify([]) });
      return;
    }

    const projectsDir = this.getClaudeProjectsDir();
    this.log.appendLine(`[BRIDGE] loadSession projectsDir="${projectsDir}" exists=${fs.existsSync(projectsDir)}`);
    try {
      if (normalizedProvider !== 'codex' && normalizedProvider !== 'grok' && fs.existsSync(projectsDir)) {
        for (const projectDir of this.getClaudeProjectDirsToScan(projectsDir)) {
          const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
          if (!fs.existsSync(filePath)) continue;
          this.log.appendLine(`[BRIDGE] loadSession: found file ${filePath}`);
          const messages = this.readClaudeSessionFile(filePath, sessionId, true);
          this.log.appendLine(`[BRIDGE] loadSession: sending ${messages.length} messages via session_messages`);
          webview.postMessage({ type: 'session_messages', content: JSON.stringify(messages) });
          return;
        }
      }
    } catch (e: any) {
      this.log.appendLine(`[BRIDGE] loadSession error: ${e?.message || e}`);
    }

    try {
      if (normalizedProvider !== 'claude' && normalizedProvider !== 'grok') {
        // Never serve Grok-owned sessions through the Codex history paths.
        if (this.getGrokSessionIdSet(this.getWorkspacePath()).has(sessionId)) {
          this.log.appendLine(`[BRIDGE] loadSession: skipping codex paths for grok sessionId="${sessionId}"`);
        } else {
          const liveMessages = this.readCodexLiveMessages(sessionId);
          if (liveMessages.length > 0) {
            this.log.appendLine(`[BRIDGE] loadSession: loaded ${liveMessages.length} messages from codex live session`);
            webview.postMessage({ type: 'session_messages', content: JSON.stringify(liveMessages) });
            return;
          }

          const cache = this.context.globalState.get<Record<string, CodexHistoryCacheEntry>>(CODEX_HISTORY_CACHE_KEY) ?? {};
          const entry = this.getCodexCacheEntryForCurrentWorkspace(cache, sessionId);
          if (entry?.messages?.length) {
            const messages = this.materializeCodexHistoryMessages(entry.messages);
            this.log.appendLine(`[BRIDGE] loadSession: loaded ${messages.length} messages from codex cache`);
            webview.postMessage({ type: 'session_messages', content: JSON.stringify(messages) });
            return;
          }
        }
      }
    } catch { /* ignore */ }

    if (normalizedProvider !== 'claude') {
      const archivedMessages = this.readCodexArchivedMessages(sessionId);
      if (archivedMessages.length > 0) {
        this.log.appendLine(`[BRIDGE] loadSession: loaded ${archivedMessages.length} messages from codex archived file`);
        webview.postMessage({ type: 'session_messages', content: JSON.stringify(archivedMessages) });
        return;
      }
    }

    this.log.appendLine('[BRIDGE] loadSession: no messages found, broadcasting empty');
    webview.postMessage({ type: 'session_messages', content: JSON.stringify([]) });
  }

  deleteHistorySession(content: string, webview: vscode.Webview): void {
    try {
      const sessionId = typeof content === 'string' && content.startsWith('{')
        ? JSON.parse(content).sessionId : content.trim();
      const deleted = this.deleteSessionFiles(sessionId);
      webview.postMessage({ type: 'delete_history_session_result', content: JSON.stringify({ success: deleted, sessionId }) });
    } catch (e: any) {
      webview.postMessage({ type: 'delete_history_session_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  deleteHistorySessions(content: string, webview: vscode.Webview): void {
    try {
      const parsed = this.safeJson<any>(content, []);
      const sessionIds = Array.isArray(parsed) ? parsed : [];
      let deleted = 0;
      for (const sessionId of sessionIds.map(String).filter(Boolean)) {
        if (this.deleteSessionFiles(sessionId)) deleted += 1;
      }
      webview.postMessage({
        type: 'delete_history_sessions_result',
        content: JSON.stringify({ success: true, deleted, sessionIds }),
      });
    } catch (e: any) {
      webview.postMessage({ type: 'delete_history_sessions_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  exportHistorySession(content: string, webview: vscode.Webview): void {
    try {
      const parsed = this.safeJson<any>(content, { sessionId: content });
      const sessionId = String(parsed.sessionId ?? content).trim();
      const title = String(parsed.title ?? '');
      const messages = this.readSessionMessages(sessionId);
      if (!sessionId || messages.length === 0) {
        this.callWebviewJson(webview, 'onExportSessionData', { error: 'Session not found', sessionId });
        return;
      }
      this.callWebviewJson(webview, 'onExportSessionData', {
        sessionId,
        title: title || sessionId.slice(0, 8),
        exportedAt: new Date().toISOString(),
        messages,
      });
    } catch (e: any) {
      this.callWebviewJson(webview, 'onExportSessionData', { error: e.message });
    }
  }

  readSessionMessages(sessionId: string): any[] {
    if (!this.isValidSessionId(sessionId)) {
      this.log.appendLine(`[BRIDGE] readSessionMessages rejected invalid sessionId="${sessionId}"`);
      return [];
    }

    const projectsDir = this.getClaudeProjectsDir();
    if (fs.existsSync(projectsDir)) {
      for (const projectDir of this.getClaudeProjectDirsToScan(projectsDir)) {
        const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
        if (!fs.existsSync(filePath)) continue;
        return this.readClaudeSessionFile(filePath, sessionId, false);
      }
    }

    const liveMessages = this.readCodexLiveMessages(sessionId);
    if (liveMessages.length > 0) return liveMessages;

    const cache = this.context.globalState.get<Record<string, CodexHistoryCacheEntry>>(CODEX_HISTORY_CACHE_KEY) ?? {};
    const entry = this.getCodexCacheEntryForCurrentWorkspace(cache, sessionId);
    if (entry?.messages?.length) return this.materializeCodexHistoryMessages(entry.messages);

    return this.readCodexArchivedMessages(sessionId);
  }

  updateHistoryTitle(content: string, webview: vscode.Webview): void {
    try {
      const parsed = JSON.parse(content);
      const sessionId: string = parsed.sessionId;
      const title: string = parsed.title ?? parsed.customTitle ?? '';
      const titles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};
      titles[sessionId] = title;
      void this.context.globalState.update('ccg.historyTitles', titles);
      webview.postMessage({ type: 'update_history_title_result', content: JSON.stringify({ success: true, sessionId, title }) });
    } catch (e: any) {
      webview.postMessage({ type: 'update_history_title_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  deleteHistoryTitle(content: string, webview: vscode.Webview): void {
    try {
      const sessionId = typeof content === 'string' && content.startsWith('{')
        ? JSON.parse(content).sessionId
        : content.trim();
      const titles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};
      delete titles[sessionId];
      void this.context.globalState.update('ccg.historyTitles', titles);
      webview.postMessage({ type: 'delete_history_title_result', content: JSON.stringify({ success: true, sessionId }) });
    } catch (e: any) {
      webview.postMessage({ type: 'delete_history_title_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  toggleFavoriteSession(content: string, webview: vscode.Webview): void {
    try {
      const sessionId = typeof content === 'string' && content.startsWith('{')
        ? JSON.parse(content).sessionId : content.trim();
      const favorites = this.getFavorites();
      if (favorites[sessionId]) {
        delete favorites[sessionId];
      } else {
        favorites[sessionId] = { favoritedAt: Date.now() };
      }
      this.saveFavorites(favorites);
      webview.postMessage({ type: 'toggle_favorite_result', content: JSON.stringify({ success: true, sessionId, isFavorited: !!favorites[sessionId] }) });
    } catch (e: any) {
      webview.postMessage({ type: 'toggle_favorite_result', content: JSON.stringify({ success: false, error: e.message }) });
    }
  }

  loadSubagentSession(content: string, webview: vscode.Webview): void {
    const payload = this.safeJson<any>(content, {});
    const sessionId = String(payload.sessionId ?? payload.leafSessionId ?? payload.sidechainSessionId ?? '').trim();
    const toolUseId = payload.toolUseId ? String(payload.toolUseId) : undefined;
    const agentId = payload.agentId ? String(payload.agentId) : undefined;
    try {
      // Claude Code stores background-agent transcripts beside the parent session:
      //   ~/.claude/projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl
      // Reading the parent session JSONL here previously returned the wrong
      // messages and never set `completed`, so StatusPanel polling could not
      // recover after a missed live task_notification.
      const sidechain = this.readSubagentSidechainMessages(sessionId, agentId);
      const messages = sidechain.messages;
      this.callWebviewJson(webview, 'onSubagentHistoryLoaded', {
        success: messages.length > 0,
        completed: sidechain.completed,
        sessionId,
        toolUseId,
        agentId,
        messages,
        error: messages.length > 0 ? undefined : 'Subagent session not found',
      });
    } catch (e: any) {
      this.callWebviewJson(webview, 'onSubagentHistoryLoaded', {
        success: false,
        completed: false,
        sessionId,
        toolUseId,
        agentId,
        messages: [],
        error: e.message,
      });
    }
  }

  /**
   * Locate and parse a background-agent sidechain transcript.
   * Returns empty messages when the file is not present yet (agent still starting).
   */
  private readSubagentSidechainMessages(
    parentSessionId: string,
    agentId: string | undefined,
  ): { messages: any[]; completed: boolean } {
    if (!parentSessionId || !agentId) {
      return { messages: [], completed: false };
    }
    const filePath = this.findSubagentSidechainFile(parentSessionId, agentId);
    if (!filePath) {
      return { messages: [], completed: false };
    }
    // Sidechain rows are the same Claude JSONL shape as parent sessions; reuse
    // the normalizer but do not restore stored user inputs (agents have none).
    const messages = this.readClaudeSessionFile(filePath, parentSessionId, false);
    return {
      messages,
      completed: this.isSubagentTranscriptCompleted(filePath, messages),
    };
  }

  private findSubagentSidechainFile(parentSessionId: string, agentId: string): string | null {
    const projectsDir = this.getClaudeProjectsDir();
    if (!fs.existsSync(projectsDir)) return null;
    return resolveSubagentSidechainFile(
      projectsDir,
      this.getClaudeProjectDirsToScan(projectsDir),
      parentSessionId,
      agentId,
    );
  }

  /**
   * A sidechain is complete when an assistant message ends with stop_reason
   * end_turn (or equivalent terminal reasons). Prefer scanning the raw file so
   * we still detect completion if message normalization drops stop_reason.
   */
  private isSubagentTranscriptCompleted(filePath: string, messages: any[]): boolean {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (isSubagentSidechainCompletedFromJsonl(raw)) return true;
    } catch {
      // fall through to message-list heuristic
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.type !== 'assistant') continue;
      const stop = msg?.raw?.message?.stop_reason ?? msg?.raw?.stop_reason;
      if (stop === 'end_turn' || stop === 'stop_sequence') return true;
      break;
    }
    return false;
  }

  convertToCliSession(content: string, webview: vscode.Webview): void {
    const sessionId = content.trim();
    const result = this.convertClaudeSessionEntrypoint(sessionId);
    this.callWebviewJson(webview, 'onConversionResult', result);
  }

  private loadCodexHistoryData(webview: vscode.Webview): void {
    const favorites = this.getFavorites();
    const vscTitles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};
    const cache = this.context.globalState.get<Record<string, CodexHistoryCacheEntry>>(CODEX_HISTORY_CACHE_KEY) ?? {};
    const workspacePath = this.getWorkspacePath();
    // Sessions owned by Grok must never appear under Codex history. Older builds
    // incorrectly wrote every provider's [MESSAGE] stream into this cache.
    const grokSessionIds = this.getGrokSessionIdSet(workspacePath);
    this.purgeForeignProviderSessionsFromCodexCache(cache, grokSessionIds);
    const sessions: any[] = [];
    let cacheSessionCount = 0;
    let archivedSessionCount = 0;
    let liveSessionCount = 0;

    for (const [storageKey, data] of this.getCodexCacheEntriesForCurrentWorkspace(cache)) {
      const sessionId = this.sessionIdFromScopedStorageKey(storageKey);
      if (grokSessionIds.has(sessionId)) continue;
      // Reject explicitly non-codex tags if present (defensive; writers always set 'codex').
      if (data.provider && data.provider !== 'codex') continue;
      const messages = this.materializeCodexHistoryMessages(Array.isArray(data.messages) ? data.messages : []);
      if (messages.length === 0) continue;
      const firstUser = messages.find((m: any) => m?.type === 'user' && this.getCodexMessageDisplayText(m).length > 0);
      const firstUserTitle = firstUser ? this.getCodexMessageDisplayText(firstUser) : '';
      const title = vscTitles[sessionId] || (firstUserTitle ? firstUserTitle.slice(0, 80) : sessionId.slice(0, 8));
      const lastTimestamp = data.updatedAt || messages[messages.length - 1]?.timestamp || new Date().toISOString();
      sessions.push({
        sessionId,
        title,
        messageCount: messages.length,
        lastTimestamp,
        isFavorited: !!favorites[sessionId],
        favoritedAt: favorites[sessionId]?.favoritedAt,
        provider: 'codex',
      });
      cacheSessionCount += 1;
    }

    try {
      const archivedDir = this.getCodexArchivedDir();
      if (fs.existsSync(archivedDir)) {
        for (const file of fs.readdirSync(archivedDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(archivedDir, file);
          const summary = summarizeCodexHistoryRows(loadCodexHistoryRowsFromFile(filePath), { imageBlockFromLocalPath }, {
            normalizeUserDisplayText: (text) => this.normalizeCodexUserTextForHistory(text),
          });
          let sessionId = summary?.sessionId ?? '';
          if (!sessionId) {
            const match = file.match(/([0-9a-f]{8,}-[0-9a-f-]{8,})\.jsonl$/i);
            sessionId = match ? match[1] : file.replace(/\.jsonl$/, '');
          }
          if (!sessionId || !summary || summary.messageCount === 0) continue;
          if (grokSessionIds.has(sessionId)) continue;
          if (workspacePath && !cwdMatchesProject(summary.cwd, workspacePath)) continue;
          sessions.push({
            sessionId,
            title: vscTitles[sessionId] || summary.firstUserText || sessionId.slice(0, 8),
            messageCount: summary.messageCount,
            lastTimestamp: summary.lastTimestamp,
            isFavorited: !!favorites[sessionId],
            favoritedAt: favorites[sessionId]?.favoritedAt,
            provider: 'codex',
          });
          archivedSessionCount += 1;
        }
      }
    } catch { /* ignore */ }

    try {
      for (const filePath of this.getCodexLiveSessionFiles()) {
        const summary = this.summarizeCodexLiveSessionFile(filePath);
        if (!summary?.sessionId || summary.messageCount === 0) continue;
        if (grokSessionIds.has(summary.sessionId)) continue;
        if (workspacePath && !cwdMatchesProject(summary.cwd, workspacePath)) continue;
        const existingIdx = sessions.findIndex(s => s.sessionId === summary.sessionId);
        const nextSession = {
          sessionId: summary.sessionId,
          title: vscTitles[summary.sessionId] || summary.firstUserText || summary.sessionId.slice(0, 8),
          messageCount: summary.messageCount,
          lastTimestamp: summary.lastTimestamp,
          isFavorited: !!favorites[summary.sessionId],
          favoritedAt: favorites[summary.sessionId]?.favoritedAt,
          provider: 'codex',
        };
        if (existingIdx >= 0) {
          const existing = sessions[existingIdx];
          const existingTs = new Date(existing.lastTimestamp || 0).getTime();
          const nextTs = new Date(nextSession.lastTimestamp || 0).getTime();
          const preferredTitle = this.isFallbackSessionTitle(existing.title, summary.sessionId) && !this.isFallbackSessionTitle(nextSession.title, summary.sessionId)
            ? nextSession.title
            : existing.title || nextSession.title;
          sessions[existingIdx] = {
            ...existing,
            ...nextSession,
            title: preferredTitle,
            messageCount: Math.max(existing.messageCount || 0, nextSession.messageCount || 0),
            lastTimestamp: nextTs >= existingTs ? nextSession.lastTimestamp : existing.lastTimestamp,
          };
        } else {
          sessions.push(nextSession);
        }
        liveSessionCount += 1;
      }
    } catch { /* ignore */ }

    const deduplicatedSessions = this.deduplicateHistorySessions(sessions);
    this.log.appendLine(`[HISTORY_DEBUG] codex history sources cache=${cacheSessionCount} archived=${archivedSessionCount} live=${liveSessionCount} merged=${sessions.length} deduped=${deduplicatedSessions.length}`);
    deduplicatedSessions.sort((a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime());
    webview.postMessage({ type: 'history_data', content: JSON.stringify({ success: true, sessions: deduplicatedSessions, total: deduplicatedSessions.length, favorites }) });
  }

  private readClaudeSessionFile(filePath: string, sessionId: string, restoreUserInput: boolean): any[] {
    const messages: any[] = [];
    const userInputsAsTyped = restoreUserInput ? this.getStoredUserInputs(sessionId) : [];
    let userInputIdx = 0;

    for (const line of fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        let row = this.sessionMessageFromClaudeJsonlLine(msg);
        if (row?.type === 'user' && userInputIdx < userInputsAsTyped.length) {
          const inner = row.raw.message;
          if (!this.userJsonlRowIsToolOnlyArtifact(inner)) {
            const t = String(userInputsAsTyped[userInputIdx++]).trim();
            if (t) {
              const role = inner?.role ?? 'user';
              const existingContent = Array.isArray(inner?.content) ? inner.content : [];
              const structuralBlocks = existingContent.filter(
                (block: any) => block && typeof block === 'object' && block.type !== 'text',
              );
              row = {
                ...row,
                content: t,
                raw: {
                  message: {
                    ...inner,
                    role,
                    content: [...structuralBlocks, { type: 'text', text: t }],
                  },
                },
              };
            }
          }
        } else if (row?.type === 'user' && restoreUserInput) {
          row = this.applyHistoryUserSkillFoldIfNoStoredInput(row);
        }
        if (row) messages.push(row);
      } catch { /* skip */ }
    }
    return messages;
  }

  private readCodexArchivedMessages(sessionId: string): any[] {
    try {
      const archivedDir = this.getCodexArchivedDir();
      if (!fs.existsSync(archivedDir)) return [];
      for (const file of fs.readdirSync(archivedDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(archivedDir, file);
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.includes(sessionId)) continue;
        const summary = summarizeCodexHistoryRows(loadCodexHistoryRowsFromFile(filePath), { imageBlockFromLocalPath }, {
          normalizeUserDisplayText: (text) => this.normalizeCodexUserTextForHistory(text),
        });
        const workspacePath = this.getWorkspacePath();
        if (workspacePath && !cwdMatchesProject(summary?.cwd, workspacePath)) continue;
        const messages = transformCodexHistoryRows(loadCodexHistoryRowsFromFile(filePath), { imageBlockFromLocalPath }, {
          normalizeUserDisplayText: (text) => this.normalizeCodexUserTextForHistory(text),
        });
        if (messages.length > 0) return messages;
      }
    } catch { /* ignore */ }
    return [];
  }

  private readCodexLiveMessages(sessionId: string): any[] {
    try {
      const liveFile = this.findCodexLiveSessionFile(sessionId);
      if (!liveFile) return [];
      this.log.appendLine(`[BRIDGE] readCodexLiveMessages: sessionId="${sessionId}" file="${liveFile}"`);
      const userInputsAsTyped = this.getStoredUserInputs(sessionId);
      const messages = transformCodexHistoryRows(loadCodexHistoryRowsFromFile(liveFile), { imageBlockFromLocalPath }, {
        storedUserInputs: userInputsAsTyped,
        shouldApplyStoredUserInput: (text) => this.shouldApplyStoredCodexUserInput(text),
        normalizeUserDisplayText: (text) => this.normalizeCodexUserTextForHistory(text),
      });
      this.log.appendLine(`[HISTORY_DEBUG] readCodexLiveMessages sessionId="${sessionId}" messages=${messages.length}`);
      return messages;
    } catch { /* ignore */ }
    return [];
  }

  private sessionMessageFromClaudeJsonlLine(msg: any): { type: string; content: string; raw: { message: any }; timestamp: string } | null {
    if (msg?.type !== 'user' && msg?.type !== 'assistant') return null;
    const inner = msg.message;
    if (!inner || typeof inner !== 'object') return null;
    const c = msg.type === 'user' ? restoreClaudeImageReferencesInContent(inner.content).content : inner.content;

    let textOnly = '';
    if (typeof c === 'string') {
      textOnly = c;
    } else if (Array.isArray(c)) {
      textOnly = c.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
    } else {
      return null;
    }

    const hasBlocks =
      Array.isArray(c) &&
      c.some(
        (b: any) =>
          b &&
          (b.type === 'text' ||
            b.type === 'thinking' ||
            b.type === 'tool_use' ||
            b.type === 'tool_result' ||
            b.type === 'image'),
      );
    if (typeof c === 'string') {
      if (!String(c).trim()) return null;
    } else if (!String(textOnly).trim() && !hasBlocks) {
      return null;
    }

    if (msg.type === 'user' && (textOnly.startsWith('You are a Claude') || textOnly.startsWith('Hello memory agent'))) {
      return null;
    }

    return {
      type: msg.type,
      content: String(textOnly),
      raw: { message: { ...inner, content: c } },
      timestamp: msg.timestamp ?? new Date().toISOString(),
    };
  }

  private userJsonlRowIsToolOnlyArtifact(inner: any): boolean {
    const c = inner?.content;
    if (!Array.isArray(c) || c.length === 0) return false;
    const textFromBlocks = c
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim();
    if (textFromBlocks.length > 0) return false;
    return c.every((b: any) => b && (b.type === 'tool_result' || b.type === 'tool_use'));
  }

  private applyHistoryUserSkillFoldIfNoStoredInput(row: {
    type: string;
    content: string;
    raw: { message: any };
    timestamp: string;
  }): { type: string; content: string; raw: { message: any }; timestamp: string } {
    if (row.type !== 'user' || !this.historyUserMessageLooksLikeExpandedSkill(row.content)) {
      return row;
    }
    const m = String(row.content).match(/^#\s*([^\n]+)/m);
    const h1 = (m && m[1] ? m[1].trim() : '').slice(0, 200);
    const brief = h1
      ? `〔技能/指令展开〕${h1}（本机未存输入原文；可升级扩展后重试以显示输入框内容）`
      : `〔长指令已折叠〕`;
    const inner = row.raw.message;
    return {
      ...row,
      content: brief,
      raw: { message: { ...inner, content: [{ type: 'text', text: brief }] } },
    };
  }

  private historyUserMessageLooksLikeExpandedSkill(text: string): boolean {
    const t = String(text);
    if (t.length < 400) return false;
    const head = t.slice(0, 6000);
    const first = t.trimStart();
    if (!first.startsWith('#') && !/^---\s*$/m.test(t.slice(0, 200))) {
      if (!/^(you are|you're|#)/i.test(first.slice(0, 80)) && t.length < 5000) return false;
    }
    const strong =
      /you are (the|a) /i.test(head) ||
      /你是(本项目的)?智能|管理后台|工作流|Harness|orchestrat|Phase\s*0|核心工作流/i.test(head) ||
      /##\s*(Core|核心|工作流|Workflow|Agent Role|Phase\b)/i.test(t) ||
      /role and instructions|工作流编排/i.test(head);
    if (!strong) {
      if (t.length < 2000) return false;
      return /(^|\n)#\s+\S+/.test(t) && (/\b(skill|sub-skill|subskill)\b/i.test(head) || t.split('\n').length > 40);
    }
    return true;
  }

  private deleteGrokSession(sessionId: string): boolean {
    try {
      return new GrokHistoryReader().deleteSession(sessionId, this.getWorkspacePath());
    } catch (e: any) {
      this.log.appendLine(`[HISTORY] deleteGrokSession failed: ${e?.message || e}`);
      return false;
    }
  }

  private deleteSessionFiles(sessionId: string): boolean {
    // Best-effort: remove matching Grok session if present.
    this.deleteGrokSession(sessionId);
    if (!this.isValidSessionId(sessionId)) {
      this.log.appendLine(`[BRIDGE] deleteSessionFiles rejected invalid sessionId="${sessionId}"`);
      return false;
    }

    let deleted = false;

    let deletedClaudeFiles = 0;
    let deletedCodexArchivedFiles = 0;
    let deletedCodexLiveFiles = 0;
    const projectsDir = this.getClaudeProjectsDir();
    if (fs.existsSync(projectsDir)) {
      for (const projectDir of fs.readdirSync(projectsDir)) {
        const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted = true;
          deletedClaudeFiles += 1;
        }
      }
    }

    const archivedDir = this.getCodexArchivedDir();
    if (fs.existsSync(archivedDir)) {
      for (const file of fs.readdirSync(archivedDir)) {
        const filePath = path.join(archivedDir, file);
        if (file.endsWith('.jsonl') && (file.includes(sessionId) || fs.readFileSync(filePath, 'utf8').includes(sessionId))) {
          fs.unlinkSync(filePath);
          deleted = true;
          deletedCodexArchivedFiles += 1;
        }
      }
    }

    for (const filePath of this.getCodexLiveSessionFiles()) {
      try {
        const summary = this.summarizeCodexLiveSessionFile(filePath);
        const matchesSummary = summary?.sessionId === sessionId;
        const matchesRaw = !matchesSummary && fs.readFileSync(filePath, 'utf8').includes(sessionId);
        if (!matchesSummary && !matchesRaw) {
          continue;
        }
        fs.unlinkSync(filePath);
        deleted = true;
        deletedCodexLiveFiles += 1;
      } catch {
        /* ignore individual file deletion failure */
      }
    }

    const cache = this.context.globalState.get<Record<string, { messages: any[]; updatedAt: string }>>(CODEX_HISTORY_CACHE_KEY) ?? {};
    if (cache[sessionId]) {
      delete cache[sessionId];
      void this.context.globalState.update(CODEX_HISTORY_CACHE_KEY, cache);
      deleted = true;
    }

    const favorites = this.getFavorites();
    if (favorites[sessionId]) {
      delete favorites[sessionId];
      this.saveFavorites(favorites);
    }

    const titles: Record<string, string> = this.context.globalState.get('ccg.historyTitles') ?? {};
    if (titles[sessionId]) {
      delete titles[sessionId];
      void this.context.globalState.update('ccg.historyTitles', titles);
    }

    const storedUserInputs = this.context.globalState.get<Record<string, string[]>>(USER_INPUT_BY_SESSION_KEY) ?? {};
    if (storedUserInputs[sessionId]) {
      delete storedUserInputs[sessionId];
      void this.context.globalState.update(USER_INPUT_BY_SESSION_KEY, storedUserInputs);
    }

    try {
      const indexFile = this.getSessionIndexFile();
      if (fs.existsSync(indexFile)) {
        const index: Record<string, number> = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        if (sessionId in index) {
          delete index[sessionId];
          fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf8');
        }
      }
    } catch {
      /* ignore session index cleanup failure */
    }

    this.log.appendLine(
      `[HISTORY_DEBUG] deleteSessionFiles sessionId="${sessionId}" deleted=${deleted} claude=${deletedClaudeFiles} codexArchived=${deletedCodexArchivedFiles} codexLive=${deletedCodexLiveFiles}`,
    );

    return deleted;
  }

  private convertClaudeSessionEntrypoint(sessionId: string): Record<string, unknown> {
    return convertClaudeSessionEntrypoint(sessionId, this.getClaudeProjectsDir()) as Record<string, unknown>;
  }

  private isValidSessionId(sessionId: string): boolean {
    return isValidSessionId(sessionId);
  }

  private findClaudeSessionFile(sessionId: string): string | null {
    return findClaudeSessionFile(this.getClaudeProjectsDir(), sessionId);
  }

  private deleteIfExists(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch { /* ignore cleanup errors */ }
  }

  private getWorkspaceStorageScope(): string {
    return sanitizeProjectPath(this.getWorkspacePath());
  }

  private getScopedSessionStorageKey(sessionId: string): string {
    const scope = this.getWorkspaceStorageScope();
    return scope ? `${scope}::${sessionId}` : sessionId;
  }

  private sessionIdFromScopedStorageKey(storageKey: string): string {
    const separator = storageKey.lastIndexOf('::');
    return separator >= 0 ? storageKey.slice(separator + 2) : storageKey;
  }

  private getCodexCacheEntriesForCurrentWorkspace(
    cache: Record<string, CodexHistoryCacheEntry>,
  ): Array<[string, CodexHistoryCacheEntry]> {
    const scope = this.getWorkspaceStorageScope();
    const entries = Object.entries(cache);
    if (!scope) {
      return entries.filter(([key]) => !key.includes('::'));
    }
    const prefix = `${scope}::`;
    return entries.filter(([key]) => key.startsWith(prefix));
  }

  /** Session ids that belong to Grok for the current (or all) project(s). */
  private getGrokSessionIdSet(workspacePath?: string): Set<string> {
    try {
      const reader = new GrokHistoryReader();
      const sessions = workspacePath
        ? reader.listSessionsForProject(workspacePath)
        : reader.listAllSessions();
      return new Set(sessions.map((s) => s.sessionId).filter(Boolean));
    } catch (error: any) {
      this.log.appendLine(`[HISTORY] getGrokSessionIdSet failed: ${error?.message || error}`);
      return new Set();
    }
  }

  /**
   * Remove cache entries that were incorrectly recorded for non-Codex providers
   * (notably Grok) so they stop showing up in Codex history after upgrade.
   */
  private purgeForeignProviderSessionsFromCodexCache(
    cache: Record<string, CodexHistoryCacheEntry>,
    foreignSessionIds: Set<string>,
  ): void {
    if (foreignSessionIds.size === 0) return;
    let removed = 0;
    const next: Record<string, CodexHistoryCacheEntry> = { ...cache };
    for (const key of Object.keys(next)) {
      const sessionId = this.sessionIdFromScopedStorageKey(key);
      if (!foreignSessionIds.has(sessionId)) continue;
      delete next[key];
      removed += 1;
    }
    if (removed === 0) return;
    void this.context.globalState.update(CODEX_HISTORY_CACHE_KEY, next);
    // Mutate caller's object so subsequent reads in this load see the purge.
    for (const key of Object.keys(cache)) {
      if (!(key in next)) delete cache[key];
    }
    this.log.appendLine(`[HISTORY] purged ${removed} foreign (non-codex) session(s) from codex history cache`);
  }

  private getCodexCacheEntryForCurrentWorkspace(
    cache: Record<string, CodexHistoryCacheEntry>,
    sessionId: string,
  ): CodexHistoryCacheEntry | undefined {
    const scopedKey = this.getScopedSessionStorageKey(sessionId);
    if (cache[scopedKey]) return cache[scopedKey];
    // Legacy unscoped cache entries cannot be tied back to a project. Only use them
    // when there is no active workspace; otherwise they are the source of cross-project leakage.
    return this.getWorkspaceStorageScope() ? undefined : cache[sessionId];
  }

  private getStoredUserInputs(sessionId: string): string[] {
    const bySid = this.context.globalState.get<Record<string, string[]>>(USER_INPUT_BY_SESSION_KEY) ?? {};
    const scopedKey = this.getScopedSessionStorageKey(sessionId);
    if (Array.isArray(bySid[scopedKey])) return bySid[scopedKey];
    return this.getWorkspaceStorageScope() ? [] : bySid[sessionId] ?? [];
  }

  private getClaudeProjectDirsToScan(projectsDir: string): string[] {
    const scopedProjectDir = sanitizeProjectPath(this.getWorkspacePath());
    return scopedProjectDir ? [scopedProjectDir] : fs.readdirSync(projectsDir);
  }

  private getSessionIndexFile(): string {
    return path.join(os.homedir(), '.codemoss', 'vscode-session-index.json');
  }

  private getClaudeProjectsDir(): string {
    return path.join(os.homedir(), '.claude', 'projects');
  }

  private getCodexArchivedDir(): string {
    return path.join(os.homedir(), '.codex', 'archived_sessions');
  }

  private getCodexSessionsDir(): string {
    return path.join(os.homedir(), '.codex', 'sessions');
  }

  private stripCodexInlineImageTags(text: string): string {
    return stripCodexInlineImageTagsText(text);
  }

  private parseCodexBlocksFromText(text: string): Array<Record<string, unknown>> {
    const raw = String(text || '');
    if (!raw.trim()) return [];

    const blocks: Array<Record<string, unknown>> = [];
    const regex = codexImageTagRegex();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const cleanTextFragment = (value: string): string => value.replace(/<\/image>/gi, '').trim();

    while ((match = regex.exec(raw)) !== null) {
      const prefix = cleanTextFragment(raw.slice(lastIndex, match.index));
      if (prefix) {
        blocks.push({ type: 'text', text: prefix });
      }
      const imagePath = imagePathFromCodexImageTagMatch(match);
      const imageBlock = imagePath ? imageBlockFromLocalPath(imagePath) : null;
      if (imageBlock) {
        blocks.push(imageBlock);
      }
      lastIndex = regex.lastIndex;
    }

    const suffix = cleanTextFragment(raw.slice(lastIndex));
    if (suffix) {
      blocks.push({ type: 'text', text: suffix });
    }

    return blocks;
  }

  private normalizeCodexImageBlock(candidate: Record<string, unknown>): Record<string, unknown> | null {
    const type = typeof candidate.type === 'string' ? candidate.type : '';
    if (type === 'image') {
      const source = candidate.source;
      if (source && typeof source === 'object') {
        const src = source as Record<string, unknown>;
        if (src.type === 'base64' && typeof src.data === 'string') {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: typeof src.media_type === 'string' ? src.media_type : 'image/png',
              data: src.data,
            },
          };
        }
      }
      if (typeof candidate.src === 'string' && candidate.src.startsWith('data:')) {
        const mediaType = typeof candidate.mediaType === 'string' ? candidate.mediaType : 'image/png';
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: candidate.src.replace(/^data:[^;]+;base64,/, ''),
          },
        };
      }
    }

    const possiblePath = [candidate.path, candidate.file_path, candidate.local_path]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (type === 'local_image' || type === 'input_image' || possiblePath) {
      return possiblePath ? imageBlockFromLocalPath(possiblePath) : null;
    }
    return null;
  }

  private normalizeCodexToolBlock(candidate: Record<string, unknown>): Record<string, unknown> | null {
    const type = typeof candidate.type === 'string' ? candidate.type : '';
    if (type === 'tool_use') {
      const name = typeof candidate.name === 'string'
        ? candidate.name
        : typeof candidate.tool_name === 'string'
          ? candidate.tool_name
          : '';
      if (!name) return null;
      return {
        type: 'tool_use',
        id: typeof candidate.id === 'string' ? candidate.id : undefined,
        name,
        input: candidate.input && typeof candidate.input === 'object' ? candidate.input : {},
      };
    }
    if (type === 'tool_result') {
      const toolUseId = typeof candidate.tool_use_id === 'string' ? candidate.tool_use_id : '';
      if (!toolUseId) return null;
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: candidate.is_error === true,
        content: candidate.content ?? '',
      };
    }
    return null;
  }

  private getCodexLiveSessionFiles(): string[] {
    const sessionsDir = this.getCodexSessionsDir();
    if (!fs.existsSync(sessionsDir)) return [];
    const results: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      }
    };
    walk(sessionsDir);
    return results;
  }

  private findCodexLiveSessionFile(sessionId: string): string | null {
    const workspacePath = this.getWorkspacePath();
    for (const filePath of this.getCodexLiveSessionFiles()) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.includes(sessionId)) continue;
        const summary = this.summarizeCodexLiveSessionFile(filePath);
        if (summary?.sessionId && summary.sessionId !== sessionId) continue;
        if (workspacePath && !cwdMatchesProject(summary?.cwd, workspacePath)) continue;
        return filePath;
      } catch { /* skip */ }
    }
    return null;
  }

  private summarizeCodexLiveSessionFile(filePath: string): {
    sessionId: string;
    firstUserText: string;
    messageCount: number;
    lastTimestamp: string;
    cwd?: string;
  } | null {
    try {
      const rows = loadCodexHistoryRowsFromFile(filePath);
      const sessionMeta = rows.find((row) => row?.type === 'session_meta');
      let sessionId = typeof sessionMeta?.payload?.session_id === 'string'
        ? sessionMeta.payload.session_id.trim()
        : typeof sessionMeta?.payload?.id === 'string'
          ? sessionMeta.payload.id.trim()
          : '';
      const summary = summarizeCodexHistoryRows(rows, { imageBlockFromLocalPath }, {
        storedUserInputs: sessionId ? this.getStoredUserInputs(sessionId) : [],
        shouldApplyStoredUserInput: (text) => this.shouldApplyStoredCodexUserInput(text),
        normalizeUserDisplayText: (text) => this.normalizeCodexUserTextForHistory(text),
      });

      if (!sessionId) {
        const match = filePath.match(/([0-9a-f]{8,}-[0-9a-f-]{8,})\.jsonl$/i);
        sessionId = match ? match[1] : '';
      }
      if (!sessionId || !summary) return null;
      return {
        sessionId,
        firstUserText: summary.firstUserText,
        messageCount: summary.messageCount,
        lastTimestamp: summary.lastTimestamp || fs.statSync(filePath).mtime.toISOString(),
        cwd: summary.cwd,
      };
    } catch {
      return null;
    }
  }

  /** Seeds the shared favorites file from legacy globalState once, if it hasn't been created yet. */
  private migrateFavoritesIfNeeded(): void {
    if (fs.existsSync(FAVORITES_FILE)) return;
    const legacy = this.context.globalState.get<Record<string, { favoritedAt: number }>>(FAVORITES_KEY);
    if (legacy && Object.keys(legacy).length > 0) {
      writeCodemossConfigFile(FAVORITES_FILE, legacy);
    }
  }

  /** Favorites are shared via `~/.codemoss/favorites.json` so both this extension and jetbrains-cc-gui see the same starred sessions. */
  private getFavorites(): Record<string, { favoritedAt: number }> {
    this.migrateFavoritesIfNeeded();
    return readCodemossConfigFile(FAVORITES_FILE, {});
  }

  private saveFavorites(favorites: Record<string, { favoritedAt: number }>): void {
    writeCodemossConfigFile(FAVORITES_FILE, favorites);
  }

  // ==================== Lite-read helpers (parity with jetbrains-cc-gui SessionLiteReader) ====================

  private liteIsSidechainFirstLine(head: string): boolean {
    if (!head) return false;
    const nl = head.indexOf('\n');
    const firstLine = nl >= 0 ? head.slice(0, nl) : head;
    return firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true');
  }

  private liteCountMessagesInHead(head: string): number {
    if (!head) return 0;
    let count = 0;
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      if (line.includes('"isSidechain":true') || line.includes('"isSidechain": true')) continue;
      count++;
    }
    return count;
  }

  private liteIsValidSession(sessionId: string, summary: string): boolean {
    if (sessionId.startsWith('agent-')) return false;
    const s = String(summary || '').trim().toLowerCase();
    if (!s) return false;
    if (s === 'warmup' || s === 'no prompt' || s.startsWith('warmup') || s.startsWith('no prompt')) return false;
    return true;
  }

  /** Extract a JSON string field via raw text scan (resilient to partial lines from byte-truncated head/tail). */
  private liteExtractJsonStringField(text: string, key: string, last: boolean): string | undefined {
    if (!text) return undefined;
    const patterns = [`"${key}":"`, `"${key}": "`];
    let found: string | undefined;
    for (const pattern of patterns) {
      let from = 0;
      for (;;) {
        const idx = text.indexOf(pattern, from);
        if (idx < 0) break;
        const valueStart = idx + pattern.length;
        let i = valueStart;
        let closed = false;
        while (i < text.length) {
          const c = text[i];
          if (c === '\\') { i += 2; continue; }
          if (c === '"') { closed = true; break; }
          i++;
        }
        if (closed) {
          const value = this.liteUnescapeJson(text.slice(valueStart, i));
          if (!last) return value;
          found = value;
        }
        from = i + 1;
      }
    }
    return found;
  }

  private liteUnescapeJson(raw: string): string {
    if (!raw.includes('\\')) return raw;
    try { return JSON.parse(`"${raw}"`); } catch { return raw; }
  }

  private liteExtractFirstPromptFromHead(head: string): string | undefined {
    if (!head) return undefined;
    let commandFallback: string | undefined;
    for (const line of head.split('\n')) {
      if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
      if (line.includes('"tool_result"')) continue;
      if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue;
      if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) continue;

      const contentText = this.liteExtractContentFromLine(line);
      if (!contentText) continue;
      let result = contentText.replace(/\n/g, ' ').trim();
      if (!result) continue;

      if (result.startsWith('<command-name>') && result.includes('</command-name>')) {
        const s = result.indexOf('<command-name>') + 14;
        const e = result.indexOf('</command-name>');
        if (e > s) { commandFallback = result.slice(s, e); continue; }
      }
      if (result.includes('<bash-input>')) {
        const s = result.indexOf('<bash-input>') + 12;
        const e = result.indexOf('</bash-input>');
        if (e > s) return '! ' + result.slice(s, e).trim();
      }
      if (result.startsWith('<') && result.length > 1) {
        const nextChar = result[1];
        if (nextChar >= 'a' && nextChar <= 'z') continue; // skip lowercase XML tags like <ide-context>
      }
      if (result.startsWith('[Request interrupted')) continue;

      if (result.length > 200) result = result.slice(0, 200).trim() + '…';
      return result;
    }
    return commandFallback;
  }

  private liteExtractContentFromLine(line: string): string | undefined {
    const s = this.liteExtractJsonStringField(line, 'content', false);
    if (s) return s;
    if (line.includes('"content":[') || line.includes('"content": [')) {
      try {
        const entry = JSON.parse(line);
        const content = entry?.message?.content;
        if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const block of content) {
            if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
          }
          const r = parts.join(' ').trim();
          return r || undefined;
        }
        if (typeof content === 'string') return content;
      } catch { /* ignore */ }
    }
    return undefined;
  }

  private safeJson<T>(content: string, fallback: T): T {
    try {
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }
}
