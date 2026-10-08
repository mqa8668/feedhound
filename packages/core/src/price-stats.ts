// Per-(item, day) price statistics with Tukey trimming.

export interface PriceStats {
  nRaw: number;
  n: number;
  median: number;
  p25: number;
  p75: number;
}

/** Linear-interpolated quantile (R type 7) over an ascending-sorted array. */
function quantile(sorted: readonly number[], q: number): number {
  const first = sorted[0];
  if (first === undefined) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const a = sorted[lo] ?? first;
  const b = sorted[lo + 1] ?? a;
  return a + (pos - lo) * (b - a);
}

/** `null` when no positive price remains. nRaw < 4 skips trimming. */
export function priceStats(prices: readonly number[]): PriceStats | null {
  const raw = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  const nRaw = raw.length;
  let kept = raw;
  if (nRaw >= 4) {
    const q1 = quantile(raw, 0.25);
    const q3 = quantile(raw, 0.75);
    const iqr = q3 - q1;
    kept = raw.filter((p) => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  }
  if (kept.length === 0) return null;
  return {
    nRaw,
    n: kept.length,
    median: Math.round(quantile(kept, 0.5)),
    p25: Math.round(quantile(kept, 0.25)),
    p75: Math.round(quantile(kept, 0.75)),
  };
}
