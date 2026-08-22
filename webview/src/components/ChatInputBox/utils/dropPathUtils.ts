/**
 * Helpers for extracting file paths from drag-and-drop DataTransfer.
 *
 * VS Code Explorer often provides text/uri-list / resourceurls rather than text/plain.
 * OS / webview File objects frequently only expose `name` (no absolute path) — those
 * must be resolved on the extension host (Mac/Windows path differences).
 */

export type DropPathPayload = {
  /** Raw URI strings (file://, vscode-*, etc.) */
  uris: string[];
  /** Bare file names without directory separators (need host resolve) */
  names: string[];
  /** Plain-text snippets that look like paths */
  texts: string[];
  /** Already-absolute paths (File.path, converted file://, etc.) */
  absolutePaths: string[];
};

/** True if value looks like an absolute filesystem path (Mac or Windows). */
export function isAbsoluteFsPath(value: string): boolean {
  const t = value.trim();
  if (!t) return false;
  // Unix / macOS
  if (t.startsWith('/')) return true;
  // Windows drive: C:\ or C:/
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  // Windows UNC: \\server\share
  if (t.startsWith('\\\\')) return true;
  return false;
}

/** Convert a file:// (or plain path) URI into a local filesystem path (best-effort in webview). */
export function uriToLocalPath(uri: string): string {
  const raw = uri.trim();
  if (!raw) return '';

  if (raw.startsWith('file:')) {
    try {
      const url = new URL(raw);
      let pathname = decodeURIComponent(url.pathname);
      // Windows: file:///C:/Users/... → /C:/Users/... → C:/Users/...
      if (/^\/[A-Za-z]:\//.test(pathname)) {
        pathname = pathname.slice(1);
      }
      // file://localhost/Users/... → /Users/...
      if (url.hostname && url.hostname !== 'localhost' && url.hostname !== '') {
        // UNC-style file://server/share → keep server as \\server\share best-effort
        return `//${url.hostname}${pathname}`.replace(/\//g, '\\');
      }
      return pathname;
    } catch {
      const stripped = raw.replace(/^file:\/\//i, '');
      if (/^\/[A-Za-z]:\//.test(stripped)) return decodeURIComponent(stripped.slice(1));
      return decodeURIComponent(stripped);
    }
  }

  return raw;
}

function pushUnique(list: string[], value: string): void {
  const v = value.trim();
  if (!v) return;
  if (!list.includes(v)) list.push(v);
}

/**
 * Collect drop candidates for host-side absolute path resolution.
 * Prefer uris / absolute paths; bare names go through workspace lookup on the host.
 */
export function collectDropPathPayload(
  dataTransfer: DataTransfer | null | undefined
): DropPathPayload {
  const uris: string[] = [];
  const names: string[] = [];
  const texts: string[] = [];
  const absolutePaths: string[] = [];

  if (!dataTransfer) {
    return { uris, names, texts, absolutePaths };
  }

  // Gather all string MIME types (VS Code may use non-standard type names).
  const typeSet = new Set<string>(Array.from(dataTransfer.types ?? []));
  // Always try these even if types[] is incomplete in some hosts.
  for (const t of [
    'text/uri-list',
    'application/vnd.code.uri-list',
    'resourceurls',
    'text/plain',
    'text/html',
  ]) {
    typeSet.add(t);
  }

  for (const type of typeSet) {
    let data = '';
    try {
      data = dataTransfer.getData(type) ?? '';
    } catch {
      continue;
    }
    if (!data.trim()) continue;

    if (type === 'resourceurls') {
      try {
        const parsed: unknown = JSON.parse(data);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item.trim()) {
              if (item.includes('://') || item.startsWith('file:')) pushUnique(uris, item.trim());
              else if (isAbsoluteFsPath(item)) pushUnique(absolutePaths, item.trim());
              else pushUnique(texts, item.trim());
            }
          }
        }
      } catch {
        // ignore
      }
      continue;
    }

    if (type === 'text/uri-list' || type === 'application/vnd.code.uri-list' || type.includes('uri-list')) {
      for (const line of data.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        pushUnique(uris, trimmed);
      }
      continue;
    }

    if (type === 'text/plain') {
      const candidates = data.includes('\n') ? data.split(/\r?\n/) : [data];
      for (const candidate of candidates) {
        const t = candidate.trim();
        if (!t) continue;
        if (t.startsWith('file:') || t.includes('://')) {
          pushUnique(uris, t);
        } else if (isAbsoluteFsPath(t) || t.includes('/') || t.includes('\\')) {
          if (isAbsoluteFsPath(t)) pushUnique(absolutePaths, t);
          else pushUnique(texts, t);
        }
      }
      continue;
    }
  }

  // File objects: path (Electron) or bare name fallback
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i] as File & { path?: string };
      if (typeof file.path === 'string' && file.path.trim()) {
        pushUnique(absolutePaths, file.path.trim());
      } else if (file.name && !file.type.startsWith('image/')) {
        // Webview often only has the basename — host must resolve.
        pushUnique(names, file.name);
      }
    }
  }

  // Also convert any URI we already understand into absolutePaths for faster host path
  for (const uri of uris) {
    const local = uriToLocalPath(uri);
    if (local && isAbsoluteFsPath(local)) {
      pushUnique(absolutePaths, local);
    }
  }

  return { uris, names, texts, absolutePaths };
}

/**
 * Collect local file paths available purely on the client (no host round-trip).
 * Returns only absolute paths; bare names are excluded (they need host resolve).
 */
export function extractPathsFromDataTransfer(dataTransfer: DataTransfer | null | undefined): string[] {
  const payload = collectDropPathPayload(dataTransfer);
  const paths: string[] = [];
  for (const p of payload.absolutePaths) {
    pushUnique(paths, p);
  }
  for (const uri of payload.uris) {
    const local = uriToLocalPath(uri);
    if (local && isAbsoluteFsPath(local)) pushUnique(paths, local);
  }
  for (const t of payload.texts) {
    if (isAbsoluteFsPath(t)) pushUnique(paths, t);
  }
  return paths;
}

/** Whether the drag payload looks like external files / explorer resources. */
export function isExternalFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types ?? []);
  return (
    types.includes('Files') ||
    types.includes('text/uri-list') ||
    types.includes('application/vnd.code.uri-list') ||
    types.includes('resourceurls')
  );
}

/** True when the event target is inside the chat input drop zone. */
export function isInsideChatInputDropZone(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.chat-input-box'));
}

/** True when payload still needs extension-host resolution (bare names / relative texts). */
export function needsHostPathResolve(payload: DropPathPayload): boolean {
  if (payload.names.length > 0) return true;
  if (payload.texts.some((t) => !isAbsoluteFsPath(t))) return true;
  // Have uris but no absolute conversion on client (odd schemes) → host parse
  if (payload.uris.length > 0 && payload.absolutePaths.length === 0) return true;
  return false;
}
