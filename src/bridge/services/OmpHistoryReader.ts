import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface OmpSessionInfo {
  sessionId: string;
  title: string;
  messageCount: number;
  lastTimestamp: number;
  firstTimestamp: number;
  cwd: string;
  fileSize: number;
  provider: 'omp';
}

const MAX_TITLE_CHARS = 80;
const MAX_TOOL_RESULT_CHARS = 20_000;
/** OMP files lead with a `type=title` line; scan a bounded prefix for the session header. */
const MAX_HEADER_SCAN_LINES = 20;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

interface SessionHeader {
  sessionId: string;
  cwd: string;
  timestamp: number;
}

/**
 * Reads OMP CLI session history from `~/.omp/agent/sessions/`.
 *
 * Layout (cross-platform, including Windows):
 *   ~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
 * OMP session files may begin with a `type=title` line; the `type=session`
 * header with `id` + `cwd` follows (not necessarily on line 1).
 * Message lines use `type=message` with roles `user`/`assistant`/`toolResult`.
 *
 * Ported from jetbrains-cc-gui's OmpHistoryReader.java. Path matching is
 * case-insensitive and normalizes `\` → `/` so Windows project paths match
 * sessions written by the OMP CLI. Message rows use the same GUI envelope
 * shape as GrokHistoryReader so the webview renders them unchanged.
 */
export class OmpHistoryReader {
  private readonly sessionsRoot: string;

  constructor(sessionsRoot?: string) {
    this.sessionsRoot = sessionsRoot ?? OmpHistoryReader.defaultSessionsRoot();
  }

  private static defaultSessionsRoot(): string {
    // omp honors the PI-prefixed env overrides (fork lineage).
    const override = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
    if (override) return override;
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
    if (agentDir) return path.join(agentDir, 'sessions');
    return path.join(os.homedir(), '.omp', 'agent', 'sessions');
  }

