"use client";

import { useState } from "react";
import clsx from "clsx";
import type { Alert, NotificationChannel, NotificationDelivery } from "@prisma/client";
import type { ChannelHealth } from "@/lib/sim/engine";
import { PanelHeader, Segmented } from "./ui";
import { fmtDateTime, fmtDuration, relativeTime } from "./format";

const SEVERITY_BAR: Record<Alert["severity"], string> = { CRITICAL: "bg-signal", WARNING: "bg-reserved", INFO: "bg-ink-faint" };
const TYPE_LABEL: Record<Alert["type"], string> = {
  BUDGET_THRESHOLD: "Budget threshold",
  BUDGET_BLOCKED: "Requests blocked",
  BUDGET_LIMIT_BYPASSED: "Over limit, allowed",
  VELOCITY_LIMIT: "Rate limit",
  AGENT_KILLED: "Agent stopped",
  AGENT_QUARANTINED: "Agent quarantined",
  ANOMALY_DETECTED: "Unusual usage",
  BILLING_SUSPENDED: "Billing suspension",
  BILLING_RESTORED: "Billing restored",
};
const CHANNEL_LABEL: Record<NotificationChannel["type"], string> = { SLACK: "Slack", TEAMS: "Teams", EMAIL: "Email", WEBHOOK: "Webhook" };

function DeliveryChip({ d, channel, nowMs }: { d: NotificationDelivery; channel: NotificationChannel | undefined; nowMs: number }) {
  const label = CHANNEL_LABEL[channel?.type ?? "WEBHOOK"];
  let text: string;
  let tone: string;
  switch (d.status) {
    case "DELIVERED":
      text = d.attempts > 1 ? `${label} sent after ${d.attempts} tries` : `${label} sent`;
      tone = "border-settled/40 text-settled";
      break;
    case "RETRY_SCHEDULED":
      text = `${label} retry ${d.attempts + 1} in ${fmtDuration(d.nextAttemptAt.getTime() - nowMs)}`;
      tone = "border-reserved/60 text-[#9A6A0C]";
      break;
    case "DEAD":
      text = `${label} failed`;
      tone = "border-signal/50 text-signal";
      break;
    case "SKIPPED":
      text = `${label} skipped`;
      tone = "border-rule text-ink-faint";
      break;
    default:
      text = `${label} sending`;
      tone = "border-rule text-ink-soft";
  }
  return (
    <span title={d.lastError ?? undefined} className={clsx("num inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", tone)}>
      {text}
    </span>
  );
}

export function NotificationsPanel({
  alerts,
  deliveries,
  channels,
  channelHealth,
  nowMs,
  onAcknowledge,
  onChannelHealthChange,
}: {
  alerts: Alert[];
  deliveries: NotificationDelivery[];
  channels: NotificationChannel[];
  channelHealth: Map<string, ChannelHealth>;
  nowMs: number;
  onAcknowledge: (alert: Alert) => void;
  onChannelHealthChange: (channelId: string, health: ChannelHealth) => void;
}) {
  const [view, setView] = useState<"open" | "all">("open");
  const open = alerts.filter((a) => !a.acknowledgedAt);
  const shown = (view === "open" ? open : alerts).slice(0, 40);
  const byAlert = new Map<string, NotificationDelivery[]>();
  for (const d of deliveries) {
    const list = byAlert.get(d.alertId) ?? [];
    list.push(d);
    byAlert.set(d.alertId, list);
  }
  const stats = channels.map((c) => {
    const ds = deliveries.filter((d) => d.channelId === c.id);
    return {
      channel: c,
      delivered: ds.filter((d) => d.status === "DELIVERED").length,
      retrying: ds.filter((d) => d.status === "RETRY_SCHEDULED" || d.status === "PENDING").length,
      dead: ds.filter((d) => d.status === "DEAD").length,
    };
  });

  return (
    <section id="notifications" aria-labelledby="notifications-title" className="panel flex scroll-mt-28 flex-col">
      <PanelHeader
        titleId="notifications-title"
        title="Alerts and notifications"
        description="Each alert is delivered to every matching channel, with backoff retries when a provider fails."
        actions={
          <Segmented
            label="Alert filter"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "open", label: `Open (${open.length})` },
              { value: "all", label: "All" },
            ]}
          />
        }
      />

      <div className="grid gap-px border-b border-rule bg-rule sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.channel.id} className="bg-panel px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{CHANNEL_LABEL[s.channel.type]}</p>
              <p className="truncate text-[11px] text-ink-faint">{s.channel.name}</p>
            </div>
            <p className="num mt-0.5 text-xs text-ink-soft">
              {s.delivered} sent
              {s.retrying > 0 && <span className="text-[#9A6A0C]">, {s.retrying} retrying</span>}
              {s.dead > 0 && <span className="text-signal">, {s.dead} failed</span>}
            </p>
            <div className="mt-2">
              <Segmented<ChannelHealth>
                label={`${CHANNEL_LABEL[s.channel.type]} provider health (simulation)`}
                size="sm"
                value={channelHealth.get(s.channel.id) ?? "healthy"}
                onChange={(h) => onChannelHealthChange(s.channel.id, h)}
                options={[
                  { value: "healthy", label: "Healthy" },
                  { value: "degraded", label: "Degraded" },
                  { value: "down", label: "Down" },
                ]}
              />
            </div>
          </div>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="px-5 py-8">
          <p className="text-sm font-medium">All alerts acknowledged.</p>
          <p className="mt-1 text-sm text-ink-soft">Threshold crossings, blocks, stops and quarantines will appear here.</p>
        </div>
      ) : (
        <ul className="max-h-[30rem] divide-y divide-rule overflow-y-auto">
          {shown.map((a) => (
            <li key={a.id} className="relative flex gap-3 py-3 pl-5 pr-4">
              <span aria-hidden className={clsx("absolute inset-y-3 left-0 w-[3px] rounded-r", SEVERITY_BAR[a.severity])} />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-ink-soft">
                  {TYPE_LABEL[a.type]} <span className="text-ink-faint">/</span>{" "}
                  <time dateTime={a.createdAt.toISOString()} title={fmtDateTime(a.createdAt.toISOString())}>
                    {relativeTime(a.createdAt.toISOString(), nowMs)}
                  </time>
                </p>
                <p className={clsx("mt-0.5 text-sm leading-snug", a.acknowledgedAt ? "text-ink-soft" : "text-ink")}>{a.message}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(byAlert.get(a.id) ?? []).map((d) => (
                    <DeliveryChip key={d.id} d={d} channel={channels.find((c) => c.id === d.channelId)} nowMs={nowMs} />
                  ))}
                  {(byAlert.get(a.id) ?? []).length === 0 && <span className="text-[11px] text-ink-faint">Below every channel's severity filter</span>}
                </div>
              </div>
              {!a.acknowledgedAt ? (
                <button
                  type="button"
                  onClick={() => onAcknowledge(a)}
                  className="h-fit shrink-0 rounded border border-rule px-2 py-1 text-xs font-medium text-ink hover:border-ink"
                >
                  Acknowledge
                </button>
              ) : (
                <span className="h-fit shrink-0 pt-1 text-xs text-ink-faint">Acknowledged</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
