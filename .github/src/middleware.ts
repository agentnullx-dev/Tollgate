import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig, MEMBERSHIP_TTL_MS } from "@/auth.config";
import {
  ACTIVE_ORG_COOKIE,
  ROLE_PERMISSIONS,
  can,
  decideRoute,
  resolveActiveMembership,
  type MembershipClaim,
  type Permission,
  type RouteDecision,
} from "@/lib/rbac";

/**
 * Multi-tenant access gate.
 *
 * Runs on the Edge before every page and console API request:
 *   1. classifies the route with the shared, fail-closed route table;
 *   2. requires a valid Auth.js session for anything protected (pages
 *      redirect to /login, APIs get 401);
 *   3. forces a membership refresh through the database when the JWT's
 *      claims are older than five minutes (pages);
 *   4. rejects cross-origin mutations on session-authenticated APIs;
 *   5. resolves the active tenant from the user's own memberships (a cookie
 *      can only pick among them) and enforces the route's permission;
 *   6. strips any client-supplied identity headers and forwards trusted ones.
 *
 * This is the first layer, not the only one: every session route handler
 * re-checks membership and role against Postgres (see `withSessionHandler`),
 * so a middleware bypass cannot grant access.
 */

const { auth } = NextAuth(authConfig);

const IDENTITY_HEADERS = ["x-tollgate-user-id", "x-tollgate-org-id", "x-tollgate-org-slug", "x-tollgate-org-role", "x-tollgate-permissions"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

function requestIdOf(req: NextRequest): string {
  const incoming = req.headers.get("x-request-id");
  return incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
}

function jsonError(status: 401 | 403, code: string, message: string, requestId: string, details?: Record<string, unknown>): NextResponse {
  return NextResponse.json(
    { error: { code, message, requestId, ...(details ? { details } : {}) } },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

/** Origins this deployment answers on (behind proxies the Host header differs from the internal URL). */
function allowedOrigins(req: NextRequest): Set<string> {
  const origins = new Set<string>([req.nextUrl.origin]);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  if (host) origins.add(`${proto}://${host}`);
  for (const configured of [process.env.AUTH_URL, process.env.APP_BASE_URL]) {
    if (!configured) continue;
    try {
      origins.add(new URL(configured).origin);
    } catch {
      // Ignore malformed configuration; the request origin still applies.
    }
  }
  return origins;
}

function unauthenticated(req: NextRequest, decision: RouteDecision, requestId: string): NextResponse {
  if (decision.api) return jsonError(401, "UNAUTHORIZED", "Sign in to continue.", requestId);
  const login = new URL("/login", req.nextUrl.origin);
  login.searchParams.set("callbackUrl", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  const res = NextResponse.redirect(login);
  res.headers.set("x-request-id", requestId);
  res.headers.set("cache-control", "no-store");
  return res;
}

function forbidden(
  req: NextRequest,
  decision: RouteDecision,
  requestId: string,
  reason: "no_membership" | "insufficient_role",
  membership: MembershipClaim | null,
  permission?: Permission,
): NextResponse {
  if (decision.api) {
    return jsonError(
      403,
      "FORBIDDEN",
      reason === "no_membership" ? "You are not a member of any organization." : "Your role does not allow this action.",
      requestId,
      { reason, role: membership?.role ?? null, requiredPermission: permission ?? null },
    );
  }
  const url = new URL("/forbidden", req.nextUrl.origin);
  url.searchParams.set("reason", reason);
  if (permission) url.searchParams.set("permission", permission);
  const res = NextResponse.rewrite(url, { status: 403 });
  res.headers.set("x-request-id", requestId);
  res.headers.set("cache-control", "no-store");
  return res;
}

function forward(req: NextRequest, requestId: string, membership: MembershipClaim | null, userId: string | null, isProtected: boolean): NextResponse {
  const headers = new Headers(req.headers);
  for (const h of IDENTITY_HEADERS) headers.delete(h);
  headers.set("x-request-id", requestId);
  if (userId) headers.set("x-tollgate-user-id", userId);
  if (membership) {
    headers.set("x-tollgate-org-id", membership.organizationId);
    headers.set("x-tollgate-org-slug", membership.slug);
    headers.set("x-tollgate-org-role", membership.role);
    headers.set("x-tollgate-permissions", [...ROLE_PERMISSIONS[membership.role]].join(","));
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  if (isProtected) {
    // Never let shared caches or the back button serve tenant data after sign-out.
    res.headers.set("cache-control", "private, no-store");
    res.headers.set("vary", "cookie");
  }
  // Pin the resolved tenant so the cookie always names a real membership.
  if (membership && req.cookies.get(ACTIVE_ORG_COOKIE)?.value !== membership.slug) {
    res.cookies.set(ACTIVE_ORG_COOKIE, membership.slug, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return res;
}

export default auth((req) => {
  const requestId = requestIdOf(req);
  const { pathname, search } = req.nextUrl;
  const decision = decideRoute(pathname, req.method);
  const session = req.auth;
  const userId = session?.user?.id || null;

  if (decision.kind === "external") return forward(req, requestId, null, null, false);

  if (decision.kind === "public") {
    // Signed-in users skip the login page.
    if (pathname === "/login" && userId) {
      const target = req.nextUrl.searchParams.get("callbackUrl");
      const safe = target && target.startsWith("/") && !target.startsWith("//") ? target : "/dashboard";
      return NextResponse.redirect(new URL(safe, req.nextUrl.origin));
    }
    return forward(req, requestId, null, userId, false);
  }

  // Everything below is protected.
  if (!userId || !session) return unauthenticated(req, decision, requestId);

  // Claims can be at most MEMBERSHIP_TTL_MS old for page access; refresh through the database.
  // Session APIs skip this because their handlers re-validate against Postgres on every call.
  const stale = Date.now() - (session.membershipsCheckedAt || 0) > MEMBERSHIP_TTL_MS;
  if (stale && !decision.api && req.method === "GET") {
    const refresh = new URL("/api/session/refresh", req.nextUrl.origin);
    refresh.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(refresh);
  }

  // Cookie-authenticated mutations must come from our own origin.
  if (decision.api && !SAFE_METHODS.has(req.method.toUpperCase())) {
    const origin = req.headers.get("origin");
    if (!origin || !allowedOrigins(req).has(origin)) {
      return jsonError(403, "CSRF_REJECTED", "Cross-origin requests are not allowed for this endpoint.", requestId);
    }
  }

  if (decision.kind === "session") return forward(req, requestId, null, userId, true);

  const membership = resolveActiveMembership(session.memberships ?? [], req.cookies.get(ACTIVE_ORG_COOKIE)?.value);
  if (!membership) return forbidden(req, decision, requestId, "no_membership", null);

  const permission = decision.permission;
  if (!permission || !can(membership.role, permission)) {
    return forbidden(req, decision, requestId, "insufficient_role", membership, permission);
  }

  return forward(req, requestId, membership, userId, true);
});

export const config = {
  // Skip static assets and routes authenticated by other means (API keys, Stripe signatures).
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|api/v1/|api/webhooks/|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)"],
};
