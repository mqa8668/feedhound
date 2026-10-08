import { createLogger } from "@feedhound/core/logger";
import { matchJobSchema } from "@feedhound/core/watch";
import type { DbHandle } from "@feedhound/db";
import type { PgBoss } from "pg-boss";
import { insertOpsAlertOnce, resolveOpsUserId } from "./ops-alerts";

const logger = createLogger({ service: "agent" });

// Constants, not Config.
export const STALE_AFTER_SEC = 600;
const BATCH = 200;
const MAX_ATTEMPTS = 3;
const STRANDED_ALERT_THRESHOLD = 50;
const ALERT_DEDUPE_MS = 60 * 60 * 1000;
const RECONCILE_CRON = "*/5 * * * *";

export const RECONCILE_QUEUE = "reconcile";
const ENRICH_QUEUE = "enrich";
const MATCH_QUEUE = "match";

export interface ReconcileOptions {
  now?: Date;
  staleAfterSec?: number;
  limit?: number;
  /** Restrict to posts of these sources (tests share a database with other data). */
  sourceIds?: string[];
  /** pg-boss schema holding the `job` table; default `pgboss`. */
  bossSchema?: string;
  strandedThreshold?: number;
}

export interface ReconcileResult {
  enrichSent: number;
  matchSent: number;
  skippedLive: number;
  failedEnrich: number;
  failedMatch: number;
  stranded: { enrich: number; match: number };
  alerts: string[];
}

type Sql = DbHandle["sql"];

function sourceFilter(sql: Sql, sourceIds: string[] | undefined) {
  return sourceIds ? sql`and p.source_id in ${sql(sourceIds)}` : sql``;
}

/**
 * Pending-stage posts that have been waiting longer than `staleAfterSec`. A post whose enrich is
 * `pending` counts as an enrich post only; a post with a settled enrich and `match_state='pending'` counts as match.
 */
export async function countStranded(
  handle: DbHandle,
  now: Date,
  staleAfterSec: number,
  sourceIds?: string[],
): Promise<{ enrich: number; match: number }> {
  if (sourceIds && sourceIds.length === 0) return { enrich: 0, match: 0 };
  const cutoff = new Date(now.getTime() - staleAfterSec * 1000).toISOString();
  const [row] = await handle.sql<{ enrich: number; match: number }[]>`
    select
      count(*) filter (where p.enrich_state = 'pending')::int as enrich,
      count(*) filter (where p.enrich_state in ('done', 'failed') and p.match_state = 'pending')::int as match
    from post p
    where p.pipeline_updated_at < ${cutoff}::timestamptz
      and (p.pipeline_reconciled_at is null or p.pipeline_reconciled_at < ${cutoff}::timestamptz)
      and (p.enrich_state = 'pending' or p.match_state = 'pending')
      ${sourceFilter(handle.sql, sourceIds)}
  `;
  return { enrich: row?.enrich ?? 0, match: row?.match ?? 0 };
}

interface Claimed {
  id: string;
  editCount: number;
  attempts: number;
  version: number;
}

/**
 * One transaction per stage: lock stale pending candidates (SKIP LOCKED), drop the ones with a live pg-boss job,
 * claim the rest (`attempts + 1`, `reconciled_at = now`). Sends happen after the commit; a failed send keeps the
 * attempt consumed (d).
 */
async function claimStage(
  handle: DbHandle,
  stage: "enrich" | "match",
  opts: { now: Date; cutoff: string; limit: number; sourceIds?: string[]; bossSchema: string },
): Promise<{ claimed: Claimed[]; skippedLive: number }> {
  const queue = stage === "enrich" ? ENRICH_QUEUE : MATCH_QUEUE;
  const nowIso = opts.now.toISOString();
  return handle.sql.begin(async (tx) => {
    const stateWhere =
      stage === "enrich"
        ? tx`p.enrich_state = 'pending'`
        : tx`p.enrich_state in ('done', 'failed') and p.match_state = 'pending'`;
    const rows = await tx<{ id: string; edit_count: number; pipeline_attempts: number; pipeline_version: number; live: boolean }[]>`
      select p.id, p.edit_count, p.pipeline_attempts, p.pipeline_version,
        exists (
          select 1 from ${tx(opts.bossSchema)}.job j
          where j.name = ${queue} and j.state in ('created', 'retry', 'active') and j.data ->> 'postId' = p.id::text
        ) as live
      from post p
      where ${stateWhere}
        and p.pipeline_updated_at < ${opts.cutoff}::timestamptz
        and (p.pipeline_reconciled_at is null or p.pipeline_reconciled_at < ${opts.cutoff}::timestamptz)
        and p.pipeline_attempts < ${MAX_ATTEMPTS}
        ${sourceFilter(handle.sql, opts.sourceIds)}
      order by p.pipeline_updated_at
      limit ${opts.limit}
      for update of p skip locked
    `;
    const free = rows.filter((r) => !r.live);
    if (free.length > 0) {
      await tx`
        update post set pipeline_attempts = pipeline_attempts + 1, pipeline_reconciled_at = ${nowIso}::timestamptz
        where id in ${tx(free.map((r) => r.id))}
      `;
    }
    return {
      claimed: free.map((r) => ({ id: r.id, editCount: r.edit_count, attempts: r.pipeline_attempts + 1, version: r.pipeline_version })),
      skippedLive: rows.length - free.length,
    };
  });
}

