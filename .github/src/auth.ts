import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { roleFromMember, type MembershipClaim } from "@/lib/rbac";
import { authConfig, MEMBERSHIP_TTL_MS } from "@/auth.config";

const MAX_MEMBERSHIP_CLAIMS = 25;

interface ProviderEntry {
  id: string;
  name: string;
  kind: "oauth" | "credentials";
  make: () => Provider;
}

/** Providers are enabled by the presence of their credentials. */
function providerCatalog(): ProviderEntry[] {
  const list: ProviderEntry[] = [];
  const env = process.env;
  if (env.AUTH_MICROSOFT_ENTRA_ID_ID && env.AUTH_MICROSOFT_ENTRA_ID_SECRET) {
    list.push({
      id: "microsoft-entra-id",
      name: "Microsoft",
      kind: "oauth",
      make: () =>
        MicrosoftEntraID({
          clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
          clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
          issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
        }),
    });
  }
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    list.push({ id: "google", name: "Google", kind: "oauth", make: () => Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }) });
  }
  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) {
    list.push({ id: "github", name: "GitHub", kind: "oauth", make: () => GitHub({ clientId: env.AUTH_GITHUB_ID, clientSecret: env.AUTH_GITHUB_SECRET }) });
  }
  // Local development only: sign in as an existing seeded user by email.
  if (env.NODE_ENV !== "production" && env.AUTH_DEV_LOGIN === "true") {
    list.push({
      id: "dev-login",
      name: "Development login",
      kind: "credentials",
      make: () =>
        Credentials({
          id: "dev-login",
          name: "Development login",
          credentials: { email: { label: "Email", type: "email" } },
          async authorize(credentials) {
            const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
            if (!email) return null;
            const user = await prisma.user.findUnique({ where: { email } });
            if (!user || user.disabledAt) return null;
            return { id: user.id, email: user.email, name: user.name, image: user.image };
          },
        }),
    });
  }
  return list;
}

/** Provider metadata for the login page. */
export function enabledProviders(): Array<{ id: string; name: string; kind: ProviderEntry["kind"] }> {
  return providerCatalog().map(({ id, name, kind }) => ({ id, name, kind }));
}

/** Authoritative membership claims for a user, or null if the user may not sign in. */
export async function loadMembershipClaims(userId: string): Promise<MembershipClaim[] | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      disabledAt: true,
      memberships: {
        orderBy: { createdAt: "asc" },
        take: MAX_MEMBERSHIP_CLAIMS,
        select: { role: true, organization: { select: { id: true, slug: true, name: true } } },
      },
    },
  });
  if (!user || user.disabledAt) return null;
  return user.memberships.map((m) => ({
    organizationId: m.organization.id,
    slug: m.organization.slug,
    name: m.organization.name,
    role: roleFromMember(m.role),
  }));
}

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: providerCatalog().map((p) => p.make()),
  callbacks: {
    ...authConfig.callbacks,
    /**
     * Node-side JWT callback: embeds membership claims at sign-in and
     * refreshes them when stale or on explicit update. Returning null ends the
     * session (user deleted or disabled).
     */
    async jwt({ token, user, trigger }) {
      if (user?.id) token.sub = user.id;
      if (!token.sub) return null;
      const checkedAt = typeof token.membershipsCheckedAt === "number" ? token.membershipsCheckedAt : 0;
      const stale = Date.now() - checkedAt > MEMBERSHIP_TTL_MS;
      if (user || trigger === "update" || stale) {
        const claims = await loadMembershipClaims(token.sub);
        if (!claims) {
          logger.warn("auth.session_revoked", { userId: token.sub });
          return null;
        }
        token.memberships = claims;
        token.membershipsCheckedAt = Date.now();
      }
      return token;
    },
  },
  events: {
    async signIn({ user, account }) {
      logger.info("auth.sign_in", { userId: user.id, provider: account?.provider });
    },
  },
});
