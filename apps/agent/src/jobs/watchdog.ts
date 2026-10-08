import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { deriveSilenceConfig, isWithinActiveHours, silenceGap, sourceSilenceIntervalSec, SILENCE_CONFIG_KEYS, type ActiveHours, type SilenceConfig } from "@feedhound/core/silence";
import { enqueueOpsNotification, schema } from "@feedhound/db";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

const logger = createLogger({ service: "agent" });

const WATCHDOG_QUEUE = "watchdog";
// Every minute (was `*/5`) — a ledger-based gap check
// needs to catch a gap "within minutes", not within 5.
const WATCHDOG_CRON = "* * * * *";

export type { ActiveHours };

/** The shape lives in core. */
export type WatchdogConfig = SilenceConfig;

export type InsertOpsAlertFn = (handle: DbHandle, teamId: string, text: string) => Promise<void>;

/**
 * Wraps a transaction (drizzle's `tx` from `handle.db.transaction`) as a
 * `DbHandle` so `insertOpsAlert` writes the notification in the same
 * transaction as the `watchdog_alert_at` claim.
 * `sql`/`close` are never touched by `insertOpsAlert`, so the outer
 * handle's are reused as harmless placeholders.
 */
function asTxHandle(handle: DbHandle, tx: Parameters<Parameters<DbHandle["db"]["transaction"]>[0]>[0]): DbHandle {
  return { db: tx as unknown as DbHandle["db"], sql: handle.sql, close: handle.close };
}

/**
 * Inserts an ops Notification (channel "ops") attributed to the team's
 * operator user. Shared shape with `apps/api/src/routes/health.ts`; the full
 * `notify_ops` delivery pipeline lands separately.
 */
export const insertOpsAlert: InsertOpsAlertFn = async (handle, teamId, text) => {
  logger.warn({ teamId, text }, "ops alert");
  const [operator] = await handle.db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(and(eq(schema.user.teamId, teamId), eq(schema.user.role, "operator")))
    .orderBy(desc(schema.user.createdAt))
    .limit(1);
  if (!operator) return;
  const kind = "watchdog";
  // Goes through the shared enqueue so an unset chat is born `skipped`.
  await enqueueOpsNotification(handle, operator.id, { kind, text, dedupeKey: `${kind}:${teamId}:${text}`, ttlSec: 0 }, new Date());
};

export interface RunWatchdogOptions {
  handle: DbHandle;
  now: Date;
  config: WatchdogConfig;
  insertOpsAlert?: InsertOpsAlertFn;
  /** Restrict the run to these source ids (tests on the shared `test` db). */
  sourceIds?: string[];
  /** When false, `kind = 'web'` sources are skipped; read from Config `web.enabled` when omitted. */
  webEnabled?: boolean;
}

export interface RunWatchdogResult {
  checked: number;
  alerted: number;
  recovered: number;
}

/**
 * Ledger-based watchdog, run every minute. Per active /
 * paused_by_health source: a recovery (any time of day) clears the open gap
 * and alerts once; otherwise, inside active hours, a silence past
 * `(expectedIntervalSec ?? fallbackIntervalSec) * gapMultiplier + gapGraceSec`
 * alerts once per gap (`watchdog_alert_at` claims the slot so two concurrent
 * runs can't double-alert). Pure of wall-clock time (`now` injected) for
 * testability.
 */
type SourceRow = typeof schema.source.$inferSelect;

/** `{ gapSec, thresholdSec, intervalSec }` — shared by the recovery clock-skew check and the alert check. */
function computeGap(source: SourceRow, now: Date, config: WatchdogConfig, intervalSec: number): { gapSec: number; thresholdSec: number; intervalSec: number } {
  const { gapSec, thresholdSec } = silenceGap(source.lastOkVisitAt ?? source.createdAt, now, intervalSec, config);
  return { gapSec, thresholdSec, intervalSec };
}

async function loadWebEnabled(handle: DbHandle): Promise<boolean> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "web.enabled"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return row?.value === true;
}

