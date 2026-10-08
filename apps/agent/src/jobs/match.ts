import { isQuiet, matchPost as matchPostImpl } from "@feedhound/core/matcher";
import type { PriceQualifier } from "@feedhound/core/price";
import { matchJobSchema, notifyJobSchema, type QuietHours } from "@feedhound/core/watch";
import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { WatchIndex } from "../watch-index";
import { RETENTION_DEFAULTS } from "./retention";

const logger = createLogger({ service: "agent" });

const MATCH_QUEUE = "match";
const NOTIFY_QUEUE = "notify";

// No metrics exporter exists yet (same TODO as apps/api/src/services/corpus.ts
// `getEnrichEnqueueFailureCount`): "Prometheus counter `match_slow_total`"
// is implemented as this in-process counter, inspectable
// via `getMatchSlowCount`, until a real exporter lands.
let matchSlowCount = 0;
export function getMatchSlowCount(): number {
  return matchSlowCount;
}

async function fetchAppTz(handle: DbHandle): Promise<string> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "app.tz"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return (row?.value as string | undefined) ?? "Asia/Ho_Chi_Minh";
}

const DEFAULT_TEXT_MAX_CHARS = 20_000;

// `match.textMaxChars` (config/defaults.yaml) was
// never read — `matchPost`'s hardcoded fallback always won. `matchPost`
// stays pure/no-I/O, so the live value is loaded here and passed
// through, same pattern as `fetchAppTz` above.
async function fetchTextMaxChars(handle: DbHandle): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "match.textMaxChars"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "number" ? row.value : DEFAULT_TEXT_MAX_CHARS;
}

export interface RunMatchJobOptions {
  handle: DbHandle;
  boss: PgBoss;
  watchIndex: Pick<WatchIndex, "getForTeam">;
  postId: string;
  trigger: "ingest" | "enrich";
  now?: Date;
}

export interface RunMatchJobResult {
  watchesScanned: number;
  matched: number;
  notified: number;
}

/**
 * Loads Post (+ latest Enrichment when present),
 * runs `matchPost` against the current watch index, inserts Match rows with
 * `ON CONFLICT (postId, watchId) DO NOTHING` (idempotent), and enqueues
 * `notify` for every Match row (new or pre-existing) whose
 * `notifyEnqueuedAt` is still null.
 *
 * Insert and notify-enqueue are not run in one DB transaction spanning the
 * `boss.send` call (pg-boss sends are their own commit), so a naive
 * "only newly inserted rows notify" scheme silently loses a notification if
 * `boss.send` throws after the row was already committed: on retry,
 * `onConflictDoNothing` returns nothing for that row and it is never
 * considered again. Fixed via `match.notifyEnqueuedAt` (code review finding
 * 3): the notify decision is looked up per match row by that column instead
 * of by "was this the row I just inserted", so a retried job re-scans and
 * re-enqueues any of *its own* matches (new or pre-existing) still missing a
 * notify decision, and never re-enqueues once `notifyEnqueuedAt` is set.
 *
 * The original "read notifyEnqueuedAt, then send, then
 * update" sequence still raced — two overlapping `match` job runs for the
 * same post (e.g. an `ingest` and an `enrich` trigger landing close
 * together, or two retries) could both read `notifyEnqueuedAt: null` before
 * either had written it, and both would enqueue `notify`. The claim is now
 * atomic: `UPDATE match SET notifyEnqueuedAt = now() WHERE id = $1 AND
 * notifyEnqueuedAt IS NULL RETURNING id`. Only the run that gets a row back
 * proceeds to `boss.send`; the loser sees no returned row and skips. If
 * `boss.send` throws after a successful claim, the claim is released
 * (`notifyEnqueuedAt` reset to `null`) before re-throwing, so pg-boss's
 * retry can claim and re-send instead of the notification being silently
 * dropped.
 *
 * Logs `{postId, trigger, watchesScanned, matched, notified, ms}`.
 */
