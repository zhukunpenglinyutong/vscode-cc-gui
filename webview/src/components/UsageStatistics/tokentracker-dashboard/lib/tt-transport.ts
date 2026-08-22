// Vendored addition (not from upstream): JCEF transport for the embedded
// TokenTracker dashboard. Upstream `lib/api.ts` fetched same-origin
// `/functions/<slug>` from the CLI's embedded HTTP server; that server sends
// no CORS headers, so inside the IDE webview all dashboard traffic goes
// through the Java TokenTrackerHandler (`tt_proxy` bridge command) instead.
//
// Bridge contract (implemented in src/main/java/.../handler/TokenTrackerHandler.java):
//   sendToJava("tt_proxy", { requestId, method, path, headers, body })
//   - `path` (query string included) must start with
//     "/functions/tokentracker-" or equal "/api/local-auth" (allowlisted).
//   - `body` is a JSON *string* (or null) — serialize before sending.
//   - On HTTP 2xx the command resolves with { body } — the raw response body,
//     which we JSON.parse here so hooks receive the parsed value directly.
//   - On non-2xx it rejects with a string message containing "HTTP <status>",
//     which we re-throw as an Error with a numeric `.status` so hooks keep
//     working unchanged (they only ever inspect err.status / err.message).
//
// Browser dev fallback: when not running inside the JCEF webview (no
// window.sendToJava), requests go to `/tt-dev<path>` via plain fetch — the
// vite dev proxy (see webview/vite.config.ts) forwards them to a locally
// running `tokentracker serve` instance on 127.0.0.1:7680.

import { isTokenTrackerBridgeAvailable, ttProxy } from "../../tokentrackerBridge";

/**
 * Vendored name kept from the desktop port: true when running inside a native
 * host whose backend proxies traffic to the local tokentracker server (Tauri
 * on desktop, the JCEF/Java bridge here).
 */
export function isTauriRuntime(): boolean {
  return isTokenTrackerBridgeAvailable();
}

function httpError(status: number): Error & { status?: number } {
  const err: any = new Error(`Request failed with HTTP ${status}`);
  err.status = status;
  return err;
}

async function ttRequestViaBridge(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: unknown,
): Promise<any> {
  try {
    const result = await ttProxy(
      method,
      path,
      headers ?? null,
      body != null ? JSON.stringify(body) : null,
    );
    const text = result?.body;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_e) {
      return text;
    }
  } catch (error) {
    const message = typeof error === "string" ? error : String((error as any)?.message ?? error);
    const match = message.match(/HTTP (\d{3})/);
    if (match) {
      throw httpError(Number(match[1]));
    }
    throw error;
  }
}

// Matches the 45s cap the bridge path applies via ttProxy (see
// tokentrackerBridge.ts) so the dev fallback can't hang forever either.
const DEV_FETCH_TIMEOUT_MS = 45_000;

async function ttRequestViaDevFetch(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: unknown,
): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEV_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`/tt-dev${path}`, {
      method,
      headers: { Accept: "application/json", ...headers },
      body: body != null ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${DEV_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw httpError(response.status);
  }
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_e) {
    return text;
  }
}

export async function ttRequest(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: unknown,
): Promise<any> {
  if (isTauriRuntime()) {
    return ttRequestViaBridge(method, path, headers, body);
  }
  return ttRequestViaDevFetch(method, path, headers, body);
}

export async function ttGet(path: string): Promise<any> {
  return ttRequest("GET", path, { Accept: "application/json" });
}
