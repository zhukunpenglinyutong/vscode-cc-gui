import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { imageBlockFromLocalPath } from './claudeImageRestore.ts';

export interface GrokSessionInfo {
  sessionId: string;
  title: string;
  messageCount: number;
  lastTimestamp: number;
  firstTimestamp: number;
  cwd: string;
  fileSize: number;
  provider: 'grok';
}

/**
 * Reads Grok CLI history from ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/.
 */
export class GrokHistoryReader {
  private readonly sessionsRoot: string;

  constructor(sessionsRoot?: string) {
    this.sessionsRoot = sessionsRoot ?? this.defaultSessionsRoot();
  }

  getSessionsForProject(projectPath: string): {
    success: boolean;
    sessions: GrokSessionInfo[];
    sessionCount: number;
    totalMessages: number;
    error?: string;
  } {
    try {
      const sessions = this.listSessionsForProject(projectPath);
      return {
        success: true,
        sessions,
        sessionCount: sessions.length,
        totalMessages: sessions.reduce((sum, s) => sum + s.messageCount, 0),
      };
    } catch (error) {
      return {
        success: false,
        sessions: [],
        sessionCount: 0,
        totalMessages: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  listSessionsForProject(projectPath: string): GrokSessionInfo[] {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    const encoded = this.encodeCwd(projectPath);
    const canon = this.encodeCwd(this.canonicalizePath(projectPath));
    const dirs = new Set([encoded, canon].filter(Boolean));
    const sessions: GrokSessionInfo[] = [];

    for (const dir of dirs) {
      const cwdDir = path.join(this.sessionsRoot, dir);
      if (!fs.existsSync(cwdDir) || !fs.statSync(cwdDir).isDirectory()) continue;
      for (const entry of fs.readdirSync(cwdDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const info = this.readSessionSummary(path.join(cwdDir, entry.name), projectPath);
        if (info) sessions.push(info);
      }
    }

    // Fallback: scan all if no exact cwd match
    if (sessions.length === 0) {
      return this.listAllSessions().filter((s) => {
        if (!projectPath) return true;
        return s.cwd === projectPath || this.canonicalizePath(s.cwd) === this.canonicalizePath(projectPath);
      });
    }

    return sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  listAllSessions(): GrokSessionInfo[] {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    const sessions: GrokSessionInfo[] = [];
    for (const cwdEntry of fs.readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!cwdEntry.isDirectory()) continue;
      const cwdDir = path.join(this.sessionsRoot, cwdEntry.name);
      const cwd = this.decodeCwd(cwdEntry.name);
      for (const sessionEntry of fs.readdirSync(cwdDir, { withFileTypes: true })) {
        if (!sessionEntry.isDirectory()) continue;
        const info = this.readSessionSummary(path.join(cwdDir, sessionEntry.name), cwd);
        if (info) sessions.push(info);
      }
    }
    return sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  getSessionMessages(sessionId: string, cwd?: string): Array<Record<string, unknown>> {
    const sessionDir = this.resolveSessionDir(sessionId, cwd);
    if (!sessionDir) return [];
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    if (!fs.existsSync(chatPath)) return [];
    return this.parseChatHistoryToMessages(chatPath);
  }

  deleteSession(sessionId: string, projectPath?: string): boolean {
    if (!this.isValidSessionId(sessionId)) return false;
    let sessionDir = this.resolveSessionDir(sessionId, projectPath);
    if (!sessionDir) sessionDir = this.findSessionDirById(sessionId) ?? undefined;
    if (!sessionDir || !fs.existsSync(sessionDir)) return false;
    this.deleteRecursively(sessionDir);
    const parent = path.dirname(sessionDir);
    try {
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    } catch { /* ignore */ }
    return true;
  }

  private readSessionSummary(sessionDir: string, cwd: string): GrokSessionInfo | null {
    const sessionId = path.basename(sessionDir);
    if (!this.isValidSessionId(sessionId)) return null;
    const summaryPath = path.join(sessionDir, 'summary.json');
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    if (!fs.existsSync(chatPath) && !fs.existsSync(summaryPath)) return null;

    // Prefer the user's real first prompt over Grok's AI-generated_title /
    // session_summary (e.g. "Simple Arithmetic Calculation 1 Plus 2"), which
    // the user never typed and looks wrong next to the chat bubble "1+2".
    let title = '';
    let aiTitle = '';
    let messageCount = 0;
    let firstTimestamp = this.fileMtime(summaryPath) || this.fileMtime(chatPath) || Date.now();
    let lastTimestamp = firstTimestamp;
    let fileSize = 0;

    try {
      if (fs.existsSync(chatPath)) fileSize = fs.statSync(chatPath).size;
    } catch { /* ignore */ }

    if (fs.existsSync(summaryPath)) {
      try {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        aiTitle = String(summary.generated_title || summary.session_summary || '').trim();
        messageCount = Number(summary.num_chat_messages ?? summary.num_messages ?? 0) || 0;
        const created = this.parseTime(summary.created_at);
        const updated = this.parseTime(summary.updated_at);
        if (created) firstTimestamp = created;
        if (updated) lastTimestamp = updated;
      } catch { /* ignore */ }
    }

    if (fs.existsSync(chatPath)) {
      try {
        const firstUserPrompt = this.extractFirstUserPromptFromChat(chatPath);
        if (firstUserPrompt) title = firstUserPrompt;
        if (messageCount === 0) {
          const lines = fs.readFileSync(chatPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
          messageCount = lines.length;
        }
        lastTimestamp = this.fileMtime(chatPath) || lastTimestamp;
      } catch { /* ignore */ }
    }

    if (!title) title = aiTitle || sessionId.slice(0, 8);

    return {
      sessionId,
      title: this.truncateTitle(title),
      messageCount,
      lastTimestamp,
      firstTimestamp,
      cwd,
      fileSize,
      provider: 'grok',
    };
  }

  /**
   * First non-synthetic, non-context user turn — matches what appears as the
   * user bubble in chat after stripUserQueryWrapper.
   */
  private extractFirstUserPromptFromChat(chatPath: string): string {
    // Cap read size for list performance; first real user turn is almost always near the head.
    let raw = '';
    try {
      const fd = fs.openSync(chatPath, 'r');
      try {
        const stat = fs.fstatSync(fd);
        const max = Math.min(stat.size, 256 * 1024);
        const buf = Buffer.alloc(max);
        const n = fs.readSync(fd, buf, 0, max, 0);
        raw = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('"type"')) continue;
      let value: any;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (value?.type !== 'user' || value.synthetic_reason) continue;
      const rawText = this.extractContentText(value.content);
      if (this.isRuntimeContextUserText(rawText)) continue;
      // Prefer the typed <user_query> body. Messages often look like:
      //   <image_files>…path…</image_files>
      //   <user_query>图片上是啥?</user_query>
      // Older code skipped any turn that *started* with <image_files>, so the
      // list fell back to Grok's English generated_title ("What Is On The Image Query").
      const display = this.stripUserQueryWrapper(rawText);
      if (!display) continue;
      // Pure image bookkeeping with no usable typed text.
      if (/^\s*<image_files>/i.test(display)) continue;
      return display;
    }
    return '';
  }

  private truncateTitle(title: string, maxLen = 80): string {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length <= maxLen) return t;
    return `${t.slice(0, maxLen - 1)}…`;
  }

  private parseChatHistoryToMessages(chatPath: string): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    let counter = 0;
    const raw = fs.readFileSync(chatPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('"type"')) continue;
      let value: any;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const type = typeof value?.type === 'string' ? value.type : '';
      if (type === 'user') {
        if (value.synthetic_reason) continue;
        const rawText = this.extractContentText(value.content);
        if (this.isRuntimeContextUserText(rawText)) continue;
        const display = this.stripUserQueryWrapper(rawText);
        const imageBlocks = this.extractImageBlocks(value.content, rawText);
        // Keep turns that have either typed text or restored images.
        // Previously image-only / image+query turns lost their pictures on history reload
        // because we only built a text block and dropped `{type:"image", url:...}`.
        if (!display && imageBlocks.length === 0) continue;
        counter += 1;
        messages.push(this.buildUserMessage(display, imageBlocks, `grok-user-${counter}`));
      } else if (type === 'assistant') {
        const text = this.extractContentText(value.content);
        if (text.trim()) {
          counter += 1;
          messages.push(this.buildAssistantTextMessage(text, `grok-assistant-${counter}`));
        }
        const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
        for (const call of toolCalls) {
          if (!call || typeof call !== 'object') continue;
          const toolName = this.resolveToolName(call);
          const toolId = typeof call.id === 'string' ? call.id : `tool-${counter}`;
          const input = this.resolveToolInput(call);
          counter += 1;
          messages.push(this.buildToolUseMessage(toolId, toolName, input, `grok-tool-use-${counter}`));
        }
      } else if (type === 'tool_result' || type === 'function_call_output') {
        const toolUseId = typeof value.tool_call_id === 'string'
          ? value.tool_call_id
          : (typeof value.tool_use_id === 'string' ? value.tool_use_id : `tool-${counter}`);
        const content = this.extractContentText(value.content ?? value.output ?? value.result);
        counter += 1;
        messages.push(this.buildToolResultMessage(toolUseId, content, Boolean(value.is_error), `grok-tool-result-${counter}`));
      } else if (type === 'reasoning') {
        const text = this.extractReasoningSummary(value.summary);
        if (!text.trim()) continue;
        counter += 1;
        messages.push(this.buildAssistantThinkingMessage(text, `grok-reasoning-${counter}`));
      }
    }
    return messages;
  }

  /**
   * Frontend history/chat rendering expects Claude-style rows:
   *   { type, content, raw: { uuid?, message: { role, content: blocks } }, timestamp? }
   * not raw CLI jsonl rows with a top-level `message` field. Without `content`/`raw`,
   * shouldShowMessage / getMessageText treat every row as empty and the chat list is blank.
   */
  private buildGuiMessage(
    type: 'user' | 'assistant',
    role: 'user' | 'assistant',
    contentBlocks: unknown[],
    textContent: string,
    uuid: string,
  ) {
    return {
      type,
      content: textContent,
      raw: {
        uuid,
        message: {
          role,
          content: contentBlocks,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  private buildUserTextMessage(text: string, uuid: string) {
    return this.buildUserMessage(text, [], uuid);
  }

  /**
   * User history row: optional restored image blocks + typed text.
   * Frontend `normalizeBlocks` accepts Anthropic-style `{ type:'image', source:{type:'base64',...} }`.
   */
  private buildUserMessage(
    text: string,
    imageBlocks: Array<Record<string, unknown>>,
    uuid: string,
  ) {
    const contentBlocks: unknown[] = [...imageBlocks];
    if (text) {
      contentBlocks.push({ type: 'text', text });
    }
    // content string is used for titles / fallbacks; keep typed text only (no image_files XML).
    return this.buildGuiMessage('user', 'user', contentBlocks, text, uuid);
  }

  /**
   * Pull image blocks out of a Grok user turn.
   *
   * Grok CLI persists multimodal user turns as:
   *   content: [
   *     { type: 'text', text: '<image_files>\n1. /.../assets/image-xxx.png\n...</image_files>\n\n<user_query>...' },
   *     { type: 'image', url: 'data:image/png;base64,...' },
   *   ]
   * Live UI shows the image; history reload previously discarded the image entries.
   */
  private extractImageBlocks(content: unknown, rawText: string): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();

    const pushBlock = (block: Record<string, unknown> | null | undefined) => {
      if (!block || block.type !== 'image') return;
      const source = block.source && typeof block.source === 'object'
        ? (block.source as Record<string, unknown>)
        : undefined;
      const key = typeof source?.data === 'string'
        ? `data:${source.media_type || ''}:${(source.data as string).slice(0, 64)}`
        : typeof (block as any).src === 'string'
          ? `src:${(block as any).src}`
          : JSON.stringify(block);
      if (seen.has(key)) return;
      seen.add(key);
      blocks.push(block);
    };

    if (Array.isArray(content)) {
      for (const entry of content) {
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry as Record<string, unknown>;
        if (candidate.type !== 'image') continue;

        // Grok format: { type: 'image', url: 'data:image/...;base64,...' }
        if (typeof candidate.url === 'string' && candidate.url) {
          pushBlock(this.imageBlockFromDataUrlOrPath(candidate.url));
          continue;
        }
        // Anthropic / already-normalized: { type: 'image', source: { type, media_type, data } }
        if (candidate.source && typeof candidate.source === 'object') {
          const source = candidate.source as Record<string, unknown>;
          if (source.type === 'base64' && typeof source.data === 'string') {
            pushBlock({
              type: 'image',
              source: {
                type: 'base64',
                media_type: typeof source.media_type === 'string' ? source.media_type : 'image/png',
                data: source.data,
              },
            });
            continue;
          }
          if (source.type === 'url' && typeof source.url === 'string') {
            pushBlock(this.imageBlockFromDataUrlOrPath(source.url));
            continue;
          }
        }
        if (typeof candidate.src === 'string' && candidate.src) {
          pushBlock(this.imageBlockFromDataUrlOrPath(candidate.src));
        }
      }
    }

    // Fallback / supplement: paths listed inside <image_files>...</image_files>
    for (const filePath of this.extractImageFilePaths(rawText)) {
      pushBlock(imageBlockFromLocalPath(filePath) ?? undefined);
    }

    return blocks;
  }

  private imageBlockFromDataUrlOrPath(value: string): Record<string, unknown> | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) return null;

    const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed);
    if (dataUrl) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: dataUrl[1] || 'image/png',
          data: dataUrl[2],
        },
      };
    }

    // Absolute file path (or file:// URL) → read bytes
    const filePath = trimmed.startsWith('file://')
      ? decodeURIComponent(trimmed.slice('file://'.length))
      : trimmed;
    if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
      return imageBlockFromLocalPath(filePath);
    }

