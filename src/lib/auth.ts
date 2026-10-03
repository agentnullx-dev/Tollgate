import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { redis, keys } from "@/lib/redis";
import { env } from "@/lib/env";
import { Errors } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const SCOPES = [
  "gateway:authorize",
  "usage:write",
  "usage:read",
  "budgets:read",
  "budgets:write",
  "agents:write",
  "org:admin",
] as const;

export type Scope = (typeof SCOPES)[number];

export interface AuthContext {
  apiKeyId: string;
  organizationId: string;
  projectId: string;
  scopes: Scope[];
  keyPrefix: string;
}

const KEY_PATTERN = /^tg_live_([a-f0-9]{12})_([A-Za-z0-9_-]{32})$/;

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function parseApiKey(raw: string): { prefix: string } | null {
  const match = KEY_PATTERN.exec(raw);
  if (!match || !match[1]) return null;
  return { prefix: match[1] };
}

export function generateApiKey(): { plaintext: string; prefix: string; hashedKey: string } {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `tg_live_${prefix}_${secret}`;
  return { plaintext, prefix, hashedKey: hashApiKey(plaintext) };
}

interface CachedKey {
  id: string;
  organizationId: string;
  projectId: string;
  hashedKey: string;
  scopes: string[];
  expiresAt: string | null;
  revoked: boolean;
  lastUsedAt: string | null;
}

function extractKey(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (header) {
    const [scheme, value] = header.split(/\s+/, 2);
    if (scheme?.toLowerCase() === "bearer" && value) return value.trim();
  }
  const direct = req.headers.get("x-api-key");
  return direct ? direct.trim() : null;
}

async function loadKey(prefix: string): Promise<CachedKey | null> {
  const r = redis();
  const cacheKey = keys.apiKeyCache(prefix);
  const cached = await r.get(cacheKey);
  if (cached) return JSON.parse(cached) as CachedKey;

  const row = await prisma.apiKey.findUnique({ where: { prefix } });
  if (!row) return null;
  const value: CachedKey = {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    hashedKey: row.hashedKey,
    scopes: row.scopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revoked: row.revokedAt !== null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
  await r.set(cacheKey, JSON.stringify(value), "EX", env().CACHE_TTL_SECONDS);
  return value;
}

export async function invalidateApiKeyCache(prefix: string): Promise<void> {
  await redis().del(keys.apiKeyCache(prefix));
}

export async function authenticateRequest(req: NextRequest): Promise<AuthContext> {
  const raw = extractKey(req);
  if (!raw) throw Errors.unauthorized();

  const parsed = parseApiKey(raw);
  if (!parsed) throw Errors.unauthorized("API key format is invalid.");

  const record = await loadKey(parsed.prefix);
  if (!record) throw Errors.unauthorized("API key is invalid.");

  const presented = Buffer.from(hashApiKey(raw), "hex");
  const stored = Buffer.from(record.hashedKey, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw Errors.unauthorized("API key is invalid.");
  }
  if (record.revoked) throw Errors.unauthorized("API key has been revoked.");
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    throw Errors.unauthorized("API key has expired.");
  }

  // Throttled last-used tracking: at most one write per key per minute.
  const lastUsed = record.lastUsedAt ? new Date(record.lastUsedAt).getTime() : 0;
  if (Date.now() - lastUsed > 60_000) {
    prisma.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .then(() => redis().del(keys.apiKeyCache(parsed.prefix)))
      .catch((err) => logger.warn("apikey.last_used_update_failed", { err, keyId: record.id }));
  }

  const scopes = record.scopes.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  return {
    apiKeyId: record.id,
    organizationId: record.organizationId,
    projectId: record.projectId,
    scopes,
    keyPrefix: parsed.prefix,
  };
}

export function hasScope(auth: AuthContext, scope: Scope): boolean {
  return auth.scopes.includes("org:admin") || auth.scopes.includes(scope);
}

export function assertScopes(auth: AuthContext, required: Scope[]): void {
  const missing = required.filter((s) => !hasScope(auth, s));
  if (missing.length > 0) {
    throw Errors.forbidden("API key is missing required scopes.", { missingScopes: missing });
  }
}

export async function enforceRateLimit(auth: AuthContext): Promise<void> {
  const limit = env().API_RATE_LIMIT_PER_MINUTE;
  const nowMs = Date.now();
  const minute = Math.floor(nowMs / 60_000);
  const key = keys.rateLimit(auth.apiKeyId, minute);
  const results = await redis().multi().incr(key).expire(key, 90).exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  if (count > limit) {
    const retryAfter = 60 - Math.floor((nowMs % 60_000) / 1000);
    throw Errors.rateLimited(retryAfter);
  }
}
