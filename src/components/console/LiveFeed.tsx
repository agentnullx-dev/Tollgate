import clsx from "clsx";
import type { Agent } from "@prisma/client";
import type { GateDecision } from "@/lib/sim/engine";
import { PanelHeader } from "./ui";
import { fmtClock, fmtUsd } from "./format";

export function LiveFeed({ decisions, agents }: { decisions: GateDecision[]; agents: Agent[] }) {
  const names = new Map(agents.map((a) => [a.id, a.displayName ?? a.externalId]));
  return (
    <section aria-labelledby="feed-title" className="panel flex flex-col">
      <PanelHeader titleId="feed-title" title="Gate decisions" description="Most recent first. Estimates are worst case; settled cost replaces them." />
      <ol className="max-h-[26rem] divide-y divide-rule overflow-y-auto" aria-live="off">
        {decisions.slice(0, 14).map((d) => (
          <li key={d.id} className="flex items-start gap-3 px-4 py-2">
            <span aria-hidden className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", d.decision === "DENY" ? "bg-signal" : d.overLimit ? "bg-reserved" : "bg-settled")} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{names.get(d.agentId) ?? d.agentId}</p>
              <p className="truncate text-xs text-ink-soft">
                {d.model}, {d.costMicros !== null ? `${fmtUsd(Number(d.costMicros) / 1e6)} settled` : `est. ${fmtUsd(Number(d.estimateMicros) / 1e6)}`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className={clsx("text-xs font-semibold", d.decision === "DENY" ? "text-signal" : d.overLimit ? "text-[#9A6A0C]" : "text-settled")}>
                {d.decision === "DENY" ? "Blocked" : d.overLimit ? "Allowed over limit" : "Allowed"}
              </p>
              <p className="num text-[11px] text-ink-faint">{d.reason ?? fmtClock(d.at.getTime())}</p>
            </div>
          </li>
        ))}
        {decisions.length === 0 && <li className="px-4 py-6 text-sm text-ink-soft">Waiting for the first request.</li>}
      </ol>
    </section>
  );
}
