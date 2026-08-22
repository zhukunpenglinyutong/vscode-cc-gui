// Vendored from upstream src/lib/local-api-auth.ts; the fetch() calls were
// swapped to ./tt-transport (Tauri `tt_proxy` command) — same endpoints,
// same cached-token behavior, same header name.
import { ttRequest } from "./tt-transport";

let localApiAuthToken: string | null = null;

export function clearLocalApiAuthToken(): void {
  localApiAuthToken = null;
}

async function getLocalApiAuthToken(): Promise<string> {
  if (localApiAuthToken) return localApiAuthToken;

  const data = (await ttRequest("GET", "/api/local-auth", { Accept: "application/json" }).catch((err) => {
    const status = Number((err as any)?.status) || 0;
    throw new Error(`Local auth request failed with HTTP ${status || "unknown"}`);
  })) as { token?: string } | null;
  const token = typeof data?.token === "string" ? data.token.trim() : "";
  if (!token) {
    throw new Error("Local auth token missing from response");
  }
  localApiAuthToken = token;
  return token;
}

export async function getLocalApiAuthHeaders(): Promise<Record<string, string>> {
  const token = await getLocalApiAuthToken();
  return { "x-tokentracker-local-auth": token };
}

// The server rotates its local-auth token on restart, so a cached-but-stale
// token comes back as 401/403. Callers should clearLocalApiAuthToken() and
// retry once (see triggerLocalSync in ./api).
export function isLocalAuthFailure(error: unknown): boolean {
  const status = Number((error as any)?.status) || 0;
  return status === 401 || status === 403;
}