  getSessionsForProject(projectPath: string): {
    success: boolean;
    sessions: OmpSessionInfo[];
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
        error: `Failed to read OMP sessions: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  listSessionsForProject(projectPath: string): OmpSessionInfo[] {
    const all = this.listAllSessions();
    if (!projectPath || !projectPath.trim()) return all;
    const filtered = all.filter((session) => session.cwd && pathsMatch(session.cwd, projectPath));
    filtered.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    return filtered;
  }

  listAllSessions(): OmpSessionInfo[] {
    const sessions: OmpSessionInfo[] = [];
    if (!this.isDirectory(this.sessionsRoot)) return sessions;
    for (const cwdEntry of fs.readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!cwdEntry.isDirectory() || cwdEntry.name.startsWith('.')) continue;
      const cwdDir = path.join(this.sessionsRoot, cwdEntry.name);
      for (const fileEntry of fs.readdirSync(cwdDir, { withFileTypes: true })) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
        const info = this.readSessionSummary(path.join(cwdDir, fileEntry.name));
        if (info) sessions.push(info);
      }
    }
    sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    return sessions;
  }

  private readSessionSummary(file: string): OmpSessionInfo | null {
    try {
      let header: SessionHeader | null = null;
      let firstUserPrompt: string | null = null;
      let messageCount = 0;
      let lastTs = 0;

      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const type = text(obj, 'type');
        if (type === 'session' && !header) {
          header = this.parseHeader(obj, file);
          continue;
        }
        if (type !== 'message') continue;
        const message = obj?.message && typeof obj.message === 'object' ? obj.message : null;
        if (!message) continue;
        const role = text(message, 'role');
        const ts = parseTimestamp(obj, message);
        if (ts > lastTs) lastTs = ts;
        if (role === 'user') {
          messageCount += 1;
          if (firstUserPrompt === null) {
            const body = extractTextBlocks(message.content);
            if (body.trim()) firstUserPrompt = body;
          }
        } else if (role === 'assistant') {
          messageCount += 1;
        }
      }

      if (!header) header = headerFromFileName(file);
      if (!header || !header.sessionId || !header.sessionId.trim()) return null;

      const fileSize = this.fileSize(file);
      const mtime = this.fileMtime(file);
      const firstTimestamp = header.timestamp > 0 ? header.timestamp : mtime;
      const lastTimestamp = lastTs > 0 ? lastTs : mtime;
      return {
        sessionId: header.sessionId,
        title: firstUserPrompt && firstUserPrompt.trim()
          ? truncate(firstUserPrompt, MAX_TITLE_CHARS)
          : `OMP session ${shortId(header.sessionId)}`,
        messageCount,
        lastTimestamp,
        firstTimestamp: firstTimestamp > 0 ? firstTimestamp : lastTimestamp,
        cwd: header.cwd,
        fileSize,
        provider: 'omp',
      };
    } catch {
      return null;
    }
  }

  private parseHeader(obj: any, file: string): SessionHeader {
    const header: SessionHeader = {
      sessionId: text(obj, 'id') ?? '',
      cwd: text(obj, 'cwd') ?? '',
      timestamp: parseIsoMillis(text(obj, 'timestamp')),
    };
    if (!header.sessionId.trim()) {
      const fromName = headerFromFileName(file);
      if (fromName) header.sessionId = fromName.sessionId;
    }
    return header;
  }

  /**
   * Load session transcript as GUI message rows (same shape as GrokHistoryReader).
   */
  getSessionMessages(sessionId: string, cwd?: string): Array<Record<string, unknown>> {
    const file = this.resolveSessionFile(sessionId, cwd);
    if (!file || !this.isFile(file)) return [];
    try {
      return this.parseMessages(file);
    } catch {
      return [];
    }
  }

  deleteSession(sessionId: string, projectPath?: string): boolean {
    if (!isSafeSessionId(sessionId)) return false;
    const file = this.resolveSessionFile(sessionId, projectPath);
    if (!file || !this.isFile(file)) return false;
    try {
      fs.rmSync(file, { force: true });
      const parent = path.dirname(file);
      if (this.isDirectory(parent)) {
        try {
          if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
        } catch { /* ignore */ }
      }
      return true;
    } catch {
      return false;
    }
  }

  private resolveSessionFile(sessionId: string, cwd?: string): string | null {
    if (!isSafeSessionId(sessionId)) return null;
    const id = sessionId.trim();
    if (!this.isDirectory(this.sessionsRoot)) return null;
    // Prefer exact match under any cwd dir; filter by cwd when multiple.
    let fallback: string | null = null;
    for (const cwdEntry of fs.readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!cwdEntry.isDirectory()) continue;
      const cwdDir = path.join(this.sessionsRoot, cwdEntry.name);
      for (const fileEntry of fs.readdirSync(cwdDir, { withFileTypes: true })) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
        const file = path.join(cwdDir, fileEntry.name);
        const header = this.readSessionHeader(file) ?? headerFromFileName(file);
        if (!header || header.sessionId !== id) continue;
        if (cwd && cwd.trim() && header.cwd && pathsMatch(header.cwd, cwd)) {
          return file;
        }
        if (!fallback) fallback = file;
      }
    }
    return fallback;
  }

  /**
   * OMP session files lead with a `type=title` line, so the `type=session`
   * header is not necessarily line 1 — scan the first MAX_HEADER_SCAN_LINES
   * lines and stop at the first session header.
   */
  private readSessionHeader(file: string): SessionHeader | null {
    let raw = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const stat = fs.fstatSync(fd);
        const max = Math.min(stat.size, 64 * 1024);
        const buf = Buffer.alloc(max);
        const n = fs.readSync(fd, buf, 0, max, 0);
        raw = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
    let scanned = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (scanned >= MAX_HEADER_SCAN_LINES) break;
      scanned += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (text(obj, 'type') === 'session') {
          return this.parseHeader(obj, file);
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  private parseMessages(file: string): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    let counter = 0;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (text(obj, 'type') !== 'message') continue;
      const message = obj?.message && typeof obj.message === 'object' ? obj.message : null;
      if (!message) continue;
      const role = text(message, 'role');
      const entryId = text(obj, 'id');
      if (role === 'user') {
        const body = extractTextBlocks(message.content);
        if (!body.trim()) continue;
        counter += 1;
        messages.push(buildUserTextMessage(body, entryId ?? `omp-user-${counter}`));
      } else if (role === 'assistant') {
        const fromAssistant = convertAssistantMessage(message, entryId, counter);
        counter += fromAssistant.length;
        messages.push(...fromAssistant);
      } else if (role === 'toolResult') {
        let callId = text(message, 'toolCallId');
        if (!callId || !callId.trim()) {
          counter += 1;
          callId = `omp-tool-${counter}`;
        }
        const content = truncate(extractTextBlocks(message.content), MAX_TOOL_RESULT_CHARS);
        const isError = message.isError === true;
        messages.push(buildToolResultMessage(callId, content, isError));
      }
    }
    return messages;
  }

  private isDirectory(candidate: string): boolean {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  private isFile(candidate: string): boolean {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }

  private fileSize(file: string): number {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  private fileMtime(file: string): number {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }
}

function headerFromFileName(file: string): SessionHeader | null {
  const name = path.basename(file);
  if (!name.endsWith('.jsonl')) return null;
  const stem = name.slice(0, name.length - '.jsonl'.length);
  const underscore = stem.lastIndexOf('_');
  if (underscore <= 0 || underscore >= stem.length - 1) return null;
  return { sessionId: stem.slice(underscore + 1), cwd: '', timestamp: 0 };
}

function convertAssistantMessage(
  message: any,
  entryId: string | null,
  counterBase: number,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const contentEl = message?.content;
  if (!Array.isArray(contentEl)) return out;
  let n = counterBase;
  let textBuf = '';
  let thinkBuf = '';
  for (const el of contentEl) {
    if (!el || typeof el !== 'object') continue;
    const type = text(el, 'type');
    if (type === 'text') {
      const t = text(el, 'text');
      if (t) textBuf = textBuf ? `${textBuf}\n${t}` : t;
    } else if (type === 'thinking') {
      const t = text(el, 'thinking');
      if (t) thinkBuf = thinkBuf ? `${thinkBuf}\n${t}` : t;
    } else if (type === 'toolCall') {
      // Flush pending text/thinking before tool use so order is preserved.
      if (thinkBuf) {
        n += 1;
        out.push(buildAssistantThinkingMessage(thinkBuf, entryId ? `${entryId}-think-${n}` : `omp-think-${n}`));
        thinkBuf = '';
      }
      if (textBuf) {
        n += 1;
        out.push(buildAssistantTextMessage(textBuf, entryId ? `${entryId}-text-${n}` : `omp-text-${n}`));
        textBuf = '';
      }
      let toolId = text(el, 'id');
      if (!toolId || !toolId.trim()) {
        n += 1;
        toolId = `omp-tool-${n}`;
      }
      const name = text(el, 'name')?.trim() || 'tool';
      const input = el.arguments && typeof el.arguments === 'object' ? el.arguments : {};
      out.push(buildToolUseMessage(toolId, name, input));
    }
  }
  if (thinkBuf) {
    n += 1;
    out.push(buildAssistantThinkingMessage(thinkBuf, entryId ? `${entryId}-think-${n}` : `omp-think-${n}`));
  }
  if (textBuf) {
    n += 1;
    out.push(buildAssistantTextMessage(textBuf, entryId ? `${entryId}-text-${n}` : `omp-text-${n}`));
  }
  return out;
}

/**
 * Frontend history/chat rendering expects Claude-style rows:
 *   { type, content, raw: { uuid?, message: { role, content: blocks } }, timestamp? }
 */
function buildGuiMessage(
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

function buildUserTextMessage(body: string, uuid: string) {
  return buildGuiMessage('user', 'user', [{ type: 'text', text: body }], body, uuid);
}

function buildAssistantTextMessage(body: string, uuid: string) {
  return buildGuiMessage('assistant', 'assistant', [{ type: 'text', text: body }], body, uuid);
}

function buildAssistantThinkingMessage(body: string, uuid: string) {
  return buildGuiMessage(
    'assistant',
    'assistant',
    [{ type: 'thinking', thinking: body }],
    body,
    uuid,
  );
}

function buildToolUseMessage(id: string, name: string, input: unknown) {
  return buildGuiMessage(
    'assistant',
    'assistant',
    [{ type: 'tool_use', id, name, input: input && typeof input === 'object' ? input : {} }],
    '',
    id,
  );
}

function buildToolResultMessage(toolUseId: string, content: string, isError: boolean) {
  // Same display marker as live tool inserts so shouldShowMessage hides
  // standalone tool_result rows (results attach to the tool card via raw).
  return buildGuiMessage(
    'user',
    'user',
    [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }],
    '[tool_result]',
    toolUseId,
  );
}

function extractTextBlocks(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const el of content) {
    if (!el || typeof el !== 'object') continue;
    const block = el as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'text' || !type) {
      const t = typeof block.text === 'string' ? block.text : '';
      if (t) parts.push(t);
    }
  }
  return parts.join('\n');
}

function text(obj: any, field: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const value = obj[field];
  if (value == null) return null;
  try {
    return String(value);
  } catch {
    return null;
  }
}

function parseTimestamp(entry: any, message: any): number {
  const fromEntry = parseIsoMillis(text(entry, 'timestamp'));
  if (fromEntry > 0) return fromEntry;
  const raw = message?.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return 0;
}

function parseIsoMillis(iso: string | null): number {
  if (!iso || !iso.trim()) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function truncate(value: string, max: number): string {
  const t = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function isSafeSessionId(sessionId: string): boolean {
  const id = String(sessionId ?? '').trim();
  if (!id) return false;
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false;
  return SESSION_ID_PATTERN.test(id);
}

/** Ported from jetbrains-cc-gui's HistoryPathMatcher (case-insensitive, bidirectional). */
function normalizePath(value: string): string {
  let p = String(value ?? '').trim().replace(/\\/g, '/');
  if (p.length >= 2 && p[1] === ':') {
    p = p[0].toLowerCase() + p.slice(1);
  }
  while (p.endsWith('/') && p.length > 1) {
    p = p.slice(0, -1);
  }
  return p;
}

function stripPrivatePrefix(value: string): string {
  return value.startsWith('/private/') ? value.slice('/private'.length) : value;
}

function pathsMatch(sessionCwd: string, projectPath: string): boolean {
  const a = normalizePath(sessionCwd).toLowerCase();
  const b = normalizePath(projectPath).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  // macOS /tmp vs /private/tmp
  const a2 = stripPrivatePrefix(a);
  const b2 = stripPrivatePrefix(b);
  if (a2 === b2) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
    || a2.startsWith(`${b2}/`) || b2.startsWith(`${a2}/`);
}
