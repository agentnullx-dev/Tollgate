import type { NextAuthConfig } from "next-auth";
import { isOrgRole, type MembershipClaim } from "@/lib/rbac";

/** Claims older than this are refreshed from Postgres before page access. */
export const MEMBERSHIP_TTL_MS = 5 * 60_000;

/**
 * Edge-safe Auth.js configuration shared by the middleware and the full Node
 * configuration in `src/auth.ts`. It must not import Prisma, Redis or any
 * Node-only module: providers and database-backed callbacks live in auth.ts.
 */
export const authConfig = {
  trustHost: true,
  session: {
    strategy: "jwt",
    // Hard ceiling for any session; memberships are re-validated far more often.
    maxAge: 8 * 60 * 60,
    updateAge: 15 * 60,
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [],
  callbacks: {
    // Edge: pass the token through untouched (no database here).
    jwt({ token }) {
      return token;
    },
    session({ session, token }) {
      const memberships = Array.isArray(token.memberships)
        ? (token.memberships as MembershipClaim[]).filter((m) => m && typeof m.organizationId === "string" && isOrgRole(m.role))
        : [];
      return {
        ...session,
        user: { ...session.user, id: token.sub ?? "" },
        memberships,
        membershipsCheckedAt: typeof token.membershipsCheckedAt === "number" ? token.membershipsCheckedAt : 0,
      };
    },
  },
} satisfies NextAuthConfig;
