import { StatusBadge } from "@/components/layout/StatusBadge";
import { EmptyState } from "@/components/layout/EmptyState";
import { ErrorState } from "@/components/layout/ErrorState";
import { formatDateCell } from "@/lib/format";
import { useSources } from "@/api/queries";

export function SourceHealthCards() {
  const { data, isLoading, isError } = useSources();

  if (isLoading)
    return (
      <div className="flex flex-col divide-y">
        {[0, 1].map((i) => (
          <div key={i} className="h-14 animate-pulse bg-muted" />
        ))}
      </div>
    );
  if (isError) return <ErrorState error={new Error("Source health unavailable.")} />;
  if (!data || data.length === 0) return <EmptyState title="No sources yet" />;

  return (
    <ul className="flex flex-col divide-y">
      {data.map((s) => {
        // `ok: null` = the source has never been visited (empty health, no
        // reason): neutral, not "degraded".
        const neverVisited = s.health.ok === null;
        const lastVisit = formatDateCell(s.health.lastVisitAt);
        const lastOkVisit = formatDateCell(s.health.lastOkVisitAt);
        // The dot used to render `s.status`, which is the *schedule* state:
        // a source paused by the watchdog for repeated failures still reads
        // "active", so an unhealthy source showed green. Health wins; the
        // schedule state is only interesting when it is not "active".
        // ok:false renders "degraded" with or without a reason; the
        // reason itself still shows below in destructive text.
        // `paused_by_health` is a schedule state raised by the watchdog for
        // repeated failures: it renders the same "degraded"
        // tone as an unhealthy source, not its own unmapped colour.
        const tone =
          s.status === "paused_by_health"
            ? "degraded"
            : s.status !== "active"
              ? s.status
              : neverVisited
                ? "never-visited"
                : s.health.ok
                  ? "healthy"
                  : "degraded";
        return (
          <li key={s.id} className="flex min-h-14 min-w-0 flex-col justify-center gap-0.5 py-2">
            <div className="flex min-w-0 text-sm font-medium" title={s.name}>
              <StatusBadge status={tone}>{s.name}</StatusBadge>
            </div>
            <p className="truncate text-xs text-muted-foreground" title={neverVisited ? undefined : lastVisit.absolute}>
              {neverVisited ? "Not visited yet" : lastVisit.relative} &middot; {s.health.postsLastHour ?? 0}/h
            </p>
            <p className="truncate text-xs text-muted-foreground" title={s.health.lastOkVisitAt == null ? undefined : lastOkVisit.absolute}>
              {s.health.coveragePct == null ? "Coverage –" : `Coverage ${s.health.coveragePct}%`} &middot;{" "}
              {s.health.lastOkVisitAt == null ? "last ok never" : `last ok ${lastOkVisit.relative}`}
            </p>
            {s.health.reason ? (
              <p className="truncate text-xs text-destructive" title={s.health.reason}>
                {s.health.reason}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
