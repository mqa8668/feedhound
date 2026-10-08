import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { StatusBadge } from "@/components/layout/StatusBadge";
import type { HealthState, Rollup } from "@feedhound/core/source-classify";

const pct = (v: number | null): string => (v === null ? "–" : `${Math.round(v * 100)}%`);

export function healthStatus(h: HealthState): string {
  return h === "ok" ? "ok" : h === "degraded" ? "degraded" : h === "down" ? "down" : h === "paused" ? "paused" : "unknown";
}

const SUMMARY_ORDER: HealthState[] = ["down", "degraded", "stale", "unknown", "paused"];

/** Muted counts of non-ok children, e.g. "2 down · 1 stale". */
export function healthSummary(health: Rollup["health"]): string {
  return SUMMARY_ORDER.filter((h) => health[h] > 0).map((h) => `${health[h]} ${h}`).join(" · ");
}

export function TreeNodeRow({
  label,
  depth,
  rollup,
  open,
  onToggle,
}: {
  label: ReactNode;
  depth: 0 | 1 | 2;
  rollup: Rollup;
  open: boolean;
  onToggle: () => void;
}) {
  const summary = healthSummary(rollup.health);
  const indent = depth === 0 ? "" : depth === 1 ? "pl-3 sm:pl-6" : "pl-6 sm:pl-12";
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-left hover:bg-muted/50 ${indent}`}
    >
      <Icon icon={open ? ChevronDown : ChevronRight} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      <span className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{rollup.sources} {rollup.sources === 1 ? "source" : "sources"}</span>
        <StatusBadge status={healthStatus(rollup.worst)}>{rollup.worst}</StatusBadge>
        {summary ? <span title="Sources by health">{summary}</span> : null}
        <span title="Coverage (ok visits)">cov {pct(rollup.coverageOk)}</span>
        <span title="Relevance share, last 7 days">rel {pct(rollup.relevance7d)}</span>
      </span>
    </button>
  );
}
