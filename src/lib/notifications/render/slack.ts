import { SEVERITY_COLOR, SEVERITY_LABEL, type HttpRequestSpec, type NotificationContext } from "../types";
import { footerLine, textMeter, truncate } from "./shared";

/** Escape the three characters Slack mrkdwn treats as control characters. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SEVERITY_EMOJI = { CRITICAL: ":red_circle:", WARNING: ":large_orange_circle:", INFO: ":large_blue_circle:" } as const;

type Block = Record<string, unknown>;

/**
 * Slack incoming-webhook payload using Block Kit inside a legacy attachment so
 * the message gets a severity-coloured side bar. `text` is the notification
 * fallback shown in push notifications and screen readers.
 */
export function renderSlack(ctx: NotificationContext): HttpRequestSpec {
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: truncate(`${ctx.isTest ? "[Test] " : ""}${ctx.title}`, 150), emoji: true },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `${SEVERITY_EMOJI[ctx.severity]} *${SEVERITY_LABEL[ctx.severity]}*  |  ${slackEscape(ctx.organizationName)}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: truncate(slackEscape(ctx.summary), 3000) } },
  ];

  if (ctx.utilization) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `\`${textMeter(ctx.utilization.ratio)}\`` },
    });
  }

  // Slack allows at most 10 fields per section; split into chunks.
  for (let i = 0; i < ctx.facts.length; i += 10) {
    blocks.push({
      type: "section",
      fields: ctx.facts.slice(i, i + 10).map((f) => ({
        type: "mrkdwn",
        text: truncate(`*${slackEscape(f.label)}*\n${slackEscape(f.value)}`, 2000),
      })),
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: ctx.actionLabel, emoji: false },
          url: ctx.actionUrl,
          ...(ctx.severity === "CRITICAL" ? { style: "danger" } : { style: "primary" }),
        },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: slackEscape(footerLine(ctx)) }] },
  );

  const payload = {
    text: `${SEVERITY_LABEL[ctx.severity]}: ${ctx.title}`,
    attachments: [{ color: SEVERITY_COLOR[ctx.severity], blocks }],
    unfurl_links: false,
    unfurl_media: false,
  };

  return {
    kind: "http",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json; charset=utf-8" },
  };
}
