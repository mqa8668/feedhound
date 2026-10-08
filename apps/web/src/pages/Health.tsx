import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/layout/Card";
import { StatCard, StatCardRow } from "@/components/layout/StatCard";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { EmptyState } from "@/components/layout/EmptyState";
import { ErrorState } from "@/components/layout/ErrorState";
import { formatDateCell } from "@/lib/format";
import { SloPanel } from "@/components/SloPanel";
import { SourceHealthCards } from "@/components/SourceHealthCards";
import { useOpsHealth } from "@/api/queries";

export default function Health() {
  const { data, isLoading, isError, refetch } = useOpsHealth();

  const queuePending = data?.queues.reduce((sum, q) => sum + q.pending, 0) ?? 0;
  const queueFailed = data?.queues.reduce((sum, q) => sum + q.failed, 0) ?? 0;
  const healthySources = data?.sources.filter((s) => s.status === "active").length ?? 0;
  const totalSources = data?.sources.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Health" />

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg border bg-muted" />
          ))}
        </div>
      ) : null}
      {isError ? <ErrorState error={new Error("Health endpoint unavailable right now.")} onRetry={() => refetch()} /> : null}

      {data ? (
        <>
          <StatCardRow>
            <StatCard label="Database" value={data.db} tone={data.db === "ok" ? "success" : "danger"} hint="connection status" />
            <StatCard
              label="Sources healthy"
              value={`${healthySources}/${totalSources}`}
              hint={`${totalSources} source${totalSources === 1 ? "" : "s"} tracked`}
              tone={totalSources === 0 ? "neutral" : healthySources === totalSources ? "success" : "warning"}
            />
            <StatCard label="Queue pending" value={queuePending} tone={queuePending > 0 ? "warning" : "neutral"} hint="jobs waiting" />
            <StatCard label="Queue failed" value={queueFailed} tone={queueFailed > 0 ? "danger" : "neutral"} hint="needs attention" />
          </StatCardRow>

          <Card title="Queues">
            {data.queues.length === 0 ? (
              <EmptyState title="No queue stats" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Queue</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.queues.map((q) => (
                    <TableRow key={q.name}>
                      <TableCell>{q.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{q.pending}</TableCell>
                      <TableCell className="text-right tabular-nums">{q.failed}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card title="Sources">
            {data.sources.length === 0 ? (
              <EmptyState title="No sources" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last visit</TableHead>
                    <TableHead>Last error</TableHead>
                    <TableHead className="text-right">Posts/hr</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.sources.map((s) => {
                    const v = formatDateCell(s.lastVisitAt);
                    return (
                      <TableRow key={s.id}>
                        <TableCell>{s.name}</TableCell>
                        <TableCell>
                          <StatusBadge status={s.status} />
                        </TableCell>
                        <TableCell title={v.absolute}>{v.relative}</TableCell>
                        <TableCell className="max-w-40 truncate">{s.lastError ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.postsLastHour}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      ) : null}

      <Card title="Source health">
        <SourceHealthCards />
      </Card>
      <Card title="Collection SLO (24 h)">
        <SloPanel />
      </Card>
    </div>
  );
}
