import type { CategoryTree, CompiledWatch, MatchInput, MatchResult } from "@feedhound/core/matcher";
import { resolveAllSchemas } from "@feedhound/core/attributes";
import { compileWatch, matchPost, watchFromRow } from "@feedhound/core/matcher";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { dailyIndex, loadAppTz } from "./watch-stats";

const BATCH_SIZE = 500;
// an unbounded scan (OFFSET paging + accumulating
// every match in memory before truncating) let a hunter with a large corpus
// / broad watch DoS the request. Cap total rows scanned per call and keep
// only the current top-`limit` results in memory throughout the scan.
const MAX_SCANNED_ROWS = 20_000;

export interface WatchTestResultPost {
  postId: string;
  title: string | null;
  url: string;
  sourceId: string;
  postedAt: string | null;
  score: number;
  matchedTerms: string[];
  /** Latest enrichment price, null when unknown (preview samples). */
  priceVnd: number | null;
}

export interface WatchTestResult {
  posts: WatchTestResultPost[];
  /** Every match found in the scanned window (not capped by `limit`). */
  total: number;
  /** Matches per `app.tz` day, `ceil(hours / 24)` entries, oldest first, summing to `total`. */
  daily: number[];
  /** Set when the `MAX_SCANNED_ROWS` cap was hit before
   * the whole `since` window was scanned — the result may be missing older
   * matching posts within the window. */
  truncated: boolean;
}

const DEFAULT_TEXT_MAX_CHARS = 20_000;

async function loadTextMaxChars(handle: DbHandle): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "match.textMaxChars"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "number" ? row.value : DEFAULT_TEXT_MAX_CHARS;
}

/** Loads `category(id) -> ltree path`, used to compile a watch's category filters. */
async function loadCategoryTree(handle: DbHandle) {
  const rows = await handle.db
    .select({ id: schema.category.id, path: schema.category.path, attributeSchema: schema.category.attributeSchema })
    .from(schema.category);
  const catTree: CategoryTree = new Map(rows.map((r) => [r.id, r.path]));
  return { catTree, attrSchemas: resolveAllSchemas(rows) };
}

/**
 * `/test` ignores `enabled`, `mutedUntil`, `quietHours` —
 * `matchPost` itself gates on those, so we run the term/enrichment logic
 * directly against a single compiled watch with those gates neutralised.
 */
function matchPostIgnoringGates(input: MatchInput, compiled: CompiledWatch, textMaxChars: number): MatchResult[] {
  const neutralised: CompiledWatch = { ...compiled, enabled: true, mutedUntil: null };
  return matchPost(input, [neutralised], new Date(), textMaxChars);
}

/**
 * `/api/watches/:id/test` compiles the stored watch
 * in-process, scans Posts with `firstSeenAt >= now - hours` (left join
 * latest Enrichment revision) in batches of `BATCH_SIZE`, and returns up to
 * `limit` results ordered by score desc then postedAt desc. Read-only:
 * inserts no rows, enqueues no jobs; ignores `enabled`/`mutedUntil`/`quietHours`,
 * honours `sourceIds`. Always scoped to `teamId`'s posts, even when `sourceIds` is empty
 * (see `effectiveSourceIds` below).
 *
 * The scan used to page by `post.id asc`. `post.id` is a
 * random `uuid` (`defaultRandom()`), so paging by it visits posts in an
 * effectively arbitrary order unrelated to time — a `MAX_SCANNED_ROWS` cap
 * hit mid-scan then returned an arbitrary slice of the `since` window rather
 * than its most recent posts. Pages by `postedAt desc, id desc` instead
 * (`id` only breaks ties for posts sharing a `postedAt`, including null
 * `postedAt` which sorts last), and reports `truncated: true` when the cap
 * is hit before the whole window was scanned.
 */
