import { formatVndCompact } from "@feedhound/core/listing";

/** Card market strip: comparable median and sample size. Renders nothing without both. */
export function MarketStrip({ medianVnd, n }: { medianVnd: number | null | undefined; n: number | null | undefined }) {
  if (medianVnd == null || n == null || n <= 0) return null;
  return (
    <span data-market-strip="true" className="text-fs-sm tabular-nums text-muted-foreground">
      Avg {formatVndCompact(medianVnd)} · {n} listings
    </span>
  );
}
