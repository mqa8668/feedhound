import { EmptyState } from "@/components/layout/EmptyState";
import { ErrorState } from "@/components/layout/ErrorState";
import { cn } from "@/lib/utils";
import { useOpsSlo } from "@/api/queries";

/** Whole percent, floored: a ratio is never shown rounded up past what was actually achieved. */
function wholePct(ratio: number | null): number | null {
  return ratio === null ? null : Math.floor(ratio * 100 + 1e-9);
}

function pct(ratio: number | null): string {
  const p = wholePct(ratio);
  return p === null ? "–" : `${p}%`;
}

/** Danger when the displayed (floored) value is below the floored target, so tone and text always agree. */
function below(ratio: number | null, target: number): boolean {
  const p = wholePct(ratio);
  return p !== null && p < (wholePct(target) ?? 0);
}

function ago(seconds: number): string {
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export function SloPanel() {
  const { data, isLoading, isError } = useOpsSlo();

  if (isLoading) return <div className="h-14 animate-pulse bg-muted" />;
  if (isError) return <ErrorState error={new Error("Collection SLO unavailable.")} />;
  if (!data || data.sources.length === 0) return <EmptyState title="No sources" />;

  const { targets } = data;
  return (
    <ul className="flex flex-col divide-y">
      {data.sources.map((s) => {
        const okBad = below(s.coverageOkRatio, targets.coverageOk);
        const lastOk = s.secondsSinceOkVisit === null ? "never" : ago(s.secondsSinceOkVisit);
        return (
          <li key={s.sourceId} className="flex min-w-0 flex-col gap-0.5 py-2 text-xs text-muted-foreground">
            <p className="min-w-0 truncate text-sm font-medium text-foreground" title={s.name}>
              {s.name}
            </p>
            <p>
              <span data-tone={okBad ? "danger" : "ok"} className={cn(okBad && "text-destructive")}>
                Coverage {pct(s.coverageOkRatio)}
              </span>{" "}
              &middot;{" "}
              <span
                data-tone="ok"
                title="Share of visits that reached the end of the new posts (stop condition met). Low values are expected while the feed is read in short passes."
              >
                complete {pct(s.coverageCompleteRatio)}
              </span>{" "}
              &middot; last ok {lastOk}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
