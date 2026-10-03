"use client";

import clsx from "clsx";
import type { Agent, SecurityIncident } from "@prisma/client";
import { PanelHeader } from "./ui";
import { fmtDateTime, fmtMicros, fmtUsd, relativeTime } from "./format";

const STATUS_TEXT: Record<SecurityIncident["status"], string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  RESOLVED: "Resolved",
  FALSE_POSITIVE: "False positive",
};

function evidenceReasons(incident: SecurityIncident): string[] {
  const ev = incident.evidence;
  if (ev && typeof ev === "object" && !Array.isArray(ev) && Array.isArray((ev as Record<string, unknown>).reasons)) {
    return ((ev as Record<string, unknown>).reasons as unknown[]).filter((r): r is string => typeof r === "string");
  }
  return [];
}

function numberField(incident: SecurityIncident, key: string): number | null {
  const ev = incident.evidence;
  if (ev && typeof ev === "object" && !Array.isArray(ev)) {
    const v = (ev as Record<string, unknown>)[key];
    return typeof v === "number" ? v : null;
  }
  return null;
}

export function IncidentsPanel({
  incidents,
  agents,
  nowMs,
  sigma,
  canRelease,
  onAcknowledge,
  onRelease,
}: {
  incidents: SecurityIncident[];
  agents: Agent[];
  nowMs: number;
  sigma: number;
  canRelease: boolean;
  onAcknowledge: (incident: SecurityIncident) => void;
  onRelease: (agent: Agent) => void;
}) {
  const open = incidents.filter((i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED");

  return (
    <section id="incidents" aria-labelledby="incidents-title" className="panel flex scroll-mt-28 flex-col">
      <PanelHeader
        titleId="incidents-title"
        title="Security incidents"
        description={open.length ? `${open.length} open. Quarantined agents refuse every request until released.` : `No open incidents. Agents are quarantined automatically above ${sigma}σ.`}
      />
      {incidents.length === 0 ? (
        <div className="px-5 py-8">
          <p className="text-sm font-medium">No anomalies recorded.</p>
          <p className="mt-1 text-sm text-ink-soft">Use “Simulate runaway” on a running agent to watch the detector quarantine it within a few minutes.</p>
        </div>
      ) : (
        <ul className="max-h-[34rem] divide-y divide-rule overflow-y-auto">
          {incidents.map((inc) => {
            const agent = agents.find((a) => a.id === inc.agentId);
            const name = agent?.displayName ?? agent?.externalId ?? inc.agentId;
            const windowMinutes = numberField(inc, "windowMinutes") ?? 5;
            const live = inc.status === "OPEN" || inc.status === "ACKNOWLEDGED";
            const baselinePerMin = inc.baselineMeanMicros / 1e6;
            const thresholdPerMin = inc.thresholdMicros / 1e6;
            const windowPerMin = Number(inc.windowSpendMicros) / 1e6 / windowMinutes;
            const scaleMax = Math.max(windowPerMin, thresholdPerMin) * 1.05 || 1;
            return (
              <li key={inc.id} className="relative px-5 py-4">
                <span aria-hidden className={clsx("absolute inset-y-4 left-0 w-[3px] rounded-r", live ? "bg-signal" : "bg-ink-faint")} />
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-ink-soft">
                      Spend anomaly <span className="text-ink-faint">/</span>{" "}
                      <time dateTime={inc.createdAt.toISOString()} title={fmtDateTime(inc.createdAt.toISOString())}>
                        {relativeTime(inc.createdAt.toISOString(), nowMs)}
                      </time>{" "}
                      <span className="text-ink-faint">/</span> {STATUS_TEXT[inc.status]}
                    </p>
                    <p className="mt-0.5 font-medium">
                      {name} spent {fmtUsd(Number(inc.windowSpendMicros) / 1e6)} in {windowMinutes} minutes,{" "}
                      <span className={live ? "text-signal" : ""}>{inc.zScore.toFixed(1)}σ above normal</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {inc.status === "OPEN" && (
                      <button type="button" onClick={() => onAcknowledge(inc)} className="rounded border border-rule px-2.5 py-1 text-xs font-medium hover:border-ink">
                        Acknowledge
                      </button>
                    )}
                    {live && agent?.status === "QUARANTINED" && canRelease && (
                      <button type="button" onClick={() => onRelease(agent)} className="rounded border border-ink px-2.5 py-1 text-xs font-medium hover:bg-paper">
                        Review and release
                      </button>
                    )}
                  </div>
                </div>

                {/* Evidence scale: normal rate, trigger and observed rate on one axis */}
                <div className="mt-3" role="img" aria-label={`Normal ${fmtUsd(baselinePerMin)} per minute, trigger ${fmtUsd(thresholdPerMin)} per minute, observed ${fmtUsd(windowPerMin)} per minute`}>
                  <div className="relative h-2 w-full rounded-full bg-[#E3E8EF]">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-settled/50" style={{ width: `${(baselinePerMin / scaleMax) * 100}%` }} />
                    <div className="absolute -top-1 h-4 w-[2px] bg-ink" style={{ left: `${(thresholdPerMin / scaleMax) * 100}%` }} />
                    <div className="absolute -top-1.5 h-5 w-[3px] rounded bg-signal" style={{ left: `calc(${(windowPerMin / scaleMax) * 100}% - 3px)` }} />
                  </div>
                  <dl className="num mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-ink-soft">Normal rate</dt>
                      <dd>{fmtUsd(baselinePerMin)}/min</dd>
                    </div>
                    <div>
                      <dt className="text-ink-soft">Trigger ({sigma}σ)</dt>
                      <dd>{fmtUsd(thresholdPerMin)}/min</dd>
                    </div>
                    <div>
                      <dt className="text-ink-soft">Observed</dt>
                      <dd className="font-semibold text-signal">{fmtUsd(windowPerMin)}/min</dd>
                    </div>
                  </dl>
                </div>

                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-ink-soft hover:text-ink">Detector evidence and ledger record</summary>
                  <dl className="num mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-paper p-3">
                    <dt className="text-ink-soft">Incident</dt>
                    <dd className="break-all">{inc.id}</dd>
                    <dt className="text-ink-soft">Window</dt>
                    <dd>
                      {fmtDateTime(inc.windowStart.toISOString())} to {fmtDateTime(inc.windowEnd.toISOString())}
                    </dd>
                    <dt className="text-ink-soft">Window spend</dt>
                    <dd>{fmtMicros(inc.windowSpendMicros)}</dd>
                    <dt className="text-ink-soft">Baseline σ (effective)</dt>
                    <dd>{fmtMicros(Math.round(inc.baselineStdMicros))} per minute</dd>
                    <dt className="text-ink-soft">Action</dt>
                    <dd>{inc.actionTaken === "QUARANTINED" ? "Agent quarantined" : inc.actionTaken}</dd>
                    <dt className="text-ink-soft">Detector</dt>
                    <dd>{inc.detectorVersion}</dd>
                    {inc.resolutionNote && (
                      <>
                        <dt className="text-ink-soft">Resolution</dt>
                        <dd>{inc.resolutionNote}</dd>
                      </>
                    )}
                  </dl>
                  {evidenceReasons(inc).length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
                      {evidenceReasons(inc).map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
