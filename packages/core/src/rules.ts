// Cheap rule pipeline: price + intent + condition + alias classification. Pure, no I/O.
import type { AliasDict } from "./classify";
import { classify } from "./classify";
import type { Condition } from "./condition";
import { detectCondition } from "./condition";
import { detectIntent, type Intent } from "./intent";
import { isPhoneShapedPrice, MASKED_PRICE_CONFIDENCE_CAP, MAX_PRICE_VND, parsePrice, type PriceQualifier } from "./price";

export { MASKED_PRICE_CONFIDENCE_CAP };

export interface RuleResult {
  intent: Intent;
  priceVnd: number | null;
  priceRaw: string | null;
  /** True when `priceVnd` is a lower bound from a masked price (e.g. `5x.000.000`), not an exact amount. */
  priceMasked: boolean;
  /** How the seller wrote the amount; null when `priceVnd` is null. */
  priceQualifier: PriceQualifier | null;
  priceMaxVnd: number | null;
  /** 0 when `priceVnd` is null. */
  priceConfidence: number;
  condition: Condition;
  categoryId: string | null;
  itemId: string | null;
  confidence: number;
  hits: string[];
}

const PRICE_MIN_VND = 1_000;
const PRICE_MAX_VND = MAX_PRICE_VND;

/** Out-of-range guard on rule-derived prices. */
function guardPrice(priceVnd: number | null): number | null {
  if (priceVnd === null) return null;
  if (priceVnd <= PRICE_MIN_VND || priceVnd >= PRICE_MAX_VND) return null;
  return priceVnd;
}

export function runRules(
  post: { text: string; textNormalized: string },
  dict: AliasDict,
): RuleResult {
  const intentResult = detectIntent(post.textNormalized);
  const condition = detectCondition(post.textNormalized);
  const priceParsed = parsePrice(post.text || post.textNormalized);
  const classifyResult = classify(post.textNormalized, dict);

  const priceVnd = guardPrice(priceParsed.priceVnd);
  const priceMasked = priceVnd !== null && priceParsed.masked === true;
  const baseConfidence = Math.min(intentResult.confidence, classifyResult.confidence);

  return {
    intent: intentResult.intent,
    priceVnd,
    priceRaw: priceVnd !== null || isPhoneShapedPrice(priceParsed.priceRaw) ? priceParsed.priceRaw : null,
    priceMasked,
    priceQualifier: priceVnd === null ? null : priceParsed.qualifier,
    priceMaxVnd: priceVnd === null ? null : priceParsed.maxVnd,
    priceConfidence: priceVnd === null ? 0 : priceParsed.confidence,
    condition,
    categoryId: classifyResult.categoryId,
    itemId: classifyResult.itemId,
    confidence: priceMasked ? Math.min(baseConfidence, MASKED_PRICE_CONFIDENCE_CAP) : baseConfidence,
    hits: classifyResult.hits,
  };
}
