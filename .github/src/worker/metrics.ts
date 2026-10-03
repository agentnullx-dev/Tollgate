/** Minimal Prometheus text-format registry (counters, gauges, histograms). */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}` : "";
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  render(): string[];
}

export class Counter implements Metric {
  readonly type = "counter" as const;
  private readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k} ${v}`);
  }
}

export class Gauge implements Metric {
  readonly type = "gauge" as const;
  private readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }
  render(): string[] {
    return [...this.values].map(([k, v]) => `${this.name}${k} ${v}`);
  }
}

export class Histogram implements Metric {
  readonly type = "histogram" as const;
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, private readonly bounds: number[]) {}
  observe(value: number, labels: Labels = {}): void {
    const k = labelKey(labels);
    const s = this.series.get(k) ?? { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
    this.series.set(k, s);
  }
  render(): string[] {
    const lines: string[] = [];
    for (const [k, s] of this.series) {
      const inner = k.slice(1, -1);
      const sep = inner ? `${inner},` : "";
      this.bounds.forEach((b, i) => lines.push(`${this.name}_bucket{${sep}le="${b}"} ${s.buckets[i]}`));
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k} ${s.sum}`);
      lines.push(`${this.name}_count${k} ${s.count}`);
    }
    return lines;
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];
  register<T extends Metric>(metric: T): T {
    this.metrics.push(metric);
    return metric;
  }
  render(): string {
    return (
      this.metrics
        .flatMap((m) => [`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.render()])
        .join("\n") + "\n"
    );
  }
}

export const registry = new Registry();

export const workerMetrics = {
  deliveries: registry.register(new Counter("tollgate_notification_deliveries_total", "Delivery attempts by channel type and outcome.")),
  deliveryLatency: registry.register(
    new Histogram("tollgate_notification_delivery_seconds", "Time to send one notification.", [0.1, 0.25, 0.5, 1, 2, 5, 10, 30]),
  ),
  fanouts: registry.register(new Counter("tollgate_alert_fanouts_total", "Alerts fanned out to channels, by source.")),
  queueDepth: registry.register(new Gauge("tollgate_notification_queue_depth", "Deliveries by queue state.")),
  circuitOpens: registry.register(new Counter("tollgate_notification_circuit_opens_total", "Circuit breaker openings by channel type.")),
  anomalyEvaluations: registry.register(new Counter("tollgate_anomaly_evaluations_total", "Agent windows evaluated, by verdict.")),
  anomalyIncidents: registry.register(new Counter("tollgate_anomaly_incidents_total", "Incidents recorded, by action.")),
  anomalyTickSeconds: registry.register(
    new Histogram("tollgate_anomaly_tick_seconds", "Duration of one anomaly engine tick.", [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]),
  ),
  leader: registry.register(new Gauge("tollgate_anomaly_leader", "1 when this replica runs the anomaly engine.")),
};
