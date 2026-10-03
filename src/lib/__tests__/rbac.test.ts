import { describe, expect, it } from "vitest";
import { can, decideRoute, resolveActiveMembership, roleFromMember, permissionsFor, type MembershipClaim } from "@/lib/rbac";

const memberships: MembershipClaim[] = [
  { organizationId: "org_a", slug: "acme", name: "Acme", role: "org:developer" },
  { organizationId: "org_b", slug: "globex", name: "Globex", role: "org:viewer" },
];

describe("roles", () => {
  it("maps database roles to org roles", () => {
    expect(roleFromMember("OWNER")).toBe("org:admin");
    expect(roleFromMember("ADMIN")).toBe("org:admin");
    expect(roleFromMember("DEVELOPER")).toBe("org:developer");
    expect(roleFromMember("VIEWER")).toBe("org:viewer");
  });

  it("gives viewers read-only access", () => {
    expect(can("org:viewer", "dashboard:read")).toBe(true);
    expect(can("org:viewer", "agents:toggle-mode")).toBe(false);
    expect(can("org:viewer", "api-keys:create")).toBe(false);
    expect(permissionsFor("org:viewer")).toEqual(["dashboard:read"]);
  });

  it("lets developers create keys and toggle alert-only, but not change limits, secrets or quarantines", () => {
    expect(can("org:developer", "api-keys:create")).toBe(true);
    expect(can("org:developer", "agents:toggle-mode")).toBe(true);
    expect(can("org:developer", "budgets:write")).toBe(false);
    expect(can("org:developer", "secrets:write")).toBe(false);
    expect(can("org:developer", "quarantine:release")).toBe(false);
    expect(can("org:developer", "agents:kill")).toBe(false);
  });

  it("gives admins every permission", () => {
    for (const p of ["budgets:write", "secrets:write", "quarantine:release", "agents:kill", "billing:manage"] as const) {
      expect(can("org:admin", p)).toBe(true);
    }
  });

  it("denies when there is no role", () => {
    expect(can(null, "dashboard:read")).toBe(false);
  });
});

describe("tenant resolution", () => {
  it("honours the cookie only for organizations the user belongs to", () => {
    expect(resolveActiveMembership(memberships, "globex")?.organizationId).toBe("org_b");
    expect(resolveActiveMembership(memberships, "someone-elses-org")?.organizationId).toBe("org_a");
    expect(resolveActiveMembership(memberships, null)?.organizationId).toBe("org_a");
    expect(resolveActiveMembership([], "acme")).toBeNull();
  });
});

describe("route table", () => {
  it("leaves API-key, webhook and auth routes to their own authentication", () => {
    expect(decideRoute("/api/v1/authorize", "POST").kind).toBe("external");
    expect(decideRoute("/api/webhooks/stripe", "POST").kind).toBe("external");
    expect(decideRoute("/api/auth/callback/github", "GET").kind).toBe("external");
    expect(decideRoute("/api/health", "GET").kind).toBe("external");
  });

  it("keeps login and landing pages public", () => {
    expect(decideRoute("/login", "GET").kind).toBe("public");
    expect(decideRoute("/", "GET").kind).toBe("public");
  });

  it("requires dashboard:read for console pages", () => {
    const d = decideRoute("/dashboard", "GET");
    expect(d.kind).toBe("permission");
    expect(d.permission).toBe("dashboard:read");
    expect(d.api).toBe(false);
  });

  it("maps console APIs to the right permission by method", () => {
    expect(decideRoute("/api/console/api-keys", "GET").permission).toBe("api-keys:read");
    expect(decideRoute("/api/console/api-keys", "POST").permission).toBe("api-keys:create");
    expect(decideRoute("/api/console/agents/agt_1", "PATCH").permission).toBe("agents:toggle-mode");
    expect(decideRoute("/api/console/budgets/bud_1", "PATCH").permission).toBe("budgets:write");
    expect(decideRoute("/api/console/notification-channels", "POST").permission).toBe("secrets:write");
    expect(decideRoute("/api/console/agents/agt_1", "PATCH").api).toBe(true);
  });

  it("fails closed for unknown protected routes and methods", () => {
    expect(decideRoute("/api/console/agents/agt_1", "DELETE").permission).toBe("members:manage");
    expect(decideRoute("/api/console/something-new", "GET").permission).toBe("members:manage");
    expect(decideRoute("/settings/billing", "GET").permission).toBe("members:manage");
    expect(decideRoute("/dashboard", "POST").permission).toBe("members:manage");
  });

  it("does not let path tricks escape a protected prefix", () => {
    expect(decideRoute("/api/console/budgets/a/b", "PATCH").permission).toBe("members:manage");
    expect(decideRoute("/dashboardx", "GET").kind).toBe("public");
  });
});
