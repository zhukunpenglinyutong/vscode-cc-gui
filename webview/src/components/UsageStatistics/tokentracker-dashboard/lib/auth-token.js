export function normalizeAccessToken(token) {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveAuthAccessToken(auth) {
  if (!auth) return null;
  if (typeof auth === "string") return normalizeAccessToken(auth);
  if (typeof auth === "function") {
    try {
      const token = await auth();
      return normalizeAccessToken(token);
    } catch {
      return null;
    }
  }
  if (typeof auth === "object") {
    if (typeof auth.getAccessToken === "function") {
      try {
        const token = await auth.getAccessToken();
        const normalized = normalizeAccessToken(token);
        if (normalized) return normalized;
      } catch {
        // fall back to object.accessToken when available
      }
      return normalizeAccessToken(auth.accessToken);
    }
    // Keep readiness semantics consistent with isAccessTokenReady:
    // object-only providers (without getAccessToken) are treated as not ready.
    return null;
  }
  return normalizeAccessToken(auth);
}

export function isAccessTokenReady(token) {
  // 本地开发模式不需要真实 token
  if (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    return true;
  }
  if (typeof token === "function") return true;
  if (token && typeof token === "object") {
    if (typeof token.getAccessToken === "function") return true;
  }
  return Boolean(normalizeAccessToken(token));
}
