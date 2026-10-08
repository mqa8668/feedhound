// Pure matching engine (packages/core/src/matcher.ts). No I/O: the
// watch index (compiled watches) and category tree are passed in by the
// caller (apps/agent/src/watch-index.ts).

import { attributeFilterSchema, evalFilter, type AttributeDef, type AttributeFilter, type AttributeSchema, type Attributes } from "./attributes";
import type { PriceQualifier } from "./price";
import type { EnrichmentDto, PostDto, WatchDto } from "./types";
import { normalizeText } from "./normalize";
import type { QuietHours } from "./watch";
import { compileCached, type SafeRegex } from "./regex-cache";
import { createLogger } from "./logger";
import { resolveWeakTerms } from "./weak-terms";

const log = createLogger({ service: "matcher" });

// DB rows (postgres-js/drizzle) return `Date` for timestamp columns while the
// API-facing `WatchDto` serializes them as ISO strings; `compileWatch` /
// `matchPost` accept either so callers can pass a raw DB row directly.
export type Watch = Omit<WatchDto, "mutedUntil" | "createdAt" | "attributeFilters"> & {
  /** Absent on callers without attribute data = no attribute predicates. */
  attributeFilters?: AttributeFilter[];
  mutedUntil: string | Date | null;
  createdAt: string | Date;
};

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** `categoryId -> ltree path` (e.g. `"electronics.phones"`). */
export type CategoryTree = Map<string, string>;

interface CompiledTermList {
  /** Original term text (for `matchedTerms` reporting), parallel to `regexes`. */
  terms: string[];
  regexes: RegExp[];
  /** Per-term class, parallel to `regexes`. */
  kinds: TermKind[];
}

/** `weak` terms never count as product evidence; `itemId` pins a term to one catalogue item. */
interface TermKind {
  weak: boolean;
  itemId: string | null;
}

/**
 * Default weak terms (`match.weakTermsPreset` "en" plus `match.weakTerms`, see weak-terms.ts): generic words that never count as product
 * evidence. Resolved with `resolveWeakTerms`.
 */
export const DEFAULT_WEAK_TERMS: readonly string[] = resolveWeakTerms({ preset: "en", custom: [] });

/** Folded term sets the caller derives from Config, the taxonomy, the schemas and the catalogue. */
export interface MatchContext {
  weakTerms: Set<string>;
  itemByAlias: Map<string, string>;
  /** Folded hint terms per category, used to infer a watch's implied category. */
  categoryHints?: { categoryId: string; terms: Set<string> }[];
}

export interface CompiledWatch extends Watch {
  compiled: {
    include: RegExp[];
    includeAll: RegExp[];
    includeKinds: TermKind[];
    includeAllKinds: TermKind[];
    exclude: RegExp[];
    // The `regex` field is untrusted (hunter-supplied): matched with `RE2`
    // (linear-time, immune to catastrophic backtracking), never JS `RegExp`.
    regex?: SafeRegex;
    /**
     * Precomputed from `CategoryTree` at compile time: the set of category
     * ids (self + every descendant, per ltree path prefix) that satisfy this
     * watch's `categoryIds` filter. Named `categoryPaths`  Interface; holds resolved ids (not raw path strings) so `matchPost`
     * can check `enrichment.categoryId` membership in O(1) without needing
     * the category tree itself (matchPost stays pure/I-O-free).
     */
    categoryPaths: Set<string>;
    /** Category ids (self + descendants) inferred from terms/name when no explicit category is set. */
    impliedCategoryIds: Set<string>;
    hasEnrichmentFilter: boolean;
    /** Attribute predicates with their defs; `def` undefined = key absent from every schema (never matches). */
    attributeFilters: { filter: AttributeFilter; def: AttributeDef | undefined }[];
  };
  // Implementation detail beyond the documented `compiled` shape: original term
  // text per compiled regex, needed to report `matchedTerms` with the terms
  // as the hunter wrote them.
  includeTerms: string[];
  includeAllTerms: string[];
}

export interface MatchInput {
  post: Pick<PostDto, "id" | "sourceId" | "textNormalized">;
  enrichment?: Pick<EnrichmentDto, "intent" | "priceVnd" | "categoryId" | "itemId"> & {
    attributes?: Attributes;
    /** Absent/null = exact. */
    priceQualifier?: PriceQualifier | null;
    priceMaxVnd?: number | null;
  };
  /** The source group's region (override > auto > source default); null when unknown/any. */
  sourceRegion?: string | null;
}

