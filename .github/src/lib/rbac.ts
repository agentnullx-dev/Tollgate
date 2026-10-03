import type { MemberRole } from "@prisma/client";

/**
 * Role-based access control shared by the edge middleware, server components
 * and route handlers. Pure and dependency-free so it runs on the Edge runtime.
 *
 *   org:viewer     read-only: dashboards, charts, incidents, alerts
 *   org:developer  viewer + create API keys + switch agents between
 *                  strict blocking and alert-only + pause/resume agents
 *   org:admin      everything: limits, stopping agents, secrets and
 *                  encryption keys, releasing quarantines, members, billing
 */

export const ORG_ROLES = ["org:viewer", "org:developer", "org:admin"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PERMISSIONS = [
  "dashboard:read",
  "api-keys:read",
  "api-keys:create",
  "agents:toggle-mode",
  "agents:pause",
  "agents:kill",
  "agents:limits",
  "budgets:write",
  "secrets:write",
  "quarantine:release",
  "members:manage",
  "billing:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = ["dashboard:read"];
const DEVELOPER: readonly Permission[] = [...VIEWER, "api-keys:read", "api-keys:create", "agents:toggle-mode", "agents:pause"];
const ADMIN: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  "org:viewer": new Set(VIEWER),
  "org:developer": new Set(DEVELOPER),
  "org:admin": new Set(ADMIN),
};

export const ROLE_RANK: Record<OrgRole, number> = { "org:viewer": 0, "org:developer": 1, "org:admin": 2 };

export function roleFromMember(role: MemberRole): OrgRole {
  switch (role) {
    case "OWNER":
    case "ADMIN":
      return "org:admin";
    case "DEVELOPER":
      return "org:developer";
    case "VIEWER":
      return "org:viewer";
    default: {
      const exhaustive: never = role;
      throw new Error(`Unknown member role ${String(exhaustive)}`);
    }
  }
}

export function can(role: OrgRole | null | undefined, permission: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: OrgRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

/** Membership claim carried in the session JWT. */
export interface MembershipClaim {
  organizationId: string;
  slug: string;
  name: string;
  role: OrgRole;
}

export const ACTIVE_ORG_COOKIE = "tg_org";

/**
 * Pick the organization a request acts on. The cookie is only a preference:
 * it is honoured only if it names an organization the user belongs to, so a
 * tampered cookie can never switch tenants.
 */
export function resolveActiveMembership(memberships: readonly MembershipClaim[], preferredSlug: string | null | undefined): MembershipClaim | null {
  if (memberships.length === 0) return null;
  if (preferredSlug) {
    const match = memberships.find((m) => m.slug === preferredSlug);
    if (match) return match;
  }
  return memberships[0] ?? null;
}

// ---------------------------------------------------------------------------
// Route table (fail closed)
// ---------------------------------------------------------------------------

export type RouteKind = "public" | "session" | "permission" | "external";

export interface RouteDecision {
  kind: RouteKind;
  /** Required permission when kind === "permission". */
  permission?: Permission;
  /** True for JSON endpoints (401/403 bodies instead of redirects). */
  api: boolean;
}

interface RouteRule {
  pattern: RegExp;
  methods?: readonly string[];
  decision: Omit<RouteDecision, "api">;
}

const READ_METHODS = ["GET", "HEAD", "OPTIONS"] as const;

/**
 * First match wins. Anything under a protected prefix that no rule matches is
 * denied with the strictest permission (fail closed), so a new route cannot
 * ship unprotected by accident.
 */
const RULES: RouteRule[] = [
  // Authenticated by other means: API keys, Stripe signatures, Auth.js itself.
  { pattern: /^\/api\/v1(\/|$)/, decision: { kind: "external" } },
  { pattern: /^\/api\/webhooks(\/|$)/, decision: { kind: "external" } },
  { pattern: /^\/api\/auth(\/|$)/, decision: { kind: "external" } },
  { pattern: /^\/api\/health$/, decision: { kind: "external" } },

  // Public pages
  { pattern: /^\/$/, decision: { kind: "public" } },
  { pattern: /^\/login$/, decision: { kind: "public" } },
  { pattern: /^\/forbidden$/, decision: { kind: "public" } },

  // Session plumbing: any signed-in user.
  { pattern: /^\/api\/session\/(refresh|active-org)$/, decision: { kind: "session" } },

  // Console pages
  { pattern: /^\/dashboard(\/.*)?$/, methods: READ_METHODS, decision: { kind: "permission", permission: "dashboard:read" } },

  // Console API (session-authenticated BFF for the dashboard)
  { pattern: /^\/api\/console\/api-keys$/, methods: READ_METHODS, decision: { kind: "permission", permission: "api-keys:read" } },
  { pattern: /^\/api\/console\/api-keys$/, methods: ["POST"], decision: { kind: "permission", permission: "api-keys:create" } },
  // Handler applies finer checks per field (kill, limits, quarantine release).
  { pattern: /^\/api\/console\/agents\/[^/]+$/, methods: ["PATCH"], decision: { kind: "permission", permission: "agents:toggle-mode" } },
  { pattern: /^\/api\/console\/budgets\/[^/]+$/, methods: ["PATCH"], decision: { kind: "permission", permission: "budgets:write" } },
  { pattern: /^\/api\/console\/notification-channels$/, methods: READ_METHODS, decision: { kind: "permission", permission: "dashboard:read" } },
  { pattern: /^\/api\/console\/notification-channels$/, methods: ["POST"], decision: { kind: "permission", permission: "secrets:write" } },
];

const PROTECTED_PREFIXES = [/^\/dashboard(\/|$)/, /^\/api\/console(\/|$)/, /^\/api\/session(\/|$)/, /^\/settings(\/|$)/];

export function decideRoute(pathname: string, method: string): RouteDecision {
  const api = pathname.startsWith("/api/");
  const m = method.toUpperCase();
  for (const rule of RULES) {
    if (!rule.pattern.test(pathname)) continue;
    if (rule.methods && !rule.methods.includes(m)) continue;
    return { ...rule.decision, api };
  }
  if (PROTECTED_PREFIXES.some((p) => p.test(pathname))) {
    // Unknown protected route or method: require the most privileged permission.
    return { kind: "permission", permission: "members:manage", api };
  }
  // Static assets and unknown public paths (Next.js will 404 them).
  return { kind: "public", api };
}