    // Relative-looking path: still try; imageBlockFromLocalPath returns null if missing
    if (filePath.includes('assets/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath)) {
      const fromPath = imageBlockFromLocalPath(filePath);
      if (fromPath) return fromPath;
    }

    return null;
  }

  /** Parse absolute paths from Grok's `<image_files>` bookkeeping block. */
  private extractImageFilePaths(text: string): string[] {
    if (!text || !text.includes('<image_files>')) return [];
    const match = text.match(/<image_files>([\s\S]*?)<\/image_files>/i);
    if (!match?.[1]) return [];
    const body = match[1];
    const paths: string[] = [];
    // Lines like: "1. /Users/.../assets/image-xxx.png"
    const lineRe = /^\s*(?:\d+\.\s*)?(\/?(?:Users|home|tmp|var|private|[A-Za-z]:)[^\r\n]+?\.(?:png|jpe?g|gif|webp|bmp|svg))\s*$/gim;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(body))) {
      const p = (m[1] || '').trim();
      if (p) paths.push(p);
    }
    // Also accept bare absolute paths without the "N." prefix / drive heuristics above
    if (paths.length === 0) {
      const looseRe = /(\/(?:Users|home|tmp|var|private)[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp|svg))/gi;
      while ((m = looseRe.exec(body))) {
        paths.push(m[1]);
      }
    }
    return paths;
  }

  private buildAssistantTextMessage(text: string, uuid: string) {
    return this.buildGuiMessage('assistant', 'assistant', [{ type: 'text', text }], text, uuid);
  }

  private buildAssistantThinkingMessage(text: string, uuid: string) {
    return this.buildGuiMessage(
      'assistant',
      'assistant',
      [{ type: 'thinking', thinking: text }],
      text,
      uuid,
    );
  }

  private buildToolUseMessage(id: string, name: string, input: unknown, uuid: string) {
    return this.buildGuiMessage(
      'assistant',
      'assistant',
      [{ type: 'tool_use', id, name, input: input && typeof input === 'object' ? input : {} }],
      '',
      uuid,
    );
  }

  private buildToolResultMessage(toolUseId: string, content: string, isError: boolean, uuid: string) {
    // Use the same display marker as live tool inserts so shouldShowMessage
    // hides standalone tool_result rows (results attach to the tool card via raw).
    return this.buildGuiMessage(
      'user',
      'user',
      [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }],
      '[tool_result]',
      uuid,
    );
  }

  private extractContentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === 'string') return block;
          if (block && typeof block === 'object') {
            const obj = block as Record<string, unknown>;
            if (typeof obj.text === 'string') return obj.text;
            if (typeof obj.content === 'string') return obj.content;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (content && typeof content === 'object') {
      const obj = content as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text;
    }
    return content == null ? '' : String(content);
  }

  private extractReasoningSummary(summary: unknown): string {
    if (typeof summary === 'string') return summary;
    if (Array.isArray(summary)) {
      return summary
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && typeof (item as any).text === 'string') {
            return (item as any).text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  private resolveToolName(call: any): string {
    return (
      call?.function?.name
      || call?.name
      || call?.tool_name
      || 'tool'
    );
  }

  private resolveToolInput(call: any): unknown {
    const args = call?.function?.arguments ?? call?.arguments ?? call?.input;
    if (typeof args === 'string') {
      try {
        return JSON.parse(args);
      } catch {
        return { raw: args };
      }
    }
    return args && typeof args === 'object' ? args : {};
  }

  private stripUserQueryWrapper(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';

    // Prefer the explicit <user_query> body when present (may sit after <image_files>).
    const queryMatch = trimmed.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
    if (queryMatch) {
      return (queryMatch[1] || '').trim();
    }

    // Drop Grok's image bookkeeping block; keep any remaining prose.
    const withoutImageFiles = trimmed
      .replace(/<image_files>[\s\S]*?<\/image_files>\s*/gi, '')
      .trim();
    return withoutImageFiles;
  }

  private isRuntimeContextUserText(text: string): boolean {
    // Grok injects system/context turns as user rows; hide them from the chat timeline.
    // Do not filter <image_files> — those are real user attachments.
    return /<ide_selection>|<opened_file>|<workspace_path>|<user_info>|<system-reminder>/i.test(text);
  }

  private resolveSessionDir(sessionId: string, cwd?: string): string | undefined {
    if (!this.isValidSessionId(sessionId)) return undefined;
    if (cwd) {
      for (const encoded of [this.encodeCwd(cwd), this.encodeCwd(this.canonicalizePath(cwd))]) {
        const direct = path.join(this.sessionsRoot, encoded, sessionId);
        if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
      }
    }
    return this.findSessionDirById(sessionId) ?? undefined;
  }

  private findSessionDirById(sessionId: string): string | null {
    if (!fs.existsSync(this.sessionsRoot)) return null;
    for (const cwdEntry of fs.readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!cwdEntry.isDirectory()) continue;
      const candidate = path.join(this.sessionsRoot, cwdEntry.name, sessionId);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    }
    return null;
  }

  private isValidSessionId(sessionId: string): boolean {
    if (!sessionId || typeof sessionId !== 'string') return false;
    const trimmed = sessionId.trim();
    return !!trimmed && !trimmed.includes('/') && !trimmed.includes('\\') && !trimmed.includes('..');
  }

  private encodeCwd(cwd: string): string {
    // Match Grok CLI session dir naming (see ai-bridge encodeGrokSessionCwd):
    // normalize separators and strip trailing slashes before encoding.
    const normalized = String(cwd || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    return encodeURIComponent(normalized);
  }

  private decodeCwd(encoded: string): string {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  private canonicalizePath(input: string): string {
    try {
      return fs.realpathSync(input);
    } catch {
      return input;
    }
  }

  private fileMtime(filePath: string): number {
    try {
      if (!fs.existsSync(filePath)) return 0;
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private parseTime(value: unknown): number {
    if (typeof value !== 'string' || !value.trim()) return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  private deleteRecursively(target: string): void {
    fs.rmSync(target, { recursive: true, force: true });
  }

  private defaultSessionsRoot(): string {
    const home = process.env.GROK_HOME?.trim() || path.join(os.homedir(), '.grok');
    return path.join(home, 'sessions');
  }
}