export async function runWatchdog({
  handle,
  now,
  config,
  insertOpsAlert: alertFn = insertOpsAlert,
  sourceIds,
  webEnabled: webEnabledOpt,
}: RunWatchdogOptions): Promise<RunWatchdogResult> {
  const webEnabled = webEnabledOpt === undefined ? await loadWebEnabled(handle) : webEnabledOpt;
  const conditions = [inArray(schema.source.status, ["active", "paused_by_health"])];
  if (sourceIds) conditions.push(inArray(schema.source.id, sourceIds));
  const sources = await handle.db.select().from(schema.source).where(and(...conditions));

  let checked = 0;
  let alerted = 0;
  let recovered = 0;

  for (const source of sources) {
    // Web sources are not watched while the web connector is off.
    if (source.kind === "web" && !webEnabled) continue;
    try {
      const sourceInterval = sourceSilenceIntervalSec(source, config);

      // a. Recovery, any time of day: an open gap (`watchdog_alert_at` set)
      // where either a later ok visit landed, or — amendment, clock-skew
      // case: the current gap has fallen back
      // under threshold even though `last_ok_visit_at` didn't strictly pass
      // `watchdog_alert_at` (client/agent clock drift).
      if (source.watchdogAlertAt !== null) {
        const watchdogAlertAt = source.watchdogAlertAt;
        const timestampRecovered = source.lastOkVisitAt !== null && source.lastOkVisitAt.getTime() > watchdogAlertAt.getTime();
        const withinHoursNow = isWithinActiveHours(now, config.tz, config.activeHours);
        const currentGap = withinHoursNow ? computeGap(source, now, config, sourceInterval) : undefined;
        const gapRecovered = !timestampRecovered && currentGap !== undefined && currentGap.gapSec < currentGap.thresholdSec;
        if (timestampRecovered || gapRecovered) {
          await handle.db.transaction(async (tx) => {
            const claimed = await tx
              .update(schema.source)
              .set({ watchdogAlertAt: null })
              .where(and(eq(schema.source.id, source.id), eq(schema.source.watchdogAlertAt, watchdogAlertAt)))
              .returning({ id: schema.source.id });
            if (claimed.length > 0) {
              const recoveredAt = source.lastOkVisitAt ?? now;
              await alertFn(
                asTxHandle(handle, tx),
                source.teamId,
                `source "${source.name}" (${source.id}) recovered: ok visit at ${recoveredAt.toISOString()}`,
              );
              recovered++;
            }
          });
          continue;
        }
      }

      // b. Outside active hours -> skip entirely (no gap check today yet).
      if (!isWithinActiveHours(now, config.tz, config.activeHours)) continue;
      checked++;

      // c/d. Gap since the last ok visit (or creation), clamped to today's
      // active window; one alert per open gap (claimed via the conditional
      // UPDATE, inside the same transaction as the notification write).
      const { gapSec, thresholdSec, intervalSec } = computeGap(source, now, config, sourceInterval);
      if (gapSec < thresholdSec) continue;

      await handle.db.transaction(async (tx) => {
        const claimed = await tx
          .update(schema.source)
          .set({ watchdogAlertAt: now })
          .where(and(eq(schema.source.id, source.id), isNull(schema.source.watchdogAlertAt)))
          .returning({ id: schema.source.id });
        if (claimed.length === 0) return;

        const healthObj = typeof source.health === "object" && source.health !== null ? (source.health as Record<string, unknown>) : {};
        const healthSuffix = source.status === "paused_by_health" ? ` — paused_by_health: ${(healthObj.reason as string | undefined) ?? "unknown"}` : "";
        await alertFn(
          asTxHandle(handle, tx),
          source.teamId,
          `source "${source.name}" (${source.id}) no ok visit for ${Math.round(gapSec / 60)}m (expected every ${Math.round(intervalSec / 60)}m)${healthSuffix}`,
        );
        alerted++;
      });
    } catch (err) {
      // a failure on one source (e.g. a
      // transient write error) must not abort the loop — later sources and
      // the coverage rollup still need to run this minute. The claim +
      // notification write above share one transaction, so a failure here
      // rolls back the claim too (the slot is not lost).
      logger.error({ err, sourceId: source.id }, "watchdog: source check failed, skipping");
    }
  }

  return { checked, alerted, recovered };
}

export interface RunCoverageRollupOptions {
  handle: DbHandle;
  now: Date;
  config: WatchdogConfig;
  sourceIds?: string[];
}

export interface RunCoverageRollupResult {
  rows: number;
}

/**
 * Hourly coverage rollup for the previous and current UTC hour
 * bucket, one grouped query per metric (no N+1 over sources) plus an
 * upsert per (source, hour). Re-running the same hour is idempotent (same
 * `ON CONFLICT (bucket, ts, dims) DO UPDATE` target as 0016).
 */
