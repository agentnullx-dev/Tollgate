import type { NotificationContext } from "../types";

/** Ten-segment text meter, e.g. "▰▰▰▰▰▰▰▰▱▱ 82%". Overflow shown as "+12%". */
export function textMeter(ratio: number, segments = 10): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * segments);
  const bar = "▰".repeat(filled) + "▱".repeat(segments - filled);
  const pct = Math.round(ratio * 100);
  return ratio > 1 ? `${bar} ${pct}% (+${pct - 100}% over)` : `${bar} ${pct}%`;
}

export function timestampUtc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function footerLine(ctx: NotificationContext): string {
  return `${ctx.organizationName} | ${timestampUtc(ctx.occurredAt)} | alert ${ctx.alertId}`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
