import { withPublicHandler, json } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function timed(check: () => Promise<unknown>): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = performance.now();
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout after 2000ms")), 2000)),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Liveness + readiness probe used by Docker and orchestrators. */
export const GET = withPublicHandler(async () => {
  const [database, cache] = await Promise.all([
    timed(() => prisma.$queryRaw`SELECT 1`),
    timed(() => redis().ping()),
  ]);
  const healthy = database.ok && cache.ok;
  return json(
    {
      status: healthy ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "1.0.0",
      checks: { database, redis: cache },
      time: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
});
