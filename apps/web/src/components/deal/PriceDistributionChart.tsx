import { CartesianGrid, ComposedChart, ReferenceArea, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { PriceDistribution } from "@feedhound/core/deal-decision";
import { formatVndCompact } from "@feedhound/core/listing";
import { axisStroke, axisTick, chartColor, gridStroke } from "@/components/analytics/chartTheme";

export interface PriceDistributionChartProps {
  distribution: PriceDistribution;
  priceVnd: number | null;
  percentile: number | null;
}

/** p10-p90 band with median and this-price markers. Loaded via React.lazy. */
export default function PriceDistributionChart({ distribution: d, priceVnd, percentile }: PriceDistributionChartProps) {
  const lo = Math.min(d.p10, priceVnd ?? d.p10);
  const hi = Math.max(d.p90, priceVnd ?? d.p90);
  const pad = (hi - lo) * 0.1 || hi * 0.05;
  return (
    <div>
      <div className="h-32 w-full" role="img" aria-label="Price distribution of comparable listings">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={[]} margin={{ top: 16, right: 16, bottom: 0, left: 16 }}>
            <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" vertical={false} />
            <XAxis type="number" dataKey="x" domain={[lo - pad, hi + pad]} tick={axisTick} stroke={axisStroke} tickFormatter={(v: number) => formatVndCompact(Math.round(v))} tickCount={5} />
            <YAxis hide domain={[0, 1]} />
            <ReferenceArea x1={d.p10} x2={d.p90} y1={0} y2={1} fill={chartColor(1)} fillOpacity={0.2} stroke="none" />
            <ReferenceArea x1={d.p25} x2={d.p75} y1={0} y2={1} fill={chartColor(1)} fillOpacity={0.25} stroke="none" />
            <ReferenceLine x={d.p50} stroke={chartColor(1)} strokeWidth={2} label={{ value: "Median", fill: "hsl(var(--muted-foreground))", fontSize: 11, position: "insideTopLeft" }} />
            {priceVnd !== null ? <ReferenceLine x={priceVnd} stroke={chartColor(2)} strokeWidth={2} strokeDasharray="4 3" label={{ value: "This price", fill: "hsl(var(--foreground))", fontSize: 11, position: "insideTopRight" }} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {percentile !== null ? `Higher than ${percentile}% of comparables` : "No price to compare"} · p10 {formatVndCompact(d.p10)} – p90 {formatVndCompact(d.p90)} · {d.n} tin
      </p>
    </div>
  );
}
