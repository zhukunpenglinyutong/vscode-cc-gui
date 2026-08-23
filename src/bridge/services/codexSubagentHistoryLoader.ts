import * as fs from 'fs';
import * as path from 'path';
import { transformCodexHistoryRows, type CodexHistoryImageLoader } from './codexHistoryTransform.ts';

/**
 * Resolves and converts Codex subagent turns from local rollout files.
 * TS port of jetbrains-cc-gui's CodexSubagentHistoryLoader: the batch status
 * lookup (loadStatuses) backs lightweight lifecycle polling, while load()
 * converts one subagent transcript for the expanded Agent card.
 */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_AGENT_PATH = /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MAX_CACHE_ENTRIES = 256;
export const MAX_STATUS_REQUESTS = 64;
/**
 * Status polling runs on a fixed two-second cadence, so directory scans
 * younger than this are reused instead of walking the sessions tree again.
 */
const SESSION_SCAN_TTL_MS = 2_000;

const NULL_IMAGE_LOADER: CodexHistoryImageLoader = { imageBlockFromLocalPath: () => null };

export class PendingException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PendingException';
  }
}

export interface SubagentStatusRequest {
  toolUseId?: string | null;
  agentPath?: string | null;
  agentId?: string | null;
}

export interface SubagentStatusResult {
  toolUseId?: string;
  agentPath?: string;
  agentId?: string;
  success: boolean;
  status: string;
  error?: string;
}

export interface CodexSubagentLoadResult {
  agentThreadId?: string;
  agentPath?: string;
  messages: Array<Record<string, any>>;
  status: string;
  error?: string;
}

interface Location {
  file: string | null;
  agentThreadId: string | null;
  agentPath: string | null;
}

interface ActivityLookup {
  locations: Map<string, Location>;
  ambiguousToolUseIds: Set<string>;
}

interface SessionIndex {
  filesByThreadId: Map<string, string[]>;
  legacyLocations: Location[];
}

interface CachedSessionFile {
  timestamp: number;
  file: string;
}

interface CachedSessionIndex {
  timestamp: number;
  key: string;
  index: SessionIndex;
}

interface TurnSlice {
  messages: Array<Record<string, any>>;
  status: string;
  error?: string;
}

interface StatusSlice {
  status: string;
  error?: string;
}

type JsonlRow = Record<string, any>;

function emptyActivityLookup(): ActivityLookup {
  return { locations: new Map(), ambiguousToolUseIds: new Set() };
}

function emptySessionIndex(): SessionIndex {
  return { filesByThreadId: new Map(), legacyLocations: [] };
}

function getString(object: JsonlRow | null | undefined, key: string): string | null {
  if (!object || typeof object !== 'object') return null;
  const value = object[key];
  return typeof value === 'string' ? value : null;
}

function eventPayload(element: JsonlRow | null | undefined, payloadType: string): JsonlRow | null {
  if (!element || typeof element !== 'object') return null;
  if (getString(element, 'type') !== 'event_msg') return null;
  const payload = element.payload;
  if (!payload || typeof payload !== 'object') return null;
  return getString(payload, 'type') === payloadType ? payload : null;
}

function getThreadSpawn(meta: JsonlRow): JsonlRow | null {
  const source = meta?.source;
  if (!source || typeof source !== 'object') return null;
  const subagent = source.subagent;
  if (!subagent || typeof subagent !== 'object') return null;
  const threadSpawn = subagent.thread_spawn;
  return threadSpawn && typeof threadSpawn === 'object' ? threadSpawn : null;
}

function getParentThreadId(meta: JsonlRow): string | null {
  const direct = getString(meta, 'parent_thread_id');
  if (direct) return direct;
  const spawn = getThreadSpawn(meta);
  return spawn ? getString(spawn, 'parent_thread_id') : null;
}

function getAgentPath(meta: JsonlRow): string | null {
  const direct = getString(meta, 'agent_path');
  if (direct) return direct;
  const spawn = getThreadSpawn(meta);
  return spawn ? getString(spawn, 'agent_path') : null;
}

