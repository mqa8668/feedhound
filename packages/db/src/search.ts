import {
  cursorKeysValid,
  decodeCursor,
  effectiveSort,
  encodeCursor,
  paramsHash,
  parseQuery,
  type QueryTerm,
  type SearchCursor,
  type SearchParams,
} from "@feedhound/core/search-query";
import { normalizeText } from "@feedhound/core/normalize";
import { sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "./index";
import { loadPiiSalt, resolveAuthorRef } from "./pii";

// Corpus search over `post` (+ `enrichment`). The predicate builder is exported so other queries can reuse it.

export interface SearchConfig {
  candidateLimit: number;
  exportMaxRows: number;
  recencyWeight: number;
  recencyTauDays: number;
  trgmMinLen: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  candidateLimit: 20000,
  exportMaxRows: 10000,
  recencyWeight: 0.5,
  recencyTauDays: 7,
  trgmMinLen: 3,
};

const J = (parts: SQL[], sep: SQL): SQL => sql.join(parts, sep);

function lexemeParts(s: string, unicode: boolean): string[] {
  return s
    .split(unicode ? /[^\p{L}\p{N}]+/u : /[^a-z0-9]+/)
    .filter((x) => x !== "");
}

interface TermForms {
  fold: string;
  parts: string[];
  compact: string;
}

function forms(term: QueryTerm): TermForms {
  const fold = normalizeText(term.text).folded;
  return { fold, parts: lexemeParts(fold, false), compact: fold.replace(/[^a-z0-9]/g, "") };
}

/** `tsv @@ <term tsquery>`; `undefined` when the term has no indexable lexeme. */
function termTsquery(term: QueryTerm, f: TermForms, mode: "rank" | "head"): SQL | undefined {
  if (f.parts.length === 0) return undefined;
  if (term.phrase) {
    return sql`phraseto_tsquery('simple', ${f.fold})`;
  }
  // Short digit-only terms match whole lexemes only (a prefix would probe digits of a masked phone)
  // Parts of <= 2 chars are exact lexemes ("to" must not prefix-match "toyota")
  const sfx = rawSubstringAllowed(f.compact) ? ":*" : "";
  const withSfx = (p: string): string => (p.length > 2 ? `${p}${sfx}` : p);
  const folded = f.parts.map(withSfx).join(" & ");
  if (mode === "head") {
    // headline runs on the accented text: also look for the accented spelling
    const nfcParts = lexemeParts(term.text, true);
    const nfc = nfcParts.map(withSfx).join(" & ");
    if (nfc !== "" && nfc !== folded) return sql`(to_tsquery('simple', ${folded}) || to_tsquery('simple', ${nfc}))`;
  }
  return sql`to_tsquery('simple', ${folded})`;
}

/** A digit-only term may use the raw substring path only as a complete 9-11 digit phone (no prefix oracle). */
function rawSubstringAllowed(compact: string): boolean {
  return !/^\d+$/.test(compact) || (compact.length >= 9 && compact.length <= 11);
}

/** Predicate for one term, over alias `p` (post). `undefined` when the term cannot match anything indexable. */
function termPredicate(term: QueryTerm, trgmMinLen: number): SQL | undefined {
  const f = forms(term);
  const legs: SQL[] = [];
  const tsq = termTsquery(term, f, "rank");
  if (tsq) legs.push(sql`p.tsv @@ ${tsq}`);
  // A compact substring of short pieces ("o to" -> "oto") matches unrelated words; need real length
  const compactOk = f.parts.every((p) => p.length >= 3) || f.compact.length >= 6;
  if (f.compact.length >= trgmMinLen && compactOk && rawSubstringAllowed(f.compact)) legs.push(sql`p.text_compact LIKE ${`%${f.compact}%`}`);
  if (legs.length === 0) return undefined;
  return legs.length === 1 ? legs[0] : sql`(${J(legs, sql` OR `)})`;
}

/** AND of the positive terms' tsqueries (rank or headline form); `undefined` if there are none. */
function positiveTsquery(terms: QueryTerm[], mode: "rank" | "head"): SQL | undefined {
  const parts: SQL[] = [];
  for (const t of terms) {
    if (t.negate) continue;
    const q = termTsquery(t, forms(t), mode);
    if (q) parts.push(q);
  }
  return parts.length === 0 ? undefined : J(parts, sql` && `);
}

function uuidList(ids: string[]): SQL {
  return J(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** True when the params restrict on enrichment columns (such rows must have an enrichment). */
function needsEnrichment(p: SearchParams): boolean {
  const sort = effectiveSort(p);
  return Boolean(
    p.categoryIds?.length ||
      p.itemIds?.length ||
      p.intents?.length ||
      p.priceMin !== undefined ||
      p.priceMax !== undefined ||
      sort === "price_asc" ||
      sort === "price_desc",
  );
}

/**
 * WHERE predicate (without the cursor keyset) for the search params, scoped to `teamId`.
 * Requires `FROM post p LEFT JOIN enrichment e ON e.post_id = p.id`. Reused by the topic queries.
 */
/** Raw author ids / names behind an `author` pseudonym ref; see `resolveAuthorRef`. */
export interface AuthorMatch {
  ids: string[];
  names: string[];
}

function textList(vals: string[]): SQL {
  return J(
    vals.map((v) => sql`${v}`),
    sql`, `,
  );
}

export function buildSearchPredicate(
  p: SearchParams,
  teamId: string,
  cfg: Pick<SearchConfig, "trgmMinLen"> = DEFAULT_SEARCH_CONFIG,
  author?: AuthorMatch,
): SQL {
  const conds: SQL[] = [sql`p.source_id IN (SELECT s.id FROM source s WHERE s.team_id = ${teamId}::uuid)`];
  for (const t of parseQuery(p.q)) {
    const pred = termPredicate(t, cfg.trgmMinLen);
    if (!pred) continue;
    // coalesce keeps rows with NULL text_compact for exclude terms (index-friendly positive legs stay bare)
    conds.push(t.negate ? sql`NOT coalesce(${pred}, false)` : pred);
  }
  if (p.sourceIds?.length) conds.push(sql`p.source_id IN (${uuidList(p.sourceIds)})`);
  if (p.categoryIds?.length) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM category c JOIN category sel ON sel.id IN (${uuidList(p.categoryIds)}) AND c.path <@ sel.path
      WHERE c.id = e.category_id)`);
  }
  if (p.itemIds?.length) conds.push(sql`e.item_id IN (${uuidList(p.itemIds)})`);
  if (p.intents?.length) conds.push(sql`e.intent IN (${J(p.intents.map((i) => sql`${i}`), sql`, `)})`);
  if (p.priceMin !== undefined) conds.push(sql`e.price_vnd >= ${p.priceMin}`);
  if (p.priceMax !== undefined) conds.push(sql`e.price_vnd <= ${p.priceMax}`);
  if (p.from) conds.push(sql`p.effective_at >= ${new Date(p.from).toISOString()}::timestamptz`);
  if (p.to) conds.push(sql`p.effective_at < ${new Date(p.to).toISOString()}::timestamptz`);
  if (p.author) {
    const legs: SQL[] = [];
    if (author?.ids.length) legs.push(sql`p.author_id IN (${textList(author.ids)})`);
    if (author?.names.length) legs.push(sql`(p.author_id IS NULL AND p.author_name IN (${textList(author.names)}))`);
    conds.push(legs.length ? sql`(${J(legs, sql` OR `)})` : sql`false`);
  }
  const sort = effectiveSort(p);
  if (sort === "price_asc" || sort === "price_desc") conds.push(sql`e.price_vnd IS NOT NULL`);
  else if (needsEnrichment(p)) conds.push(sql`e.post_id IS NOT NULL`);
  return J(conds, sql` AND `);
}

export interface SearchHit {
  id: string;
  sourceId: string;
  sourceName: string;
  url: string;
  authorName: string | null;
  authorId: string | null;
  title: string | null;
  snippet: string;
  postedAt: string | null;
  firstSeenAt: string;
  editCount: number;
  capture: string | null;
  media: unknown[];
  enrichment: { intent: string | null; priceVnd: number | null; priceQualifier: string | null; priceMaxVnd: number | null; categoryId: string | null; itemId: string | null; confidence: number | null; sentiment: string | null; intentTags: string[] } | null;
  matchCount: number;
  score: number;
  // only with `full: true` (CSV export)
  text?: string;
  categoryName?: string | null;
  itemName?: string | null;
}

export interface SearchPage {
  items: SearchHit[];
  nextCursor: string | null;
  total: number;
  totalIsExact: boolean;
  candidatesTruncated: boolean;
}

export type SearchResult = { ok: true; page: SearchPage } | { ok: false; error: "invalid_cursor" | "cursor_params_mismatch" };

interface Row extends Record<string, unknown> {
  id: string;
  source_id: string;
  source_name: string;
  url: string;
  author_name: string | null;
  author_id: string | null;
  title: string | null;
  edit_count: number;
  capture: string | null;
  media: unknown;
  posted_at: string | null;
  first_seen_at: string;
  eff_text: string;
  score: number | null;
  price: number | null;
  has_enr: boolean;
  intent: string | null;
  price_vnd: number | null;
  price_qualifier: string | null;
  price_max_vnd: number | null;
  category_id: string | null;
  item_id: string | null;
  confidence: number | null;
  sentiment: string | null;
  intent_tags: string[] | null;
  match_count: number;
  headline: string | null;
  plain: string;
  cand_n: number | null;
  full_text: string | null;
  category_name: string | null;
  item_name: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toSnippet(headline: string | null, plain: string): string {
  if (headline?.includes("<mark>")) {
    // ts_headline ran on text whose <, >, & were already escaped in SQL; only <mark> tags are markup.
    return headline;
  }
  return escapeHtml(plain.slice(0, 200));
}

const ESC_TEXT = sql`replace(replace(replace(p.text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;

interface Keyset {
  where: SQL | undefined;
  order: SQL;
}

function keyset(sort: ReturnType<typeof effectiveSort>, cursor: SearchCursor | undefined, ref: { eff: SQL; id: SQL; price: SQL; score: SQL }): Keyset {
  const k = cursor?.k ?? [];
  const tail = (i: number): SQL => sql`(${ref.eff}, ${ref.id}) < (${String(k[i])}::timestamptz, ${String(k[i + 1])}::uuid)`;
  switch (sort) {
    case "relevance":
      return {
        where: cursor ? sql`(${ref.score}, ${ref.eff}, ${ref.id}) < (${Number(k[0])}::float8, ${String(k[1])}::timestamptz, ${String(k[2])}::uuid)` : undefined,
        order: sql`${ref.score} DESC, ${ref.eff} DESC, ${ref.id} DESC`,
      };
    case "newest":
      return { where: cursor ? tail(0) : undefined, order: sql`${ref.eff} DESC, ${ref.id} DESC` };
    case "price_asc":
      return {
        where: cursor ? sql`(${ref.price} > ${Number(k[0])}::float8 OR (${ref.price} = ${Number(k[0])}::float8 AND ${tail(1)}))` : undefined,
        order: sql`${ref.price} ASC, ${ref.eff} DESC, ${ref.id} DESC`,
      };
    case "price_desc":
      return {
        where: cursor ? sql`(${ref.price} < ${Number(k[0])}::float8 OR (${ref.price} = ${Number(k[0])}::float8 AND ${tail(1)}))` : undefined,
        order: sql`${ref.price} DESC, ${ref.eff} DESC, ${ref.id} DESC`,
      };
  }
}

export interface SearchOptions {
  /** Include `text`, `categoryName`, `itemName` (CSV export). */
  full?: boolean;
}

/**
 * Runs one page of the corpus search for `teamId`. Pure SQL, no side effects. Returns an error result for a
 * malformed cursor or one issued for different params.
 */
export async function searchPosts(
  handle: DbHandle,
  p: SearchParams,
  teamId: string,
  cfg: SearchConfig = DEFAULT_SEARCH_CONFIG,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const sort = effectiveSort(p);
  const terms = parseQuery(p.q);
  let cursor: SearchCursor | undefined;
  if (p.cursor) {
    cursor = decodeCursor(p.cursor);
    if (!cursor) return { ok: false, error: "invalid_cursor" };
    if (cursor.h !== paramsHash(p)) return { ok: false, error: "cursor_params_mismatch" };
    if (!cursorKeysValid(sort, cursor.k)) return { ok: false, error: "invalid_cursor" };
  }
  const at = cursor?.at ?? new Date().toISOString();
  const hash = paramsHash(p);
  const author = p.author ? await resolveAuthorRef(handle, teamId, await loadPiiSalt(handle), p.author) : undefined;
  const pred = buildSearchPredicate(p, teamId, cfg, author);
  const n = p.limit;

  const rankTsq = positiveTsquery(terms, "rank");
  const headTsq = positiveTsquery(terms, "head");
  const recency = sql`${cfg.recencyWeight}::float8 * exp(-greatest(extract(epoch FROM (${at}::timestamptz - p.effective_at)) / 86400.0, 0) / ${cfg.recencyTauDays}::float8)`;
  const score = rankTsq ? sql`(ts_rank_cd(p.tsv, ${rankTsq}, 32)::float8 + ${recency})` : recency;

  const from = sql`FROM post p LEFT JOIN enrichment e ON e.post_id = p.id`;
  let pageCte: SQL;
  if (sort === "relevance") {
    const ks = keyset(sort, cursor, { eff: sql`effective_at`, id: sql`id`, price: sql`price`, score: sql`score` });
    pageCte = sql`
      cand AS MATERIALIZED (
        SELECT p.id, p.effective_at, ${score} AS score, e.price_vnd AS price ${from}
        WHERE ${pred} ORDER BY p.effective_at DESC, p.id DESC LIMIT ${cfg.candidateLimit}
      ),
      pg AS MATERIALIZED (
        SELECT id, effective_at, score, price, (SELECT count(*)::int FROM cand) AS cand_n FROM cand
        ${ks.where ? sql`WHERE ${ks.where}` : sql``} ORDER BY ${ks.order} LIMIT ${n + 1}
      )`;
  } else {
    const ks = keyset(sort, cursor, { eff: sql`p.effective_at`, id: sql`p.id`, price: sql`e.price_vnd`, score: sql`0` });
    pageCte = sql`
      pg AS MATERIALIZED (
        SELECT p.id, p.effective_at, 0::float8 AS score, e.price_vnd AS price, NULL::int AS cand_n ${from}
        WHERE ${pred}${ks.where ? sql` AND ${ks.where}` : sql``} ORDER BY ${ks.order} LIMIT ${n + 1}
      )`;
  }
  const outerOrder =
    sort === "relevance"
      ? sql`pg.score DESC, pg.effective_at DESC, pg.id DESC`
      : sort === "newest"
        ? sql`pg.effective_at DESC, pg.id DESC`
        : sort === "price_asc"
          ? sql`pg.price ASC, pg.effective_at DESC, pg.id DESC`
          : sql`pg.price DESC, pg.effective_at DESC, pg.id DESC`;
  const headline = headTsq
    ? sql`ts_headline('simple', ${ESC_TEXT}, ${headTsq}, 'MaxWords=30, MinWords=12, StartSel=<mark>, StopSel=</mark>')`
    : sql`NULL::text`;
  const iso = (col: string): SQL => sql.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

  const rows = await handle.db.execute<Row>(sql`
    WITH ${pageCte}
    SELECT p.id, p.source_id, s.name AS source_name, p.url, p.author_name, p.author_id, p.title, p.edit_count, p.capture, p.media,
      ${iso("p.posted_at")} AS posted_at, ${iso("p.first_seen_at")} AS first_seen_at, pg.effective_at::text AS eff_text,
      pg.score, pg.price, pg.cand_n, (e.post_id IS NOT NULL) AS has_enr, e.intent, e.price_vnd, e.price_qualifier, e.price_max_vnd, e.category_id, e.item_id, e.confidence, e.sentiment, e.intent_tags,
      (SELECT count(*)::int FROM match m WHERE m.post_id = p.id) AS match_count,
      ${headline} AS headline, left(p.text, 200) AS plain,
      ${opts.full ? sql`p.text` : sql`NULL::text`} AS full_text,
      ${opts.full ? sql`(SELECT c.name FROM category c WHERE c.id = e.category_id)` : sql`NULL::text`} AS category_name,
      ${opts.full ? sql`(SELECT ci.name FROM catalog_item ci WHERE ci.id = e.item_id)` : sql`NULL::text`} AS item_name
    FROM pg JOIN post p ON p.id = pg.id JOIN source s ON s.id = p.source_id LEFT JOIN enrichment e ON e.post_id = p.id
    ORDER BY ${outerOrder}`);

  const list = Array.from(rows);
  const pageRows = list.slice(0, n);
  const items = pageRows.map((r): SearchHit => {
    const hit: SearchHit = {
      id: r.id,
      sourceId: r.source_id,
      sourceName: r.source_name,
      url: r.url,
      authorName: r.author_name,
      authorId: r.author_id,
      title: r.title,
      snippet: toSnippet(r.headline, r.plain),
      postedAt: r.posted_at,
      firstSeenAt: r.first_seen_at,
      editCount: r.edit_count,
      capture: r.capture,
      media: Array.isArray(r.media) ? r.media.slice(0, 3) : [],
      enrichment: r.has_enr ? { intent: r.intent, priceVnd: r.price_vnd, priceQualifier: r.price_qualifier, priceMaxVnd: r.price_max_vnd, categoryId: r.category_id, itemId: r.item_id, confidence: r.confidence, sentiment: r.sentiment, intentTags: r.intent_tags ?? [] } : null,
      matchCount: r.match_count,
      score: sort === "relevance" ? Number(r.score ?? 0) : 0,
    };
    if (opts.full) {
      hit.text = r.full_text ?? "";
      hit.categoryName = r.category_name;
      hit.itemName = r.item_name;
    }
    return hit;
  });

  let total: number;
  let totalIsExact: boolean;
  if (cursor) {
    total = cursor.total;
    totalIsExact = cursor.te;
  } else {
    const cap = cfg.exportMaxRows + 1;
    const [c] = await handle.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM (SELECT 1 ${from} WHERE ${pred} LIMIT ${cap}) t`);
    const n0 = c?.n ?? 0;
    totalIsExact = n0 < cap;
    total = n0;
  }

  let nextCursor: string | null = null;
  const last = pageRows[pageRows.length - 1];
  if (list.length > n && last) {
    const k: (string | number)[] =
      sort === "relevance"
        ? [Number(last.score ?? 0), last.eff_text, last.id]
        : sort === "newest"
          ? [last.eff_text, last.id]
          : [Number(last.price ?? 0), last.eff_text, last.id];
    nextCursor = encodeCursor({ v: 1, h: hash, at, total, te: totalIsExact, k });
  }
  const candN = list[0]?.cand_n ?? 0;
  return {
    ok: true,
    page: { items, nextCursor, total, totalIsExact, candidatesTruncated: sort === "relevance" && candN >= cfg.candidateLimit },
  };
}