export async function runMatchJob(opts: RunMatchJobOptions): Promise<RunMatchJobResult> {
  const start = performance.now();
  const now = opts.now ?? new Date();
  const { handle, boss, watchIndex, postId, trigger } = opts;

  const [post] = await handle.db
    .select({
      id: schema.post.id,
      sourceId: schema.post.sourceId,
      textNormalized: schema.post.textNormalized,
      firstSeenAt: schema.post.firstSeenAt,
      enrichState: schema.post.enrichState,
      pipelineVersion: schema.post.pipelineVersion,
      teamId: schema.source.teamId,
      sourceDefaults: schema.source.defaults,
      overrideRegion: schema.sourceGroup.overrideRegion,
      autoRegion: schema.sourceGroup.autoRegion,
    })
    .from(schema.post)
    .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
    .leftJoin(schema.sourceGroup, eq(schema.sourceGroup.sourceId, schema.post.sourceId))
    .where(eq(schema.post.id, postId))
    .limit(1);

  if (!post) {
    logger.warn({ postId, trigger }, "match job: post not found, skipping");
    return { watchesScanned: 0, matched: 0, notified: 0 };
  }

  // Once a match is retention-deleted its dedupe row is gone; never re-alert for posts older than the match window.
  if (now.getTime() - post.firstSeenAt.getTime() > RETENTION_DEFAULTS.matchDays * 24 * 60 * 60 * 1000) {
    logger.info({ postId, trigger }, "match job: post older than the match retention window, skipping");
    await markMatchDone(handle, post);
    return { watchesScanned: 0, matched: 0, notified: 0 };
  }

  const [enrichmentRow] = await handle.db
    .select({
      intent: schema.enrichment.intent,
      priceVnd: schema.enrichment.priceVnd,
      priceQualifier: schema.enrichment.priceQualifier,
      priceMaxVnd: schema.enrichment.priceMaxVnd,
      categoryId: schema.enrichment.categoryId,
      itemId: schema.enrichment.itemId,
      attributes: schema.enrichment.attributes,
    })
    .from(schema.enrichment)
    .where(eq(schema.enrichment.postId, postId))
    .orderBy(desc(schema.enrichment.revision))
    .limit(1);

  const index = watchIndex.getForTeam(post.teamId); // A post only matches watches of its own team
  const textMaxChars = await fetchTextMaxChars(handle);
  const sourceRegion = resolveSourceRegion(post.overrideRegion, post.autoRegion, post.sourceDefaults);
  const results = matchPostSafe(post, enrichmentRow, index, now, textMaxChars, sourceRegion);

  let notified = 0;
  const tz = await fetchAppTz(handle);

  for (const result of results) {
    const [inserted] = await handle.db
      .insert(schema.match)
      .values({ postId: post.id, watchId: result.watchId, score: result.score, matchedTerms: result.matchedTerms })
      .onConflictDoNothing({ target: [schema.match.postId, schema.match.watchId] })
      .returning({ id: schema.match.id });

    // Conflict (row already existed, e.g. duplicate `ingest`/`enrich`
    // delivery or a retried job): re-fetch its id so we can still attempt to
    // claim the notify decision — do not skip it outright.
    const matchId =
      inserted?.id ??
      (
        await handle.db
          .select({ id: schema.match.id })
          .from(schema.match)
          .where(and(eq(schema.match.postId, post.id), eq(schema.match.watchId, result.watchId)))
          .limit(1)
      )[0]?.id;

    if (!matchId) continue;

    // Atomic claim: only the run that flips `notifyEnqueuedAt` from null to
    // `now` in this single statement proceeds; a concurrent run of another
    // `match` job for the same (post, watch) sees no returned row and skips
    // (see doc comment above).
    const [claimed] = await handle.db
      .update(schema.match)
      .set({ notifyEnqueuedAt: now })
      .where(and(eq(schema.match.id, matchId), isNull(schema.match.notifyEnqueuedAt)))
      .returning({ id: schema.match.id });

    if (!claimed) continue; // already decided (or claimed by a concurrent run) — idempotent no-op

    const watch = index.find((w) => w.id === result.watchId);
    if (watch) {
      try {
        await boss.send(NOTIFY_QUEUE, notifyJobSchema.parse({
          matchId,
          watchId: watch.id,
          notifierIds: watch.notifierIds,
          quiet: isQuiet((watch.quietHours as QuietHours | null) ?? null, now, tz),
        }));
        notified++;
      } catch (err) {
        // Release the claim so a retried job can re-claim and re-send
        // instead of the notification being silently dropped.
        await handle.db.update(schema.match).set({ notifyEnqueuedAt: null }).where(eq(schema.match.id, matchId));
        throw err;
      }
    }
  }

  await markMatchDone(handle, post);

  const ms = performance.now() - start;
  if (ms > 100) matchSlowCount++;

  logger.info(
    { postId, trigger, watchesScanned: index.length, matched: results.length, notified, ms: Math.round(ms) },
    "match job run",
  );

  return { watchesScanned: index.length, matched: results.length, notified };
}