export interface MatchResult {
  watchId: string;
  score: number;
  matchedTerms: string[];
}

/** Mirrors `match.textMaxChars` default (config/defaults.yaml). Callers that
 * load the real config value should truncate `post.textNormalized` before
 * calling `matchPost`; this is a defensive fallback cap only. */
const DEFAULT_TEXT_MAX_CHARS = 20_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTermList(terms: string[], ctx?: MatchContext): CompiledTermList {
  const kinds: TermKind[] = [];
  const regexes = terms.map((term) => {
    const folded = normalizeText(term).folded;
    kinds.push({ weak: ctx?.weakTerms.has(folded) ?? false, itemId: ctx?.itemByAlias.get(folded) ?? null });
    const escaped = escapeRegExp(folded);
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u");
  });
  return { terms, regexes, kinds };
}

/** A pattern that never matches; used when a stored `watch.regex` fails to
 * compile (should not happen — `validateRegex` runs at write time — but this
 * keeps matching fail-closed instead of throwing or silently ignoring the
 * filter). */
const NEVER_MATCHES: SafeRegex = { test: () => false, source: "" };

// Untrusted, hunter-supplied pattern: compiled with `RE2` (linear-time),
// never JS `RegExp`, so no post text can trigger catastrophic backtracking
// at match time regardless of what shape the stored regex has. Routed
// through the shared `compileCached` cache (regex-cache.ts) so recompiling
// the same watch on every `WatchIndex.reload()` allocates no new wasm heap
// (re2-wasm never frees it) — the leak that previously bricked the agent
// after ~20 regex watches and ~80 minutes of reloads.
function compileRegexField(src: string | null): SafeRegex | undefined {
  if (!src) return undefined;
  const compiled = compileCached(src, "iu");
  if (!compiled.ok) {
    log.error({ src }, "matcher: regex compile failed at watch-index reload, watch will never match on regex");
    return NEVER_MATCHES;
  }
  return compiled.re;
}

/** Category ids (self + descendants) that satisfy `categoryIds`, resolved via `cat`'s ltree paths. */
function resolveCategoryDescendants(categoryIds: string[], cat: CategoryTree): Set<string> {
  const watchPaths = categoryIds.map((id) => cat.get(id)).filter((p): p is string => p !== undefined);
  const out = new Set<string>();
  for (const [id, path] of cat) {
    if (watchPaths.some((wp) => path === wp || path.startsWith(`${wp}.`))) out.add(id);
  }
  return out;
}

/**
 * The category a category-less watch implies, from its terms and name. Scores each category by the
 * hint terms found (whole-word) in the watch's folded terms/name; only a unique best score wins.
 */
function inferImpliedCategory(w: Watch, hints: NonNullable<MatchContext["categoryHints"]>): string | null {
  const haystack = [...w.include, ...w.includeAll, w.name].map((t) => ` ${normalizeText(t).folded} `).join("|");
  let best: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const { categoryId, terms } of hints) {
    let score = 0;
    for (const t of terms) if (t !== "" && haystack.includes(` ${t} `)) score++;
    if (score > bestScore) {
      best = categoryId;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) tie = true;
  }
  return tie ? null : best;
}

/** Never matches: stands in for stored `attribute_filters` that no longer parse (fail closed). */
const UNMATCHABLE_FILTER: AttributeFilter = { key: "__invalid__", op: "eq", value: "x" };

/** Typed view of a DB watch row (`attribute_filters` is jsonb); unparsable filters make the watch unmatchable. */
export function watchFromRow<T extends { attributeFilters: unknown }>(row: T): Omit<T, "attributeFilters"> & { attributeFilters: AttributeFilter[] } {
  const parsed = attributeFilterSchema.array().safeParse(row.attributeFilters);
  return { ...row, attributeFilters: parsed.success ? parsed.data : [UNMATCHABLE_FILTER] };
}

