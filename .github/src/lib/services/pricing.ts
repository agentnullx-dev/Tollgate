import { prisma } from "@/lib/prisma";
import type { ModelPricing } from "@/lib/money";

const REFRESH_MS = 60_000;

interface PricingState {
  table: Map<string, ModelPricing>;
  loadedAt: number;
  inflight: Promise<Map<string, ModelPricing>> | null;
}

const globalForPricing = globalThis as unknown as { __tollgatePricing?: PricingState };
const state: PricingState =
  globalForPricing.__tollgatePricing ?? (globalForPricing.__tollgatePricing = { table: new Map(), loadedAt: 0, inflight: null });

function key(provider: string, model: string): string {
  return `${provider.toLowerCase()}/${model.toLowerCase()}`;
}

async function loadTable(): Promise<Map<string, ModelPricing>> {
  const rows = await prisma.modelPrice.findMany({
    where: { effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: "desc" },
  });
  const table = new Map<string, ModelPricing>();
  for (const row of rows) {
    const k = key(row.provider, row.model);
    // Rows are ordered newest-first, so the first one seen is the effective price.
    if (!table.has(k)) {
      table.set(k, {
        provider: row.provider,
        model: row.model,
        inputMicrosPerMTok: row.inputMicrosPerMTok,
        outputMicrosPerMTok: row.outputMicrosPerMTok,
        cachedInputMicrosPerMTok: row.cachedInputMicrosPerMTok,
      });
    }
  }
  return table;
}

async function currentTable(): Promise<Map<string, ModelPricing>> {
  if (Date.now() - state.loadedAt < REFRESH_MS && state.table.size > 0) return state.table;
  if (!state.inflight) {
    state.inflight = loadTable()
      .then((table) => {
        state.table = table;
        state.loadedAt = Date.now();
        return table;
      })
      .finally(() => {
        state.inflight = null;
      });
  }
  return state.inflight;
}

/** Strip dated snapshot suffixes, e.g. "model-20250929" or "model@20250929". */
export function baseModelName(model: string): string {
  return model.replace(/[-@]\d{8}$/, "");
}

export async function getModelPricing(provider: string, model: string): Promise<ModelPricing | null> {
  const table = await currentTable();
  return table.get(key(provider, model)) ?? table.get(key(provider, baseModelName(model))) ?? null;
}

export function invalidatePricingCache(): void {
  state.loadedAt = 0;
}
