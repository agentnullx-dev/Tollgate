import { describe, expect, it } from "vitest";
import { backoffSchedule, computeBackoffMs, nextRetryDelayMs, parseRetryAfter } from "@/lib/notifications/backoff";
import { renderEmail, renderSlack, renderTeams, renderWebhook } from "@/lib/notifications/render";
import { slackEscape } from "@/lib/notifications/render/slack";
import { escapeHtml } from "@/lib/notifications/render/email";
import { signWebhook } from "@/lib/notifications/render/webhook";
import { textMeter } from "@/lib/notifications/render/shared";
import type { NotificationContext } from "@/lib/notifications/types";
import { isPrivateAddress, validateDestinationUrl, UnsafeUrlError } from "@/lib/url-guard";
import { canTransition, requiresReason } from "@/lib/agent-transitions";

const policy = { baseMs: 2_000, maxMs: 30 * 60_000 };

const ctx: NotificationContext = {
  alertId: "alr_1",
  organizationName: "Acme <Robotics> & Co",
  type: "BUDGET_THRESHOLD",
  severity: "CRITICAL",
  title: "Company monthly cap reached 90% of its limit",
  summary: "Spend is $2,250.00 of $2,500.00.",
  facts: [
    { label: "Budget", value: "Company monthly cap" },
    { label: "Spent this period", value: "$2,250.00" },
  ],
  utilization: { ratio: 0.9, spentUsd: 2250, limitUsd: 2500 },
  incident: null,
  actionUrl: "https://tollgate.example/dashboard#budgets",
  actionLabel: "Review budget",
  occurredAt: new Date("2026-10-03T14:20:00Z"),
  isTest: false,
};

describe("backoff", () => {
  it("grows exponentially within equal-jitter bounds", () => {
    expect(computeBackoffMs(1, policy, () => 0)).toBe(1_000);
    expect(computeBackoffMs(1, policy, () => 1)).toBe(2_000);
    expect(computeBackoffMs(4, policy, () => 0)).toBe(8_000);
    expect(computeBackoffMs(4, policy, () => 1)).toBe(16_000);
  });

  it("caps at the maximum delay and never overflows", () => {
    expect(computeBackoffMs(50, policy, () => 1)).toBe(policy.maxMs);
    expect(Number.isFinite(computeBackoffMs(10_000, policy))).toBe(true);
  });

  it("honours Retry-After when it is longer than our own delay", () => {
    expect(nextRetryDelayMs(1, policy, 45_000, () => 1)).toBe(45_000);
    expect(nextRetryDelayMs(8, policy, 1_000, () => 1)).toBe(256_000);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    const now = Date.parse("2026-10-03T14:20:00Z");
    expect(parseRetryAfter("Sat, 03 Oct 2026 14:21:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("documents a full schedule", () => {
    const schedule = backoffSchedule(10, policy);
    expect(schedule).toHaveLength(9);
    expect(schedule.at(-1)?.maxMs).toBe(512_000);
  });
});

describe("renderers", () => {
  it("builds a Slack Block Kit payload with escaped text and a colour bar", () => {
    const body = JSON.parse(renderSlack(ctx).body);
    expect(body.text).toContain("Critical");
    expect(body.attachments[0].color).toBe("#C2352B");
    const blocks = body.attachments[0].blocks as Array<{ type: string; elements?: Array<{ text?: string }> }>;
    expect(blocks[0]?.type).toBe("header");
    expect(JSON.stringify(blocks)).toContain("Acme &lt;Robotics&gt; &amp; Co");
    expect(blocks.some((b) => b.type === "actions")).toBe(true);
  });

  it("builds a Teams Adaptive Card message", () => {
    const body = JSON.parse(renderTeams(ctx).body);
    expect(body.type).toBe("message");
    const card = body.attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.version).toBe("1.4");
    expect(card.content.actions[0].type).toBe("Action.OpenUrl");
    expect(card.content.body.some((b: { type: string }) => b.type === "FactSet")).toBe(true);
  });

  it("builds an HTML email with a plain-text alternative and escapes content", () => {
    const email = renderEmail(ctx, "On-call");
    expect(email.subject).toBe("[Critical] Company monthly cap reached 90% of its limit");
    expect(email.html).toContain("Acme &lt;Robotics&gt; &amp; Co");
    expect(email.html).not.toContain("<Robotics>");
    expect(email.text).toContain("Review budget: https://tollgate.example/dashboard#budgets");
  });

  it("signs generic webhooks with HMAC over timestamp and body", () => {
    const now = new Date("2026-10-03T14:20:00Z");
    const spec = renderWebhook(ctx, "dlv_1", "s3cr3t-s3cr3t-s3cr3t", now);
    const ts = spec.headers["x-tollgate-timestamp"]!;
    expect(spec.headers["x-tollgate-signature"]).toBe(`sha256=${signWebhook("s3cr3t-s3cr3t-s3cr3t", ts, spec.body)}`);
    expect(spec.headers["idempotency-key"]).toBe("dlv_1");
  });

  it("draws text meters including overflow", () => {
    expect(textMeter(0.5)).toBe("▰▰▰▰▰▱▱▱▱▱ 50%");
    expect(textMeter(1.2)).toContain("+20% over");
  });

  it("escapes Slack and HTML control characters", () => {
    expect(slackEscape("<@here> & co")).toBe("&lt;@here&gt; &amp; co");
    expect(escapeHtml(`"><script>`)).toBe("&quot;&gt;&lt;script&gt;");
  });
});

describe("url guard", () => {
  it("accepts provider webhooks on allow-listed hosts only", () => {
    expect(validateDestinationUrl("https://hooks.slack.com/services/T0/B0/xyz", "SLACK").hostname).toBe("hooks.slack.com");
    expect(() => validateDestinationUrl("https://evil.example/services", "SLACK")).toThrow(UnsafeUrlError);
    expect(validateDestinationUrl("https://acme.webhook.office.com/webhookb2/abc", "TEAMS").hostname).toBe("acme.webhook.office.com");
  });

  it("rejects plain http, credentials and private targets", () => {
    expect(() => validateDestinationUrl("http://example.com/hook", "WEBHOOK")).toThrow(UnsafeUrlError);
    expect(() => validateDestinationUrl("https://user:pw@example.com/hook", "WEBHOOK")).toThrow(UnsafeUrlError);
    expect(() => validateDestinationUrl("https://169.254.169.254/latest", "WEBHOOK")).toThrow(UnsafeUrlError);
    expect(() => validateDestinationUrl("https://localhost/hook", "WEBHOOK")).toThrow(UnsafeUrlError);
  });

  it("classifies private and public addresses", () => {
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("agent state machine", () => {
  it("allows only defined transitions", () => {
    expect(canTransition("ACTIVE", "QUARANTINED")).toBe(true);
    expect(canTransition("KILLED", "QUARANTINED")).toBe(false);
    expect(canTransition("QUARANTINED", "PAUSED")).toBe(false);
    expect(canTransition("QUARANTINED", "ACTIVE")).toBe(true);
  });

  it("requires reasons for stops and quarantine releases", () => {
    expect(requiresReason("ACTIVE", "KILLED")).toBe(true);
    expect(requiresReason("QUARANTINED", "ACTIVE")).toBe(true);
    expect(requiresReason("PAUSED", "ACTIVE")).toBe(false);
  });
});