function validateId(name: string, value: string | null | undefined): void {
  if (!value || !SAFE_ID.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
}

function validateAgentPath(value: string): void {
  if (value.length > 500 || (!SAFE_AGENT_PATH.test(value) && !SAFE_ID.test(value))) {
    throw new Error('Invalid agentPath');
  }
  // The SAFE_AGENT_PATH alphabet technically matches ".." segments. Reject
  // them explicitly so a future path-concatenation sink can never turn an
  // agentPath into a traversal.
  for (const segment of value.split('/')) {
    if (segment === '..') {
      throw new Error('Invalid agentPath');
    }
  }
}

function matchesAgentPath(requested: string, candidate: string | null): boolean {
  if (!candidate) return false;
  return requested === candidate || (!requested.startsWith('/') && candidate.endsWith(`/${requested}`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error';
}

function parseObject(line: string): JsonlRow | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonlRows(file: string): JsonlRow[] {
  const rows: JsonlRow[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = parseObject(line);
    if (record) rows.push(record);
  }
  return rows;
}

const SESSION_META_HEAD_BYTES = 64 * 1024;

function findSessionMeta(rows: JsonlRow[]): JsonlRow | null {
  for (const record of rows) {
    if (getString(record, 'type') !== 'session_meta'
        || !record.payload || typeof record.payload !== 'object') {
      continue;
    }
    return record.payload;
  }
  return null;
}

/**
 * Read at most the first SESSION_META_HEAD_BYTES of a jsonl file and parse its
 * rows. Cheap enough to run against every rollout under ~/.codex/sessions; the
 * session_meta row lives at the top, so full reads are rarely needed. The last
 * line may be truncated mid-JSON — parseObject drops it, and callers fall back
 * to a full read when no session_meta row survives the head scan.
 */
function readJsonlHeadRows(file: string): JsonlRow[] {
  let raw = '';
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const max = Math.min(stat.size, SESSION_META_HEAD_BYTES);
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    raw = buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const rows: JsonlRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const record = parseObject(line);
    if (record) rows.push(record);
  }
  return rows;
}

function walkJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

/** Insertion/eviction helpers emulating the Java LinkedHashMap access-order LRU. */
function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function lruPut<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function lookupKeyOf(parentSessionId: string, toolUseId?: string | null, agentPath?: string | null, agentId?: string | null): string {
  return ['codex', parentSessionId, toolUseId ?? '', agentPath ?? '', agentId ?? ''].join('\n');
}

function statusLookupKey(parentSessionId: string, request: SubagentStatusRequest): string {
  return lookupKeyOf(parentSessionId, request.toolUseId, request.agentPath, request.agentId);
}

export class CodexSubagentHistoryLoader {
  private readonly locationCache = new Map<string, Location>();
  private readonly sessionFileCache = new Map<string, CachedSessionFile>();
  private sessionIndexCache: CachedSessionIndex | null = null;
  private readonly sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  load(
    parentSessionId: string,
    toolUseId: string | undefined,
    requestedAgentPath: string | undefined,
    imageLoader: CodexHistoryImageLoader = NULL_IMAGE_LOADER,
  ): CodexSubagentLoadResult {
    validateId('sessionId', parentSessionId);
    if (toolUseId?.trim()) validateId('toolUseId', toolUseId);
    if (requestedAgentPath?.trim()) validateAgentPath(requestedAgentPath);
    if (!toolUseId?.trim() && !requestedAgentPath?.trim()) {
      throw new Error('Missing toolUseId and agentPath');
    }

    const key = lookupKeyOf(parentSessionId, toolUseId, requestedAgentPath);
    let location = lruGet(this.locationCache, key);
    if (!location?.file || !fs.statSync(location.file, { throwIfNoEntry: false })?.isFile()) {
      location = this.resolveLocation(parentSessionId, toolUseId, requestedAgentPath);
      lruPut(this.locationCache, key, location);
    }

    const rollout = this.readInitialSubagentRollout(location.file!);
    const turn = CodexSubagentHistoryLoader.extractInitialSubagentTurn(rollout);
    return {
      agentThreadId: location.agentThreadId ?? undefined,
      agentPath: location.agentPath ?? undefined,
      messages: transformCodexHistoryRows(turn.messages, imageLoader),
      status: turn.status,
      error: turn.error,
    };
  }

  loadStatuses(parentSessionId: string, requests: SubagentStatusRequest[] | null): SubagentStatusResult[] {
    validateId('sessionId', parentSessionId);
    if (!requests || requests.length > MAX_STATUS_REQUESTS) {
      throw new Error('Invalid agents count');
    }
    for (const request of requests) {
      CodexSubagentHistoryLoader.validateStatusRequest(request);
    }
    if (requests.length === 0) {
      return [];
    }

    const results: Array<SubagentStatusResult | null> = new Array(requests.length).fill(null);
    const unresolvedIndexes: number[] = [];
    for (let i = 0; i < requests.length; i++) {
      const cached = lruGet(this.locationCache, statusLookupKey(parentSessionId, requests[i]));
      if (cached?.file && fs.statSync(cached.file, { throwIfNoEntry: false })?.isFile()) {
        results[i] = this.readStatus(requests[i], cached);
      } else {
        unresolvedIndexes.push(i);
      }
    }
    if (unresolvedIndexes.length === 0) {
      return results as SubagentStatusResult[];
    }

    const requestedToolUseIds = new Set<string>();
    for (const index of unresolvedIndexes) {
      const toolUseId = requests[index].toolUseId;
      if (toolUseId?.trim()) requestedToolUseIds.add(toolUseId);
    }

    let activities = emptyActivityLookup();
    let activityPendingError: string | null = null;
    let activityFailure: string | null = null;
    if (requestedToolUseIds.size > 0) {
      try {
        activities = this.findActivityLocations(this.findExactSessionFile(parentSessionId), requestedToolUseIds);
      } catch (error) {
        if (error instanceof PendingException) {
          activityPendingError = errorMessage(error);
        } else if (error instanceof Error && (error as NodeJS.ErrnoException).code) {
          // Transient read failure (slow disk, file mid-write): stay
          // retryable instead of failing the whole batch permanently.
          activityPendingError = errorMessage(error);
        } else {
          activityFailure = errorMessage(error);
        }
      }
    }

    const requiredThreadIds = new Set<string>();
    let needsLegacyLookup = false;
    for (const index of unresolvedIndexes) {
      const request = requests[index];
      const activity = request.toolUseId != null ? activities.locations.get(request.toolUseId) : undefined;
      if (activity?.agentThreadId) {
        requiredThreadIds.add(activity.agentThreadId);
      }
      if (request.agentId?.trim()) {
        requiredThreadIds.add(request.agentId);
      }
      if (!activity && activityPendingError == null && request.agentPath?.trim()) {
        needsLegacyLookup = true;
      }
    }

    let sessionIndex: SessionIndex;
    try {
      sessionIndex = this.buildSessionIndex(parentSessionId, requiredThreadIds, needsLegacyLookup);
    } catch (error) {
      if (error instanceof PendingException) {
        sessionIndex = emptySessionIndex();
        if (activityPendingError == null) {
          activityPendingError = errorMessage(error);
        }
      } else {
        throw error;
      }
    }

    for (const index of unresolvedIndexes) {
      const request = requests[index];
      const resolutionFailure = CodexSubagentHistoryLoader.resolveFailure(
        request, activities, activityPendingError, activityFailure,
      );
      if (resolutionFailure) {
        results[index] = resolutionFailure;
        continue;
      }

      let location: Location;
      try {
        location = this.resolveBatchLocation(parentSessionId, request, activities, sessionIndex);
      } catch (error) {
        results[index] = error instanceof PendingException
          ? pendingStatus(request, errorMessage(error))
          : failedStatus(request, errorMessage(error));
        continue;
      }

      lruPut(this.locationCache, statusLookupKey(parentSessionId, request), location);
      results[index] = this.readStatus(request, location);
    }
    return results as SubagentStatusResult[];
  }

  private static validateStatusRequest(request: SubagentStatusRequest | null): void {
    if (!request) {
      throw new Error('Invalid agent request');
    }
    if (request.toolUseId?.trim()) validateId('toolUseId', request.toolUseId);
    if (request.agentId?.trim()) validateId('agentId', request.agentId);
    if (request.agentPath?.trim()) validateAgentPath(request.agentPath);
    if (!request.toolUseId?.trim() && !request.agentId?.trim() && !request.agentPath?.trim()) {
      throw new Error('Missing agent identifier');
    }
  }

  private static resolveFailure(
    request: SubagentStatusRequest,
    activities: ActivityLookup,
    activityPendingError: string | null,
    activityFailure: string | null,
  ): SubagentStatusResult | null {
    if (!request.toolUseId?.trim()) {
      return null;
    }
    if (activities.ambiguousToolUseIds.has(request.toolUseId)) {
      return failedStatus(request, 'Ambiguous Codex subagent activity');
    }
    if (activityFailure != null) {
      return failedStatus(request, activityFailure);
    }
    if (activityPendingError != null && !request.agentId?.trim()) {
      return pendingStatus(request, activityPendingError);
    }
    return null;
  }

  private resolveBatchLocation(
    parentSessionId: string,
    request: SubagentStatusRequest,
    activities: ActivityLookup,
    sessionIndex: SessionIndex,
  ): Location {
    const activity = request.toolUseId != null ? activities.locations.get(request.toolUseId) : undefined;
    if (activity?.agentThreadId) {
      return CodexSubagentHistoryLoader.exactLocation(activity.agentThreadId, activity.agentPath, sessionIndex);
    }
    if (request.agentId?.trim()) {
      const direct = CodexSubagentHistoryLoader.exactLocation(request.agentId, request.agentPath ?? null, sessionIndex);
      const meta = this.readSessionMeta(direct.file!);
      if (!meta) {
        // Null means the file is unreadable or not fully written yet. Retry on
        // the next poll instead of misreporting a transient read failure as a
        // permanent ownership error.
        throw new PendingException(`Codex subagent metadata not readable yet: ${request.agentId}`);
      }
      if (parentSessionId !== getParentThreadId(meta)) {
        throw new Error('Codex subagent does not belong to parent session');
      }
      return { file: direct.file, agentThreadId: request.agentId, agentPath: getAgentPath(meta) };
    }
    if (!request.agentPath?.trim()) {
      throw new PendingException('Codex subagent activity not found yet');
    }

    const matches = sessionIndex.legacyLocations
      .filter((location) => matchesAgentPath(request.agentPath!, location.agentPath));
    if (matches.length === 0) {
      throw new PendingException('Codex subagent rollout not found yet');
    }
    if (matches.length > 1) {
      throw new Error('Ambiguous Codex subagent rollout for agentPath');
    }
    return matches[0];
  }

  private static exactLocation(threadId: string, agentPath: string | null, sessionIndex: SessionIndex): Location {
    const matches = sessionIndex.filesByThreadId.get(threadId) ?? [];
    if (matches.length === 0) {
      throw new PendingException(`Codex session rollout not found yet: ${threadId}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous Codex session rollout: ${threadId}`);
    }
    return { file: matches[0], agentThreadId: threadId, agentPath };
  }

  private findActivityLocations(parentFile: string, requestedToolUseIds: Set<string>): ActivityLookup {
    const locations = new Map<string, Location>();
    const ambiguousToolUseIds = new Set<string>();
    for (const record of readJsonlRows(parentFile)) {
      const payload = eventPayload(record, 'sub_agent_activity');
      const toolUseId = getString(payload, 'event_id');
      if (!toolUseId || !requestedToolUseIds.has(toolUseId)) {
        continue;
      }
      const threadId = getString(payload, 'agent_thread_id');
      if (!threadId?.trim()) {
        continue;
      }
      validateId('agentThreadId', threadId);
      const previous = locations.get(toolUseId);
      if (previous && previous.agentThreadId !== threadId) {
        ambiguousToolUseIds.add(toolUseId);
        locations.delete(toolUseId);
        continue;
      }
      if (!ambiguousToolUseIds.has(toolUseId)) {
        locations.set(toolUseId, { file: null, agentThreadId: threadId, agentPath: getString(payload, 'agent_path') });
      }
    }
    return { locations, ambiguousToolUseIds };
  }

  private buildSessionIndex(
    parentSessionId: string,
    requiredThreadIds: Set<string>,
    needsLegacyLookup: boolean,
  ): SessionIndex {
    const cacheKey = `${parentSessionId}\n${[...requiredThreadIds].sort().join(',')}\n${needsLegacyLookup}`;
    const cached = this.sessionIndexCache;
    const now = Date.now();
    if (cached && cached.key === cacheKey && now - cached.timestamp < SESSION_SCAN_TTL_MS) {
      return cached.index;
    }
    const index = this.scanSessionIndex(parentSessionId, requiredThreadIds, needsLegacyLookup);
    this.sessionIndexCache = { timestamp: now, key: cacheKey, index };
    return index;
  }

  private scanSessionIndex(
    parentSessionId: string,
    requiredThreadIds: Set<string>,
    needsLegacyLookup: boolean,
  ): SessionIndex {
    if (!fs.statSync(this.sessionsDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new PendingException('Codex sessions directory not found yet');
    }
    const filesByThreadId = new Map<string, string[]>();
    const legacyLocations: Location[] = [];
    for (const filePath of walkJsonlFiles(this.sessionsDir)) {
      const fileName = path.basename(filePath);
      for (const threadId of requiredThreadIds) {
        if (fileName.endsWith(`-${threadId}.jsonl`)) {
          const list = filesByThreadId.get(threadId) ?? [];
          list.push(filePath);
          filesByThreadId.set(threadId, list);
        }
      }
      if (!needsLegacyLookup) {
        continue;
      }
      const meta = this.readSessionMeta(filePath);
      if (!meta || parentSessionId !== getParentThreadId(meta)) {
        continue;
      }
      const threadId = getString(meta, 'id');
      if (threadId) {
        legacyLocations.push({ file: filePath, agentThreadId: threadId, agentPath: getAgentPath(meta) });
      }
    }
    return { filesByThreadId, legacyLocations };
  }

  private readStatus(request: SubagentStatusRequest, location: Location): SubagentStatusResult {
    try {
      const status = this.readInitialSubagentStatus(location.file!);
      return {
        toolUseId: request.toolUseId ?? undefined,
        agentPath: location.agentPath ?? request.agentPath ?? undefined,
        agentId: location.agentThreadId ?? undefined,
        success: true,
        status: status.status,
        ...(status.error != null && { error: status.error }),
      };
    } catch (error) {
      if (error instanceof PendingException) {
        return pendingStatus(request, errorMessage(error));
      }
      if (error instanceof Error && (error as NodeJS.ErrnoException).code) {
        // Transient read failure (slow disk, file mid-write): stay retryable
        // instead of locking the agent into a terminal error.
        return pendingStatus(request, errorMessage(error));
      }
      return failedStatus(request, errorMessage(error));
    }
  }

  private readInitialSubagentStatus(file: string): StatusSlice {
    let afterSessionMeta = false;
    const startedTurnIds = new Set<string>();
    let turnId: string | null = null;
    for (const record of readJsonlRows(file)) {
      if (getString(record, 'type') === 'session_meta') {
        afterSessionMeta = true;
        startedTurnIds.clear();
        turnId = null;
        continue;
      }
      if (!afterSessionMeta) {
        continue;
      }
      const started = eventPayload(record, 'task_started');
      if (started) {
        const startedTurnId = getString(started, 'turn_id');
        if (startedTurnId) {
          startedTurnIds.add(startedTurnId);
        }
      }
      if (turnId == null && getString(record, 'type') === 'turn_context'
          && record.payload && typeof record.payload === 'object') {
        turnId = getString(record.payload, 'turn_id');
        continue;
      }
      if (turnId != null && matchesTurnEvent(record, 'task_complete', turnId)) {
        if (!startedTurnIds.has(turnId)) {
          throw new PendingException('Codex subagent turn start not found yet');
        }
        return { status: 'completed' };
      }
      if (turnId != null && matchesTurnEvent(record, 'turn_aborted', turnId)) {
        if (!startedTurnIds.has(turnId)) {
          throw new PendingException('Codex subagent turn start not found yet');
        }
        return { status: 'error', error: 'Codex subagent turn was aborted' };
      }
    }
    if (turnId == null) {
      throw new PendingException('Codex subagent turn context not found yet');
    }
    if (!startedTurnIds.has(turnId)) {
      throw new PendingException('Codex subagent turn start not found yet');
    }
    return { status: 'running' };
  }

  private resolveLocation(
    parentSessionId: string,
    toolUseId: string | undefined,
    requestedAgentPath: string | undefined,
  ): Location {
    if (toolUseId?.trim()) {
      const parentFile = this.findExactSessionFile(parentSessionId);
      const activityLocation = this.findActivityLocation(parentFile, toolUseId);
      if (activityLocation) {
        const childFile = this.findExactSessionFile(activityLocation.agentThreadId!);
        return { file: childFile, agentThreadId: activityLocation.agentThreadId, agentPath: activityLocation.agentPath };
      }
    }

    if (!requestedAgentPath?.trim()) {
      throw new PendingException('Codex subagent activity not found yet');
    }
    return this.findLegacyLocation(parentSessionId, requestedAgentPath);
  }

  private findActivityLocation(parentFile: string, toolUseId: string): Location | null {
    let matched: Location | null = null;
    for (const record of readJsonlRows(parentFile)) {
      const payload = eventPayload(record, 'sub_agent_activity');
      if (!payload || toolUseId !== getString(payload, 'event_id')) {
        continue;
      }
      const threadId = getString(payload, 'agent_thread_id');
      if (!threadId?.trim()) {
        continue;
      }
      validateId('agentThreadId', threadId);
      const agentPath = getString(payload, 'agent_path');
      if (matched && matched.agentThreadId !== threadId) {
        throw new Error('Ambiguous Codex subagent activity');
      }
      matched = { file: null, agentThreadId: threadId, agentPath };
    }
    return matched;
  }

  private findLegacyLocation(parentSessionId: string, agentPath: string): Location {
    const matches: Location[] = [];
    if (!fs.statSync(this.sessionsDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new PendingException('Codex sessions directory not found yet');
    }
    for (const filePath of walkJsonlFiles(this.sessionsDir)) {
      const meta = this.readSessionMeta(filePath);
      if (!meta) {
        continue;
      }
      const candidateParent = getParentThreadId(meta);
      const candidatePath = getAgentPath(meta);
      const threadId = getString(meta, 'id');
      if (parentSessionId === candidateParent && matchesAgentPath(agentPath, candidatePath) && threadId) {
        matches.push({ file: filePath, agentThreadId: threadId, agentPath: candidatePath });
      }
    }
    if (matches.length === 0) {
      throw new PendingException('Codex subagent rollout not found yet');
    }
    if (matches.length > 1) {
      throw new Error('Ambiguous Codex subagent rollout for agentPath');
    }
    return matches[0];
  }

  private findExactSessionFile(sessionId: string): string {
    const cached = lruGet(this.sessionFileCache, sessionId);
    const now = Date.now();
    if (cached
        && now - cached.timestamp < SESSION_SCAN_TTL_MS
        && fs.statSync(cached.file, { throwIfNoEntry: false })?.isFile()) {
      return cached.file;
    }
    const resolved = this.scanExactSessionFile(sessionId);
    lruPut(this.sessionFileCache, sessionId, { timestamp: now, file: resolved });
    return resolved;
  }

  private scanExactSessionFile(sessionId: string): string {
    if (!fs.statSync(this.sessionsDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new PendingException('Codex sessions directory not found yet');
    }
    const suffix = `-${sessionId}.jsonl`;
    const matches = walkJsonlFiles(this.sessionsDir)
      .filter((filePath) => path.basename(filePath).endsWith(suffix))
      .slice(0, 2);
    if (matches.length === 0) {
      throw new PendingException(`Codex session rollout not found yet: ${sessionId}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous Codex session rollout: ${sessionId}`);
    }
    return matches[0];
  }

  private readSessionMeta(file: string): JsonlRow | null {
    let rows: JsonlRow[];
    try {
      rows = readJsonlHeadRows(file);
    } catch {
      return null;
    }
    const headMeta = findSessionMeta(rows);
    if (headMeta) {
      return headMeta;
    }
    // Rare: session_meta beyond the head window (or split mid-line by the byte
    // cap) — fall back to the full read to preserve the previous behavior.
    try {
      rows = readJsonlRows(file);
    } catch {
      return null;
    }
    return findSessionMeta(rows);
  }

  private readInitialSubagentRollout(file: string): JsonlRow[] {
    let messages: JsonlRow[] = [];
    let afterSessionMeta = false;
    let turnId: string | null = null;
    for (const record of readJsonlRows(file)) {
      if (getString(record, 'type') === 'session_meta') {
        messages = [];
        afterSessionMeta = true;
        turnId = null;
      }
      if (!afterSessionMeta) {
        continue;
      }
      messages.push(record);
      if (turnId == null && getString(record, 'type') === 'turn_context'
          && record.payload && typeof record.payload === 'object') {
        turnId = getString(record.payload, 'turn_id');
        continue;
      }
      if (turnId != null && (matchesTurnEvent(record, 'task_complete', turnId)
          || matchesTurnEvent(record, 'turn_aborted', turnId))) {
        break;
      }
    }
    return messages;
  }

  static extractInitialSubagentTurn(rollout: JsonlRow[]): TurnSlice {
    let sessionMetaIndex = -1;
    for (let i = 0; i < rollout.length; i++) {
      if (getString(rollout[i], 'type') === 'session_meta') {
        sessionMetaIndex = i;
      }
    }

    let turnId: string | null = null;
    let contextIndex = -1;
    for (let i = sessionMetaIndex + 1; i < rollout.length; i++) {
      const record = rollout[i];
      if (getString(record, 'type') !== 'turn_context'
          || !record.payload || typeof record.payload !== 'object') {
        continue;
      }
      turnId = getString(record.payload, 'turn_id');
      if (turnId != null) {
        contextIndex = i;
        break;
      }
    }
    if (turnId == null) {
      throw new PendingException('Codex subagent turn context not found yet');
    }

    let startIndex = -1;
    for (let i = sessionMetaIndex + 1; i <= contextIndex; i++) {
      const payload = eventPayload(rollout[i], 'task_started');
      if (payload && turnId === getString(payload, 'turn_id')) {
        startIndex = i;
      }
    }
    if (startIndex < 0) {
      throw new PendingException('Codex subagent turn start not found yet');
    }

    const turnMessages: JsonlRow[] = [];
    let status = 'running';
    let error: string | undefined;
    for (let i = startIndex; i < rollout.length; i++) {
      const record = rollout[i];
      turnMessages.push(record);
      const completed = eventPayload(record, 'task_complete');
      if (completed && turnId === getString(completed, 'turn_id')) {
        status = 'completed';
        break;
      }
      const aborted = eventPayload(record, 'turn_aborted');
      if (aborted && turnId === getString(aborted, 'turn_id')) {
        status = 'error';
        error = 'Codex subagent turn was aborted';
        break;
      }
    }
    return { messages: turnMessages, status, error };
  }
}

function matchesTurnEvent(record: JsonlRow, eventType: string, turnId: string): boolean {
  const payload = eventPayload(record, eventType);
  return payload != null && turnId === getString(payload, 'turn_id');
}

function pendingStatus(request: SubagentStatusRequest, error: string): SubagentStatusResult {
  return {
    toolUseId: request.toolUseId ?? undefined,
    agentPath: request.agentPath ?? undefined,
    agentId: request.agentId ?? undefined,
    success: false,
    status: 'running',
    error,
  };
}

function failedStatus(request: SubagentStatusRequest, error: string): SubagentStatusResult {
  return {
    toolUseId: request.toolUseId ?? undefined,
    agentPath: request.agentPath ?? undefined,
    agentId: request.agentId ?? undefined,
    success: false,
    status: 'error',
    error,
  };
}
