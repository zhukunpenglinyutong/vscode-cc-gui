/**
 * Bridge helpers for talking to the macOS TokenTrackerBar host via WKWebView's
 * `window.webkit.messageHandlers.nativeBridge`. The native side dispatches a
 * `native:settings` CustomEvent on `window` whenever state changes.
 *
 * Safe no-ops in browser/cloud mode.
 *
 * Vendored 裁剪版：仅保留嵌入宿主所需导出（isNativeEmbed / setNativeSetting /
 * theme 相关），pet/notify/Windows 等无消费者的导出已删除。
 */

// Module-level cache for native system appearance.
// An always-on listener (installed at module load) keeps this fresh,
// so React components don't depend on lifecycle ordering to receive
// `native:systemAppearanceChanged` events.
let nativeSystemDark = null; // null = unknown, true/false = native push received
const nativeSystemListeners = new Set();

if (typeof window !== "undefined") {
  window.addEventListener("native:systemAppearanceChanged", (event) => {
    const d = event?.detail?.isDark;
    if (typeof d !== "boolean") return;
    nativeSystemDark = d;
    // Defensive: also write .dark directly so the page reflects the change
    // even before React re-renders. ThemeProvider's applyThemeToDOM will
    // converge on the same value moments later.
    try {
      const root = document.documentElement;
      if (d) root.classList.add("dark");
      else root.classList.remove("dark");
    } catch { /* ignore */ }
    nativeSystemListeners.forEach((cb) => {
      try { cb(d); } catch { /* ignore listener errors */ }
    });
  });
}

/** Latest system appearance pushed by native, or null if none yet. */
export function getCachedNativeSystemDark() {
  return nativeSystemDark;
}

/** Subscribe to native system appearance changes. Returns unsubscribe fn. */
export function subscribeNativeSystemAppearance(callback) {
  nativeSystemListeners.add(callback);
  return () => nativeSystemListeners.delete(callback);
}

/** True when running inside TokenTrackerBar WKWebView (bridge is always present). */
export function isNativeEmbed() {
  if (typeof window === "undefined") return false;
  return Boolean(window.webkit?.messageHandlers?.nativeBridge);
}

function getHandler() {
  if (typeof window === "undefined") return null;
  return window.webkit?.messageHandlers?.nativeBridge ?? null;
}

function post(message) {
  const handler = getHandler();
  if (!handler) return false;
  try {
    handler.postMessage(message);
    return true;
  } catch (err) {
    console.warn("[tokentracker] nativeBridge post failed:", err);
    return false;
  }
}

export function setNativeSetting(key, value) {
  return post({ type: "setSetting", key, value });
}

export function requestNativeSystemAppearance() {
  return post({ type: "getSystemAppearance" });
}

/**
 * macOS Dashboard 窗口：与 Web 主题同步 NSWindow.appearance。
 * `theme === "system"` 时原生侧将窗口 appearance 置为跟随系统；系统切换时再由原生推送 `native:systemAppearanceChanged`（WKWebView 内 matchMedia 常不刷新）。
 * @param {"light" | "dark"} resolvedTheme
 * @param {"light" | "dark" | "system"} theme
 */
export function syncNativeChromeAppearance(resolvedTheme, theme) {
  if (!isNativeEmbed()) return;
  const isDark = resolvedTheme === "dark";
  post({ type: "setChromeAppearance", isDark, theme: theme ?? "system" });
}
