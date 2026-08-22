// Parses a pasted GitHub Copilot / VS Code MCP config (root key `servers`, an object keyed
// by server id) into the internal MCP server shape used by the existing add/save path. Pure
// string-in/object-out logic so it can be unit tested without any bridge/webview plumbing.

const PASS_THROUGH_FIELDS = ['command', 'args', 'env', 'url', 'type', 'x-metadata'] as const;

export interface CopilotImportServerApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
}

export interface CopilotImportServerResult {
  id: string;
  name: string;
  server: Record<string, unknown>;
  apps: CopilotImportServerApps;
  enabled: boolean;
}

export interface CopilotImportResult {
  servers: CopilotImportServerResult[];
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Copies header entries, dropping any value that is `null`/`undefined`. Later calls win on key conflicts. */
function copyNonNullHeaders(headers: unknown, into: Record<string, string>): void {
  if (!isPlainObject(headers)) return;
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null && value !== undefined) {
      into[key] = String(value);
    }
  }
}

/** Merges `requestInit.headers` (Copilot's fetch-style init object) with the direct `headers` field; direct wins. */
function mergeCopilotHeaders(source: Record<string, unknown>): Record<string, string> {
  const merged: Record<string, string> = {};
  const requestInit = isPlainObject(source.requestInit) ? source.requestInit : undefined;
  copyNonNullHeaders(requestInit?.headers, merged);
  copyNonNullHeaders(source.headers, merged);
  return merged;
}

/** A command implies stdio; a `/sse` URL implies sse; any other URL implies http; otherwise stdio. */
function inferCopilotServerType(spec: Record<string, unknown>): string {
  if (spec.command !== undefined && spec.command !== null) return 'stdio';
  const url = typeof spec.url === 'string' ? spec.url : undefined;
  if (url) return url.includes('/sse') ? 'sse' : 'http';
  return 'stdio';
}

function buildCopilotServerEntry(id: string, source: Record<string, unknown>, isCodexMode: boolean): CopilotImportServerResult {
  const spec: Record<string, unknown> = {};
  for (const field of PASS_THROUGH_FIELDS) {
    const value = source[field];
    if (value !== undefined && value !== null) {
      spec[field] = value;
    }
  }

  const headers = mergeCopilotHeaders(source);
  if (Object.keys(headers).length > 0) {
    spec.headers = headers;
  }

  if (spec.type === undefined) {
    spec.type = inferCopilotServerType(spec);
  }

  return {
    id,
    name: firstNonEmptyString(source.name) ?? id,
    server: spec,
    apps: { claude: !isCodexMode, codex: !!isCodexMode, gemini: false },
    enabled: true,
  };
}

/**
 * Parses a raw pasted GitHub Copilot MCP config string (`{ "servers": { ... } }`) into the
 * internal server-entry shape. Any parse error, or a missing/empty `servers` object, produces
 * `{ servers: [], error }` rather than throwing.
 */
export function parseCopilotMcpConfig(rawJson: string, isCodexMode = false): CopilotImportResult {
  try {
    const config = JSON.parse(rawJson);
    const serversRaw = isPlainObject(config) ? config.servers : undefined;
    if (!isPlainObject(serversRaw) || Object.keys(serversRaw).length === 0) {
      return { servers: [], error: 'No servers found in config' };
    }

    const servers = Object.entries(serversRaw)
      .filter(([, value]) => isPlainObject(value))
      .map(([id, value]) => buildCopilotServerEntry(id, value as Record<string, unknown>, isCodexMode));

    if (servers.length === 0) {
      return { servers: [], error: 'No servers found in config' };
    }
    return { servers };
  } catch (error) {
    return { servers: [], error: error instanceof Error ? error.message : String(error) };
  }
}
