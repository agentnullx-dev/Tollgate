import clsx from "clsx";
import { fmtUsd } from "./format";

interface SpendMeterProps {
  committed: number;
  reserved: number;
  limit: number;
  /** Optional forecast marker, e.g. projected end-of-period spend. */
  projected?: number;
  size?: "sm" | "lg";
  label: string;
}

/**
 * Three-part meter used everywhere money meets a limit:
 * settled spend (solid), in-flight reservations (hatched), and the hard limit
 * (a post). When spend or the forecast passes the limit, the scale extends so
 * the overshoot stays visible instead of being clipped.
 */
export function SpendMeter({ committed, reserved, limit, projected, size = "sm", label }: SpendMeterProps) {
  const used = committed + reserved;
  const ceiling = Math.max(limit, used, projected ?? 0) * (Math.max(used, projected ?? 0) > limit ? 1.06 : 1);
  const pct = (v: number) => (ceiling > 0 ? Math.min(100, (v / ceiling) * 100) : 0);
  const over = used > limit;
  const limitPos = pct(limit);

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.round(used * 100) / 100}
      aria-valuetext={`${fmtUsd(committed)} settled, ${fmtUsd(reserved)} in flight, limit ${fmtUsd(limit)}`}
      className={clsx("relative w-full", size === "lg" ? "pt-1" : "")}
    >
      <div
        className={clsx(
          "relative w-full overflow-hidden rounded-meter bg-[#E3E8EF]",
          size === "lg" ? "h-7" : "h-2.5",
        )}
      >
        <div
          className={clsx(
            "absolute inset-y-0 left-0 origin-left animate-meter-fill transition-[width] duration-500",
            committed > limit ? "bg-signal" : "bg-settled",
          )}
          style={{ width: `${pct(committed)}%` }}
        />
        {reserved > 0 && (
          <div
            className="hatch absolute inset-y-0 origin-left animate-meter-fill transition-[left,width] duration-500"
            style={{ left: `${pct(committed)}%`, width: `${Math.max(pct(reserved), size === "lg" ? 0.4 : 0.8)}%` }}
          />
        )}
        {limitPos < 100 && (
          <div
            className="absolute inset-y-0 right-0 bg-signal/15"
            style={{ left: `${limitPos}%` }}
            aria-hidden
          />
        )}
      </div>

      {/* Limit post */}
      <div
        aria-hidden
        className="absolute -top-1 h-[calc(100%+0.5rem)] w-[2px] bg-ink"
        style={{ left: `calc(${limitPos}% - 1px)` }}
      />

      {projected !== undefined && projected > 0 && (
        <div
          aria-hidden
          className={clsx(
            "absolute border-l-2 border-dashed",
            projected > limit ? "border-signal" : "border-ink-faint",
            size === "lg" ? "-top-2 h-[calc(100%+1rem)]" : "-top-1 h-[calc(100%+0.5rem)]",
          )}
          style={{ left: `${pct(projected)}%` }}
        />
      )}

      {size === "sm" && over && <span className="sr-only">Over limit</span>}
    </div>
  );
}

export function MeterLegend({ showProjection }: { showProjection?: boolean }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-3.5 rounded-[2px] bg-settled" aria-hidden />
        Settled
      </li>
      <li className="flex items-center gap-1.5">
        <span className="hatch inline-block h-2.5 w-3.5 rounded-[2px]" aria-hidden />
        In flight
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-[2px] bg-ink" aria-hidden />
        Limit
      </li>
      {showProjection && (
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-3 border-l-2 border-dashed border-signal" aria-hidden />
          Month-end pace
        </li>
      )}
    </ul>
  );
}
