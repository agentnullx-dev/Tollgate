"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Agent, Budget } from "@prisma/client";
import { SimulationEngine, type AgentPatch, type BudgetPatch } from "@/lib/sim/engine";
import { MockTransport, type TollgateTransport } from "@/lib/sim/transport";
import type { ToastMessage } from "./ui";

const noopSubscribe = () => () => undefined;
const zero = () => 0;

interface Overlay<T> {
  mutationId: number;
  entityId: string;
  patch: Partial<T>;
}

function applyOverlays<T extends { id: string }>(rows: T[], overlays: Overlay<T>[]): T[] {
  if (overlays.length === 0) return rows;
  return rows.map((row) => {
    let out = row;
    for (const o of overlays) if (o.entityId === row.id) out = { ...out, ...o.patch };
    return out;
  });
}

/**
 * Owns the simulation engine, subscribes React to its ticks, and provides
 * optimistic mutations. Each mutation layers a patch over engine state until
 * the transport settles; on failure that single layer is dropped (rollback)
 * and a toast explains what happened.
 */
export function useConsole() {
  const [engine, setEngine] = useState<SimulationEngine | null>(null);
  const transportRef = useRef<TollgateTransport | null>(null);
  const mutationSeq = useRef(0);
  const [agentOverlays, setAgentOverlays] = useState<Overlay<Agent>[]>([]);
  const [budgetOverlays, setBudgetOverlays] = useState<Overlay<Budget>[]>([]);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => {
    // Built on the client only: history generation uses the real clock.
    const e = new SimulationEngine();
    transportRef.current = new MockTransport(e);
    e.start();
    setEngine(e);
    return () => e.stop();
  }, []);

  const version = useSyncExternalStore(engine?.subscribe ?? noopSubscribe, engine?.getVersion ?? zero, zero);

  const toast = useCallback((text: string, tone: ToastMessage["tone"] = "neutral") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const mutateAgent = useCallback(
    async (agentId: string, patch: AgentPatch, optimistic: Partial<Agent>, messages: { done: string; tone?: ToastMessage["tone"] }) => {
      const transport = transportRef.current;
      if (!transport) return false;
      const mutationId = ++mutationSeq.current;
      setAgentOverlays((o) => [...o, { mutationId, entityId: agentId, patch: optimistic }]);
      try {
        await transport.updateAgent(agentId, patch);
        toast(messages.done, messages.tone);
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : "The change could not be saved.", "signal");
        return false;
      } finally {
        setAgentOverlays((o) => o.filter((x) => x.mutationId !== mutationId));
      }
    },
    [toast],
  );

  const mutateBudget = useCallback(
    async (budgetId: string, patch: BudgetPatch, messages: { done: string }) => {
      const transport = transportRef.current;
      if (!transport) return false;
      const mutationId = ++mutationSeq.current;
      setBudgetOverlays((o) => [...o, { mutationId, entityId: budgetId, patch: patch as Partial<Budget> }]);
      try {
        await transport.updateBudget(budgetId, patch);
        toast(messages.done);
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : "The change could not be saved.", "signal");
        return false;
      } finally {
        setBudgetOverlays((o) => o.filter((x) => x.mutationId !== mutationId));
      }
    },
    [toast],
  );

  const acknowledgeAlert = useCallback(
    async (alertId: string) => {
      try {
        await transportRef.current?.acknowledgeAlert(alertId);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Could not acknowledge the alert.", "signal");
      }
    },
    [toast],
  );

  const acknowledgeIncident = useCallback(
    async (incidentId: string) => {
      try {
        await transportRef.current?.acknowledgeIncident(incidentId);
        toast("Incident acknowledged");
      } catch (err) {
        toast(err instanceof Error ? err.message : "Could not acknowledge the incident.", "signal");
      }
    },
    [toast],
  );

  // Engine arrays are mutated in place; `version` is the change signal for memoization.
  const agents = useMemo(
    () => (engine ? applyOverlays(engine.agents.map((a) => ({ ...a })), agentOverlays) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, version, agentOverlays],
  );
  const budgets = useMemo(
    () => (engine ? applyOverlays(engine.budgets.map((b) => ({ ...b })), budgetOverlays) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, version, budgetOverlays],
  );
  const pendingAgentIds = useMemo(() => new Set(agentOverlays.map((o) => o.entityId)), [agentOverlays]);
  const pendingBudgetIds = useMemo(() => new Set(budgetOverlays.map((o) => o.entityId)), [budgetOverlays]);

  return {
    engine,
    version,
    agents,
    budgets,
    pendingAgentIds,
    pendingBudgetIds,
    mutateAgent,
    mutateBudget,
    acknowledgeAlert,
    acknowledgeIncident,
    toasts,
    toast,
    dismissToast,
  };
}

export type ConsoleState = ReturnType<typeof useConsole>;
