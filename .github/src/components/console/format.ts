const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdPrecise = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 4 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

export function fmtUsd(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.1) return usdPrecise.format(value);
  return usd.format(value);
}

export function fmtUsdShort(value: number): string {
  if (Math.abs(value) >= 10_000) return `$${(value / 1000).toFixed(1)}k`;
  return usd.format(value);
}

export function fmtInt(value: number): string {
  return integer.format(value);
}

export function fmtTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

export function fmtPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Dates are rendered in UTC so server and client output match. */
export function fmtDay(isoDate: string): string {
  return shortDate.format(new Date(isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate));
}

export function fmtDateTime(iso: string): string {
  return `${dateTime.format(new Date(iso))} UTC`;
}

export function relativeTime(iso: string, nowMs: number): string {
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 45) return `${Math.max(1, s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function periodLabel(period: "DAILY" | "WEEKLY" | "MONTHLY" | "TOTAL"): string {
  switch (period) {
    case "DAILY":
      return "Per day";
    case "WEEKLY":
      return "Per week";
    case "MONTHLY":
      return "Per month";
    case "TOTAL":
      return "Lifetime";
  }
}

const timeOnly = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });
const dayHour = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const microsFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmtClock(ms: number): string {
  return `${timeOnly.format(new Date(ms))} UTC`;
}

export function fmtDayHour(ms: number): string {
  return dayHour.format(new Date(ms));
}

/** Exact micro-dollar figure, e.g. "12,345,600 µ$". */
export function fmtMicros(micros: number | bigint): string {
  return `${microsFmt.format(typeof micros === "bigint" ? Number(micros) : micros)} µ$`;
}

export function microsToUsdNumber(micros: bigint | number): number {
  return Number(micros) / 1_000_000;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
