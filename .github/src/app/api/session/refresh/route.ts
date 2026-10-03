import { NextResponse, type NextRequest } from "next/server";
import { auth, unstable_update } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/api/session/") ? raw : "/dashboard";
}

/**
 * Re-issue the session JWT with membership claims read from Postgres. The
 * middleware sends page requests here when claims are older than five
 * minutes, which bounds how long a removed member keeps page access.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const session = await auth();
  if (!session?.user?.id) {
    const login = new URL("/login", req.nextUrl.origin);
    login.searchParams.set("callbackUrl", next);
    return NextResponse.redirect(login);
  }
  // Triggers the jwt callback with trigger "update", which reloads memberships
  // (or ends the session if the user was deleted or disabled).
  const updated = await unstable_update({});
  if (!updated?.user?.id) {
    const login = new URL("/login", req.nextUrl.origin);
    login.searchParams.set("error", "SessionRevoked");
    return NextResponse.redirect(login);
  }
  const res = NextResponse.redirect(new URL(next, req.nextUrl.origin));
  res.headers.set("cache-control", "no-store");
  return res;
}
