import type { Agent, Budget } from "@prisma/client";
import type { AgentPatch, BudgetPatch, SimulationEngine } from "./engine";

/**
 * The dashboard talks to a transport, never to the engine directly. The mock
 * transport adds realistic latency and optional injected failures so the
 * optimistic-update and rollback paths are exercised exactly as they would be
 * against the real API (PATCH /api/v1/agents/:id, PATCH /api/v1/budgets/:id).
 */
export interface TollgateTransport {
  updateAgent(agentId: string, patch: AgentPatch): Promise<Agent>;
  updateBudget(budgetId: string, patch: BudgetPatch): Promise<Budget>;
  acknowledgeAlert(alertId: string): Promise<void>;
  acknowledgeIncident(incidentId: string): Promise<void>;
}

export class TransportError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "TransportError";
  }
}

export class MockTransport implements TollgateTransport {
  constructor(private readonly engine: SimulationEngine, private readonly latency: [number, number] = [120, 450]) {}

  private async roundTrip<T>(fn: () => T): Promise<T> {
    const [min, max] = this.latency;
    await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
    if (Math.random() < this.engine.apiFailureRate) {
      throw new TransportError("The gateway did not respond. Your change was not saved.", 503, "SERVICE_UNAVAILABLE");
    }
    try {
      return fn();
    } catch (err) {
      throw new TransportError(err instanceof Error ? err.message : String(err), 409, "CONFLICT");
    }
  }

  updateAgent(agentId: string, patch: AgentPatch): Promise<Agent> {
    return this.roundTrip(() => this.engine.updateAgent(agentId, patch));
  }

  updateBudget(budgetId: string, patch: BudgetPatch): Promise<Budget> {
    return this.roundTrip(() => this.engine.updateBudget(budgetId, patch));
  }

  acknowledgeAlert(alertId: string): Promise<void> {
    return this.roundTrip(() => this.engine.acknowledgeAlert(alertId));
  }

  acknowledgeIncident(incidentId: string): Promise<void> {
    return this.roundTrip(() => this.engine.acknowledgeIncident(incidentId));
  }
}
