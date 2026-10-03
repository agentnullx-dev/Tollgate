"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import type { Agent, Budget, BudgetScope, Project } from "@prisma/client";
import type { BudgetCounter } from "@/lib/sim/engine";
import { SpendMeter } from "./SpendMeter";
import { PanelHeader, Segmented, Switch } from "./ui";
import { fmtUsd, periodLabel } from "./format";

export interface BudgetRow {
  budget: Budget;
  counter: BudgetCounter | null;
  target: string;
}

type SortKey = "name" | "period" | "spent" | "limit" | "utilization";
type ScopeFilter = "ALL" | BudgetScope;
type StateFilter = "ALL" | "OVER" | "WARN" | "OK";
type EnforcementFilter = "ALL" | "BLOCK" | "ALERT_ONLY";

const PERIOD_ORDER = { DAILY: 0, WEEKLY: 1, MONTHLY: 2, TOTAL: 3 } as const;

function usdOf(micros: bigint): number {
  return Number(micros) / 1e6;
}

function utilization(row: BudgetRow): number {
  if (!row.counter || row.budget.limitMicros <= 0n) return 0;
  return Number(row.counter.committedMicros + row.counter.reservedMicros) / Number(row.budget.limitMicros);
}

export function describeTarget(budget: Budget, projects: Project[], agents: Agent[]): string {
  if (budget.scope === "ORGANIZATION") return "Whole organization";
  if (budget.scope === "PROJECT") return projects.find((p) => p.id === budget.projectId)?.name ?? "Project";
  const agent = agents.find((a) => a.id === budget.agentId);
  return `Agent: ${agent?.displayName ?? agent?.externalId ?? "unknown"}`;
}

function LimitEditor({ budget, disabled, onCommit }: { budget: Budget; disabled: boolean; onCommit: (usd: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(usdOf(budget.limitMicros).toFixed(2));
          setError(null);
          setEditing(true);
        }}
        className="num rounded px-1 py-0.5 text-right font-semibold underline decoration-rule decoration-dotted underline-offset-4 hover:decoration-ink disabled:no-underline"
        aria-label={`Edit limit for ${budget.name}`}
      >
        {fmtUsd(usdOf(budget.limitMicros))}
      </button>
    );
  }

  const commit = () => {
    const value = Number(draft);
    if (!Number.isFinite(value) || value <= 0 || value > 10_000_000) {
      setError("Enter an amount between $0.01 and $10,000,000.");
      return;
    }
    setEditing(false);
    if (Math.round(value * 1e6) !== Number(budget.limitMicros)) onCommit(value);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <span className="text-ink-faint">$</span>
        <input
          autoFocus
          inputMode="decimal"
          value={draft}
          aria-label={`New limit for ${budget.name} in US dollars`}
          aria-invalid={!!error}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className={clsx("num w-24 rounded border bg-panel px-2 py-1 text-right text-sm outline-none focus:border-ink", error ? "border-signal" : "border-rule")}
        />
      </div>
      {error && <p className="max-w-[18ch] text-right text-[11px] text-signal">{error}</p>}
    </div>
  );
}

