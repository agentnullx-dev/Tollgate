import type { DefaultSession } from "next-auth";
import type { MembershipClaim } from "@/lib/rbac";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
    memberships: MembershipClaim[];
    membershipsCheckedAt: number;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    memberships?: MembershipClaim[];
    membershipsCheckedAt?: number;
  }
}
