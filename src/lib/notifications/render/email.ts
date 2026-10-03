import { SEVERITY_COLOR, SEVERITY_LABEL, type EmailMessageSpec, type NotificationContext } from "../types";
import { footerLine, timestampUtc } from "./shared";
import { formatUsdValue } from "../context";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const INK = "#13233F";
const SOFT = "#45526A";
const FAINT = "#7A869B";
const RULE = "#D5DCE5";
const PAPER = "#EEF2F6";
const SETTLED = "#0E7C6B";

function meterHtml(ratio: number, spentUsd: number, limitUsd: number): string {
  const pct = Math.round(ratio * 100);
  const fill = Math.max(1, Math.min(100, pct));
  const color = ratio >= 1 ? SEVERITY_COLOR.CRITICAL : ratio >= 0.8 ? SEVERITY_COLOR.WARNING : SETTLED;
  const rest = 100 - fill;
  return `
  <tr><td style="padding:4px 32px 20px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
      <tr>
        <td width="${fill}%" height="12" style="background:${color};border-radius:3px 0 0 3px;font-size:0;line-height:0;">&nbsp;</td>
        ${rest > 0 ? `<td width="${rest}%" height="12" style="background:#E3E8EF;border-radius:0 3px 3px 0;font-size:0;line-height:0;">&nbsp;</td>` : ""}
      </tr>
    </table>
    <p style="margin:8px 0 0 0;font-size:13px;color:${SOFT};">
      <strong style="color:${INK};">${escapeHtml(formatUsdValue(spentUsd))}</strong> of ${escapeHtml(formatUsdValue(limitUsd))}
      <span style="color:${ratio >= 1 ? SEVERITY_COLOR.CRITICAL : SOFT};">&nbsp;(${pct}%)</span>
    </p>
  </td></tr>`;
}

/** Transactional alert email: table layout and inline styles for client compatibility. */
export function renderEmail(ctx: NotificationContext, channelName: string): EmailMessageSpec {
  const sev = SEVERITY_LABEL[ctx.severity];
  const color = SEVERITY_COLOR[ctx.severity];
  const subject = `${ctx.isTest ? "[Test] " : ""}[${sev}] ${ctx.title}`;
  const preheader = ctx.summary.slice(0, 140);

  const factRows = ctx.facts
    .map(
      (f) => `
      <tr>
        <td style="padding:8px 12px 8px 0;border-bottom:1px solid ${RULE};font-size:13px;color:${SOFT};vertical-align:top;white-space:nowrap;">${escapeHtml(f.label)}</td>
        <td style="padding:8px 0;border-bottom:1px solid ${RULE};font-size:13px;color:${INK};font-weight:600;vertical-align:top;">${escapeHtml(f.value)}</td>
      </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid ${RULE};border-radius:6px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="height:6px;background:${color};border-radius:6px 6px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:24px 32px 0 32px;">
        <p style="margin:0;font-size:13px;font-weight:700;color:${color};">${escapeHtml(sev)}${ctx.isTest ? " (test)" : ""}</p>
        <h1 style="margin:6px 0 0 0;font-size:22px;line-height:1.3;color:${INK};font-weight:700;">${escapeHtml(ctx.title)}</h1>
        <p style="margin:6px 0 0 0;font-size:13px;color:${FAINT};">${escapeHtml(ctx.organizationName)} | ${escapeHtml(timestampUtc(ctx.occurredAt))}</p>
      </td></tr>
      <tr><td style="padding:16px 32px 16px 32px;">
        <p style="margin:0;font-size:15px;line-height:1.6;color:${INK};">${escapeHtml(ctx.summary)}</p>
      </td></tr>
      ${ctx.utilization ? meterHtml(ctx.utilization.ratio, ctx.utilization.spentUsd, ctx.utilization.limitUsd) : ""}
      ${
        ctx.facts.length
          ? `<tr><td style="padding:0 32px 8px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${RULE};">${factRows}</table>
      </td></tr>`
          : ""
      }
      <tr><td style="padding:20px 32px 28px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:${INK};border-radius:5px;">
            <a href="${escapeHtml(ctx.actionUrl)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none;">${escapeHtml(ctx.actionLabel)}</a>
          </td>
        </tr></table>
      </td></tr>
    </table>
    <p style="max-width:600px;margin:16px auto 0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${FAINT};text-align:center;">
      Sent to the "${escapeHtml(channelName)}" notification channel in Tollgate. Change which alerts reach this address in notification settings.<br>
      ${escapeHtml(footerLine(ctx))}
    </p>
  </td></tr>
</table>
</body>
</html>`;

  const lines = [
    `${sev.toUpperCase()}${ctx.isTest ? " (TEST)" : ""}: ${ctx.title}`,
    ctx.organizationName,
    "",
    ctx.summary,
    "",
    ...(ctx.utilization
      ? [`Spent ${formatUsdValue(ctx.utilization.spentUsd)} of ${formatUsdValue(ctx.utilization.limitUsd)} (${Math.round(ctx.utilization.ratio * 100)}%)`, ""]
      : []),
    ...ctx.facts.map((f) => `${f.label}: ${f.value}`),
    "",
    `${ctx.actionLabel}: ${ctx.actionUrl}`,
    "",
    `-- Sent to the "${channelName}" channel. ${footerLine(ctx)}`,
  ];

  return { kind: "email", subject, html, text: lines.join("\n") };
}
