import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __tollgatePrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__tollgatePrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__tollgatePrisma = prisma;
}