export async function runCoverageRollup({ handle, now, config, sourceIds }: RunCoverageRollupOptions): Promise<RunCoverageRollupResult> {
  const conditions = sourceIds ? [inArray(schema.source.id, sourceIds)] : [];
  const sources = await handle.db
    .select({ id: schema.source.id, status: schema.source.status, expectedIntervalSec: schema.source.expectedIntervalSec })
    .from(schema.source)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  if (sources.length === 0) return { rows: 0 };
  const sourceIdList = sources.map((s) => s.id);

  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);
  const prevHour = new Date(currentHour.getTime() - 3_600_000);

  let rows = 0;
  for (const hourStart of [prevHour, currentHour]) {
    const hourEnd = new Date(hourStart.getTime() + 3_600_000);

    const visitsOkRows = await handle.db
      .select({ sourceId: schema.visit.sourceId, count: sql<string>`count(*)` })
      .from(schema.visit)
      .where(and(eq(schema.visit.outcome, "ok"), gte(schema.visit.startedAt, hourStart), lt(schema.visit.startedAt, hourEnd), inArray(schema.visit.sourceId, sourceIdList)))
      .groupBy(schema.visit.sourceId);
    const okMap = new Map(visitsOkRows.map((r) => [r.sourceId, Number(r.count)]));

    const completeRows = await handle.db
      .select({ sourceId: schema.visit.sourceId, count: sql<string>`count(*)` })
      .from(schema.visit)
      .where(
        and(
          eq(schema.visit.outcome, "ok"),
          eq(schema.visit.reachedKnownTail, true),
          gte(schema.visit.startedAt, hourStart),
          lt(schema.visit.startedAt, hourEnd),
          inArray(schema.visit.sourceId, sourceIdList),
        ),
      )
      .groupBy(schema.visit.sourceId);
    const completeMap = new Map(completeRows.map((r) => [r.sourceId, Number(r.count)]));

    const postsRows = await handle.db
      .select({ sourceId: schema.post.sourceId, count: sql<string>`count(*)` })
      .from(schema.post)
      .where(and(gte(schema.post.firstSeenAt, hourStart), lt(schema.post.firstSeenAt, hourEnd), inArray(schema.post.sourceId, sourceIdList)))
      .groupBy(schema.post.sourceId);
    const postsMap = new Map(postsRows.map((r) => [r.sourceId, Number(r.count)]));

    const windowEnd = new Date(Math.min(hourEnd.getTime(), now.getTime()));
    let activeMinutes = 0;
    for (let t = hourStart.getTime(); t < windowEnd.getTime(); t += 60_000) {
      if (isWithinActiveHours(new Date(t), config.tz, config.activeHours)) activeMinutes++;
    }
    const activeSec = activeMinutes * 60;

    // one multi-row upsert per hour bucket
    // instead of a row-by-row insert loop over sources.
    const upsertRows = sources.map((source) => {
      const intervalSec = source.expectedIntervalSec ?? config.fallbackIntervalSec;
      const sourceActiveSec = source.status === "paused" ? 0 : activeSec;
      const visitsExpected = Math.round((sourceActiveSec / intervalSec) * 100) / 100;
      const counts = {
        visits_expected: visitsExpected,
        visits_ok: okMap.get(source.id) ?? 0,
        visits_complete: completeMap.get(source.id) ?? 0,
        posts_new: postsMap.get(source.id) ?? 0,
      };
      const dims = { metric: "coverage", sourceId: source.id };
      return { dims, counts };
    });

    if (upsertRows.length > 0) {
      await handle.sql`
        insert into metric_rollup (bucket, ts, dims, counts)
        select 'hour', ${hourStart.toISOString()}::timestamptz, elem -> 'dims', elem -> 'counts'
        from jsonb_array_elements(${JSON.stringify(upsertRows)}::jsonb) as elem
        on conflict (bucket, ts, dims) do update set counts = excluded.counts
      `;
    }
    rows += upsertRows.length;
  }

  return { rows };
}

async function loadWatchdogConfig(handle: DbHandle): Promise<WatchdogConfig> {
  const raw: Partial<Record<(typeof SILENCE_CONFIG_KEYS)[number], unknown>> = {};
  for (const key of SILENCE_CONFIG_KEYS) {
    const [row] = await handle.db
      .select({ value: schema.config.value })
      .from(schema.config)
      .where(eq(schema.config.key, key))
      .orderBy(desc(schema.config.version))
      .limit(1);
    if (row?.value !== undefined && row.value !== null) raw[key] = row.value;
  }
  return deriveSilenceConfig(raw);
}

/** Registers the `watchdog` cron job (every minute) on `boss`. */
export async function registerWatchdogJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(WATCHDOG_QUEUE);
  await boss.schedule(WATCHDOG_QUEUE, WATCHDOG_CRON, {});
  await boss.work(WATCHDOG_QUEUE, async () => {
    const config = await loadWatchdogConfig(handle);
    const now = new Date();
    const watchdogResult = await runWatchdog({ handle, now, config });
    const rollupResult = await runCoverageRollup({ handle, now, config });
    logger.info({ watchdog: watchdogResult, coverageRollup: rollupResult }, "watchdog run");
  });
}
