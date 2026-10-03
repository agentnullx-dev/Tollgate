import type { Metadata } from "next";
import { Dashboard } from "@/components/console/Dashboard";
import { requirePageContext } from "@/lib/session";

export const metadata: Metadata = { title: "Tollgate console" };
export const dynamic = "force-dynamic";

/**
 * The middleware already gated this route; the page re-reads membership from
 * Postgres so role changes apply on the next render and the UI only offers
 * actions the user's role allows.
 */
export default async function DashboardPage() {
  const ctx = await requirePageContext("dashboard:read", "/dashboard");
  return (
    <Dashboard
      access={{
        role: ctx.role,
        permissions: [...ctx.permissions],
        userEmail: ctx.email,
        organizationName: ctx.organizationName,
      }}
    />
  );
}
