import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import type { MemberRole } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AppError, Errors } from "@/lib/errors";
import { resolveRequestId, run } from "@/lib/http";
import {
  ACTIVE_ORG_COOKIE,
  ROLE_PERMISSIONS,
  resolveActiveMembership,
  roleFromMember,
  type MembershipClaim,
  type OrgRole,
  type Permission,
} from "@/lib/rbac";

/**
 * Authoritative session context. Unlike the middleware (which trusts the JWT),
 * this reads the user's memberships from Postgres on every call, so removing a
 * member, downgrading a role or disabling a user takes effect immediately for
 * every server-rendered page and console API request.
 */
export interface SessionContext {
  userId: string;
  email: string | null;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  memberRole: MemberRole;
  role: OrgRole;
  permissions: ReadonlySet<Permission>;
  memberships: MembershipClaim[];
}

export type SessionResolution =
  | { status: "ok"; context: SessionContext }
  | { status: "unauthenticated" }
  | { status: "no_membership"; userId: string };

export async function resolveSessionContext(): Promise<SessionResolution> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { status: "unauthenticated" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      disabledAt: true,
      memberships: {
        orderBy: { createdAt: "asc" },
        select: { role: true, organization: { select: { id: true, slug: true, name: true } } },
      },
    },
  });
  if (!user || user.disabledAt) return { status: "unauthenticated" };

  const claims: Array<MembershipClaim & { memberRole: MemberRole }> = user.memberships.map((m) => ({
    organizationId: m.organization.id,
    slug: m.organization.slug,
    name: m.organization.name,
    role: roleFromMember(m.role),
    memberRole: m.role,
  }));
  const preferred = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const active = resolveActiveMembership(claims, preferred);
  if (!active) return { status: "no_membership", userId };
  const full = claims.find((c) => c.organizationId === active.organizationId)!;

  return {
    status: "ok",
    context: {
      userId,
      email: user.email,
      organizationId: full.organizationId,
      organizationSlug: full.slug,
      organizationName: full.name,
      memberRole: full.memberRole,
      role: full.role,
      permissions: ROLE_PERMISSIONS[full.role],
      memberships: claims.map(({ memberRole: _ignored, ...c }) => c),
    },
  };
}

export function requirePermission(ctx: SessionContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw Errors.forbidden("Your role does not allow this action.", { role: ctx.role, requiredPermission: permission });
  }
}

/** Server components: redirect to login or the forbidden page instead of throwing. */
export async function requirePageContext(permission: Permission, returnTo: string): Promise<SessionContext> {
  const resolution = await resolveSessionContext();
  if (resolution.status === "unauthenticated") redirect(`/login?callbackUrl=${encodeURIComponent(returnTo)}`);
  if (resolution.status === "no_membership") redirect("/forbidden?reason=no_membership");
  if (!resolution.context.permissions.has(permission)) redirect(`/forbidden?reason=insufficient_role&permission=${encodeURIComponent(permission)}`);
  return resolution.context;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function assertSameOrigin(req: NextRequest): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const allowed = new Set([req.nextUrl.origin, host ? `${proto}://${host}` : ""]);
  for (const configured of [process.env.AUTH_URL, process.env.APP_BASE_URL]) {
    if (configured) {
      try {
        allowed.add(new URL(configured).origin);
      } catch {
        // ignore malformed configuration
      }
    }
  }
  if (!origin || !allowed.has(origin)) throw new AppError(403, "FORBIDDEN", "Cross-origin requests are not allowed for this endpoint.");
}

export interface SessionHandlerContext<P> {
  req: NextRequest;
  params: P;
  requestId: string;
  session: SessionContext;
}

/**
 * Wrap a cookie-authenticated console route: same-origin check, fresh
 * membership from Postgres, permission check, error mapping and request ids.
 */
export function withSessionHandler<P extends Record<string, string> = Record<string, string>>(
  options: { permission: Permission },
  handler: (ctx: SessionHandlerContext<P>) => Promise<Response>,
) {
  return async function routeHandler(req: NextRequest, segment: { params: Promise<P> }): Promise<Response> {
    const requestId = resolveRequestId(req);
    return run(req, requestId, async () => {
      assertSameOrigin(req);
      const params = ((await segment?.params) ?? {}) as P;
      const resolution = await resolveSessionContext();
      if (resolution.status === "unauthenticated") throw Errors.unauthorized("Sign in to continue.");
      if (resolution.status === "no_membership") throw Errors.forbidden("You are not a member of any organization.");
      requirePermission(resolution.context, options.permission);
      return handler({ req, params, requestId, session: resolution.context });
    });
  };
}