/** Compiles a stored `Watch` into a `CompiledWatch` ready for `matchPost`. */
export function compileWatch(
  w: Watch,
  cat: CategoryTree,
  schemas?: Map<string, AttributeSchema>,
  ctx?: MatchContext,
): CompiledWatch {
  const include = compileTermList(w.include, ctx);
  const includeAll = compileTermList(w.includeAll, ctx);
  const exclude = compileTermList(w.exclude);

  const hasEnrichmentFilter =
    w.categoryIds.length > 0 ||
    w.itemIds.length > 0 ||
    w.priceMin !== null ||
    w.priceMax !== null ||
    (w.attributeFilters?.length ?? 0) > 0 ||
    w.intents.length > 0;

  const attributeFilters = (w.attributeFilters ?? []).map((filter) => {
    let def: AttributeDef | undefined;
    for (const id of w.categoryIds) {
      def = schemas?.get(id)?.find((d) => d.key === filter.key);
      if (def) break;
    }
    // A region filter falls back to any schema that declares `region`.
    if (!def && filter.key === "region" && schemas) {
      for (const schema of schemas.values()) {
        def = schema.find((d) => d.key === "region");
        if (def) break;
      }
    }
    return { filter, def };
  });

  const implied =
    w.categoryIds.length === 0 && ctx?.categoryHints ? inferImpliedCategory(w, ctx.categoryHints) : null;

  return {
    ...w,
    includeTerms: include.terms,
    includeAllTerms: includeAll.terms,
    compiled: {
      include: include.regexes,
      includeAll: includeAll.regexes,
      includeKinds: include.kinds,
      includeAllKinds: includeAll.kinds,
      exclude: exclude.regexes,
      regex: compileRegexField(w.regex),
      categoryPaths: resolveCategoryDescendants(w.categoryIds, cat),
      impliedCategoryIds: implied ? resolveCategoryDescendants([implied], cat) : new Set<string>(),
      hasEnrichmentFilter,
      attributeFilters,
    },
  };
}

