// Pure sell/buy/other intent classifier for Vietnamese marketplace text. No I/O.

export type Intent = "sell" | "buy" | "other";

export interface IntentResult {
  intent: Intent;
  confidence: number;
}

const BUY_PATTERNS = [
  /\bcần mua\b/,
  /\bcan mua\b/,
  /\btìm mua\b/,
  /\btim mua\b/,
  /\bmuốn mua\b/,
  /\bmuon mua\b/,
  /\bhỏi mua\b/,
  /\bhoi mua\b/,
  /\bwant to buy\b/,
  /\bwtb\b/,
  /\bthu mua\b/,
];

/** Phrases that mention "mua" but are a seller addressing buyers, not a buy cue. */
const NOT_BUY_RE =
  /\b(?:ai (?:cần|can) mua|ai (?:có|co) nhu (?:cầu|cau)|(?:người|nguoi) mua|(?:khách|khach) mua)\b/g;

/** Position of the earliest match among `patterns`, or Infinity. */
function earliest(patterns: RegExp[], text: string): number {
  let best = Infinity;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m.index < best) best = m.index;
  }
  return best;
}

const SELL_PATTERNS = [
  /\bcần bán\b/,
  /\bcan ban\b/,
  /\bthanh lý\b/,
  /\bthanh ly\b/,
  /\bbán gấp\b/,
  /\bban gap\b/,
  /\bra đi\b/,
  /\bra di\b/,
  /\bcho e ban\b/,
  /\bfor sale\b/,
  /\bwts\b/,
  /\bbán\b/,
  /\bban\b/,
];

/**
 * Runs against `textNormalized` (lowercased, whitespace-collapsed; diacritics
 * may or may not be present). The earliest-positioned buy or sell cue wins, so
 * "cần bán Kia, ai cần mua ib" is a sale. A bare "mua" is a weak buy fallback.
 */
export function detectIntent(textNormalized: string): IntentResult {
  const text = textNormalized.toLowerCase().replace(NOT_BUY_RE, (m) => " ".repeat(m.length));

  const buyAt = earliest(BUY_PATTERNS, text);
  const sellAt = earliest(SELL_PATTERNS, text);
  if (buyAt < sellAt) return { intent: "buy", confidence: 0.9 };
  if (sellAt < Infinity) return { intent: "sell", confidence: 0.9 };
  if (/\bmua\b/.test(text)) return { intent: "buy", confidence: 0.55 };

  return { intent: "other", confidence: 0.5 };
}
