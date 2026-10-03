"use client";

import { useMemo, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipProps } from "recharts";
import type { TrendInterval, TrendPoint } from "@/lib/sim/engine";
import { PanelHeader, Segmented } from "./ui";
import { fmtDayHour, fmtInt, fmtMicros, fmtTokens, fmtUsd, fmtPct } from "./format";

const INTERVALS: Array<{ value: TrendInterval; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

const BUCKET_LABEL: Record<TrendInterval, string> = { "24h": "15-minute", "7d": "hourly", "30d": "6-hour" };

const AXIS = { fill: "#7A869B", fontSize: 11 };

function tickTime(interval: TrendInterval) {
  const fmt =
    interval === "24h"
      ? new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })
      : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (t: number) => fmt.format(new Date(t));
}

function Shell({ active, payload, children }: TooltipProps<number, string> & { children: (p: TrendPoint) => ReactNode }) {
  const p = payload?.[0]?.payload as TrendPoint | undefined;
  if (!active || !p) return null;
  return (
    <div className="rounded-md border border-rule bg-panel px-3 py-2 text-sm shadow-md">
      <p className="font-medium">{fmtDayHour(p.t)} UTC</p>
      {children(p)}
    </div>
  );
}

export function TrendPanel({
  points,
  interval,
  onIntervalChange,
}: {
  points: TrendPoint[];
  interval: TrendInterval;
  onIntervalChange: (i: TrendInterval) => void;
}) {
  const totals = useMemo(
    () =>
      points.reduce(
        (a, p) => ({
          costMicros: a.costMicros + p.costMicros,
          requests: a.requests + p.requests,
          blocked: a.blocked + p.blocked,
          tokens: a.tokens + p.inputTokens + p.cachedTokens + p.outputTokens,
          cached: a.cached + p.cachedTokens,
          input: a.input + p.inputTokens,
        }),
        { costMicros: 0, requests: 0, blocked: 0, tokens: 0, cached: 0, input: 0 },
      ),
    [points],
  );
  const tick = tickTime(interval);
  const attempted = totals.requests + totals.blocked;
  const peak = points.reduce<TrendPoint | null>((best, p) => (!best || p.costMicros > best.costMicros ? p : best), null);

  return (
    <section id="trends" aria-labelledby="trends-title" className="panel scroll-mt-28">
      <PanelHeader
        titleId="trends-title"
        title="Spend, requests and tokens"
        description={`${BUCKET_LABEL[interval]} buckets, settled usage only`}
        actions={<Segmented<TrendInterval> label="Trend interval" value={interval} onChange={onIntervalChange} options={INTERVALS} size="sm" />}
      />

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 pt-4 sm:grid-cols-4 sm:px-5">
        <div>
          <dt className="text-xs text-ink-soft">Spend</dt>
          <dd className="num text-xl font-semibold">{fmtUsd(totals.costMicros / 1e6)}</dd>
          <dd className="num text-[11px] text-ink-faint">{fmtMicros(totals.costMicros)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Requests settled</dt>
          <dd className="num text-xl font-semibold">{fmtInt(totals.requests)}</dd>
          <dd className="num text-[11px] text-ink-faint">{fmtUsd(totals.requests ? totals.costMicros / 1e6 / totals.requests : 0)} each</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Requests blocked</dt>
          <dd className="num text-xl font-semibold">{fmtInt(totals.blocked)}</dd>
          <dd className="num text-[11px] text-ink-faint">{fmtPct(attempted ? totals.blocked / attempted : 0)} of attempts</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Tokens</dt>
          <dd className="num text-xl font-semibold">{fmtTokens(totals.tokens)}</dd>
          <dd className="num text-[11px] text-ink-faint">{fmtPct(totals.input + totals.cached ? totals.cached / (totals.input + totals.cached) : 0)} of input from cache</dd>
        </div>
      </dl>

      <div className="space-y-1 px-1 pb-2 pt-4 sm:px-3">
        <p className="px-3 text-xs font-medium text-ink-soft">Spend</p>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} syncId="tollgate-trend" margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0E7C6B" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#0E7C6B" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#E3E8EF" />
              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={tick} tick={AXIS} axisLine={{ stroke: "#D5DCE5" }} tickLine={false} minTickGap={40} hide />
              <YAxis width={60} tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`)} dataKey="costUsd" />
              <Tooltip
                cursor={{ stroke: "#13233F", strokeDasharray: "3 3" }}
                content={
                  <Shell>
                    {(p) => (
                      <>
                        <p className="num text-ink">{fmtUsd(p.costUsd)}</p>
                        <p className="num text-xs text-ink-faint">{fmtMicros(p.costMicros)}</p>
                      </>
                    )}
                  </Shell>
                }
              />
              <Area type="monotone" dataKey="costUsd" stroke="#0E7C6B" strokeWidth={2} fill="url(#spendFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <p className="px-3 pt-2 text-xs font-medium text-ink-soft">Requests</p>
        <div className="h-28">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} syncId="tollgate-trend" margin={{ top: 4, right: 12, bottom: 0, left: 4 }} barCategoryGap={1}>
              <CartesianGrid vertical={false} stroke="#E3E8EF" />
              <XAxis dataKey="t" tickFormatter={tick} tick={AXIS} hide />
              <YAxis width={60} tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtTokens(v)} />
              <Tooltip
                cursor={{ fill: "rgba(19,35,63,0.06)" }}
                content={
                  <Shell>
                    {(p) => (
                      <>
                        <p className="num text-ink">{fmtInt(p.requests)} settled</p>
                        <p className="num text-xs text-signal">{fmtInt(p.blocked)} blocked</p>
                      </>
                    )}
                  </Shell>
                }
              />
              <Bar dataKey="requests" stackId="r" fill="#45526A" isAnimationActive={false} />
              <Bar dataKey="blocked" stackId="r" fill="#C2352B" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <p className="px-3 pt-2 text-xs font-medium text-ink-soft">Tokens</p>
        <div className="h-36">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} syncId="tollgate-trend" margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} stroke="#E3E8EF" />
              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={tick} tick={AXIS} axisLine={{ stroke: "#D5DCE5" }} tickLine={false} minTickGap={48} />
              <YAxis width={60} tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtTokens(v)} />
              <Tooltip
                cursor={{ stroke: "#13233F", strokeDasharray: "3 3" }}
                content={
                  <Shell>
                    {(p) => (
                      <dl className="num mt-0.5 grid grid-cols-[auto_auto] gap-x-3 text-xs">
                        <dt className="text-ink-soft">Input</dt>
                        <dd>{fmtTokens(p.inputTokens)}</dd>
                        <dt className="text-ink-soft">Cached input</dt>
                        <dd>{fmtTokens(p.cachedTokens)}</dd>
                        <dt className="text-ink-soft">Output</dt>
                        <dd>{fmtTokens(p.outputTokens)}</dd>
                      </dl>
                    )}
                  </Shell>
                }
              />
              <Area type="monotone" dataKey="inputTokens" stackId="t" stroke="#13233F" fill="#13233F" fillOpacity={0.55} isAnimationActive={false} />
              <Area type="monotone" dataKey="cachedTokens" stackId="t" stroke="#7A869B" fill="#7A869B" fillOpacity={0.45} isAnimationActive={false} />
              <Area type="monotone" dataKey="outputTokens" stackId="t" stroke="#D99A1E" fill="#D99A1E" fillOpacity={0.6} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-1 text-xs text-ink-soft">
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[2px] bg-[#45526A]" aria-hidden />Settled requests</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[2px] bg-signal" aria-hidden />Blocked requests</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[2px] bg-ink/60" aria-hidden />Input tokens</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[2px] bg-ink-faint/60" aria-hidden />Cached input</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-3.5 rounded-[2px] bg-reserved" aria-hidden />Output tokens</li>
        </ul>
      </div>

      {peak && peak.costMicros > 0 && (
        <p className="border-t border-rule px-4 py-2.5 text-[13px] text-ink-soft sm:px-5">
          Most expensive {BUCKET_LABEL[interval]} bucket: <span className="font-medium text-ink">{fmtDayHour(peak.t)} UTC</span>, {fmtUsd(peak.costUsd)} across {fmtInt(peak.requests)} requests.
        </p>
      )}
    </section>
  );
}