export function BudgetsTable({
  rows,
  canEdit,
  pendingIds,
  onToggleEnforcement,
  onToggleActive,
  onChangeLimit,
}: {
  rows: BudgetRow[];
  canEdit: boolean;
  pendingIds: Set<string>;
  onToggleEnforcement: (budget: Budget) => void;
  onToggleActive: (budget: Budget) => void;
  onChangeLimit: (budget: Budget, usd: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("ALL");
  const [state, setState] = useState<StateFilter>("ALL");
  const [enforcement, setEnforcement] = useState<EnforcementFilter>("ALL");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "utilization", dir: "desc" });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      const u = utilization(r);
      if (scope !== "ALL" && r.budget.scope !== scope) return false;
      if (enforcement !== "ALL" && r.budget.enforcement !== enforcement) return false;
      if (state === "OVER" && u <= 1) return false;
      if (state === "WARN" && (u < 0.8 || u > 1)) return false;
      if (state === "OK" && u >= 0.8) return false;
      return !q || r.budget.name.toLowerCase().includes(q) || r.target.toLowerCase().includes(q);
    });
    const dir = sort.dir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      switch (sort.key) {
        case "name":
          return dir * a.budget.name.localeCompare(b.budget.name);
        case "period":
          return dir * (PERIOD_ORDER[a.budget.period] - PERIOD_ORDER[b.budget.period]);
        case "spent":
          return dir * Number((a.counter?.committedMicros ?? 0n) - (b.counter?.committedMicros ?? 0n));
        case "limit":
          return dir * Number(a.budget.limitMicros - b.budget.limitMicros);
        default:
          return dir * (utilization(a) - utilization(b));
      }
    });
  }, [rows, query, scope, state, enforcement, sort]);

  const header = (label: string, key: SortKey, align: "left" | "right" = "left", extra = "") => {
    const active = sort.key === key;
    return (
      <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={clsx("px-3 py-2.5 font-medium", align === "right" && "text-right", extra)}>
        <button
          type="button"
          onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "period" ? "asc" : "desc" }))}
          className={clsx("inline-flex items-center gap-1 hover:text-ink", active && "text-ink")}
        >
          {label}
          {active && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
        </button>
      </th>
    );
  };

  const overCount = rows.filter((r) => utilization(r) > 1).length;

  return (
    <section id="budgets" aria-labelledby="budgets-title" className="panel scroll-mt-28">
      <PanelHeader
        titleId="budgets-title"
        title="Budgets"
        description={`${rows.length} budgets, ${overCount} over limit. Every request is checked against all budgets that cover it.`}
        actions={
          <label className="relative block">
            <span className="sr-only">Search budgets</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search budgets"
              className="w-48 rounded-md border border-rule bg-panel py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-ink-faint focus:border-ink"
            />
          </label>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2.5 sm:px-5">
        <Segmented<ScopeFilter>
          label="Filter by scope"
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: "ALL", label: "All scopes" },
            { value: "ORGANIZATION", label: "Organization" },
            { value: "PROJECT", label: "Project" },
            { value: "AGENT", label: "Agent" },
          ]}
        />
        <Segmented<StateFilter>
          label="Filter by state"
          size="sm"
          value={state}
          onChange={setState}
          options={[
            { value: "ALL", label: "Any usage" },
            { value: "OVER", label: "Over limit" },
            { value: "WARN", label: "80–100%" },
            { value: "OK", label: "Under 80%" },
          ]}
        />
        <Segmented<EnforcementFilter>
          label="Filter by enforcement"
          size="sm"
          value={enforcement}
          onChange={setEnforcement}
          options={[
            { value: "ALL", label: "Any rule" },
            { value: "BLOCK", label: "Blocks" },
            { value: "ALERT_ONLY", label: "Alerts only" },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <div className="px-5 py-8">
          <p className="text-sm font-medium">No budgets match these filters.</p>
          <p className="mt-1 text-sm text-ink-soft">Clear the search or widen the filters to see more.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-xs text-ink-soft">
                {header("Budget", "name", "left", "pl-5")}
                {header("Period", "period")}
                <th scope="col" className="w-[30%] px-3 py-2.5 font-medium">
                  <button type="button" onClick={() => setSort((s) => ({ key: "utilization", dir: s.key === "utilization" && s.dir === "desc" ? "asc" : "desc" }))} className={clsx("inline-flex items-center gap-1 hover:text-ink", sort.key === "utilization" && "text-ink")}>
                    Current period
                    {sort.key === "utilization" && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                  </button>
                </th>
                {header("Spent", "spent", "right")}
                {header("Limit", "limit", "right")}
                <th scope="col" className="px-3 py-2.5 font-medium">Block at limit</th>
                <th scope="col" className="px-5 py-2.5 font-medium">On</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {visible.map((r) => {
                const { budget, counter } = r;
                const u = utilization(r);
                const pending = pendingIds.has(budget.id);
                const committed = counter ? usdOf(counter.committedMicros) : 0;
                const reserved = counter ? usdOf(counter.reservedMicros) : 0;
                const limit = usdOf(budget.limitMicros);
                return (
                  <tr key={budget.id} className={clsx(!budget.isActive && "text-ink-faint", pending && "opacity-70")} aria-busy={pending}>
                    <td className="px-3 py-3.5 pl-5 align-top">
                      <p className={clsx("font-medium", budget.isActive ? "text-ink" : "text-ink-faint")}>{budget.name}</p>
                      <p className="mt-0.5 text-xs text-ink-soft">{r.target}</p>
                      {budget.managedBy && <p className="mt-0.5 text-[11px] text-ink-faint">Set by your subscription plan</p>}
                    </td>
                    <td className="px-3 py-3.5 align-top text-ink-soft">
                      {periodLabel(budget.period)}
                      {counter && <p className="num text-[11px] text-ink-faint">{counter.periodKey}</p>}
                    </td>
                    <td className="px-3 py-3.5 align-top">
                      <div className={clsx(!budget.isActive && "opacity-40")}>
                        <SpendMeter committed={committed} reserved={reserved} limit={limit} label={`${budget.name} utilization`} />
                        <p
                          className={clsx(
                            "num mt-2 text-xs font-medium",
                            u > 1 ? "text-signal" : u >= 0.8 ? "text-[#9A6A0C]" : "text-ink-soft",
                          )}
                        >
                          {u > 1 ? `Over by ${fmtUsd(committed + reserved - limit)}` : `${Math.round(u * 100)}% used`}
                          {u > 1 && budget.enforcement === "ALERT_ONLY" && <span className="font-normal text-ink-soft">, still allowing requests</span>}
                        </p>
                      </div>
                    </td>
                    <td className="num px-3 py-3.5 text-right align-top">{fmtUsd(committed)}</td>
                    <td className="px-3 py-3.5 text-right align-top">
                      <LimitEditor budget={budget} disabled={pending || !canEdit || !!budget.managedBy} onCommit={(usd) => onChangeLimit(budget, usd)} />
                    </td>
                    <td className="px-3 py-3.5 align-top">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={budget.enforcement === "BLOCK"}
                          onChange={() => onToggleEnforcement(budget)}
                          label={`Block requests when ${budget.name} is reached`}
                          disabled={!budget.isActive || !canEdit || !!budget.managedBy}
                        />
                        <span className="text-xs text-ink-soft">{budget.enforcement === "BLOCK" ? "Blocks" : "Alerts only"}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 align-top">
                      <Switch
                        checked={budget.isActive}
                        onChange={() => onToggleActive(budget)}
                        disabled={!canEdit || !!budget.managedBy}
                        label={`Turn ${budget.name} ${budget.isActive ? "off" : "on"}`}
                      />
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
