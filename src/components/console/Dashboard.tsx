"use client";

import { useMemo, useState } from "react";
import type { Agent, AgentEnforcementMode, AgentStatus, Budget } from "@prisma/client";
import { DEFAULT_DETECTOR_CONFIG } from "@/lib/anomaly/detector";
import type { OrgRole, Permission } from "@/lib/rbac";
import type { SimSpeed, TrendInterval } from "@/lib/sim/engine";
import { useConsole } from "./useConsole";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { SummaryBand } from "./SummaryBand";
import { TrendPanel } from "./TrendPanel";
import { BudgetsTable, describeTarget, type BudgetRow } from "./BudgetsTable";
import { AgentsTable, STATUS_LABEL, type AgentRow } from "./AgentsTable";
import { IncidentsPanel } from "./IncidentsPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { LiveFeed } from "./LiveFeed";
import { AgentActionDialog, type AgentAction } from "./AgentActionDialog";
import { Toasts } from "./ui";

const SIGMA = DEFAULT_DETECTOR_CONFIG.sigma;

function LoadingShell() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <p className="text-sm font-medium">Building 30 days of usage history</p>
        <p className="mt-1 text-sm text-ink-soft">Running the anomaly detector over every minute of the last day.</p>
        <div className="mx-auto mt-4 h-1.5 w-48 overflow-hidden rounded-full bg-[#E3E8EF]">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-settled" />
        </div>
      </div>
    </div>
  );
}

export interface ConsoleAccess {
  role: OrgRole;
  permissions: Permission[];
  userEmail: string | null;
  organizationName: string;
}

const ROLE_LABEL: Record<OrgRole, string> = { "org:admin": "Admin", "org:developer": "Developer", "org:viewer": "Viewer (read only)" };

