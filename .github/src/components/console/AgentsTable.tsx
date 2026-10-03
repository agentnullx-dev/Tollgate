"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Loader2, Search, Zap } from "lucide-react";
import type { Agent, AgentEnforcementMode, AgentStatus, Project } from "@prisma/client";
import type { AgentLiveStats, TrendInterval } from "@/lib/sim/engine";
import { PanelHeader, Segmented, Switch } from "./ui";
import { Sparkline } from "./Sparkline";
import { fmtDateTime, fmtInt, fmtTokens, fmtUsd, relativeTime } from "./format";

export interface AgentRow {
  agent: Agent;
  project: Project | undefined;
  model: string;
  provider: string;
  stats: AgentLiveStats;
  runaway: boolean;
}

type SortKey = "name" | "rate" | "spend" | "requests" | "tpr" | "z" | "lastSeen";
type StatusFilter = "ALL" | AgentStatus;
type ModeFilter = "ALL" | AgentEnforcementMode;

export const STATUS_LABEL: Record<AgentStatus, string> = {
  ACTIVE: "Running",
  PAUSED: "Paused",
  KILLED: "Stopped",
  QUARANTINED: "Quarantined",
};
const STATUS_DOT: Record<AgentStatus, string> = {
  ACTIVE: "bg-settled",
  PAUSED: "bg-reserved",
  KILLED: "bg-signal",
  QUARANTINED: "bg-signal ring-2 ring-signal/30",
};

const INTERVAL_LABEL: Record<TrendInterval, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

function zOf(row: AgentRow): number {
  const v = row.stats.verdict;
  return v && v.status !== "insufficient_history" ? v.zScore : 0;
}

/** Horizontal gauge of the latest z-score against the 3σ trigger. */
function AnomalyGauge({ row, sigma }: { row: AgentRow; sigma: number }) {
  const v = row.stats.verdict;
  if (!v || v.status === "insufficient_history") return <span className="text-xs text-ink-faint">Learning</span>;
  const z = v.zScore;
  const max = sigma * 2;
  const pct = Math.max(0, Math.min(100, (z / max) * 100));
  const tone = z >= sigma ? "bg-signal" : z >= sigma * 0.66 ? "bg-reserved" : "bg-settled";
  return (
    <div className="w-28" title={v.reasons.join(" ") || `Window mean ${(v.windowMeanPerMinute / 1e6).toFixed(4)} USD/min vs threshold ${(v.thresholdPerMinute / 1e6).toFixed(4)}`}>
      <div className="relative h-1.5 w-full rounded-full bg-[#E3E8EF]">
        <div className={clsx("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", tone)} style={{ width: `${pct}%` }} />
        <div className="absolute -top-1 h-3.5 w-[2px] bg-ink" style={{ left: "50%" }} aria-hidden />
      </div>
      <p className={clsx("num mt-1 text-xs", z >= sigma ? "font-semibold text-signal" : "text-ink-soft")}>
        {z >= 0 ? "+" : ""}
        {z.toFixed(1)}σ <span className="text-ink-faint">/ {sigma}σ</span>
      </p>
    </div>
  );
}

