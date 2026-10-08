// Alias-dictionary category/item classifier. Pure, no I/O.
import { normalizeText } from "./normalize";

export interface Category {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
}

export interface CatalogItem {
  id: string;
  categoryId: string;
  name: string;
  aliases: string[];
}

interface AliasEntry {
  alias: string; // folded, lowercase
  categoryId: string;
  itemId: string | null;
}

export interface AliasDict {
  entries: AliasEntry[];
}

export interface ClassifyResult {
  categoryId: string | null;
  itemId: string | null;
  confidence: number;
  hits: string[];
}

function foldAlias(text: string): string {
  return normalizeText(text).folded;
}

/** Builds a longest-alias-wins dictionary from categories (by name/slug) and catalog items (by name + aliases). */
export function buildAliasDict(categories: Category[], items: CatalogItem[]): AliasDict {
  const entries: AliasEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (rawAlias: string, categoryId: string, itemId: string | null) => {
    const alias = foldAlias(rawAlias);
    if (!alias) return;
    const key = `${alias}::${categoryId}::${itemId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ alias, categoryId, itemId });
  };

  for (const cat of categories) {
    addEntry(cat.name, cat.id, null);
    addEntry(cat.slug.replace(/-/g, " "), cat.id, null);
  }
  for (const item of items) {
    addEntry(item.name, item.categoryId, item.id);
    for (const alias of item.aliases) addEntry(alias, item.categoryId, item.id);
  }

  // Longest alias first so e.g. "iphone 15 pro max" wins over "iphone".
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return { entries };
}

function wordBoundaryRegex(alias: string): RegExp {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u");
}

/** Longest-alias-wins, whole-word classification. Item hit implies its category. */
export function classify(textNormalized: string, dict: AliasDict): ClassifyResult {
  const folded = foldAlias(textNormalized);
  const padded = ` ${folded} `;
  const hits: string[] = [];

  let best: AliasEntry | undefined;
  for (const entry of dict.entries) {
    if (wordBoundaryRegex(entry.alias).test(padded)) {
      hits.push(entry.alias);
      if (!best) best = entry;
    }
  }

  if (!best) return { categoryId: null, itemId: null, confidence: 0, hits: [] };

  const confidence = best.itemId ? 0.9 : 0.6;
  return { categoryId: best.categoryId, itemId: best.itemId, confidence, hits };
}
