// MCP server marketplace: types, disk cache, pure entry-normalization/search logic, and the
// network orchestration for the 3 remote-capable sources (built-in is synchronous).
//
// This is intentionally one file rather than the usual per-concern split: the extension-host
// test runner (`node --experimental-strip-types`) resolves relative ESM imports against the
// literal on-disk filename, which requires either exact `.ts` extensions in every import (that
// breaks `tsc` unless `allowImportingTsExtensions` is set — see the pre-existing, deliberately
// untouched issue in `setupWizardHelpers.ts`) or, as the rest of this codebase does, no local
// relative imports at all in a file that a `*.test.mts` imports directly. Keeping every piece
// that `McpMarketplaceService` needs in one dependency-free module lets it stay fully unit
// testable. Network access is injected via `fetchJson` (see `./mcpMarketplaceHttp.ts` for the
// real implementation), so this file itself only ever imports `fs`/`path`/`url`.
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';

// ─── Types ────────────────────────────────────────────────────────────────────

export type McpMarketplaceSourceType = 'BUILT_IN' | 'REGISTRY' | 'GITHUB_ORG';

export interface McpMarketplaceSource {
  id: string;
  name: string;
  type: McpMarketplaceSourceType;
  url: string;
  enabled: boolean;
}

export type McpInstallTransportType = 'stdio' | 'http' | 'sse';

export type McpInstallRiskLevel = 'local-command' | 'verified' | 'unverified-command' | 'remote';

export interface McpInstallOption {
  label: string;
  type: McpInstallTransportType;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  riskLevel: McpInstallRiskLevel;
}

export interface McpMarketplaceEntry {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  sourceId: string;
  sourceName: string;
  sourceType: McpMarketplaceSourceType;
  official: boolean;
  tags: string[];
  installOptions: McpInstallOption[];
  homepage?: string;
  repositoryUrl?: string;
}

export type McpMarketplaceFetchJson = (url: string) => Promise<unknown>;

/** The 4 marketplace sources this extension ships with. Never built from user input. */
export const MCP_MARKETPLACE_SOURCES: readonly McpMarketplaceSource[] = [
  { id: 'built-in', name: 'Built-in Presets', type: 'BUILT_IN', url: 'codriver://built-in-mcp-presets', enabled: true },
  { id: 'official-registry', name: 'Official MCP Registry', type: 'REGISTRY', url: 'https://registry.modelcontextprotocol.io', enabled: true },
  { id: 'github-mcp-registry', name: 'GitHub MCP Registry', type: 'REGISTRY', url: 'https://api.mcp.github.com', enabled: true },
  { id: 'official-github-org', name: 'modelcontextprotocol org', type: 'GITHUB_ORG', url: 'https://github.com/modelcontextprotocol', enabled: true },
];

/** Runners the marketplace trusts without flagging the install option as unverified. */
const KNOWN_RUNNERS = new Set([
  'npx', 'uvx', 'uv', 'pnpm', 'pnpx', 'bunx', 'node', 'deno', 'python', 'python3', 'docker', 'podman',
]);

/** Container/runner flags that grant host access or escalate privilege. */
const DANGEROUS_RUNNER_FLAGS = new Set([
  '--privileged', '--cap-add', '--device', '--pid', '--ipc', '--userns', '--network', '--net',
  '-v', '--volume', '--mount',
]);

// ─── Disk cache ───────────────────────────────────────────────────────────────

export const MCP_MARKETPLACE_CACHE_TTL_MS = 60 * 60 * 1000;

