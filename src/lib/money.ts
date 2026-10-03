export const MICROS_PER_USD = 1_000_000n;
const MTOK = 1_000_000n;

export interface ModelPricing {
  provider: string;
  model: string;
  inputMicrosPerMTok: bigint;
  outputMicrosPerMTok: bigint;
  cachedInputMicrosPerMTok: bigint;
}

export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens: number;
}

/**
 * Exact integer cost in micro-USD, rounded up so the gateway never
 * under-reports spend.
 */
export function computeCostMicros(pricing: ModelPricing, usage: TokenUsage): bigint {
  const total =
    BigInt(usage.inputTokens) * pricing.inputMicrosPerMTok +
    BigInt(usage.outputTokens) * pricing.outputMicrosPerMTok +
    BigInt(usage.cachedInputTokens) * pricing.cachedInputMicrosPerMTok;
  if (total === 0n) return 0n;
  return (total + MTOK - 1n) / MTOK;
}

export function usdToMicros(usd: number): bigint {
  if (!Number.isFinite(usd)) throw new RangeError("USD amount must be finite.");
  return BigInt(Math.round(usd * 1_000_000));
}

export function microsToUsd(micros: bigint | number | string): number {
  const value = typeof micros === "bigint" ? micros : BigInt(micros);
  const whole = value / MICROS_PER_USD;
  const frac = value % MICROS_PER_USD;
  return Number(whole) + Number(frac) / 1_000_000;
}

export function formatUsd(micros: bigint): string {
  return `$${microsToUsd(micros).toFixed(micros < 10_000n ? 4 : 2)}`;
}