/**
 * After a run that did not throw, a post whose enrichment is settled (`done`/`failed`) is
 * `match_state='done'`. The update is guarded by the `pipeline_version` this run read, so a capture upgrade or
 * edit that bumped the version meanwhile leaves the post `pending` for its own re-run. A still-pending enrich
 * leaves the state alone (the post is matched again after enrichment lands).
 */
async function markMatchDone(handle: DbHandle, post: { id: string; enrichState: string; pipelineVersion: number }): Promise<void> {
  if (post.enrichState !== "done" && post.enrichState !== "failed") return;
  await handle.db
    .update(schema.post)
    .set({
      matchState: "done",
      pipelineVersion: sql`${schema.post.pipelineVersion} + 1`,
      pipelineAttempts: 0,
      pipelineReconciledAt: null,
      pipelineUpdatedAt: sql`now()`,
    })
    .where(and(eq(schema.post.id, post.id), eq(schema.post.pipelineVersion, post.pipelineVersion), eq(schema.post.matchState, "pending")));
}

/** Regions that carry no information for matching. */
const UNINFORMATIVE_REGIONS = new Set(["any", "mixed", "other"]);

/** `source_group.override_region ?? auto_region ?? source.defaults.region`; any/mixed/other -> null. */
export function resolveSourceRegion(
  overrideRegion: string | null | undefined,
  autoRegion: string | null | undefined,
  sourceDefaults: Record<string, string | number> | null | undefined,
): string | null {
  const fallback = sourceDefaults?.region;
  const region = overrideRegion ?? autoRegion ?? (typeof fallback === "string" ? fallback : null);
  return region === null || UNINFORMATIVE_REGIONS.has(region) ? null : region;
}

// Isolated so a matcher throw (should not happen — matchPost is pure) still
// produces an informative log instead of an unhandled worker crash.
function matchPostSafe(
  post: { id: string; sourceId: string; textNormalized: string },
  enrichmentRow: { intent: string | null; priceVnd: number | null; priceQualifier: string | null; priceMaxVnd: number | null; categoryId: string | null; itemId: string | null; attributes: Record<string, string | number> } | undefined,
  index: ReturnType<WatchIndex["getForTeam"]>,
  now: Date,
  textMaxChars: number,
  sourceRegion: string | null,
): { watchId: string; score: number; matchedTerms: string[] }[] {
  const enrichment = enrichmentRow
    ? {
        intent: enrichmentRow.intent as "sell" | "buy" | "other" | null,
        priceVnd: enrichmentRow.priceVnd,
        priceQualifier: enrichmentRow.priceQualifier as PriceQualifier | null,
        priceMaxVnd: enrichmentRow.priceMaxVnd,
        categoryId: enrichmentRow.categoryId,
        itemId: enrichmentRow.itemId,
        attributes: enrichmentRow.attributes,
      }
    : undefined;
  return matchPostImpl({ post, enrichment, sourceRegion }, index, now, textMaxChars);
}

/** Registers the `match` job worker on `boss`. `retryLimit 3`, `expireInSeconds 60` (queue defaults). */
export async function registerMatchJob(boss: PgBoss, handle: DbHandle, watchIndex: Pick<WatchIndex, "getForTeam">): Promise<void> {
  await boss.createQueue(MATCH_QUEUE, { retryLimit: 3, expireInSeconds: 60 });
  await boss.createQueue(NOTIFY_QUEUE);
  await boss.work(MATCH_QUEUE, async ([job]) => {
    const payload = matchJobSchema.parse(job?.data);
    await runMatchJob({ handle, boss, watchIndex, postId: payload.postId, trigger: payload.trigger });
  });
}
