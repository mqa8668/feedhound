import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeText } from "./normalize";
import { AUTHOR_REF_RE } from "./pii";

// Corpus search parameters, query grammar, cursor, and the search -> watch mapping.

export const SEARCH_MAX_TOKENS = 10;
export const SEARCH_MIN_TOKEN_LEN = 2;
const MAX_Q_LEN = 200;
const DEFAULT_LIMIT = 25;
const HARD_LIMIT_MAX = 100;

export const SEARCH_SORTS = ["relevance", "newest", "price_asc", "price_desc"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO date" });

export const searchParamsSchema = z.object({
  q: z.string().max(MAX_Q_LEN).optional(),
  sourceIds: z.array(z.string().uuid()).max(100).optional(),
  categoryIds: z.array(z.string().uuid()).max(100).optional(),
  itemIds: z.array(z.string().uuid()).max(100).optional(),
  intents: z.array(z.enum(["sell", "buy", "other"])).max(3).optional(),
  priceMin: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  priceMax: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  author: z.string().regex(AUTHOR_REF_RE).optional(),
  sort: z.enum(SEARCH_SORTS).optional(),
  limit: z.number().int().min(1).max(HARD_LIMIT_MAX).default(DEFAULT_LIMIT),
  cursor: z.string().max(2000).optional(),
});
export type SearchParams = z.infer<typeof searchParamsSchema>;

/** Params a saved search stores: no paging state. */
export const savedSearchParamsSchema = searchParamsSchema.omit({ cursor: true, limit: true }).strict();
export type SavedSearchParams = z.infer<typeof savedSearchParamsSchema>;

const NUMERIC_KEYS = new Set(["priceMin", "priceMax", "limit"]);
const ARRAY_KEYS = new Set(["sourceIds", "categoryIds", "itemIds", "intents"]);

/**
 * Builds SearchParams input from a URL query (`name -> values[]`, repeated keys = arrays; `a,b` is also split).
 * Unknown keys are ignored; empty values are dropped.
 */
export function searchParamsFromQuery(queries: Record<string, string[]>): z.ZodSafeParseResult<SearchParams> {
  const raw: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(queries)) {
    const vals = values.filter((v) => v !== "");
    if (vals.length === 0) continue;
    if (ARRAY_KEYS.has(key)) raw[key] = vals.flatMap((v) => v.split(",")).filter((v) => v !== "");
    else if (NUMERIC_KEYS.has(key)) raw[key] = Number(vals[0]);
    else raw[key] = vals[0];
  }
  return searchParamsSchema.safeParse(raw);
}

export interface QueryTerm {
  /** NFC lowercase text, quotes/`-` removed (accents kept). */
  text: string;
  phrase: boolean;
  negate: boolean;
}

const TOKEN_RE = /-?"[^"]*"?|\S+/g;

/**
 * Grammar: whitespace tokens; `"..."` phrase; `-term` / `-"..."` exclude; <= 10 tokens; tokens < 2 chars dropped.
 * A run of >= 2 adjacent unquoted positive tokens that are each <= 2 chars (folded), such as
 * `ô tô`, becomes one phrase so the pieces do not match unrelated words ("to", "o").
 */
export function parseQuery(q: string | undefined): QueryTerm[] {
  if (!q) return [];
  const out: QueryTerm[] = [];
  let run: QueryTerm[] = [];
  const flush = (): void => {
    if (run.length >= 2) out.push({ text: run.map((t) => t.text).join(" "), phrase: true, negate: false });
    else for (const t of run) if (t.text.length >= SEARCH_MIN_TOKEN_LEN) out.push(t);
    run = [];
  };
  let seen = 0;
  for (const raw of q.match(TOKEN_RE) ?? []) {
    if (seen >= SEARCH_MAX_TOKENS) break;
    seen++;
    let tok = raw;
    let negate = false;
    if (tok.startsWith("-") && tok.length > 1) {
      negate = true;
      tok = tok.slice(1);
    }
    const phrase = tok.startsWith('"');
    if (phrase) tok = tok.replace(/^"/, "").replace(/"$/, "");
    const text = normalizeText(tok.replaceAll('"', " ")).nfc;
    if (text.length === 0) continue;
    const term: QueryTerm = { text, phrase, negate };
    if (!phrase && !negate && normalizeText(text).folded.length <= 2) {
      run.push(term);
      continue;
    }
    flush();
    if (text.length >= SEARCH_MIN_TOKEN_LEN) out.push(term);
  }
  flush();
  return out;
}

