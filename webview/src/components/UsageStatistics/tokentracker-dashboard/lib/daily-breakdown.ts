import { formatDateUTC } from "./date-range";

type DailyBreakdownRangeOptions = {
  period?: string;
  selectedFrom?: string;
  selectedTo?: string;
  todayKey?: string;
};

type DailyBreakdownRow = {
  day?: string;
  missing?: boolean;
  future?: boolean;
  [key: string]: unknown;
};

function parseUtcDateKey(value?: string): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return formatDateUTC(date) === value ? date : null;
}

export function buildDailyBreakdownRange({
  period,
  selectedFrom,
  selectedTo,
  todayKey,
}: DailyBreakdownRangeOptions = {}) {
  if (period === "total" && selectedFrom && selectedTo) {
    return { from: selectedFrom, to: selectedTo };
  }

  const end = parseUtcDateKey(todayKey) || new Date();
  const start = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate() - 29,
  ));
  return { from: formatDateUTC(start), to: formatDateUTC(end) };
}

export function selectDailyBreakdownRows(
  rows: DailyBreakdownRow[] | null | undefined,
  { period }: { period?: string } = {},
) {
  const visible = (Array.isArray(rows) ? rows : []).filter((row) => !row?.future && row?.day);
  const candidates = period === "total"
    ? visible.filter((row) => !row?.missing)
    : visible;
  return candidates.slice(-30);
}
