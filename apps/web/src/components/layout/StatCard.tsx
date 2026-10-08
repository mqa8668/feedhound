import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  delta?: string;
  hint?: string;
  tone?: StatTone;
  /** 7-point trend, drawn as an inline SVG polyline. */
  sparkline?: number[];
}

const TONE_CLASS: Record<StatTone, string> = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-info",
};

/** One tile in the Overview/Health stat row: 4 cols >=1280, 2 cols below (incl. <640). */
export function StatCard({ label, value, delta, hint, tone = "neutral", sparkline }: StatCardProps) {
  return (
    <div className="rounded-lg border bg-card p-3 sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-2 text-xl font-semibold tabular-nums sm:text-2xl", TONE_CLASS[tone])}>{value}</p>
      {delta || hint ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {delta ? <span className="mr-1">{delta}</span> : null}
          {hint}
        </p>
      ) : null}
      {sparkline ? <Sparkline values={sparkline} tone={tone} /> : null}
    </div>
  );
}

const SPARK_W = 120;
const SPARK_H = 24;

function Sparkline({ values, tone }: { values: number[]; tone: StatTone }) {
  const max = Math.max(...values, 0);
  const step = values.length > 1 ? SPARK_W / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(max === 0 ? SPARK_H - 1 : SPARK_H - 1 - (v / max) * (SPARK_H - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      role="img"
      aria-label="7-day trend"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={cn("mt-2 h-6 w-full", tone === "neutral" ? "text-muted-foreground" : TONE_CLASS[tone])}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Responsive stat-tile row: 2 cols <1280, 4 cols >=1280. */
export function StatCardRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{children}</div>;
}
