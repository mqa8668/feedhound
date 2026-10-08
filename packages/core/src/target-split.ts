import { parsePrice } from "./price";

export interface TargetSplit {
  /** Product words with the price phrase removed (original casing kept). */
  product: string;
  priceMin: number | null;
  priceMax: number | null;
}

const PRICE_PHRASE_RE =
  /\s*(dưới|duoi|không quá|khong qua|tối đa|toi da|<=|<|trên|tren|từ|tu|>=|>)\s*(\d[\d.,]*\s*(?:tr\d?|triệu|trieu|củ|nghìn|nghin|k|tỷ|tỉ|ty|đ|₫|vnd)?)\s*$/i;
const UPPER = new Set(["dưới", "duoi", "không quá", "khong qua", "tối đa", "toi da", "<=", "<"]);

/** Deterministic split of a hunt target such as "Honda City dưới 250tr" into product words and a price bound (no LLM). */
export function splitTarget(target: string): TargetSplit {
  const trimmed = target.normalize("NFC").trim();
  const m = PRICE_PHRASE_RE.exec(trimmed);
  if (!m) return { product: trimmed, priceMin: null, priceMax: null };
  const value = parsePrice(m[2] ?? "").priceVnd;
  const product = trimmed.slice(0, m.index).trim();
  if (value === null || product.length === 0) return { product: trimmed, priceMin: null, priceMax: null };
  const upper = UPPER.has((m[1] ?? "").toLowerCase());
  return { product, priceMin: upper ? null : value, priceMax: upper ? value : null };
}