export function Dashboard({ access }: { access: ConsoleAccess }) {
  const c = useConsole();
  const has = (p: Permission) => access.permissions.includes(p);
  const can = {
    toggleMode: has("agents:toggle-mode"),
    pause: has("agents:pause"),
    kill: has("agents:kill"),
    release: has("quarantine:release"),
    limits: has("agents:limits"),
    budgets: has("budgets:write"),
  };
  const { engine, version } = c;
  const [interval, setTrendInterval] = useState<TrendInterval>("24h");
  const [project, setProject] = useState("all");
  const [action, setAction] = useState<AgentAction>(null);
  const projectId = project === "all" ? null : project;

  // Engine state is mutable; `version` advances on every tick and mutation.
  const trend = useMemo(() => (engine ? engine.trend(interval, projectId) : []), [engine, version, interval, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const agentRows: AgentRow[] = useMemo(() => {
    if (!engine) return [];
    return c.agents
      .filter((a) => !projectId || a.projectId === projectId)
      .map((agent) => {
        const { model, provider } = engine.modelOf(agent.id);
        return {
          agent,
          project: engine.projects.find((p) => p.id === agent.projectId),
          model,
          provider,
          stats: engine.agentStats(agent.id, interval),
          runaway: engine.isRunaway(agent.id),
        };
      });
  }, [engine, version, c.agents, interval, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const budgetRows: BudgetRow[] = useMemo(() => {
    if (!engine) return [];
    return c.budgets
      .filter((b) => !projectId || b.scope === "ORGANIZATION" || b.projectId === projectId)
      .map((budget) => ({
        budget,
        counter: budget.isActive ? engine.counterFor(engine.budgets.find((x) => x.id === budget.id) ?? budget) : engine.counters.get(budget.id) ?? null,
        target: describeTarget(budget, engine.projects, engine.agents),
      }));
  }, [engine, version, c.budgets, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!engine) return <LoadingShell />;

  const visibleAgentIds = new Set(agentRows.map((r) => r.agent.id));
  const incidents = engine.incidents.filter((i) => visibleAgentIds.has(i.agentId));
  const openIncidents = incidents.filter((i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED");
  const alerts = engine.alerts.filter((a) => !projectId || !a.agentId || visibleAgentIds.has(a.agentId));
  const openAlerts = alerts.filter((a) => !a.acknowledgedAt).length;
  const retrying = engine.deliveries.filter((d) => d.status === "RETRY_SCHEDULED").length;
  const capBudget = c.budgets.find((b) => b.scope === "ORGANIZATION" && b.period === "MONTHLY") ?? null;
  const counts = { incidents: openIncidents.length, alerts: openAlerts };

  // ---- mutations -----------------------------------------------------------

  const setMode = (agent: Agent, mode: AgentEnforcementMode) =>
    void c.mutateAgent(
      agent.id,
      { enforcementMode: mode },
      { enforcementMode: mode },
      { done: `${agent.displayName} now ${mode === "STRICT" ? "uses strict blocking" : "runs alert-only"}` },
    );

  const setStatus = (agent: Agent, status: AgentStatus, reason?: string, resolution?: "RESOLVED" | "FALSE_POSITIVE") =>
    c.mutateAgent(
      agent.id,
      { status, reason, incidentResolution: resolution },
      { status, killReason: status === "KILLED" ? reason ?? null : null },
      {
        done:
          agent.status === "QUARANTINED" && status === "ACTIVE"
            ? `${agent.displayName} released from quarantine`
            : `${agent.displayName} ${STATUS_LABEL[status].toLowerCase()}`,
        tone: status === "KILLED" ? "signal" : "neutral",
      },
    );

  const toggleEnforcement = (b: Budget) => {
    const next = b.enforcement === "BLOCK" ? "ALERT_ONLY" : "BLOCK";
    void c.mutateBudget(b.id, { enforcement: next }, { done: next === "BLOCK" ? `${b.name} now blocks at its limit` : `${b.name} now only alerts` });
  };

  const toggleActive = (b: Budget) =>
    void c.mutateBudget(b.id, { isActive: !b.isActive }, { done: b.isActive ? `${b.name} turned off` : `${b.name} turned on` });

  const changeLimit = (b: Budget, usd: number) =>
    void c.mutateBudget(b.id, { limitMicros: BigInt(Math.round(usd * 1_000_000)) }, { done: `${b.name} limit saved` });

  return (
    <div id="top" className="min-h-screen">
      <Sidebar
        orgName={engine.organization.name}
        plan={engine.organization.plan}
        counts={counts}
        viewer={{ email: access.userEmail, roleLabel: ROLE_LABEL[access.role] }}
      />
      <div className="lg:pl-60">
        <TopBar
          projects={engine.projects}
          projectId={project}
          onProjectChange={setProject}
          nowMs={engine.now}
          running={engine.running}
          onRunningChange={(v) => engine.setRunning(v)}
          speed={engine.speed}
          onSpeedChange={(s: SimSpeed) => engine.setSpeed(s)}
          apiErrors={engine.apiFailureRate > 0}
          onApiErrorsChange={(v) => engine.setApiFailureRate(v ? 0.35 : 0)}
          counts={counts}
        />

        <main className="mx-auto flex max-w-[1480px] flex-col gap-6 px-4 py-6 sm:px-6">
          <SummaryBand
            capBudget={capBudget}
            capCounter={capBudget ? engine.counterFor(engine.budgets.find((b) => b.id === capBudget.id) ?? capBudget) : null}
            nowMs={engine.now}
            spendRatePerMinute={engine.spendRateUsdPerMinute(projectId)}
            agentsRunning={agentRows.filter((r) => r.agent.status === "ACTIVE").length}
            agentsTotal={agentRows.length}
            openIncidents={openIncidents.length}
            retryingDeliveries={retrying}
          />

          <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
            <TrendPanel points={trend} interval={interval} onIntervalChange={setTrendInterval} />
            <LiveFeed decisions={engine.decisions.filter((d) => visibleAgentIds.has(d.agentId))} agents={engine.agents} />
          </div>

          <AgentsTable
            rows={agentRows}
            interval={interval}
            nowMs={engine.now}
            sigma={SIGMA}
            pendingIds={c.pendingAgentIds}
            can={can}
            onModeChange={setMode}
            onStatusChange={(a, s) => void setStatus(a, s)}
            onRequestStop={(agent) => setAction({ kind: "stop", agent })}
            onRequestRelease={(agent) => setAction({ kind: "release", agent })}
            onAutoStopChange={(a, v) =>
              void c.mutateAgent(a.id, { autoKillOnVelocity: v }, { autoKillOnVelocity: v }, { done: v ? `Auto-stop on for ${a.displayName}` : `Auto-stop off for ${a.displayName}` })
            }
            onInjectRunaway={(a) => {
              engine.injectRunaway(a.id);
              c.toast(`${a.displayName} is now looping. Watch its anomaly score climb toward ${SIGMA}σ.`);
            }}
          />

          <BudgetsTable rows={budgetRows} canEdit={can.budgets} pendingIds={c.pendingBudgetIds} onToggleEnforcement={toggleEnforcement} onToggleActive={toggleActive} onChangeLimit={changeLimit} />

          <div className="grid gap-6 xl:grid-cols-2">
            <IncidentsPanel
              incidents={incidents}
              agents={c.agents}
              nowMs={engine.now}
              sigma={SIGMA}
              canRelease={can.release}
              onAcknowledge={(i) => void c.acknowledgeIncident(i.id)}
              onRelease={(agent) => setAction({ kind: "release", agent })}
            />
            <NotificationsPanel
              alerts={alerts}
              deliveries={engine.deliveries}
              channels={engine.channels}
              channelHealth={engine.channelHealth}
              nowMs={engine.now}
              onAcknowledge={(a) => void c.acknowledgeAlert(a.id)}
              onChannelHealthChange={(id, h) => engine.setChannelHealth(id, h)}
            />
          </div>

          <footer className="pb-8 pt-2 text-xs text-ink-faint">
            Simulated tenant. Entities are typed from the Prisma schema; pricing, budget windows, the anomaly detector and notification backoff run the
            same code as the gateway and worker.
          </footer>
        </main>
      </div>

      <AgentActionDialog
        action={action}
        openIncidents={action ? engine.incidents.filter((i) => i.agentId === action.agent.id && (i.status === "OPEN" || i.status === "ACKNOWLEDGED")) : []}
        onClose={() => setAction(null)}
        onConfirm={({ reason, resolution }) => {
          if (!action) return;
          const { agent, kind } = action;
          setAction(null);
          void setStatus(agent, kind === "stop" ? "KILLED" : "ACTIVE", reason, kind === "release" ? resolution : undefined);
        }}
      />
      <Toasts items={c.toasts} onDismiss={c.dismissToast} />
    </div>
  );
}
