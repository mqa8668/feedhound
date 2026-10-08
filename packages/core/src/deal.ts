// Price vs. peer median ("deal score"). Pure.

import { priceStats } from "./price-stats";

export interface DealScore {
  medianVnd: number;
  n: number;
  /** Signed percent vs. the peer median, one decimal (negative = cheaper). */
  pct: number;
}

export const DEFAULT_MIN_PEERS = 5;

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[lo + 1] ?? a;
  return a + (pos - lo) * (b - a);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * `null` unless at least `minPeers` peers survive trimming. `priceStats` trims by IQR, which collapses on small
 * samples with repeated values, so trimming is skipped when the IQR is 0.
 */
export function dealScore(priceVnd: number, peerPrices: readonly number[], minPeers: number = DEFAULT_MIN_PEERS): DealScore | null {
  const raw = peerPrices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (raw.length < minPeers) return null;
  let median: number;
  let n: number;
  if (quantile(raw, 0.75) - quantile(raw, 0.25) === 0) {
    median = Math.round(quantile(raw, 0.5));
    n = raw.length;
  } else {
    const st = priceStats(raw);
    if (!st) return null;
    median = st.median;
    n = st.n;
  }
  if (n < minPeers || median <= 0) return null;
  return { medianVnd: median, n, pct: round1(((priceVnd - median) / median) * 100) };
}
