/** Tiny inline SVG trend line; the last point is emphasized. */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  tone = "settled",
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: "settled" | "signal";
  label: string;
}) {
  const max = Math.max(...values, 1e-9);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)] as const);
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${d} L${width},${height} L0,${height} Z`;
  const color = tone === "signal" ? "#C2352B" : "#0E7C6B";
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="overflow-visible">
      <path d={area} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={2.2} fill={color} />}
    </svg>
  );
}
