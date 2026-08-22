import { formatCompactNumber, toDisplayNumber } from "./format";

export const TOKEN_FORMAT_MODES = Object.freeze({
  COMPACT: "compact",
  CHINESE: "chinese",
  FULL: "full",
});

export const TOKEN_FORMAT_STORAGE_KEY = "tt.tokenFormat";

export function normalizeTokenFormatMode(value) {
  return Object.values(TOKEN_FORMAT_MODES).includes(value)
    ? value
    : TOKEN_FORMAT_MODES.COMPACT;
}

export function getNextTokenFormatMode(value) {
  switch (normalizeTokenFormatMode(value)) {
    case TOKEN_FORMAT_MODES.COMPACT:
      return TOKEN_FORMAT_MODES.CHINESE;
    case TOKEN_FORMAT_MODES.CHINESE:
      return TOKEN_FORMAT_MODES.FULL;
    default:
      return TOKEN_FORMAT_MODES.COMPACT;
  }
}

export function formatChineseCompactNumber(value, { decimals = 1 } = {}) {
  const n = Number(String(value));
  if (!Number.isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const safeDecimals = Math.max(0, Math.min(6, Math.floor(decimals)));
  const units = [
    [100000000, "亿"],
    [10000, "万"],
    [1000, "千"],
  ];

  if (abs < 1000) return `${sign}${String(abs)}`;

  const unitIndex = units.findIndex(([threshold]) => abs >= threshold);
  const [unit, suffix] = units[unitIndex];
  const fixed = (abs / unit).toFixed(safeDecimals);
  const normalized = Number(fixed);
  const nextUnit = unitIndex > 0 ? units[unitIndex - 1] : null;
  if (nextUnit && normalized >= nextUnit[0] / unit) {
    return `${sign}${Number((abs / nextUnit[0]).toFixed(safeDecimals)).toString()}${nextUnit[1]}`;
  }
  return `${sign}${normalized.toString()}${suffix}`;
}

export function readTokenFormatMode() {
  if (typeof window === "undefined") return TOKEN_FORMAT_MODES.COMPACT;
  try {
    return normalizeTokenFormatMode(window.localStorage?.getItem(TOKEN_FORMAT_STORAGE_KEY));
  } catch (_error) {
    return TOKEN_FORMAT_MODES.COMPACT;
  }
}

export function persistTokenFormatMode(value) {
  const mode = normalizeTokenFormatMode(value);
  if (typeof window === "undefined") return mode;
  try {
    window.localStorage?.setItem(TOKEN_FORMAT_STORAGE_KEY, mode);
  } catch (_error) {
    // localStorage can be unavailable in private/locked-down browser contexts.
  }
  return mode;
}

export function formatTokenCount(
  value,
  {
    mode = TOKEN_FORMAT_MODES.COMPACT,
    forceFull = false,
    decimals = 1,
    thousandSuffix = "K",
    millionSuffix = "M",
    billionSuffix = "B",
  } = {},
) {
  if (forceFull || normalizeTokenFormatMode(mode) === TOKEN_FORMAT_MODES.FULL) {
    return toDisplayNumber(value);
  }
  if (normalizeTokenFormatMode(mode) === TOKEN_FORMAT_MODES.CHINESE) {
    return formatChineseCompactNumber(value, { decimals });
  }
  return formatCompactNumber(value, {
    decimals,
    thousandSuffix,
    millionSuffix,
    billionSuffix,
  });
}

export function formatTokenTooltip(value, options = {}) {
  const full = toDisplayNumber(value);
  const display = formatTokenCount(value, options);
  if (display === full || display === "-" || full === "-") return full;
  return `${display} · ${full}`;
}