export async function testWatch(
  handle: DbHandle,
  watch: typeof schema.watch.$inferSelect,
  hours: number,
  limit: number,
  teamId: string,
  now: Date = new Date(),
): Promise<WatchTestResult> {
  const { catTree, attrSchemas } = await loadCategoryTree(handle);
  const compiled = compileWatch(watchFromRow(watch), catTree, attrSchemas);
  const textMaxChars = await loadTextMaxChars(handle);
  const tz = await loadAppTz(handle);
  const dayCount = Math.ceil(hours / 24);
  const daily = new Array<number>(dayCount).fill(0);
  let total = 0;
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  // This predicate used to be gated on `watch.sourceIds.length > 0`, so
  // `sourceIds: []` (any watch/draft) fell through to an unscoped scan of every team's
  // posts. `effectiveSourceIds` is always non-empty-safe and always team-scoped: the
  // watch's own sourceIds when set (already validated team-owned by the caller), else
  // every sourceId belonging to `teamId` — applied unconditionally below, never bypassable
  // by an empty list.
  const teamSourceRows = await handle.db.select({ id: schema.source.id }).from(schema.source).where(eq(schema.source.teamId, teamId));
  const effectiveSourceIds = watch.sourceIds.length > 0 ? watch.sourceIds : teamSourceRows.map((r) => r.id);

  // Latest enrichment revision per post ("left join Enrichment").
  const latestEnrichment = handle.db
    .selectDistinctOn([schema.enrichment.postId], {
      postId: schema.enrichment.postId,
      intent: schema.enrichment.intent,
      priceVnd: schema.enrichment.priceVnd,
      categoryId: schema.enrichment.categoryId,
      itemId: schema.enrichment.itemId,
      attributes: schema.enrichment.attributes,
    })
    .from(schema.enrichment)
    .orderBy(schema.enrichment.postId, desc(schema.enrichment.revision))
    .as("latest_enrichment");

  let results: WatchTestResultPost[] = [];
  let scanned = 0;
  let truncated = false;
  // Keyset cursor on `(postedAt desc, id desc)` — a compound row-value cursor
  // so paging visits posts newest-first (see doc comment above); `epoch` is
  // substituted for a null `postedAt` on both sides of the comparison so
  // nulls sort last consistently regardless of Postgres's default NULLS
  // FIRST/LAST for DESC.
  let cursor: { postedAt: Date; id: string } | undefined;
  for (;;) {
    const whereClauses = [gte(schema.post.firstSeenAt, since), inArray(schema.post.sourceId, effectiveSourceIds)];
    if (cursor) {
      whereClauses.push(
        sql`(coalesce(${schema.post.postedAt}, 'epoch'::timestamptz), ${schema.post.id}) < (${cursor.postedAt}, ${cursor.id})`,
      );
    }

    const rows = await handle.db
      .select({
        id: schema.post.id,
        sourceId: schema.post.sourceId,
        title: schema.post.title,
        url: schema.post.url,
        textNormalized: schema.post.textNormalized,
        postedAt: schema.post.postedAt,
        firstSeenAt: schema.post.firstSeenAt,
        enrIntent: latestEnrichment.intent,
        enrPriceVnd: latestEnrichment.priceVnd,
        enrCategoryId: latestEnrichment.categoryId,
        enrItemId: latestEnrichment.itemId,
        enrAttributes: latestEnrichment.attributes,
      })
      .from(schema.post)
      .leftJoin(latestEnrichment, eq(latestEnrichment.postId, schema.post.id))
      .where(and(...whereClauses))
      .orderBy(desc(sql`coalesce(${schema.post.postedAt}, 'epoch'::timestamptz)`), desc(schema.post.id))
      .limit(BATCH_SIZE);

    for (const row of rows) {
      const enrichment =
        row.enrIntent !== null || row.enrPriceVnd !== null || row.enrCategoryId !== null || row.enrItemId !== null
          ? {
              intent: row.enrIntent as "sell" | "buy" | "other" | null,
              priceVnd: row.enrPriceVnd,
              categoryId: row.enrCategoryId,
              itemId: row.enrItemId,
              attributes: row.enrAttributes ?? {},
            }
          : undefined;

      const matches = matchPostIgnoringGates(
        { post: { id: row.id, sourceId: row.sourceId, textNormalized: row.textNormalized }, enrichment },
        compiled,
        textMaxChars,
      );
      const m = matches[0];
      if (!m) continue;
      total++;
      const dayIdx = dailyIndex(row.firstSeenAt, now, tz, dayCount);
      daily[dayIdx] = (daily[dayIdx] ?? 0) + 1;
      results.push({
        priceVnd: row.enrPriceVnd,
        postId: row.id,
        title: row.title,
        url: row.url,
        sourceId: row.sourceId,
        postedAt: row.postedAt ? row.postedAt.toISOString() : null,
        score: m.score,
        matchedTerms: m.matchedTerms,
      });
    }

    scanned += rows.length;
    const lastRow = rows[rows.length - 1];
    if (lastRow) cursor = { postedAt: lastRow.postedAt ?? new Date(0), id: lastRow.id };

    // Truncate to the current top-`limit` after every batch instead of
    // accumulating every match for the whole scan — bounds memory use
    // regardless of how many posts in the corpus match.
    if (results.length > limit) {
      results.sort(sortByScoreThenPostedAtDesc);
      results = results.slice(0, limit);
    }

    if (rows.length < BATCH_SIZE) break;
    if (scanned >= MAX_SCANNED_ROWS) {
      // A full last batch landing exactly on the cap
      // (e.g. scanned == MAX_SCANNED_ROWS with nothing left in the `since`
      // window) is not actually truncated. Probe for one more row past the
      // cursor before reporting `truncated: true`.
      truncated = await hasMoreRows(handle, since, effectiveSourceIds, cursor);
      break;
    }
  }

  results.sort(sortByScoreThenPostedAtDesc);

  return { posts: results.slice(0, limit), total, daily, truncated };
}

/**
 * Probes for a single row past `cursor` within the same
 * `since`/`sourceIds` window, so hitting `MAX_SCANNED_ROWS` on a batch that
 * exactly exhausts the window is not misreported as `truncated: true`.
 */
async function hasMoreRows(
  handle: DbHandle,
  since: Date,
  sourceIds: string[],
  cursor: { postedAt: Date; id: string } | undefined,
): Promise<boolean> {
  const whereClauses = [gte(schema.post.firstSeenAt, since), inArray(schema.post.sourceId, sourceIds)];
  if (cursor) {
    whereClauses.push(
      sql`(coalesce(${schema.post.postedAt}, 'epoch'::timestamptz), ${schema.post.id}) < (${cursor.postedAt}, ${cursor.id})`,
    );
  }
  const [row] = await handle.db
    .select({ id: schema.post.id })
    .from(schema.post)
    .where(and(...whereClauses))
    .limit(1);
  return row !== undefined;
}

function sortByScoreThenPostedAtDesc(a: WatchTestResultPost, b: WatchTestResultPost): number {
  if (b.score !== a.score) return b.score - a.score;
  const ap = a.postedAt ? Date.parse(a.postedAt) : 0;
  const bp = b.postedAt ? Date.parse(b.postedAt) : 0;
  return bp - ap;
}
