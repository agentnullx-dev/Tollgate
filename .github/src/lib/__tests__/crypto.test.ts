import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { resetEnvCache } from "@/lib/env";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.REDIS_URL ??= "redis://localhost:6379/0";
  process.env.NOTIFICATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  resetEnvCache();
});

describe("secret encryption", () => {
  it("round-trips with matching associated data", () => {
    const sealed = encryptSecret("https://hooks.slack.com/services/T0/B0/xyz", "org_1");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("hooks.slack.com");
    expect(decryptSecret(sealed, "org_1")).toBe("https://hooks.slack.com/services/T0/B0/xyz");
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptSecret("same", "org_1")).not.toBe(encryptSecret("same", "org_1"));
  });

  it("refuses ciphertext moved to another tenant or tampered with", () => {
    const sealed = encryptSecret("secret", "org_1");
    expect(() => decryptSecret(sealed, "org_2")).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), "org_1")).toThrow();
  });
});
