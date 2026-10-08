// Coarse "is it worth an LLM call" prefilter. Pure, no I/O.
import { normalizeText } from "./normalize";
import type { RuleResult } from "./rules";

/**
 * `terms` is a caller-built set combining two kinds of members:
 *  - plain normalized text terms: enabled-Watch `include`/`includeAll`
 *    entries and every alias of items referenced by a Watch's `itemIds` --
 *    matched as a whole word against `textNormalized`.
 *  - Watch `categoryIds` (raw category UUIDs) -- matched by exact membership
 *    against `rule.categoryId`, not as text, so a classify hit only counts
 *    when its category is one a Watch actually cares about.
 *
 * True when `rule.categoryId` is a watched category id, or when any text
 * term is present as a whole word.
 */
export function prefilter(textNormalized: string, terms: Set<string>, rule: RuleResult): boolean {
  if (rule.hits.length > 0 && rule.categoryId !== null && terms.has(rule.categoryId)) return true;
  if (terms.size === 0) return false;

  const folded = normalizeText(textNormalized).folded;
  const padded = ` ${folded} `;
  for (const rawTerm of terms) {
    const term = normalizeText(rawTerm).folded;
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u");
    if (re.test(padded)) return true;
  }
  return false;
}