/** Filenames must never escape the cache directory or collide across unrelated keys. */
export function sanitizeMcpMarketplaceCacheKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function cacheFilePath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${sanitizeMcpMarketplaceCacheKey(key)}.json`);
}

export interface ReadMcpMarketplaceCacheOptions {
  /** Cache age cutoff in ms. Ignored when `allowStale` is true. */
  ttlMs?: number;
  /** When true, return the cached value regardless of age (used for failure fallback). */
  allowStale?: boolean;
}

/** Reads a cached entry, honoring the TTL unless `allowStale` is set. Returns `undefined` on any miss/error. */
export function readMcpMarketplaceCache(cacheDir: string, key: string, options: ReadMcpMarketplaceCacheOptions = {}): unknown {
  const file = cacheFilePath(cacheDir, key);
  try {
    const stat = fs.statSync(file);
    if (!options.allowStale) {
      const ttlMs = options.ttlMs ?? MCP_MARKETPLACE_CACHE_TTL_MS;
      if (Date.now() - stat.mtimeMs > ttlMs) {
        return undefined;
      }
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Writes a cache entry atomically: write to `{file}.tmp`, then rename over the real path. */
export function writeMcpMarketplaceCache(cacheDir: string, key: string, data: unknown): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = cacheFilePath(cacheDir, key);
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf8');
  fs.renameSync(tmpFile, file);
}

// ─── Built-in presets ────────────────────────────────────────────────────────

interface BuiltInPresetDefinition {
  id: string;
  displayName: string;
  description: string;
  packageName: string;
}

const BUILT_IN_PRESETS: readonly BuiltInPresetDefinition[] = [
  { id: 'fetch', displayName: 'fetch', description: 'Fetch web pages and convert them into model-friendly content.', packageName: 'mcp-server-fetch' },
  { id: 'time', displayName: 'time', description: 'Provide current time and timezone conversion utilities.', packageName: '@modelcontextprotocol/server-time' },
  { id: 'memory', displayName: 'memory', description: 'Persist and query a local knowledge graph across chats.', packageName: '@modelcontextprotocol/server-memory' },
  { id: 'sequential-thinking', displayName: 'sequential-thinking', description: 'Expose a structured sequential-thinking tool for planning and reasoning.', packageName: '@modelcontextprotocol/server-sequential-thinking' },
  { id: 'context7', displayName: 'context7', description: 'Retrieve current library documentation and code examples.', packageName: '@upstash/context7-mcp' },
];

export function builtInMarketplaceEntries(source: McpMarketplaceSource): McpMarketplaceEntry[] {
  return BUILT_IN_PRESETS.map((preset) => ({
    id: `${source.id}:${preset.id}`,
    name: preset.id,
    displayName: preset.displayName,
    description: preset.description,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    official: true,
    tags: [],
    installOptions: [
      { label: 'npx', type: 'stdio' as const, command: 'npx', args: ['-y', preset.packageName], riskLevel: 'local-command' as const },
    ],
  }));
}

// ─── MCP-registry entries ────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function asArrayOf(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function shortName(name: string | undefined): string {
  if (!name) return '';
  const slash = name.lastIndexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** The canonical modelcontextprotocol registry is the only source whose "official" _meta is trusted. */
function isTrustedOfficialSource(source: McpMarketplaceSource): boolean {
  try {
    return new URL(source.url).hostname.toLowerCase() === 'registry.modelcontextprotocol.io';
  } catch {
    return false;
  }
}

function isOfficialEnvelope(envelope: Record<string, any>): boolean {
  const meta = asRecord(envelope._meta);
  const official = meta['io.modelcontextprotocol.registry/official'];
  if (!official || typeof official !== 'object') return false;
  return 'id' in official || 'publishedAt' in official || 'isLatest' in official;
}

function normalizeRegistryType(registryType: unknown): 'npm' | 'pypi' | 'docker' | '' {
  if (typeof registryType !== 'string') return '';
  const normalized = registryType.trim().toLowerCase();
  if (normalized.includes('npm')) return 'npm';
  if (normalized.includes('pypi') || normalized.includes('python') || normalized.includes('uv')) return 'pypi';
  if (normalized.includes('docker') || normalized.includes('oci')) return 'docker';
  return '';
}

function fallbackCommandForRegistryType(registryType: 'npm' | 'pypi' | 'docker' | ''): string | undefined {
  if (registryType === 'npm') return 'npx';
  if (registryType === 'pypi') return 'uvx';
  if (registryType === 'docker') return 'docker';
  return undefined;
}

function normalizePackageTransport(type: unknown): McpInstallTransportType {
  if (typeof type !== 'string') return 'stdio';
  const lower = type.toLowerCase();
  if (lower.includes('sse')) return 'sse';
  if (lower.includes('http')) return 'http';
  return 'stdio';
}

/** Renders MCP-registry argument descriptors (named/positional) into a flat CLI arg list. */
function renderArguments(rawArguments: unknown): string[] {
  const result: string[] = [];
  for (const raw of asArrayOf(rawArguments)) {
    if (typeof raw === 'string') {
      result.push(raw);
      continue;
    }
    const arg = asRecord(raw);
    const argType = firstNonEmptyString(arg.type) ?? 'positional';
    const hint = firstNonEmptyString(arg.valueHint, arg.value_hint);
    const value = firstNonEmptyString(arg.value, arg.default, arg.defaultValue) ?? (hint ? `{${hint}}` : undefined);
    if (argType.toLowerCase() === 'named') {
      const name = firstNonEmptyString(arg.name);
      if (!name) continue;
      result.push(name);
      if (value !== undefined) result.push(value);
    } else if (value !== undefined) {
      result.push(value);
    }
  }
  return result;
}

/** Renders the package's `environmentVariables` into an env map, preserving placeholders. */
function renderEnvironmentVariables(rawVariables: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of asArrayOf(rawVariables)) {
    const entry = asRecord(raw);
    const name = firstNonEmptyString(entry.name);
    if (!name) continue;
    env[name] = firstNonEmptyString(entry.value, entry.default, entry.defaultValue) ?? `{${name.toLowerCase()}}`;
  }
  return env;
}

/** True if any runtime argument is a host-access / privilege-escalation flag. */
function hasDangerousRunnerArg(args: string[]): boolean {
  return args.some((arg) => {
    const normalized = arg.trim().toLowerCase();
    const flag = normalized.includes('=') ? normalized.slice(0, normalized.indexOf('=')) : normalized;
    return DANGEROUS_RUNNER_FLAGS.has(flag);
  });
}

function riskLevelForCommand(command: string | undefined, runtimeArgs: string[]): McpInstallRiskLevel {
  if (hasDangerousRunnerArg(runtimeArgs)) return 'unverified-command';
  return command && KNOWN_RUNNERS.has(command.trim().toLowerCase()) ? 'verified' : 'unverified-command';
}

function mapRegistryPackageToInstallOption(rawPackage: unknown): McpInstallOption | undefined {
  const pkg = asRecord(rawPackage);
  const packageName = firstNonEmptyString(pkg.name, pkg.identifier);
  if (!packageName) return undefined;

  const registryType = normalizeRegistryType(pkg.registryType ?? pkg.registry_type ?? pkg.type);
  const runtimeHint = firstNonEmptyString(pkg.runtimeHint, pkg.runtime_hint);
  const command = runtimeHint ?? fallbackCommandForRegistryType(registryType);

  const runtimeArgs = renderArguments(pkg.runtimeArguments ?? pkg.runtime_arguments);
  const packageArgs = renderArguments(pkg.packageArguments ?? pkg.package_arguments);
  const env = renderEnvironmentVariables(pkg.environmentVariables ?? pkg.environment_variables);
  const transport = asRecord(pkg.transport);
  const type = normalizePackageTransport(transport.type);

  return {
    label: command ?? 'unknown',
    type,
    command,
    args: [...runtimeArgs, packageName, ...packageArgs],
    ...(Object.keys(env).length > 0 ? { env } : {}),
    riskLevel: riskLevelForCommand(command, runtimeArgs),
  };
}

export function mapRegistryEnvelopeToEntry(rawEnvelope: unknown, source: McpMarketplaceSource): McpMarketplaceEntry {
  const envelope = asRecord(rawEnvelope);
  // Registry v0.1 wraps each entry as `{ server: {...}, _meta: {...} }`; flat payloads keep
  // the fields at the top level, so fall back to the envelope itself.
  const data = envelope.server && typeof envelope.server === 'object' ? asRecord(envelope.server) : envelope;

  const name = firstNonEmptyString(data.name, data.id, data.server_name) ?? '';
  const displayName = firstNonEmptyString(data.title, data.displayName, data.display_name) ?? shortName(name);
  const description = firstNonEmptyString(data.description);
  const version = firstNonEmptyString(data.version);
  const repository = asRecord(data.repository);
  const repositoryUrl = firstNonEmptyString(repository.url);
  const official = isTrustedOfficialSource(source) && isOfficialEnvelope(envelope);

  const installOptions = asArrayOf(data.packages)
    .map(mapRegistryPackageToInstallOption)
    .filter((option): option is McpInstallOption => option !== undefined);

  const tags = [version, official ? 'official' : undefined].filter((tag): tag is string => !!tag);

  return {
    id: `${source.id}:${name}`,
    name,
    displayName,
    description,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    official,
    tags,
    installOptions,
    homepage: repositoryUrl,
    repositoryUrl,
  };
}

// ─── GitHub org entries ──────────────────────────────────────────────────────

export function mapGitHubRepoToEntry(rawRepo: unknown, source: McpMarketplaceSource): McpMarketplaceEntry | undefined {
  const repo = asRecord(rawRepo);
  if (repo.fork === true) return undefined;

  const name = firstNonEmptyString(repo.name) ?? '';
  return {
    id: firstNonEmptyString(repo.full_name) ?? `${source.id}:${name}`,
    name,
    displayName: name,
    description: firstNonEmptyString(repo.description),
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    official: false,
    tags: Array.isArray(repo.topics) ? repo.topics : [],
    installOptions: [],
    repositoryUrl: firstNonEmptyString(repo.html_url),
    homepage: firstNonEmptyString(repo.homepage),
  };
}

// ─── Aggregate search pipeline: dedupe → filter → sort → cap ────────────────

const MAX_RESULT_COUNT = 250;

export function dedupeMarketplaceEntries(entries: McpMarketplaceEntry[]): McpMarketplaceEntry[] {
  const byKey = new Map<string, McpMarketplaceEntry>();
  for (const entry of entries) {
    const key = `${entry.sourceId}:${entry.name}`;
    if (!byKey.has(key)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

function entrySearchableFields(entry: McpMarketplaceEntry): string[] {
  return [
    entry.name ?? '',
    entry.displayName ?? '',
    entry.description ?? '',
    entry.repositoryUrl ?? '',
    entry.tags.join(' '),
  ].map((value) => value.toLowerCase());
}

export function filterMarketplaceEntries(entries: McpMarketplaceEntry[], query: string | undefined): McpMarketplaceEntry[] {
  const trimmed = (query ?? '').trim();
  if (!trimmed) return entries;
  const terms = trimmed.toLowerCase().split(/\s+/);
  return entries.filter((entry) => {
    const fields = entrySearchableFields(entry);
    return terms.every((term) => fields.some((field) => field.includes(term)));
  });
}

export function sortMarketplaceEntries(entries: McpMarketplaceEntry[]): McpMarketplaceEntry[] {
  return [...entries].sort((left, right) => {
    if (left.official !== right.official) return left.official ? -1 : 1;
    const leftInstallable = left.installOptions.length > 0;
    const rightInstallable = right.installOptions.length > 0;
    if (leftInstallable !== rightInstallable) return leftInstallable ? -1 : 1;
    return (left.displayName ?? '').localeCompare(right.displayName ?? '', undefined, { sensitivity: 'base' });
  });
}

export function capMarketplaceEntries(entries: McpMarketplaceEntry[]): McpMarketplaceEntry[] {
  return entries.length > MAX_RESULT_COUNT ? entries.slice(0, MAX_RESULT_COUNT) : entries;
}

// ─── Network orchestration ────────────────────────────────────────────────────

const REGISTRY_MAX_PAGES = 20;
const GITHUB_ORG_MAX_PAGES = 5;
const REGISTRY_PAGE_LIMIT = 100;

export interface McpMarketplaceSearchResult {
  entries: McpMarketplaceEntry[];
  error?: string;
}

export interface McpMarketplaceServiceOptions {
  cacheDir: string;
  fetchJson: McpMarketplaceFetchJson;
  cacheTtlMs?: number;
}

/**
 * Reads a fresh cache entry (unless `forceRefresh`), else fetches + writes the cache. On a
 * fetch failure, falls back to a stale cache entry — but only when NOT `forceRefresh`.
 */
async function cachedFetchJson(
  cacheDir: string,
  cacheKey: string,
  url: string,
  fetchJson: McpMarketplaceFetchJson,
  forceRefresh: boolean,
  ttlMs: number,
): Promise<unknown> {
  if (!forceRefresh) {
    const fresh = readMcpMarketplaceCache(cacheDir, cacheKey, { ttlMs });
    if (fresh !== undefined) return fresh;
  }
  try {
    const data = await fetchJson(url);
    writeMcpMarketplaceCache(cacheDir, cacheKey, data);
    return data;
  } catch (error) {
    if (!forceRefresh) {
      const stale = readMcpMarketplaceCache(cacheDir, cacheKey, { allowStale: true });
      if (stale !== undefined) return stale;
    }
    throw error;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildRegistryPageUrl(baseUrl: string, cursor: string | undefined): string {
  const url = `${trimTrailingSlash(baseUrl)}/v0.1/servers?limit=${REGISTRY_PAGE_LIMIT}`;
  return cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url;
}

function readNextCursor(root: unknown): string | undefined {
  const metadata = root && typeof root === 'object' ? (root as any).metadata : undefined;
  const cursor = metadata?.next_cursor ?? metadata?.nextCursor;
  return typeof cursor === 'string' && cursor.trim() ? cursor : undefined;
}

/** Cheap non-cryptographic hash, used only to keep cursor-page cache filenames short/stable. */
function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

async function loadRegistryEntries(
  source: McpMarketplaceSource,
  cacheDir: string,
  fetchJson: McpMarketplaceFetchJson,
  forceRefresh: boolean,
  ttlMs: number,
): Promise<McpMarketplaceEntry[]> {
  const byName = new Map<string, McpMarketplaceEntry>();
  let cursor: string | undefined;
  for (let page = 0; page < REGISTRY_MAX_PAGES; page += 1) {
    const url = buildRegistryPageUrl(source.url, cursor);
    const cacheKey = `${source.id}_page_${page}_${cursor ? hashCode(cursor) : 'first'}`;
    const data = await cachedFetchJson(cacheDir, cacheKey, url, fetchJson, forceRefresh, ttlMs);
    const root = data && typeof data === 'object' ? (data as any) : {};
    const servers = Array.isArray(root.servers) ? root.servers : [];
    for (const raw of servers) {
      const entry = mapRegistryEnvelopeToEntry(raw, source);
      if (entry.name && !byName.has(entry.name)) {
        byName.set(entry.name, entry);
      }
    }
    cursor = readNextCursor(root);
    if (!cursor) break;
  }
  return [...byName.values()];
}

function extractOrganizationName(url: string): string {
  const trimmed = trimTrailingSlash(url.trim());
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

async function loadGitHubOrgEntries(
  source: McpMarketplaceSource,
  cacheDir: string,
  fetchJson: McpMarketplaceFetchJson,
  forceRefresh: boolean,
  ttlMs: number,
): Promise<McpMarketplaceEntry[]> {
  const entries: McpMarketplaceEntry[] = [];
  const organization = extractOrganizationName(source.url);
  for (let page = 1; page <= GITHUB_ORG_MAX_PAGES; page += 1) {
    const url = `https://api.github.com/orgs/${organization}/repos?type=public&per_page=100&sort=stars&direction=desc&page=${page}`;
    const cacheKey = `${source.id}_page_${page}`;
    const data = await cachedFetchJson(cacheDir, cacheKey, url, fetchJson, forceRefresh, ttlMs);
    const repos = Array.isArray(data) ? data : [];
    if (repos.length === 0) break;
    for (const repo of repos) {
      const entry = mapGitHubRepoToEntry(repo, source);
      if (entry) entries.push(entry);
    }
    if (repos.length < 100) break;
  }
  return entries;
}

