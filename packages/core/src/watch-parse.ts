// Maps a (validated) LLM watch-parse output onto real ids. Pure: no I/O.

import { canonFilter, checkFilter, type AttributeFilter, type AttributeSchema } from "./attributes";
import { normalizeText } from "./normalize";

const MAX_NAME_LEN = 80;
const MAX_TERMS_PER_LIST = 50;
const MAX_TERM_LEN = 64;
const MAX_FILTERS = 10;
const MAX_WARNINGS = 20;

/** Structural view of `@feedhound/llm`'s `WatchParseOutput` (core must not depend on llm). */
export interface WatchParseOutputLike {
  name: string;
  categorySlugs: string[];
  itemNames: string[];
  include: string[];
  exclude: string[];
  intents: ("sell" | "buy" | "other")[];
  priceMinVnd: number | null;
  priceMaxVnd: number | null;
  attributeFilters: AttributeFilter[];
}

/**
 * The watch fields a parse can fill (`watchInputObjectSchema` subset). Lists are always present (empty when
 * unknown); `priceMin`/`priceMax` are omitted when unknown so the draft can be POSTed as-is.
 */
export interface WatchDraft {
  name: string;
  include: string[];
  includeAll: string[];
  exclude: string[];
  categoryIds: string[];
  itemIds: string[];
  intents: ("sell" | "buy" | "other")[];
  priceMin?: number;
  priceMax?: number;
  attributeFilters: AttributeFilter[];
}

export interface DraftLookups {
  categories: { id: string; slug: string }[];
  items: { id: string; name: string; aliases: string[]; categoryId: string }[];
  /** Resolved (inherited) attribute schema per category id. */
  schemas: Map<string, AttributeSchema>;
}

function fold(s: string): string {
  return normalizeText(s).folded;
}

/** Trims, drops empty / over-long terms, dedupes by folded form, caps the list. */
function cleanTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    const len = normalizeText(t).nfc.length;
    if (len < 1 || len > MAX_TERM_LEN) continue;
    const key = fold(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TERMS_PER_LIST) break;
  }
  return out;
}

export function resolveDraft(out: WatchParseOutputLike, lookups: DraftLookups): { draft: WatchDraft; warnings: string[] } {
  const warnings: string[] = [];

  const bySlug = new Map(lookups.categories.map((c) => [c.slug, c.id]));
  const categoryIds: string[] = [];
  for (const slug of out.categorySlugs) {
    const id = bySlug.get(slug);
    if (!id) {
      warnings.push(`unknown category "${slug}"`);
      continue;
    }
    if (!categoryIds.includes(id)) categoryIds.push(id);
  }

  const byName = new Map<string, { id: string; categoryId: string }[]>();
  for (const item of lookups.items) {
    for (const key of new Set([fold(item.name), ...item.aliases.map(fold)])) {
      const list = byName.get(key) ?? [];
      list.push({ id: item.id, categoryId: item.categoryId });
      byName.set(key, list);
    }
  }
  const itemIds: string[] = [];
  const itemCategoryIds = new Set<string>();
  const unmatchedNames: string[] = [];
  for (const name of out.itemNames) {
    const candidates = byName.get(fold(name)) ?? [];
    const hit = candidates.find((c) => categoryIds.includes(c.categoryId)) ?? candidates[0];
    if (!hit) {
      unmatchedNames.push(name);
      continue;
    }
    if (!itemIds.includes(hit.id)) itemIds.push(hit.id);
    itemCategoryIds.add(hit.categoryId);
  }

  const attributeFilters: AttributeFilter[] = [];
  for (const f of out.attributeFilters) {
    if (attributeFilters.length >= MAX_FILTERS) break;
    const filterCategoryIds = [...new Set([...categoryIds, ...itemCategoryIds])];
    const def = filterCategoryIds.map((id) => lookups.schemas.get(id)?.find((d) => d.key === f.key)).find((d) => d !== undefined);
    if (!def) {
      warnings.push(`dropped filter "${f.key}": not defined for the selected categories`);
      continue;
    }
    const reason = checkFilter(def, f);
    if (reason) {
      warnings.push(`dropped filter "${f.key}": ${reason}`);
      continue;
    }
    attributeFilters.push(canonFilter(def, f));
  }

  let priceMin = out.priceMinVnd ?? undefined;
  let priceMax = out.priceMaxVnd ?? undefined;
  if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
    warnings.push("dropped price range: minimum is above maximum");
    priceMin = undefined;
    priceMax = undefined;
  }

  const draft: WatchDraft = {
    name: out.name.trim().slice(0, MAX_NAME_LEN) || "New watch",
    include: cleanTerms([...unmatchedNames, ...out.include]),
    includeAll: [],
    exclude: cleanTerms(out.exclude),
    categoryIds,
    itemIds,
    intents: [...new Set(out.intents)],
    attributeFilters,
  };
  if (priceMin !== undefined) draft.priceMin = priceMin;
  if (priceMax !== undefined) draft.priceMax = priceMax;
  return { draft, warnings: warnings.slice(0, MAX_WARNINGS) };
}