/**
 * Exhaustion: a stage still `pending`, stale and out of attempts becomes `failed`. Returns the ids
 * (with their new version) so an enrich failure can send its match right away.
 */
async function failExhausted(
  handle: DbHandle,
  stage: "enrich" | "match",
  opts: { now: Date; cutoff: string; limit: number; sourceIds?: string[]; bossSchema: string },
): Promise<{ id: string; version: number }[]> {
  const queue = stage === "enrich" ? ENRICH_QUEUE : MATCH_QUEUE;
  const nowIso = opts.now.toISOString();
  return handle.sql.begin(async (tx) => {
    const stateWhere =
      stage === "enrich"
        ? tx`p.enrich_state = 'pending'`
        : tx`p.enrich_state in ('done', 'failed') and p.match_state = 'pending'`;
    const rows = await tx<{ id: string }[]>`
      select p.id from post p
      where ${stateWhere}
        and p.pipeline_updated_at < ${opts.cutoff}::timestamptz
        and (p.pipeline_reconciled_at is null or p.pipeline_reconciled_at < ${opts.cutoff}::timestamptz)
        and p.pipeline_attempts >= ${MAX_ATTEMPTS}
        and not exists (
          select 1 from ${tx(opts.bossSchema)}.job j
          where j.name = ${queue} and j.state in ('created', 'retry', 'active') and j.data ->> 'postId' = p.id::text
        )
        ${sourceFilter(handle.sql, opts.sourceIds)}
      order by p.pipeline_updated_at
      limit ${opts.limit}
      for update of p skip locked
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    // An enrich failure hands the post to match as attempt 1 of the match stage (same tick).
    const done = stage === "enrich"
      ? tx<{ id: string; pipeline_version: number }[]>`
          update post set enrich_state = 'failed', pipeline_version = pipeline_version + 1, pipeline_attempts = 1,
            pipeline_reconciled_at = ${nowIso}::timestamptz, pipeline_updated_at = now()
          where id in ${tx(ids)} returning id, pipeline_version`
      : tx<{ id: string; pipeline_version: number }[]>`
          update post set match_state = 'failed', pipeline_version = pipeline_version + 1, pipeline_attempts = 0,
            pipeline_reconciled_at = null, pipeline_updated_at = now()
          where id in ${tx(ids)} returning id, pipeline_version`;
    return (await done).map((r) => ({ id: r.id, version: r.pipeline_version }));
  });
}

async function sendMatch(boss: PgBoss, postId: string, version: number): Promise<boolean> {
  try {
    await boss.send(MATCH_QUEUE, matchJobSchema.parse({ postId, trigger: "enrich" }), {
      singletonKey: `match:${postId}:v${version}`,
      retryLimit: 3,
      expireInSeconds: 60,
    });
    return true;
  } catch (err) {
    logger.error({ err, postId }, "reconcile: failed to send match");
    return false;
  }
}

const LEGACY_QUEUE = "enrich_backfill";

/** Drops queued jobs of the retired backfill queue left over from the retired schedule. */
async function purgeLegacyBackfillJobs(handle: DbHandle, bossSchema: string): Promise<void> {
  try {
    await handle.sql`
      delete from ${handle.sql(bossSchema)}.job where name = ${LEGACY_QUEUE} and state in ('created', 'retry')
    `;
  } catch (err) {
    logger.warn({ err }, "reconcile: could not purge legacy backfill jobs");
  }
}

/** Re-sends lost enrich/match jobs for stale pending posts, fails exhausted stages and raises ops alerts. */
export async function runReconcile(handle: DbHandle, boss: PgBoss, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const staleAfterSec = opts.staleAfterSec ?? STALE_AFTER_SEC;
  const limit = opts.limit ?? BATCH;
  const bossSchema = opts.bossSchema ?? "pgboss";
  const strandedThreshold = opts.strandedThreshold ?? STRANDED_ALERT_THRESHOLD;
  const result: ReconcileResult = {
    enrichSent: 0,
    matchSent: 0,
    skippedLive: 0,
    failedEnrich: 0,
    failedMatch: 0,
    stranded: { enrich: 0, match: 0 },
    alerts: [],
  };
  if (opts.sourceIds && opts.sourceIds.length === 0) return result;

  result.stranded = await countStranded(handle, now, staleAfterSec, opts.sourceIds);
  const cutoff = new Date(now.getTime() - staleAfterSec * 1000).toISOString();
  const stage = { now, cutoff, limit, sourceIds: opts.sourceIds };

  // Exhaustion first: an enrich that just failed gets its match sent right here (not stale next tick).
  const failedEnrich = await failExhausted(handle, "enrich", { ...stage, bossSchema });
  const failedMatch = await failExhausted(handle, "match", { ...stage, bossSchema });
  result.failedEnrich = failedEnrich.length;
  result.failedMatch = failedMatch.length;
  for (const f of failedEnrich) if (await sendMatch(boss, f.id, f.version)) result.matchSent++;

  const enrich = await claimStage(handle, "enrich", { ...stage, bossSchema });
  result.skippedLive += enrich.skippedLive;
  for (const c of enrich.claimed) {
    try {
      await boss.send(
        ENRICH_QUEUE,
        { postId: c.id, revision: c.editCount },
        { singletonKey: `enrich:${c.id}:${c.editCount}:r${c.attempts}`, retryLimit: 3, retryBackoff: true },
      );
      result.enrichSent++;
    } catch (err) {
      logger.error({ err, postId: c.id }, "reconcile: failed to send enrich");
    }
  }

  const match = await claimStage(handle, "match", { ...stage, bossSchema });
  result.skippedLive += match.skippedLive;
  for (const c of match.claimed) if (await sendMatch(boss, c.id, c.version)) result.matchSent++;

  const wantStranded = result.stranded.enrich + result.stranded.match > strandedThreshold;
  const wantFailed = result.failedEnrich + result.failedMatch > 0;
  if (wantStranded || wantFailed) {
    const opsUserId = await resolveOpsUserId(handle);
    if (!opsUserId) {
      logger.warn({ stranded: result.stranded, failedEnrich: result.failedEnrich, failedMatch: result.failedMatch }, "reconcile: no operator user, alert not recorded");
    } else {
      if (wantFailed) {
        const message = `posts failed enrich=${result.failedEnrich} match=${result.failedMatch}`;
        if (await insertOpsAlertOnce(handle, opsUserId, "pipeline_failed", message, now, ALERT_DEDUPE_MS)) result.alerts.push("pipeline_failed");
      }
      if (wantStranded) {
        const message = `posts stranded in pipeline enrich=${result.stranded.enrich} match=${result.stranded.match}`;
        if (await insertOpsAlertOnce(handle, opsUserId, "pipeline_stranded", message, now, ALERT_DEDUPE_MS)) result.alerts.push("pipeline_stranded");
      }
    }
  }

  if (result.enrichSent + result.matchSent + result.failedEnrich + result.failedMatch > 0) logger.info(result, "reconcile run");
  return result;
}

/** Registers the `reconcile` cron (every 5 min) and retires the pre-015 backfill schedule. */
export async function registerReconcileJob(boss: PgBoss, handle: DbHandle, bossSchema = "pgboss"): Promise<void> {
  await boss.createQueue(RECONCILE_QUEUE);
  try {
    await boss.unschedule(LEGACY_QUEUE);
  } catch {
    // no such schedule (or a boss double without it): nothing to retire
  }
  await purgeLegacyBackfillJobs(handle, bossSchema);
  await boss.schedule(RECONCILE_QUEUE, RECONCILE_CRON, {});
  await boss.work(RECONCILE_QUEUE, async () => {
    await runReconcile(handle, boss, { bossSchema });
  });
}
