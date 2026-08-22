// Vendored from upstream src/lib/api.ts with cloud/leaderboard/insforge and
// mock branches removed (see vendor plan). Kept function names, signatures
// and response shapes are unchanged so hooks work unmodified; the transport
// went from same-origin fetch to ./tt-transport (Tauri `tt_proxy` command).
import { ttGet, ttRequest } from "./tt-transport";
import { clearLocalApiAuthToken, getLocalApiAuthHeaders, isLocalAuthFailure } from "./local-api-auth";

type AnyRecord = Record<string, any>;

// React auth/scope resolution can make multiple consumers ask for the exact
// same GET while the first request is still in flight. Coalesce only that
// overlap (no result TTL), so manual refreshes still fetch fresh data.
const inFlightJsonGets = new Map<string, Promise<any>>();

function coalesceJsonGet(key: string, request: () => Promise<any>) {
  const existing = inFlightJsonGets.get(key);
  if (existing) return existing;

  const pending = request();
  inFlightJsonGets.set(key, pending);
  const cleanup = () => {
    if (inFlightJsonGets.get(key) === pending) inFlightJsonGets.delete(key);
  };
  pending.then(cleanup, cleanup);
  return pending;
}

const PATHS = {
  usageSummary: "tokentracker-usage-summary",
  usageDaily: "tokentracker-usage-daily",
  usageHourly: "tokentracker-usage-hourly",
  usageMonthly: "tokentracker-usage-monthly",
  usageHeatmap: "tokentracker-usage-heatmap",
  usageModelBreakdown: "tokentracker-usage-model-breakdown",
  projectUsageSummary: "tokentracker-project-usage-summary",
  projectUsageDetail: "tokentracker-project-usage-detail",
  userStatus: "tokentracker-user-status",
  localSync: "tokentracker-local-sync",
};

// Vendored change: upstream built a same-origin URL and used fetch(); here
// the request path (with query string) is handed to the Tauri proxy. The
// `options.accessToken` parameter is still accepted (and ignored) so caller
// signatures stay identical to upstream.
async function fetchLocalJson(slug: string, params?: AnyRecord, options?: AnyRecord) {
  const searchParams = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  const path = `/functions/${slug}${query ? `?${query}` : ""}`;
  const { accessToken: _omit } = options || {};
  return coalesceJsonGet(path, () => ttGet(path));
}

function buildTimeZoneParams({ timeZone, tzOffsetMinutes }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const tz = typeof timeZone === "string" ? timeZone.trim() : "";
  if (tz) params.tz = tz;
  if (Number.isFinite(tzOffsetMinutes)) {
    params.tz_offset_minutes = String(Math.trunc(tzOffsetMinutes));
  }
  return params;
}

function buildFilterParams({ source, model, device }: AnyRecord = {}) {
  const params: AnyRecord = {};
  const normalizedSource = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (normalizedSource) params.source = normalizedSource;
  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel) params.model = normalizedModel;
  const normalizedDevice = typeof device === "string" ? device.trim() : "";
  if (normalizedDevice) params.device_id = normalizedDevice;
  return params;
}

export async function getUsageSummary({
  from,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  rolling = false,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const rollingParams = rolling ? { rolling: "1" } : {};
  return fetchLocalJson(PATHS.usageSummary, { from, to, ...filterParams, ...tzParams, ...rollingParams }, { accessToken });
}

export async function getProjectUsageSummary({
  from,
  to,
  source,
  limit,
  timeZone,
  tzOffsetMinutes,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source });
  const params: AnyRecord = { ...filterParams, ...tzParams };
  if (from) params.from = from;
  if (to) params.to = to;
  if (limit != null) params.limit = String(limit);
  return fetchLocalJson(PATHS.projectUsageSummary, params);
}

export async function getProjectUsageDetail({
  projectKey,
  from,
  to,
  timeZone,
  tzOffsetMinutes,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const params: AnyRecord = { project_key: projectKey, ...tzParams };
  if (from) params.from = from;
  if (to) params.to = to;
  return fetchLocalJson(PATHS.projectUsageDetail, params);
}

export async function getUserStatus(_opts: AnyRecord = {}) {
  return fetchLocalJson(PATHS.userStatus);
}

// Vendored change: POST goes through ttRequest with the local-auth header
// fetched via /api/local-auth (see lib/local-api-auth.ts). The `signal`
// option from upstream is dropped — the Tauri proxy has no abort channel.
export async function triggerLocalSync({
  auto = false,
  background = false,
  allLocalSources = false,
  drain = false,
}: AnyRecord = {}) {
  const body: AnyRecord = {};
  if (drain) {
    body.drain = true;
  } else if (auto) {
    body.auto = true;
    if (background) {
      body.background = true;
      if (allLocalSources) body.allLocalSources = true;
    }
  }
  const doSyncRequest = async () => {
    const authHeaders = await getLocalApiAuthHeaders();
    return ttRequest("POST", `/functions/${PATHS.localSync}`, {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders,
    }, body);
  };
  // The server rotates its local-auth token on restart; on 401/403 drop the
  // cached token and retry once with a freshly fetched one (no further retry,
  // to avoid a loop if the server keeps rejecting).
  let payload;
  try {
    payload = await doSyncRequest();
  } catch (err) {
    if (!isLocalAuthFailure(err)) throw err;
    clearLocalApiAuthToken();
    payload = await doSyncRequest();
  }
  if (payload?.ok === false) {
    const message = payload?.error || payload?.message || "Local sync request failed";
    const error: any = new Error(message);
    throw error;
  }
  return payload;
}

export async function getUsageModelBreakdown({
  from,
  to,
  source,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, device });
  return fetchLocalJson(PATHS.usageModelBreakdown, { from, to, ...filterParams, ...tzParams }, { accessToken });
}

export async function getUsageDaily({
  from,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageDaily, { from, to, ...filterParams, ...tzParams }, { accessToken });
}

export async function getUsageHourly({
  day,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  const params = day ? { day, ...filterParams, ...tzParams } : { ...filterParams, ...tzParams };
  return fetchLocalJson(PATHS.usageHourly, params, { accessToken });
}

export async function getUsageMonthly({
  months,
  to,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageMonthly, {
    ...(months ? { months: String(months) } : {}),
    ...(to ? { to } : {}),
    ...filterParams,
    ...tzParams,
  }, { accessToken });
}

export async function getUsageHeatmap({
  weeks,
  to,
  weekStartsOn,
  source,
  model,
  device,
  timeZone,
  tzOffsetMinutes,
  accessToken,
}: AnyRecord = {}) {
  const tzParams = buildTimeZoneParams({ timeZone, tzOffsetMinutes });
  const filterParams = buildFilterParams({ source, model, device });
  return fetchLocalJson(PATHS.usageHeatmap, {
    weeks: String(weeks),
    to,
    week_starts_on: weekStartsOn,
    ...filterParams,
    ...tzParams,
  }, { accessToken });
}