export class McpMarketplaceService {
  private readonly cacheDir: string;
  private readonly fetchJson: McpMarketplaceFetchJson;
  private readonly cacheTtlMs: number;

  constructor(options: McpMarketplaceServiceOptions) {
    this.cacheDir = options.cacheDir;
    this.fetchJson = options.fetchJson;
    this.cacheTtlMs = options.cacheTtlMs ?? MCP_MARKETPLACE_CACHE_TTL_MS;
  }

  getSources(): readonly McpMarketplaceSource[] {
    return MCP_MARKETPLACE_SOURCES;
  }

  private loadEntriesForSource(source: McpMarketplaceSource, forceRefresh: boolean): Promise<McpMarketplaceEntry[]> {
    switch (source.type) {
      case 'BUILT_IN':
        return Promise.resolve(builtInMarketplaceEntries(source));
      case 'REGISTRY':
        return loadRegistryEntries(source, this.cacheDir, this.fetchJson, forceRefresh, this.cacheTtlMs);
      case 'GITHUB_ORG':
        return loadGitHubOrgEntries(source, this.cacheDir, this.fetchJson, forceRefresh, this.cacheTtlMs);
      default:
        return Promise.resolve([]);
    }
  }

  async search(query: string | undefined, requestedSourceId: string | undefined, forceRefresh: boolean): Promise<McpMarketplaceSearchResult> {
    const sourceId = requestedSourceId && requestedSourceId.trim() ? requestedSourceId.trim() : 'all';
    const sources = MCP_MARKETPLACE_SOURCES.filter((source) => source.enabled && (sourceId === 'all' || source.id === sourceId));

    const settled = await Promise.allSettled(sources.map((source) => this.loadEntriesForSource(source, forceRefresh)));

    const allEntries: McpMarketplaceEntry[] = [];
    const failures: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allEntries.push(...result.value);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push(`${sources[index]?.name ?? sources[index]?.id ?? 'unknown source'}: ${reason}`);
      }
    });

    const entries = capMarketplaceEntries(
      sortMarketplaceEntries(filterMarketplaceEntries(dedupeMarketplaceEntries(allEntries), query)),
    );

    // Only surface an error when every requested source failed; a partial failure still
    // returns whatever entries the healthy sources produced.
    const error = sources.length > 0 && failures.length === sources.length ? failures.join('; ') : undefined;
    return { entries, error };
  }
}
