// Charts take every colour from CSS variables (--chart-1..--chart-8 and the shared
// shadcn tokens), so light/dark follow `prefers-color-scheme` with no hard-coded fills.

export const MAX_SERIES = 8;
export const OTHER_KEY = "other";

export const CHART_COLORS: readonly string[] = Array.from({ length: MAX_SERIES }, (_, i) => `hsl(var(--chart-${i + 1}))`);

export const chartColor = (i: number): string => CHART_COLORS[i % MAX_SERIES] ?? CHART_COLORS[0]!;

export const axisTick = { fill: "hsl(var(--muted-foreground))", fontSize: 12 } as const;
export const gridStroke = "hsl(var(--border))";
export const axisStroke = "hsl(var(--border))";

export const tooltipStyles = {
  contentStyle: {
    background: "hsl(var(--popover))",
    color: "hsl(var(--popover-foreground))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "var(--radius)",
    fontSize: 12,
  },
  labelStyle: { color: "hsl(var(--muted-foreground))" },
  itemStyle: { color: "hsl(var(--popover-foreground))" },
  cursor: { fill: "hsl(var(--muted))", fillOpacity: 0.4 },
} as const;

export const formatCount = (n: number): string => n.toLocaleString("en-US");
export const formatVnd = (n: number): string => `${n.toLocaleString("en-US")} VND`;

export interface SeriesLike<P> {
  key: string;
  label: string;
  points: P[];
}

/** Keeps the 7 largest series (by `weight`) and merges the rest into one `other` series (<= 8 total). */
export function mergeSmallSeries<P extends { ts: string }>(
  series: readonly SeriesLike<P>[],
  weight: (p: P) => number,
  merge: (a: P | undefined, b: P) => P,
): SeriesLike<P>[] {
  if (series.length <= MAX_SERIES) return [...series];
  const ranked = [...series].sort((a, b) => b.points.reduce((s, p) => s + weight(p), 0) - a.points.reduce((s, p) => s + weight(p), 0));
  const keep = ranked.slice(0, MAX_SERIES - 1);
  const byTs = new Map<string, P>();
  for (const s of ranked.slice(MAX_SERIES - 1)) for (const p of s.points) byTs.set(p.ts, merge(byTs.get(p.ts), p));
  const rest = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  return [...keep, { key: OTHER_KEY, label: "Other", points: rest }];
}