export function effectiveSort(p: Pick<SearchParams, "q" | "sort">): SearchSort {
  return p.sort ?? (p.q && p.q.trim() ? "relevance" : "newest");
}

function canonical(p: SearchParams): string {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(p).sort()) {
    if (key === "cursor" || key === "limit") continue;
    const v = (p as Record<string, unknown>)[key];
    if (v === undefined) continue;
    body[key] = Array.isArray(v) ? [...v].sort() : v;
  }
  body.sort = effectiveSort(p);
  return JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** First 16 hex chars of sha256 over the canonical params (without cursor/limit). */
export function paramsHash(p: SearchParams): string {
  return createHash("sha256").update(canonical(p)).digest("hex").slice(0, 16);
}

export interface SearchCursor {
  v: 1;
  /** params hash */
  h: string;
  /** ISO instant fixed at page 1 (recency reference). */
  at: string;
  total: number;
  /** total was not capped */
  te: boolean;
  /** keyset: [score, effectiveAt, id] | [effectiveAt, id] | [priceVnd, effectiveAt, id]; effectiveAt is a PG timestamptz text. */
  k: (string | number)[];
}

export function encodeCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PG_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const uuidCheck = z.string().uuid();

/** True when `k` has the keyset shape for `sort` (number/timestamp/uuid positions); guards the SQL casts. */
export function cursorKeysValid(sort: SearchSort, k: (string | number)[]): boolean {
  const ts = (v: unknown): boolean => typeof v === "string" && PG_TS_RE.test(v) && !Number.isNaN(Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")));
  const id = (v: unknown): boolean => uuidCheck.safeParse(v).success;
  const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  if (sort === "newest") return k.length === 2 && ts(k[0]) && id(k[1]);
  return k.length === 3 && num(k[0]) && ts(k[1]) && id(k[2]);
}

const cursorSchema = z.object({
  v: z.literal(1),
  h: z.string().length(16),
  at: z.string().regex(ISO_INSTANT_RE).refine((s) => !Number.isNaN(Date.parse(s))),
  total: z.number().int().min(0),
  te: z.boolean(),
  k: z.array(z.union([z.string(), z.number()])).min(2).max(3),
});

/** `undefined` for any malformed cursor. */
export function decodeCursor(raw: string): SearchCursor | undefined {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface WatchFromSearch {
  includeAll: string[];
  exclude: string[];
  categoryIds: string[];
  itemIds: string[];
  priceMin?: number;
  priceMax?: number;
  intents: ("sell" | "buy" | "other")[];
  sourceIds: string[];
}

export type SearchToWatch = { ok: true; watch: WatchFromSearch; dropped: string[] } | { ok: false; reason: string };

/** `author`, `from`, `to`, `sort` have no watch equivalent and are reported in `dropped`. */
export function searchParamsToWatch(p: Pick<SearchParams, "q" | "sourceIds" | "categoryIds" | "itemIds" | "intents" | "priceMin" | "priceMax" | "author" | "from" | "to" | "sort">): SearchToWatch {
  const terms = parseQuery(p.q);
  const watch: WatchFromSearch = {
    includeAll: terms.filter((t) => !t.negate).map((t) => t.text),
    exclude: terms.filter((t) => t.negate).map((t) => t.text),
    categoryIds: p.categoryIds ?? [],
    itemIds: p.itemIds ?? [],
    intents: p.intents ?? [],
    sourceIds: p.sourceIds ?? [],
  };
  if (p.priceMin !== undefined) watch.priceMin = p.priceMin;
  if (p.priceMax !== undefined) watch.priceMax = p.priceMax;
  if (watch.includeAll.length === 0 && watch.categoryIds.length === 0 && watch.itemIds.length === 0) {
    return { ok: false, reason: "a watch needs at least one positive term, category or item" };
  }
  const dropped: string[] = [];
  if (p.author) dropped.push("author");
  if (p.from) dropped.push("from");
  if (p.to) dropped.push("to");
  if (p.sort) dropped.push("sort");
  return { ok: true, watch, dropped };
}