/** `HH:MM` wall-clock time of `now` in `tz`. */
function wallClockTime(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

/**
 * `{start, end}` in `tz`; `start > end` wraps midnight;
 * `start == end` -> never quiet; minute precision, inclusive start, exclusive end.
 */
export function isQuiet(q: QuietHours | null | undefined, now: Date, tz: string): boolean {
  if (!q) return false;
  if (q.start === q.end) return false;
  const current = wallClockTime(now, tz);
  if (q.start < q.end) return current >= q.start && current < q.end;
  return current >= q.start || current < q.end; // wraps midnight
}

/** Does the post's price interval intersect the watch's [priceMin, priceMax]? */
function priceGatePasses(watch: Watch, e: NonNullable<MatchInput["enrichment"]>): boolean {
  if (e.priceVnd === null || e.priceVnd === undefined) return false;
  const v = e.priceVnd;
  let lo = v;
  let hi = v;
  let loOpen = false;
  if (e.priceQualifier === "floor") {
    hi = Infinity;
    loOpen = true;
  } else if (e.priceQualifier === "ceiling") {
    lo = 0;
  } else if (e.priceQualifier === "range") {
    hi = e.priceMaxVnd ?? v;
  }
  const pmin = watch.priceMin ?? 0;
  const pmax = watch.priceMax ?? Infinity;
  const low = Math.max(lo, pmin);
  const high = Math.min(hi, pmax);
  const open = loOpen && low === lo;
  return low < high || (low === high && !open);
}

function enrichmentFiltersPass(
  compiled: CompiledWatch["compiled"],
  watch: Watch,
  enrichment: MatchInput["enrichment"],
  sourceRegion: string | null | undefined,
): boolean {
  if (!compiled.hasEnrichmentFilter) return true;
  if (!enrichment) return false; // skip, not reject, when enrichment absent

  if (watch.categoryIds.length > 0) {
    if (!enrichment.categoryId || !compiled.categoryPaths.has(enrichment.categoryId)) return false;
  }
  if (watch.itemIds.length > 0) {
    if (!enrichment.itemId || !watch.itemIds.includes(enrichment.itemId)) return false;
  }
  if (watch.priceMin !== null || watch.priceMax !== null) {
    if (!priceGatePasses(watch, enrichment)) return false;
  }
  for (const { filter, def } of compiled.attributeFilters) {
    // A post without the attribute fails, same as a price filter on a post without price.
    // The post's region falls back to its source group's region.
    const value =
      filter.key === "region"
        ? (enrichment.attributes?.region ?? sourceRegion ?? undefined)
        : enrichment.attributes?.[filter.key];
    if (!def || !evalFilter(def, filter, value)) return false;
  }
  if (watch.intents.length > 0) {
    if (!enrichment.intent || !watch.intents.includes(enrichment.intent)) return false;
  }
  return true;
}

/**
 * Matches one post/enrichment against every compiled watch ( * behaviour rules 2-7). O(watches) per call, each watch O(terms); no I/O.
 * `textMaxChars`: callers that have loaded the live
 * `match.textMaxChars` Config value should pass it through here instead of
 * relying on the hardcoded fallback — `matchPost` itself stays pure/no-I/O,
 * the caller (`apps/agent/src/jobs/match.ts`) does the Config read.
 */
export function matchPost(
  input: MatchInput,
  index: CompiledWatch[],
  now: Date,
  textMaxChars: number = DEFAULT_TEXT_MAX_CHARS,
): MatchResult[] {
  const text = normalizeText(input.post.textNormalized.slice(0, textMaxChars)).folded;
  const results: MatchResult[] = [];

  for (const w of index) {
    if (!w.enabled) continue;
    if (w.mutedUntil && toDate(w.mutedUntil) > now) continue;
    if (w.sourceIds.length > 0 && !w.sourceIds.includes(input.post.sourceId)) continue;
    if (!enrichmentFiltersPass(w.compiled, w, input.enrichment, input.sourceRegion)) continue;

    const matchedSet = new Set<string>();
    const postItemId = input.enrichment?.itemId ?? null;
    // An item-pinned hit counts only when the post's item is unknown or that item.
    const counted = (k: TermKind | undefined): boolean => !k?.itemId || postItemId === null || postItemId === k.itemId;
    let evidence = false;

    let includeOk = w.compiled.include.length === 0;
    w.compiled.include.forEach((re, i) => {
      const kind = w.compiled.includeKinds[i];
      if (re.test(text) && counted(kind)) {
        includeOk = true;
        matchedSet.add(w.includeTerms[i] ?? "");
        if (!kind?.weak) evidence = true;
      }
    });
    if (!includeOk) continue;

    let includeAllOk = true;
    const includeAllHits: string[] = [];
    w.compiled.includeAll.forEach((re, i) => {
      const kind = w.compiled.includeAllKinds[i];
      if (re.test(text) && counted(kind)) {
        includeAllHits.push(w.includeAllTerms[i] ?? "");
        if (!kind?.weak) evidence = true;
      } else includeAllOk = false;
    });
    if (!includeAllOk) continue;
    for (const t of includeAllHits) matchedSet.add(t);

    if (w.compiled.exclude.some((re) => re.test(text))) continue;

    let regexHit = false;
    if (w.compiled.regex) {
      if (!w.compiled.regex.test(text)) continue;
      regexHit = true;
    }

    // Weak hits alone never match; a gate (items/categories) or a regex-only watch is evidence.
    const hasTermFilters = w.compiled.include.length > 0 || w.compiled.includeAll.length > 0;
    if (w.itemIds.length > 0 || w.categoryIds.length > 0) evidence = true;
    if (regexHit && !hasTermFilters && w.categoryIds.length === 0 && w.itemIds.length === 0) evidence = true;
    // A weak-only hit suffices when the post's category equals the explicit-or-implied category.
    const postCat = input.enrichment?.categoryId;
    if (!evidence && postCat && w.compiled.impliedCategoryIds.has(postCat)) evidence = true;
    if (!evidence) continue;

    const termScore = matchedSet.size + (regexHit ? 1 : 0);
    const itemBonus = w.itemIds.length > 0 ? 1.5 : 0;
    const priceBonus = w.priceMin !== null || w.priceMax !== null ? 0.5 : 0;
    const attrBonus = (w.attributeFilters?.length ?? 0) > 0 ? 0.5 : 0;
    const score = 1.0 * termScore + itemBonus + priceBonus + attrBonus;

    const matchedTerms = [...matchedSet];
    if (regexHit && w.regex) matchedTerms.push(`regex:${w.regex}`);

    results.push({ watchId: w.id, score, matchedTerms });
  }

  return results;
}
