import { SEVERITY_LABEL, type HttpRequestSpec, type NotificationContext } from "../types";
import { footerLine, textMeter } from "./shared";

const CONTAINER_STYLE = { CRITICAL: "attention", WARNING: "warning", INFO: "emphasis" } as const;
const TEXT_COLOR = { CRITICAL: "attention", WARNING: "warning", INFO: "accent" } as const;

/**
 * Microsoft Teams message carrying an Adaptive Card (schema 1.4), accepted by
 * Teams Workflows webhooks and legacy incoming webhooks alike.
 */
export function renderTeams(ctx: NotificationContext): HttpRequestSpec {
  const body: Array<Record<string, unknown>> = [
    {
      type: "Container",
      style: CONTAINER_STYLE[ctx.severity],
      bleed: true,
      items: [
        {
          type: "TextBlock",
          text: `${SEVERITY_LABEL[ctx.severity].toUpperCase()}${ctx.isTest ? " (TEST)" : ""}`,
          size: "Small",
          weight: "Bolder",
          color: TEXT_COLOR[ctx.severity],
          spacing: "None",
        },
        { type: "TextBlock", text: ctx.title, size: "Large", weight: "Bolder", wrap: true, spacing: "Small" },
        { type: "TextBlock", text: ctx.organizationName, isSubtle: true, spacing: "None", wrap: true },
      ],
    },
    { type: "TextBlock", text: ctx.summary, wrap: true, spacing: "Medium" },
  ];

  if (ctx.utilization) {
    const pct = Math.round(ctx.utilization.ratio * 100);
    body.push({
      type: "ColumnSet",
      spacing: "Medium",
      columns: [
        {
          type: "Column",
          width: "stretch",
          items: [{ type: "TextBlock", text: textMeter(ctx.utilization.ratio), fontType: "Monospace", wrap: false }],
        },
        {
          type: "Column",
          width: "auto",
          verticalContentAlignment: "Center",
          items: [{ type: "TextBlock", text: `${pct}%`, weight: "Bolder", color: pct >= 100 ? "Attention" : pct >= 80 ? "Warning" : "Default" }],
        },
      ],
    });
  }

  if (ctx.facts.length > 0) {
    body.push({
      type: "FactSet",
      spacing: "Medium",
      facts: ctx.facts.map((f) => ({ title: f.label, value: f.value })),
    });
  }

  body.push({ type: "TextBlock", text: footerLine(ctx), size: "Small", isSubtle: true, wrap: true, spacing: "Medium" });

  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body,
    actions: [{ type: "Action.OpenUrl", title: ctx.actionLabel, url: ctx.actionUrl }],
  };

  const message = {
    type: "message",
    summary: `${SEVERITY_LABEL[ctx.severity]}: ${ctx.title}`,
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }],
  };

  return {
    kind: "http",
    body: JSON.stringify(message),
    headers: { "content-type": "application/json; charset=utf-8" },
  };
}
