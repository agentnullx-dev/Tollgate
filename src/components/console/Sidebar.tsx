import clsx from "clsx";
import { Activity, Bell, Gauge, LineChart, ShieldAlert, Wallet } from "lucide-react";

export function GateMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} aria-hidden>
      <rect x="3" y="6" width="4" height="19" rx="1" fill="currentColor" />
      <rect x="21" y="6" width="4" height="19" rx="1" fill="currentColor" />
      <rect x="5" y="10" width="18" height="3.5" rx="1" fill="#D99A1E" />
      <rect x="5" y="16" width="11" height="3.5" rx="1" fill="#0E7C6B" />
    </svg>
  );
}

export interface NavCounts {
  incidents: number;
  alerts: number;
}

const NAV = [
  { href: "#top", label: "Overview", icon: Gauge },
  { href: "#trends", label: "Trends", icon: LineChart },
  { href: "#budgets", label: "Budgets", icon: Wallet },
  { href: "#agents", label: "Running agents", icon: Activity },
  { href: "#incidents", label: "Incidents", icon: ShieldAlert, count: "incidents" as const },
  { href: "#notifications", label: "Notifications", icon: Bell, count: "alerts" as const },
];

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="num rounded-full bg-signal px-1.5 text-[11px] font-semibold leading-[18px] text-white">{n}</span>;
}

export function Sidebar({
  orgName,
  plan,
  counts,
  viewer,
}: {
  orgName: string;
  plan: string;
  counts: NavCounts;
  viewer?: { email: string | null; roleLabel: string };
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-rule bg-panel lg:flex">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <GateMark className="h-7 w-7 text-ink" />
        <span className="text-lg font-semibold tracking-[-0.02em]">Tollgate</span>
      </div>
      <nav aria-label="Primary" className="flex-1 px-3">
        <ul className="space-y-0.5">
          {NAV.map((item, i) => (
            <li key={item.href}>
              <a
                href={item.href}
                aria-current={i === 0 ? "page" : undefined}
                className={clsx(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
                  i === 0 ? "bg-paper text-ink" : "text-ink-soft hover:bg-paper hover:text-ink",
                )}
              >
                <item.icon className="h-4 w-4" aria-hidden />
                <span className="flex-1">{item.label}</span>
                {item.count && <Badge n={counts[item.count]} />}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-rule px-5 py-4">
        <p className="text-sm font-medium">{orgName}</p>
        <p className="text-xs text-ink-soft">{plan.charAt(0) + plan.slice(1).toLowerCase()} plan</p>
        {viewer && (
          <p className="mt-2 text-xs text-ink-soft">
            <span className="block truncate text-ink">{viewer.email ?? "Signed in"}</span>
            {viewer.roleLabel}
          </p>
        )}
        <a href="/api/health" className="mt-2 inline-block text-xs text-ink-soft underline-offset-2 hover:text-ink hover:underline">
          Gateway status
        </a>
      </div>
    </aside>
  );
}

export function MobileNav({ counts }: { counts: NavCounts }) {
  return (
    <nav aria-label="Sections" className="-mx-4 overflow-x-auto px-4 lg:hidden">
      <ul className="flex gap-1 pb-1">
        {NAV.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] font-medium text-ink-soft hover:bg-paper hover:text-ink"
            >
              {item.label}
              {item.count && <Badge n={counts[item.count]} />}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
