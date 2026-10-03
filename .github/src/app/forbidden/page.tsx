import type { Metadata } from "next";
import Link from "next/link";
import { signOut } from "@/auth";
import { PERMISSIONS, type Permission } from "@/lib/rbac";

export const metadata: Metadata = { title: "No access" };
export const dynamic = "force-dynamic";

const PERMISSION_TEXT: Record<Permission, string> = {
  "dashboard:read": "view the console",
  "api-keys:read": "view API keys",
  "api-keys:create": "create API keys",
  "agents:toggle-mode": "switch agents between strict blocking and alert-only",
  "agents:pause": "pause and resume agents",
  "agents:kill": "stop agents",
  "agents:limits": "change agent rate limits",
  "budgets:write": "change budgets and limits",
  "secrets:write": "enter webhook URLs, secrets and encryption keys",
  "quarantine:release": "release quarantined agents",
  "members:manage": "manage members",
  "billing:manage": "manage billing",
};

export default async function ForbiddenPage({ searchParams }: { searchParams: Promise<{ reason?: string; permission?: string }> }) {
  const { reason, permission } = await searchParams;
  const perm = (PERMISSIONS as readonly string[]).includes(permission ?? "") ? (permission as Permission) : null;

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="panel w-full max-w-md p-6">
        <h1 className="text-lg font-semibold">{reason === "no_membership" ? "You're not in an organization yet" : "Your role can't open this"}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {reason === "no_membership"
            ? "Ask an admin of your organization to invite you, then sign in again."
            : perm
              ? `This needs permission to ${PERMISSION_TEXT[perm]}. Ask an admin to change your role.`
              : "Ask an admin of your organization to change your role."}
        </p>
        <div className="mt-5 flex gap-2">
          {reason !== "no_membership" && (
            <Link href="/dashboard" className="rounded-md border border-rule px-3 py-1.5 text-sm font-medium hover:border-ink">
              Back to the console
            </Link>
          )}
          <form action={doSignOut}>
            <button type="submit" className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-white">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
