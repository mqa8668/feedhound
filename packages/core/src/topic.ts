import type { SearchParams } from "./search-query";

// Intent tags carried on every enrichment row.
export const INTENT_TAGS = ["buy", "sell", "ask", "complain", "review"] as const;

/** Tags a rule-only post gets from its `intent` (no LLM call, so no sentiment). */
export function ruleIntentTags(intent: "sell" | "buy" | "other" | null): string[] {
  if (intent === "sell") return ["sell"];
  if (intent === "buy") return ["buy"];
  return [];
}

// ---- topics + spikes ----
export type TopicParams = Omit<SearchParams, "sourceIds" | "author" | "from" | "to" | "sort" | "cursor" | "limit">;

const TOPIC_DROPPED_KEYS = ["sourceIds", "author", "from", "to", "sort"] as const;

/**
 * Snapshot of a saved search for a topic: topics span all team sources and all time,
 * so source/author/date/sort filters are dropped and reported back in `dropped`.
 */
export function searchParamsToTopic(p: SearchParams): { params: TopicParams; dropped: string[] } {
  const dropped: string[] = [];
  for (const k of TOPIC_DROPPED_KEYS) {
    const v = p[k];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    dropped.push(k);
  }
  const params: TopicParams = {};
  if (p.q !== undefined && p.q !== "") params.q = p.q;
  if (p.categoryIds?.length) params.categoryIds = p.categoryIds;
  if (p.itemIds?.length) params.itemIds = p.itemIds;
  if (p.intents?.length) params.intents = p.intents;
  if (p.priceMin !== undefined) params.priceMin = p.priceMin;
  if (p.priceMax !== undefined) params.priceMax = p.priceMax;
  return { params, dropped };
}

export interface SpikeConfig {
  minVolume: number;
  ratioMin: number;
  zMin: number;
}

export interface SpikeVerdict {
  spike: boolean;
  count: number;
  mean: number;
  sd: number;
  ratio: number;
  z: number;
  explain: string;
}

/** Daily spike rule: population mean/sd, both floored to 1 in the denominators. */
export function detectSpike(count: number, baseline: number[], cfg: SpikeConfig): SpikeVerdict {
  const n = baseline.length;
  const mean = n === 0 ? 0 : baseline.reduce((a, b) => a + b, 0) / n;
  const sd = n === 0 ? 0 : Math.sqrt(baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const ratio = count / Math.max(mean, 1);
  const z = (count - mean) / Math.max(sd, 1);
  const spike = count >= cfg.minVolume && ratio >= cfg.ratioMin && z >= cfg.zMin;
  const explain = `${count} posts vs 7-day avg ${mean.toFixed(1)} (${ratio.toFixed(1)}×, z ${z.toFixed(1)})`;
  return { spike, count, mean, sd, ratio, z, explain };
}
