"use client";

import { Pause, Play } from "lucide-react";
import type { Project } from "@prisma/client";
import type { SimSpeed } from "@/lib/sim/engine";
import { GateMark, MobileNav, type NavCounts } from "./Sidebar";
import { Segmented, Switch } from "./ui";
import { fmtClock } from "./format";

export function TopBar({
  projects,
  projectId,
  onProjectChange,
  nowMs,
  running,
  onRunningChange,
  speed,
  onSpeedChange,
  apiErrors,
  onApiErrorsChange,
  counts,
}: {
  projects: Project[];
  projectId: string;
  onProjectChange: (id: string) => void;
  nowMs: number;
  running: boolean;
  onRunningChange: (v: boolean) => void;
  speed: SimSpeed;
  onSpeedChange: (s: SimSpeed) => void;
  apiErrors: boolean;
  onApiErrorsChange: (v: boolean) => void;
  counts: NavCounts;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-paper/90 backdrop-blur supports-[backdrop-filter]:bg-paper/75">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-3 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <GateMark className="h-6 w-6 text-ink lg:hidden" />
            <label>
              <span className="sr-only">Project</span>
              <select
                value={projectId}
                onChange={(e) => onProjectChange(e.target.value)}
                className="rounded-md border border-rule bg-panel px-2.5 py-1.5 text-sm font-medium outline-none focus:border-ink"
              >
                <option value="all">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="num hidden text-xs text-ink-soft md:block" aria-live="off">
              {running ? "Live" : "Paused"} at {fmtClock(nowMs)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => onRunningChange(!running)}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-panel px-2.5 py-1.5 text-sm font-medium hover:border-ink"
              aria-pressed={!running}
            >
              {running ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              {running ? "Pause" : "Resume"}
            </button>
            <Segmented<SimSpeed>
              label="Simulation speed"
              size="sm"
              value={speed}
              onChange={onSpeedChange}
              options={[
                { value: 1, label: "Real time" },
                { value: 10, label: "10×" },
                { value: 60, label: "60×" },
              ]}
            />
            <label className="flex items-center gap-2 text-[13px] text-ink-soft">
              <Switch checked={apiErrors} onChange={onApiErrorsChange} label="Simulate API errors" tone="signal" />
              <span className="hidden sm:inline">Simulate API errors</span>
            </label>
          </div>
        </div>
        <MobileNav counts={counts} />
      </div>
    </header>
  );
}
