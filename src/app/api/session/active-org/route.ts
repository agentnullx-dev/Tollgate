import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { withSessionHandler } from "@/lib/session";
import { ACTIVE_ORG_COOKIE } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ slug: z.string().trim().min(1).max(64) }).strict();

/** Switch the active organization. Only organizations the user belongs to (per Postgres) are accepted. */
export const POST = withSessionHandler({ permission: "dashboard:read" }, async ({ req, session }) => {
  const { slug } = await parseJsonBody(req, Body, 1_000);
  const target = session.memberships.find((m) => m.slug === slug);
  if (!target) throw Errors.forbidden("You are not a member of that organization.");
  const res = NextResponse.json({ data: { organizationId: target.organizationId, slug: target.slug, role: target.role } });
  res.cookies.set(ACTIVE_ORG_COOKIE, target.slug, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
});
