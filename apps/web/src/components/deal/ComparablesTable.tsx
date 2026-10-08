import { Link } from "react-router-dom";
import { formatKm } from "@feedhound/core/listing";
import { Card } from "@/components/layout/Card";
import type { DecisionDto } from "@/api/decision";
import { formatPriceQualified, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Up to 10 comparable listings, closest year/odo first. */
export function ComparablesTable({ rows }: { rows: DecisionDto["comparables"] }) {
  if (rows.length === 0) return null;
  return (
    <Card title="Comparable listings" count={rows.length}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead>
            <tr className="border-b text-left text-fs-sm text-muted-foreground">
              <th className="py-1 pr-3 font-medium">Tin</th>
              <th className="py-1 pr-3 font-medium">Price</th>
              <th className="py-1 pr-3 font-medium">Diff</th>
              <th className="py-1 pr-3 font-medium">Year</th>
              <th className="py-1 pr-3 font-medium">ODO</th>
              <th className="py-1 font-medium">Posted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.postId} data-comparable={r.postId} className="border-b last:border-b-0">
                <td className="max-w-[16rem] truncate py-1.5 pr-3">
                  <Link to={`/posts/${r.postId}`} title={r.title} className="hover:underline">
                    {r.title}
                  </Link>
                  <span className="block text-fs-sm text-muted-foreground">{r.sourceName}</span>
                </td>
                <td className="py-1.5 pr-3 tabular-nums">{formatPriceQualified(r.priceVnd)}</td>
                <td className={cn("py-1.5 pr-3 tabular-nums", r.deltaPct < 0 ? "text-good" : r.deltaPct > 0 ? "text-warn" : "")}>
                  {r.deltaPct > 0 ? "+" : ""}
                  {r.deltaPct.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%
                </td>
                <td className="py-1.5 pr-3 tabular-nums">{r.year ?? "—"}</td>
                <td className="py-1.5 pr-3 tabular-nums">{r.odoKm == null ? "—" : formatKm(r.odoKm)}</td>
                <td className="py-1.5 text-muted-foreground">{formatRelative(r.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
