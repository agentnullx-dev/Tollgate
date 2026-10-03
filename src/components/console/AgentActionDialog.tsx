"use client";

import { useState, type FormEvent } from "react";
import type { Agent, SecurityIncident } from "@prisma/client";
import { Dialog } from "./ui";
import { fmtUsd } from "./format";

export type AgentAction = { kind: "stop" | "release"; agent: Agent } | null;

export function AgentActionDialog({
  action,
  openIncidents,
  onClose,
  onConfirm,
}: {
  action: AgentAction;
  openIncidents: SecurityIncident[];
  onClose: () => void;
  onConfirm: (input: { reason: string; resolution: "RESOLVED" | "FALSE_POSITIVE" }) => void;
}) {
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState<"RESOLVED" | "FALSE_POSITIVE">("RESOLVED");
  const name = action ? action.agent.displayName ?? action.agent.externalId : "agent";
  const releasing = action?.kind === "release";

  const close = () => {
    setReason("");
    setResolution("RESOLVED");
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    onConfirm({ reason: reason.trim(), resolution });
    setReason("");
    setResolution("RESOLVED");
  };

  return (
    <Dialog
      open={action !== null}
      onClose={close}
      title={releasing ? `Release ${name} from quarantine?` : `Stop ${name}?`}
      description={
        releasing
          ? "The agent will accept requests again immediately. Its open incidents are closed with the outcome you choose."
          : "Every new request from this agent will be refused until someone reactivates it. Requests already running finish normally."
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        {releasing && openIncidents.length > 0 && (
          <ul className="space-y-1 rounded-md bg-paper p-3 text-xs text-ink-soft">
            {openIncidents.map((i) => (
              <li key={i.id}>
                {fmtUsd(Number(i.windowSpendMicros) / 1e6)} in the detection window, {i.zScore.toFixed(1)}σ above normal.
              </li>
            ))}
          </ul>
        )}
        {releasing && (
          <fieldset className="flex flex-col gap-1.5 text-sm">
            <legend className="mb-1 font-medium">What did the review find?</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="resolution" checked={resolution === "RESOLVED"} onChange={() => setResolution("RESOLVED")} />
              A real problem that has been fixed
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="resolution" checked={resolution === "FALSE_POSITIVE"} onChange={() => setResolution("FALSE_POSITIVE")} />
              Expected traffic (false positive)
            </label>
          </fieldset>
        )}
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Reason</span>
          <textarea
            required
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={releasing ? "e.g. Retry loop in the crawler fixed in release 4.2.1" : "e.g. Retry loop on the billing tool, investigating"}
            className="rounded-md border border-rule px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-ink"
          />
          <span className="text-xs text-ink-soft">Saved to the audit log{releasing ? " and the incident record" : " and sent with the alert"}.</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={close} className="rounded-md border border-rule px-3 py-1.5 text-sm font-medium hover:border-ink">
            {releasing ? "Keep quarantined" : "Keep running"}
          </button>
          <button
            type="submit"
            disabled={!reason.trim()}
            className={releasing ? "rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40" : "rounded-md bg-signal px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"}
          >
            {releasing ? "Release agent" : "Stop agent"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
