import type { ReactNode } from "react";
import clsx from "clsx";
import type { Budget } from "@prisma/client";
import type { BudgetCounter } from "@/lib/sim/engine";
import { SpendMeter, MeterLegend } from "./SpendMeter";
import { fmtUsd, fmtDay } from "./format";

const DAY = 86_400_000;

export function SummaryBand({
  capBudget,
  capCounter,
  nowMs,
  spendRatePerMinute,
  agentsRunning,
  agentsTotal,
  openIncidents,
  retryingDeliveries,
}: {
  capBudget: Budget | null;
  capCounter: BudgetCounter | null;
  nowMs: number;
  spendRatePerMinute: number;
  agentsRunning: number;
  agentsTotal: number;
  openIncidents: number;
  retryingDeliveries: number;
}) {
  let meter: ReactNode = null;
  if (capBudget && capCounter && capCounter.periodEnd) {
    const committed = Number(capCounter.committedMicros) / 1e6;
    const reserved = Number(capCounter.reservedMicros) / 1e6;
    const limit = Number(capBudget.limitMicros) / 1e6;
    const start = capCounter.periodStart.getTime();
    const end = capCounter.periodEnd.getTime();
    const elapsedDays = Math.max(0.25, (nowMs - start) / DAY);
    const periodDays = (end - start) / DAY;
    const projected = (committed / elapsedDays) * periodDays;
    const crossesAt = projected > limit && committed > 0 ? start + (limit / (committed / elapsedDays)) * DAY : null;
    const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(start));

    const verdict =
      committed >= limit
        ? capBudget.enforcement === "BLOCK"
          ? "The cap is reached. Strict agents are being blocked."
          : "The cap is passed. Requests continue because this budget only alerts."
        : crossesAt
          ? `At this pace you'll hit the cap around ${fmtDay(new Date(crossesAt).toISOString())} and overshoot it by ${fmtUsd(projected - limit)}.`
          : `At this pace ${month} ends near ${fmtUsd(projected)}, inside the cap.`;

    meter = (
      <section aria-labelledby="cap-title" className="flex flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 id="cap-title" className="text-sm font-medium text-ink-soft">
            {capBudget.name}, {month}
          </h1>
          <p className="text-sm text-ink-soft">{capBudget.enforcement === "BLOCK" ? "Blocks strict agents at the limit" : "Alerts only"}</p>
        </div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          <p className="num text-[2.4rem] font-semibold leading-none tracking-[-0.03em] sm:text-[3rem]">{fmtUsd(committed)}</p>
          <p className="num pb-1 text-lg text-ink-soft">of {fmtUsd(limit)}</p>
        </div>
        <SpendMeter size="lg" committed={committed} reserved={reserved} limit={limit} projected={projected} label={`${capBudget.name} utilization`} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <p className={clsx("max-w-[56ch] text-[15px] leading-relaxed", crossesAt ? "text-signal" : "text-ink")}>{verdict}</p>
          <MeterLegend showProjection />
        </div>
      </section>
    );
  }

  const stats = [
    { term: "Spending now", value: `${fmtUsd(spendRatePerMinute)}/min`, hint: "Average of the last 5 minutes", tone: "ink" },
    { term: "Agents running", value: `${agentsRunning} of ${agentsTotal}`, hint: "Others are paused, stopped or quarantined", tone: "ink" },
    { term: "Open incidents", value: String(openIncidents), hint: openIncidents ? "Quarantined agents need review" : "No anomalies detected", tone: openIncidents ? "signal" : "ink" },
    { term: "Notifications retrying", value: String(retryingDeliveries), hint: retryingDeliveries ? "Backing off after provider errors" : "All channels delivering", tone: retryingDeliveries ? "warn" : "ink" },
  ] as const;

  return (
    <div className="panel grid overflow-hidden xl:grid-cols-[minmax(0,1fr)_380px]">
      {meter}
      <dl className="grid grid-cols-2 gap-px border-t border-rule bg-rule xl:grid-cols-1 xl:border-l xl:border-t-0">
        {stats.map((s) => (
          <div key={s.term} className="bg-panel px-4 py-3 sm:px-5">
            <dt className="text-xs text-ink-soft">{s.term}</dt>
            <dd className={clsx("num mt-0.5 text-xl font-semibold", s.tone === "signal" && "text-signal", s.tone === "warn" && "text-[#9A6A0C]")}>{s.value}</dd>
            <dd className="mt-0.5 text-xs text-ink-faint">{s.hint}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