export function AgentsTable({
  rows,
  interval,
  nowMs,
  sigma,
  pendingIds,
  can,
  onModeChange,
  onStatusChange,
  onRequestStop,
  onRequestRelease,
  onAutoStopChange,
  onInjectRunaway,
}: {
  rows: AgentRow[];
  interval: TrendInterval;
  nowMs: number;
  sigma: number;
  pendingIds: Set<string>;
  can: { toggleMode: boolean; pause: boolean; kill: boolean; release: boolean; limits: boolean };
  onModeChange: (agent: Agent, mode: AgentEnforcementMode) => void;
  onStatusChange: (agent: Agent, status: AgentStatus) => void;
  onRequestStop: (agent: Agent) => void;
  onRequestRelease: (agent: Agent) => void;
  onAutoStopChange: (agent: Agent, value: boolean) => void;
  onInjectRunaway: (agent: Agent) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [mode, setMode] = useState<ModeFilter>("ALL");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "rate", dir: "desc" });

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { ALL: rows.length, ACTIVE: 0, PAUSED: 0, KILLED: 0, QUARANTINED: 0 };
    for (const r of rows) c[r.agent.status]++;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (status === "ALL" || r.agent.status === status) &&
        (mode === "ALL" || r.agent.enforcementMode === mode) &&
        (!q ||
          r.agent.externalId.toLowerCase().includes(q) ||
          (r.agent.displayName ?? "").toLowerCase().includes(q) ||
          r.model.toLowerCase().includes(q) ||
          (r.project?.name ?? "").toLowerCase().includes(q)),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    const key = (r: AgentRow): number | string => {
      switch (sort.key) {
        case "name":
          return (r.agent.displayName ?? r.agent.externalId).toLowerCase();
        case "rate":
          return r.stats.spendPerMinuteUsd;
        case "spend":
          return r.stats.spendInIntervalUsd;
        case "requests":
          return r.stats.requestsInInterval;
        case "tpr":
          return r.stats.tokensPerRequest;
        case "z":
          return zOf(r);
        case "lastSeen":
          return r.agent.lastSeenAt?.getTime() ?? 0;
      }
    };
    return filtered.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return dir * (typeof ka === "string" && typeof kb === "string" ? ka.localeCompare(kb) : (ka as number) - (kb as number));
    });
  }, [rows, query, status, mode, sort]);

  const th = (label: string, k: SortKey, align: "left" | "right" = "left", extra = "") => {
    const active = sort.key === k;
    return (
      <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={clsx("px-3 py-2.5 font-medium", align === "right" && "text-right", extra)}>
        <button
          type="button"
          onClick={() => setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" ? "asc" : "desc" }))}
          className={clsx("inline-flex items-center gap-1 hover:text-ink", active && "text-ink")}
        >
          {label}
          {active && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
        </button>
      </th>
    );
  };

  const btn = "rounded border border-rule px-2.5 py-1 text-xs font-medium hover:border-ink disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <section id="agents" aria-labelledby="agents-title" className="panel scroll-mt-28">
      <PanelHeader
        titleId="agents-title"
        title="Running agents"
        description={`Live rate and anomaly score per agent. Spend and requests cover the last ${INTERVAL_LABEL[interval]}.`}
        actions={
          <label className="relative block">
            <span className="sr-only">Search agents</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents, models, projects"
              className="w-60 rounded-md border border-rule bg-panel py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-ink-faint focus:border-ink"
            />
          </label>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2.5 sm:px-5">
        <Segmented<StatusFilter>
          label="Filter by status"
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: "ALL", label: `All ${counts.ALL}` },
            { value: "ACTIVE", label: `Running ${counts.ACTIVE}` },
            { value: "PAUSED", label: `Paused ${counts.PAUSED}` },
            { value: "KILLED", label: `Stopped ${counts.KILLED}` },
            { value: "QUARANTINED", label: `Quarantined ${counts.QUARANTINED}` },
          ]}
        />
        <Segmented<ModeFilter>
          label="Filter by enforcement mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "ALL", label: "Any mode" },
            { value: "STRICT", label: "Strict blocking" },
            { value: "ALERT_ONLY", label: "Alert-only" },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <div className="px-5 py-8">
          <p className="text-sm font-medium">No agents match.</p>
          <p className="mt-1 text-sm text-ink-soft">Clear the search or pick another filter. New agents appear on their first request.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-xs text-ink-soft">
                {th("Agent", "name", "left", "pl-5")}
                <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Budget enforcement</th>
                {th("Spend rate", "rate")}
                {th("Spend", "spend", "right")}
                {th("Requests", "requests", "right")}
                {th("Tokens/req", "tpr", "right")}
                {th("Anomaly", "z")}
                {th("Last request", "lastSeen")}
                <th scope="col" className="px-5 py-2.5 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {visible.map((r) => {
                const a = r.agent;
                const name = a.displayName ?? a.externalId;
                const pending = pendingIds.has(a.id);
                const strict = a.enforcementMode === "STRICT";
                const restricted = a.status === "KILLED" || a.status === "QUARANTINED";
                return (
                  <tr key={a.id} className={clsx(a.status === "QUARANTINED" && "bg-signal-soft/40", a.status === "KILLED" && "bg-signal-soft/20")} aria-busy={pending}>
                    <td className="px-3 py-3 pl-5 align-top">
                      <p className="flex items-center gap-1.5 font-medium">
                        {name}
                        {pending && <Loader2 className="h-3 w-3 animate-spin text-ink-faint" aria-label="Saving" />}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-soft">
                        {a.externalId}
                        <span className="text-ink-faint"> on </span>
                        {r.model}
                      </p>
                      <p className="text-[11px] text-ink-faint">{r.project?.name}</p>
                      {restricted && a.killReason && <p className="mt-1 max-w-[36ch] text-xs leading-snug text-signal">{a.killReason}</p>}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span aria-hidden className={clsx("h-2 w-2 rounded-full", STATUS_DOT[a.status])} />
                        {STATUS_LABEL[a.status]}
                      </span>
                      {a.status === "QUARANTINED" && a.quarantinedAt && <p className="mt-0.5 text-xs text-ink-faint">{fmtDateTime(a.quarantinedAt.toISOString())}</p>}
                      {r.runaway && a.status === "ACTIVE" && <p className="mt-0.5 text-xs font-medium text-signal">Runaway in progress</p>}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <label className="flex items-center gap-2">
                        <Switch
                          checked={strict}
                          onChange={(v) => onModeChange(a, v ? "STRICT" : "ALERT_ONLY")}
                          label={`${name}: ${strict ? "switch to alert-only" : "switch to strict blocking"}`}
                          disabled={pending || !can.toggleMode}
                        />
                        <span className={clsx("whitespace-nowrap text-xs font-medium", strict ? "text-ink" : "text-[#9A6A0C]")}>{strict ? "Strict blocking" : "Alert-only"}</span>
                      </label>
                      <p className="mt-1 max-w-[22ch] text-[11px] leading-snug text-ink-faint">
                        {strict ? "Requests over a blocking budget are refused." : "Over-limit requests pass and raise an alert."}
                      </p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <Sparkline values={r.stats.sparkline} tone={zOf(r) >= sigma || r.runaway ? "signal" : "settled"} label={`${name} spend per minute, last 30 minutes`} />
                        <span className="num whitespace-nowrap text-xs font-semibold">{fmtUsd(r.stats.spendPerMinuteUsd)}/min</span>
                      </div>
                    </td>
                    <td className="num px-3 py-3 text-right align-top font-semibold">{fmtUsd(r.stats.spendInIntervalUsd)}</td>
                    <td className="num px-3 py-3 text-right align-top">
                      {fmtInt(r.stats.requestsInInterval)}
                      {r.stats.blockedInInterval > 0 && <p className="text-[11px] text-signal">{fmtInt(r.stats.blockedInInterval)} blocked</p>}
                    </td>
                    <td className="num px-3 py-3 text-right align-top text-ink-soft">{r.stats.tokensPerRequest ? fmtTokens(Math.round(r.stats.tokensPerRequest)) : "n/a"}</td>
                    <td className="px-3 py-3 align-top">
                      <AnomalyGauge row={r} sigma={sigma} />
                    </td>
                    <td className="px-3 py-3 align-top text-ink-soft">
                      {a.lastSeenAt ? (
                        <time dateTime={a.lastSeenAt.toISOString()} title={fmtDateTime(a.lastSeenAt.toISOString())}>
                          {relativeTime(a.lastSeenAt.toISOString(), nowMs)}
                        </time>
                      ) : (
                        "Never"
                      )}
                      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-faint">
                        <Switch
                          checked={a.autoKillOnVelocity}
                          onChange={(v) => onAutoStopChange(a, v)}
                          disabled={a.maxRequestsPerMinute === null || pending || !can.limits}
                          tone="signal"
                          label={`Stop ${name} automatically above ${a.maxRequestsPerMinute ?? "its"} requests per minute`}
                        />
                        Auto-stop above {a.maxRequestsPerMinute ?? "∞"}/min
                      </label>
                    </td>
                    <td className="px-5 py-3 align-top">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {a.status === "ACTIVE" && (
                          <>
                            {can.pause && (
                              <button type="button" className={btn} disabled={pending} onClick={() => onStatusChange(a, "PAUSED")}>
                                Pause
                              </button>
                            )}
                            <button
                              type="button"
                              className={clsx(btn, "inline-flex items-center gap-1")}
                              disabled={r.runaway}
                              onClick={() => onInjectRunaway(a)}
                              title="Multiply this agent's request rate and size for 15 simulated minutes"
                            >
                              <Zap className="h-3 w-3" aria-hidden />
                              Simulate runaway
                            </button>
                          </>
                        )}
                        {a.status === "PAUSED" && can.pause && (
                          <button type="button" className={btn} disabled={pending} onClick={() => onStatusChange(a, "ACTIVE")}>
                            Resume
                          </button>
                        )}
                        {a.status === "QUARANTINED" && can.release && (
                          <button type="button" className={clsx(btn, "border-ink text-ink")} disabled={pending} onClick={() => onRequestRelease(a)}>
                            Review and release
                          </button>
                        )}
                        {a.status === "KILLED" && can.kill && (
                          <button type="button" className={btn} disabled={pending} onClick={() => onStatusChange(a, "ACTIVE")}>
                            Reactivate
                          </button>
                        )}
                        {a.status !== "KILLED" && can.kill && (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => onRequestStop(a)}
                            className="rounded border border-signal/40 px-2.5 py-1 text-xs font-medium text-signal hover:border-signal hover:bg-signal-soft disabled:opacity-40"
                          >
                            Stop
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
