import { createServer, type Server } from "node:http";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { NotificationWorker } from "./notification-worker";
import { AnomalyEngine } from "./anomaly-engine";
import { registry } from "./metrics";

/**
 * Background worker process: notification engine + anomaly engine.
 * Run any number of replicas; the anomaly engine elects a single leader,
 * and notification work is partitioned by the Redis queue and stream group.
 *
 *   WORKER_ROLES=notifications,anomaly  (default: both)
 */
async function main(): Promise<void> {
  const e = env();
  const roles = new Set((process.env.WORKER_ROLES ?? "notifications,anomaly").split(",").map((r) => r.trim()));
  const client = redis();
  await client.ping();
  await prisma.$queryRaw`SELECT 1`;

  const blocking = client.duplicate();
  const notifier = roles.has("notifications") ? new NotificationWorker(client, blocking) : null;
  const anomaly = roles.has("anomaly") ? new AnomalyEngine(client) : null;

  await notifier?.start();
  anomaly?.start();

  let healthy = true;
  const server: Server = createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(registry.render());
      return;
    }
    if (req.url === "/healthz") {
      try {
        await Promise.all([client.ping(), prisma.$queryRaw`SELECT 1`]);
        res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: healthy ? "ok" : "shutting_down", roles: [...roles] }));
      } catch (err) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "degraded", error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(e.WORKER_HEALTH_PORT, () => logger.info("worker.listening", { port: e.WORKER_HEALTH_PORT, roles: [...roles] }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    healthy = false;
    logger.info("worker.shutdown", { signal });
    const hardStop = setTimeout(() => {
      logger.error("worker.shutdown_timeout");
      process.exit(1);
    }, 30_000);
    hardStop.unref();
    await Promise.allSettled([notifier?.stop(), anomaly?.stop()]);
    server.close();
    await Promise.allSettled([blocking.quit(), client.quit(), prisma.$disconnect()]);
    clearTimeout(hardStop);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error("worker.unhandled_rejection", { err: reason }));
}

main().catch((err) => {
  logger.error("worker.fatal", { err });
  process.exit(1);
});
