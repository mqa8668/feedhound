import { Card } from "@/components/layout/Card";
import type { DecisionDto } from "@/api/decision";

/** Pseudonymous seller summary; the raw author key never reaches the browser. */
export function SellerPanel({ seller }: { seller: DecisionDto["seller"] }) {
  return (
    <Card title="Seller">
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-fs-sm text-muted-foreground">ID</dt>
          <dd className="break-words">{seller.label ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-fs-sm text-muted-foreground">Listings in 90 days</dt>
          <dd className="tabular-nums">{seller.sellPosts90}</dd>
        </div>
        <div>
          <dt className="text-fs-sm text-muted-foreground">Reposts</dt>
          <dd className="tabular-nums">{seller.repostCount}</dd>
        </div>
      </dl>
    </Card>
  );
}
