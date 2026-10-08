// Pure helpers behind the deal decision UI (verdict text, distribution, watch fit, compare highlights).

import { evalFilter, renderValue, type AttributeFilter, type AttributeSchema, type Attributes } from "./attributes";
import { formatVndCompact } from "./listing";
import type { PriceQualifier } from "./price";

export interface PriceDistribution {
  n: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

type Confidence = "high" | "medium" | "low";

/** Linear-interpolated quantile (R type 7) over an ascending-sorted array, as `deal.ts`. */
function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[lo + 1] ?? a;
  return a + (pos - lo) * (b - a);
}

/** Untrimmed quantiles; `null` when fewer than `minPeers` positive prices. */
export function priceDistribution(prices: readonly number[], minPeers: number): PriceDistribution | null {
  const s = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (s.length === 0 || s.length < minPeers) return null;
  const q = (x: number): number => Math.round(quantile(s, x));
  return { n: s.length, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9) };
}

/** Share (0-100) of `prices` strictly below `price`; `null` when `prices` is empty. */
export function percentileOf(price: number, prices: readonly number[]): number | null {
  if (prices.length === 0) return null;
  return Math.round((100 * prices.filter((p) => p < price).length) / prices.length);
}

const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "high", medium: "medium", low: "low" };

export function verdictText(i: {
  pct: number | null;
  n: number;
  minPeers: number;
  noun: "car" | "listing";
  qualifier: PriceQualifier | null;
  priceVnd: number | null;
  confidence?: Confidence | null;
}): string {
  if (i.priceVnd === null) return "No price";
  let text: string;
  if (i.pct === null || i.n < i.minPeers) text = `Not enough comparable listings to judge the price (${i.n} found)`;
  else if (i.pct <= -1) text = `${Math.round(Math.abs(i.pct))}% cheaper than ${i.n} comparable ${i.noun}${i.n === 1 ? "" : "s"}`;
  else if (i.pct >= 1) text = `${Math.round(i.pct)}% pricier than ${i.n} comparable ${i.noun}${i.n === 1 ? "" : "s"}`;
  else text = `At market price (${i.n} comparable ${i.noun}${i.n === 1 ? "" : "s"})`;
  if (i.qualifier !== null && i.qualifier !== "exact") text += " · price not exact";
  if (i.confidence) text += `, ${CONFIDENCE_LABEL[i.confidence]} confidence`;
  return text;
}

export interface FitItem {
  label: string;
  status: "ok" | "fail" | "unknown";
}

const INTENT_LABEL: Record<string, string> = { sell: "selling", buy: "buying", other: "other" };
const OP_SYMBOL: Record<AttributeFilter["op"], string> = { eq: "=", in: "∈", gte: "≥", lte: "≤" };

/** One item per criterion the watch sets, evaluated against the post. */
export function watchFit(
  w: { priceMin: number | null; priceMax: number | null; intents: string[]; attributeFilters: AttributeFilter[] },
  p: { priceVnd: number | null; priceSuspect: boolean; qualifier: PriceQualifier | null; intent: string | null; attributes: Attributes },
  schema: AttributeSchema,
): FitItem[] {
  const items: FitItem[] = [];
  const priceUsable = p.priceVnd !== null && !p.priceSuspect;
  const price = p.priceVnd ?? 0;
  if (w.priceMin !== null) {
    let status: FitItem["status"] = "unknown";
    if (priceUsable) {
      if (p.qualifier === "floor") status = price >= w.priceMin ? "ok" : "unknown";
      else if (p.qualifier === "ceiling") status = price < w.priceMin ? "fail" : "unknown";
      else status = price >= w.priceMin ? "ok" : "fail";
    }
    items.push({ label: `Price ≥ ${formatVndCompact(w.priceMin)}`, status });
  }
  if (w.priceMax !== null) {
    let status: FitItem["status"] = "unknown";
    if (priceUsable) {
      if (p.qualifier === "floor") status = price > w.priceMax ? "fail" : "unknown";
      else if (p.qualifier === "ceiling") status = price <= w.priceMax ? "ok" : "unknown";
      else status = price <= w.priceMax ? "ok" : "fail";
    }
    items.push({ label: `Price ≤ ${formatVndCompact(w.priceMax)}`, status });
  }
  if (w.intents.length > 0) {
    const label = `Listing type: ${w.intents.map((x) => INTENT_LABEL[x] ?? x).join(", ")}`;
    items.push({ label, status: p.intent === null ? "unknown" : w.intents.includes(p.intent) ? "ok" : "fail" });
  }
  for (const f of w.attributeFilters) {
    const def = schema.find((d) => d.key === f.key);
    const label = def?.label ?? f.key;
    const shown = (v: string | number): string => (def ? renderValue(def, v) : String(v));
    const vals = f.op === "in" ? (f.values ?? []).map(shown).join(", ") : f.value === undefined ? "" : shown(f.value);
    const value = p.attributes[f.key];
    const status: FitItem["status"] = !def || value === undefined ? "unknown" : evalFilter(def, f, value) ? "ok" : "fail";
    items.push({ label: `${label} ${OP_SYMBOL[f.op]} ${vals}`, status });
  }
  return items;
}

/** Indexes holding the best non-null value (ties all returned); empty when every value is null. */
export function bestIndexes(values: (number | null)[], better: "low" | "high"): number[] {
  let best: number | null = null;
  for (const v of values) if (v !== null && (best === null || (better === "low" ? v < best : v > best))) best = v;
  if (best === null) return [];
  const out: number[] = [];
  values.forEach((v, i) => {
    if (v === best) out.push(i);
  });
  return out;
}

export type Capabilities = { listing: boolean; dealV2: boolean; risk: boolean; seller: boolean };

/** Slice 1: none of the 042-045 data is wired in yet. */
export const NO_CAPABILITIES: Capabilities = { listing: false, dealV2: false, risk: false, seller: false };
