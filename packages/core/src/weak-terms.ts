/**
 * Word lists for the language-dependent defaults: weak (low-signal) match terms and the
 * exclusion phrases suggested for "for sale" watches. A preset picks the built-in list; the
 * explicit config list (`match.weakTerms`, `watch.suggestExcludeSell`) adds extras on top.
 */

export type TermPreset = "en" | "vi" | "none";
export const TERM_PRESETS: readonly TermPreset[] = ["en", "vi", "none"];

/** Generic words that never count as product evidence when a watch decides whether a post matches. */
export const WEAK_TERM_PRESETS: { readonly en: readonly string[]; readonly vi: readonly string[] } = {
  en: [
    "for sale", "selling", "sell", "wanted", "buy", "price", "offer", "new", "used", "cheap",
    "contact", "pm", "dm", "obo", "shipping",
  ],
  vi: [
    "ban xe", "xe cu", "odo", "so tu dong", "so san", "can ban", "ban", "mua", "xe", "oto", "o to", "gia",
    "thanh ly", "pass", "lien he", "chinh chu", "zin", "full do", "bao test",
  ],
};

/** Phrases proposed as exclusions so buyers posing as sellers stay out of the results. */
export const SUGGEST_EXCLUDE_PRESETS: { readonly en: readonly string[]; readonly vi: readonly string[] } = {
  en: ["wtb", "want to buy", "looking to buy", "looking for"],
  vi: ["thu mua", "cầm đồ", "cần mua", "tìm mua"],
};

function union(preset: unknown, lists: { readonly en: readonly string[]; readonly vi: readonly string[] }, custom: readonly string[] | null | undefined): string[] {
  const base = preset === "vi" ? lists.vi : preset === "none" ? [] : lists.en;
  return [...new Set([...base, ...(custom ?? [])])];
}

/** Union (order kept, de-duplicated) of the preset list and the explicit custom list. Unknown presets act as "en". */
export function resolveWeakTerms({ preset, custom }: { preset?: unknown; custom?: readonly string[] | null }): string[] {
  return union(preset, WEAK_TERM_PRESETS, custom);
}

export function resolveSuggestExclude({ preset, custom }: { preset?: unknown; custom?: readonly string[] | null }): string[] {
  return union(preset, SUGGEST_EXCLUDE_PRESETS, custom);
}
