import { NotImplementedError, telegramNotifierConfigSchema, type Notifier, type NotifierTarget, type OutgoingMessage } from "@feedhound/core/notifiers";
import { z } from "zod";
import { splitTitle } from "@feedhound/core/title";
import { createLogger } from "@feedhound/core/logger";
import { formatAlert, formatOps } from "@feedhound/bot/format";
import type { DbHandle } from "@feedhound/db";
import { enqueueOpsNotification, fetchOpsChatId, schema, type OpsAlertInput } from "@feedhound/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { resolveOpsUserId } from "./ops-alerts";
import type { PgBoss } from "pg-boss";
import { RateLimiter } from "../lib/rate-limit";

export { enqueueOpsNotification, fetchOpsChatId, type OpsAlertInput };

const logger = createLogger({ service: "agent" });

const NOTIFY_QUEUE = "notify";
// Accepts 003's full `{matchId, watchId, notifierIds, quiet}` payload
// (match.ts, out of 004's Files list, is the enqueuer and is not touched
// here) but only ever reads `matchId` — `runNotifyJob` recomputes
// everything else (watches, targets, quiet/mute state) from the DB inside
// the advisory-lock group scan, so a bare `{matchId}` retry enqueue
// (apps/api/src/routes/notifications.ts) is equally valid.
const notifyJobPayloadSchema = z.object({ matchId: z.string().uuid() }).passthrough();
const NOTIFY_SWEEP_QUEUE = "notify_sweep";
const NOTIFY_SWEEP_CRON = "*/1 * * * *";
/** CR-1: a match claimed (`notify_enqueued_at` set) but with no Notification row after this many minutes is re-enqueued. */
const SWEEP_STALE_MINUTES = 5;
/** Matches older than this are never (re-)notified: the sweeper ignores them and `runNotifyJob` refuses them. */
export const NOTIFY_MAX_MATCH_AGE_DAYS = 7;
/** A `sending` row untouched this long is retried. */
const STUCK_SENDING_MINUTES = 2;
export const MAX_429_CUMULATIVE_WAIT_SEC = 300;
export const MAX_429_WAIT_SEC = 60;

export interface NotifyConfig {
  retryDelaysSec: number[];
  digestDefaultEveryMin: number;
  digestMaxEntries: number;
  excerptChars: number;
}

const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  retryDelaysSec: [5, 30, 120, 600, 1800],
  digestDefaultEveryMin: 10,
  digestMaxEntries: 20,
  excerptChars: 300,
};

/**
 * every config value is validated with a Zod schema + sane bounds before use — an
 * unvalidated `notify.digest.maxEntries = 0` makes `format.ts`'s chunk loop (`i += 0`) spin
 * forever, and a non-array `notify.retry.delaysSec` throws inside `sendAlertRow`. An
 * out-of-range or malformed value falls back to the default and logs a warning instead of
 * propagating a bad value or throwing.
 */
async function fetchConfigValue<T>(handle: DbHandle, key: string, fallback: T, validator: z.ZodType<T>): Promise<T> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  if (row === undefined) return fallback;
  const parsed = validator.safeParse(row.value);
  if (!parsed.success) {
    logger.warn({ key, value: row.value, error: parsed.error.message }, "notify: invalid config value, using default");
    return fallback;
  }
  return parsed.data;
}

const retryDelaysSecSchema = z.array(z.number().positive()).min(1).max(20);
const digestEveryMinSchema = z.number().int().min(1).max(24 * 60);
const digestMaxEntriesSchema = z.number().int().min(1).max(1000);
const excerptCharsSchema = z.number().int().min(1).max(4096);

export async function fetchNotifyConfig(handle: DbHandle): Promise<NotifyConfig> {
  return {
    retryDelaysSec: await fetchConfigValue(handle, "notify.retry.delaysSec", DEFAULT_NOTIFY_CONFIG.retryDelaysSec, retryDelaysSecSchema),
    digestDefaultEveryMin: await fetchConfigValue(handle, "notify.digest.defaultEveryMin", DEFAULT_NOTIFY_CONFIG.digestDefaultEveryMin, digestEveryMinSchema),
    digestMaxEntries: await fetchConfigValue(handle, "notify.digest.maxEntries", DEFAULT_NOTIFY_CONFIG.digestMaxEntries, digestMaxEntriesSchema),
    excerptChars: await fetchConfigValue(handle, "notify.excerptChars", DEFAULT_NOTIFY_CONFIG.excerptChars, excerptCharsSchema),
  };
}

const perChatPerSecSchema = z.number().positive().max(1000);
const perChatPerMinSchema = z.number().int().positive().max(100_000);
const globalPerSecSchema = z.number().positive().max(10_000);

/**
 * the 1/s + 20/min per-chat limits are read from
 * `notify.rateLimit.*` instead of being hardcoded, so a single `RateLimiter`
 * built from this config can be shared by every send path (instant `notify`
 * and `notify_digest`/`notify_ops`) instead of each constructing its own
 * independent bucket set.
 */
export async function fetchRateLimitOptions(handle: DbHandle): Promise<{ perChatPerSec: number; perChatPerMin: number; globalPerSec: number }> {
  return {
    perChatPerSec: await fetchConfigValue(handle, "notify.rateLimit.perChatPerSec", 1, perChatPerSecSchema),
    perChatPerMin: await fetchConfigValue(handle, "notify.rateLimit.perChatPerMin", 20, perChatPerMinSchema),
    globalPerSec: await fetchConfigValue(handle, "notify.rateLimit.globalPerSec", 25, globalPerSecSchema),
  };
}

export async function fetchAppTz(handle: DbHandle): Promise<string> {
  return fetchConfigValue(handle, "app.tz", "Asia/Ho_Chi_Minh", z.string().min(1));
}

/** `HH:MM` wall-clock time of `now` in `tz` (same algorithm as 003's `matcher.ts`, kept local — that file is out of 004's Files list). */
function wallClockTime(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

export interface QuietHours {
  start: string;
  end: string;
}

export function isQuietNow(q: QuietHours | null | undefined, now: Date, tz: string): boolean {
  if (!q) return false;
  if (q.start === q.end) return false;
  const current = wallClockTime(now, tz);
  if (q.start < q.end) return current >= q.start && current < q.end;
  return current >= q.start || current < q.end;
}

/** Next wall-clock instant (>= `now`) at which quiet hours end, in `tz`. Minute precision. */
export function quietHoursEndAt(q: QuietHours, now: Date, tz: string): Date {
  const [endH, endM] = q.end.split(":").map(Number) as [number, number];
  // Walk forward minute-by-minute from `now` until wall-clock reads `q.end` — simple and
  // correct across DST because it only relies on `Intl.DateTimeFormat`, not fixed offsets.
  // 25h cap is a safety valve; quiet windows are <= 24h.
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 25 * 60; i++) {
    const wc = wallClockTime(cursor, tz);
    if (wc === q.end && cursor.getTime() > now.getTime() - 60_000) {
      return cursor;
    }
    cursor.setTime(cursor.getTime() + 60_000);
  }
  // Fallback (should not happen): same wall time next day.
  const fallback = new Date(now);
  fallback.setHours(endH, endM, 0, 0);
  if (fallback <= now) fallback.setDate(fallback.getDate() + 1);
  return fallback;
}

/** Whether any Notification row (including a terminal marker) exists for `matchId` yet. */
async function hasAnyNotificationForMatch(handle: DbHandle, matchId: string): Promise<boolean> {
  const [row] = await handle.db.select({ id: schema.notification.id }).from(schema.notification).where(eq(schema.notification.matchId, matchId)).limit(1);
  return row !== undefined;
}

export type NotifierMap = Partial<Record<string, Notifier>>;

export interface NotifyRunDeps {
  handle: DbHandle;
  notifiers: NotifierMap;
  rateLimiter: RateLimiter;
  config?: NotifyConfig;
  tz?: string;
  now?: Date;
}

type NotificationRow = typeof schema.notification.$inferSelect;
type WatchRow = typeof schema.watch.$inferSelect;

interface SiblingMatch {
  matchId: string;
  watchId: string;
  watchName: string;
  notifierIds: string[];
  mutedUntil: Date | null;
  quietHours: QuietHours | null;
}

/**
 * Given one `matchId`, loads every Match for the same
 * (postId, userId) whose watch is enabled, creates a `Notification` row per
 * (match, target notifier) with `ON CONFLICT (matchId, notifierId) DO
 * NOTHING`, and (re)computes the primary/merged split for each notifier's
 * group. Runs inside `pg_advisory_xact_lock(hashtext(postId||':'||userId))`
 * so overlapping `notify` jobs for the same post/user serialise.
 */
export async function runNotifyJob(payload: { matchId: string }, deps: NotifyRunDeps): Promise<void> {
  const { handle } = deps;
  const now = deps.now ?? new Date();
  const config = deps.config ?? (await fetchNotifyConfig(handle));
  const tz = deps.tz ?? (await fetchAppTz(handle));

  const [match] = await handle.db.select().from(schema.match).where(eq(schema.match.id, payload.matchId)).limit(1);
  if (!match) {
    logger.warn({ matchId: payload.matchId }, "notify: match not found, skipping");
    return;
  }

  const [ownWatch] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, match.watchId)).limit(1);
  if (!ownWatch || !ownWatch.enabled) {
    logger.info({ matchId: payload.matchId }, "notify: watch missing or disabled, skipping");
    // A disabled watch legitimately produces no Notification row, but with
    // nothing recorded the CR-1 sweeper keeps finding this match "claimed, no
    // notification row" every minute forever and re-enqueues `notify` for it
    // indefinitely. Record a terminal marker row (matchId set, notifierId null) so the
    // sweeper's `not exists (select 1 from notification where match_id = m.id)` check
    // stops matching it. Only possible when the watch (and thus its userId) still
    // exists; a deleted watch cascades its Matches away instead (003).
    if (ownWatch && !(await hasAnyNotificationForMatch(handle, payload.matchId))) {
      // `(matchId, notifierId)`'s partial unique index does not dedupe
      // two marker rows that both have `notifierId = null` — Postgres never treats NULLs as
      // equal for uniqueness — so a sweeper-triggered run racing a plain enqueue for the
      // same match (different `singletonKey`s, no shared advisory lock here) could insert
      // two. `notification_match_no_notifier_unique` (packages/db/migrations/0013) covers
      // exactly this case.
      await handle.db
        .insert(schema.notification)
        .values({
          matchId: payload.matchId,
          notifierId: null,
          userId: ownWatch.userId,
          channel: "none",
          status: "suppressed",
          lastError: "watch disabled",
          payload: { postId: match.postId, userId: ownWatch.userId },
        })
        .onConflictDoNothing({
          target: [schema.notification.matchId],
          where: sql`${schema.notification.matchId} is not null and ${schema.notification.notifierId} is null`,
        });
    }
    return;
  }
  const maxAgeMs = NOTIFY_MAX_MATCH_AGE_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() - match.createdAt.getTime() > maxAgeMs) {
    logger.warn({ matchId: payload.matchId }, "notify: match older than the notify window, skipping");
    if (!(await hasAnyNotificationForMatch(handle, payload.matchId))) {
      await handle.db
        .insert(schema.notification)
        .values({
          matchId: payload.matchId,
          notifierId: null,
          userId: ownWatch.userId,
          channel: "none",
          status: "skipped",
          lastError: "match too old",
          payload: { postId: match.postId, userId: ownWatch.userId },
        })
        .onConflictDoNothing({
          target: [schema.notification.matchId],
          where: sql`${schema.notification.matchId} is not null and ${schema.notification.notifierId} is null`,
        });
    }
    return;
  }
  // A web (`capture = 'api'`) listing older than `web.alertMaxAgeMinutes` is matched but never alerted,
  // so the first poll of a new source cannot flood Telegram with old ads.
  const [alertPost] = await handle.db
    .select({ capture: schema.post.capture, postedAt: schema.post.postedAt })
    .from(schema.post)
    .where(eq(schema.post.id, match.postId))
    .limit(1);
  if (alertPost?.capture === "api" && alertPost.postedAt) {
    const maxAgeMin = await fetchConfigValue(handle, "web.alertMaxAgeMinutes", 120, z.number().int().min(1).max(10080));
    if (now.getTime() - alertPost.postedAt.getTime() > maxAgeMin * 60_000) {
      if (!(await hasAnyNotificationForMatch(handle, payload.matchId))) {
        await handle.db
          .insert(schema.notification)
          .values({
            matchId: payload.matchId,
            notifierId: null,
            userId: ownWatch.userId,
            channel: "none",
            status: "skipped",
            lastError: "post too old",
            payload: { postId: match.postId, userId: ownWatch.userId },
          })
          .onConflictDoNothing({
            target: [schema.notification.matchId],
            where: sql`${schema.notification.matchId} is not null and ${schema.notification.notifierId} is null`,
          });
      }
      return;
    }
  }
  const userId = ownWatch.userId;
  const postId = match.postId;

  const notifierGroups = await handle.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${postId} || ':' || ${userId}))`);

    const siblings = await tx
      .select({
        matchId: schema.match.id,
        watchId: schema.watch.id,
        watchName: schema.watch.name,
        notifierIds: schema.watch.notifierIds,
        mutedUntil: schema.watch.mutedUntil,
        quietHours: schema.watch.quietHours,
      })
      .from(schema.match)
      .innerJoin(schema.watch, eq(schema.match.watchId, schema.watch.id))
      .where(and(eq(schema.match.postId, postId), eq(schema.watch.userId, userId), eq(schema.watch.enabled, true)))
      .orderBy(schema.watch.id);

    const siblingMatches: SiblingMatch[] = siblings.map((s) => ({
      matchId: s.matchId,
      watchId: s.watchId,
      watchName: s.watchName,
      notifierIds: s.notifierIds,
      mutedUntil: s.mutedUntil,
      quietHours: s.quietHours as unknown as QuietHours | null,
    }));

    // Marks `payload.matchId` (the match that triggered this run) terminal
    // when there is legitimately nothing to notify about, so the CR-1 sweeper's `not
    // exists (select 1 from notification where match_id = m.id)` check stops matching
    // it — otherwise a watch with no enabled notifier (e.g. before `/link`) or a
    // notifier disabled after a 403 causes an unbounded once-a-minute re-enqueue loop.
    const markNoTarget = async (lastError: string): Promise<void> => {
      const [existing] = await tx.select({ id: schema.notification.id }).from(schema.notification).where(eq(schema.notification.matchId, payload.matchId)).limit(1);
      if (existing) return;
      // See `notification_match_no_notifier_unique` note above — this
      // insert races the same way against a concurrent run for the same matchId.
      await tx
        .insert(schema.notification)
        .values({
          matchId: payload.matchId,
          notifierId: null,
          userId,
          channel: "none",
          status: "suppressed",
          lastError,
          payload: { postId, userId },
        })
        .onConflictDoNothing({
          target: [schema.notification.matchId],
          where: sql`${schema.notification.matchId} is not null and ${schema.notification.notifierId} is null`,
        });
    };

    let targetNotifierIds = [...new Set(siblingMatches.flatMap((s) => s.notifierIds))];
    // Fallback: any matching watch with no picks means "all my enabled notifiers",
    // even when a sibling watch has explicit picks.
    if (targetNotifierIds.length === 0 || siblingMatches.some((s) => s.notifierIds.length === 0)) {
      const rows = await tx
        .select({ id: schema.notifier.id })
        .from(schema.notifier)
        .where(and(eq(schema.notifier.userId, userId), eq(schema.notifier.enabled, true)));
      targetNotifierIds = [...new Set([...targetNotifierIds, ...rows.map((r) => r.id)])];
    }
    if (targetNotifierIds.length === 0) {
      await markNoTarget("no enabled notifier");
      return [];
    }

    const notifierRows = await tx
      .select()
      .from(schema.notifier)
      .where(and(inArray(schema.notifier.id, targetNotifierIds), eq(schema.notifier.enabled, true)));
    if (notifierRows.length === 0) {
      await markNoTarget("no enabled notifier");
      return [];
    }

    const groups: { notifier: typeof schema.notifier.$inferSelect; rows: NotificationRow[] }[] = [];

    for (const notifierRow of notifierRows) {
      for (const sibling of siblingMatches) {
        await tx
          .insert(schema.notification)
          .values({
            matchId: sibling.matchId,
            notifierId: notifierRow.id,
            userId,
            channel: notifierRow.kind,
            status: "pending",
            payload: { postId, userId, watchIds: [sibling.watchId], watchNames: [sibling.watchName] },
          })
          // The unique index is partial (`where match_id is not null`); Postgres only infers
          // it as an arbiter when the same predicate is repeated here.
          .onConflictDoNothing({
            target: [schema.notification.matchId, schema.notification.notifierId],
            where: sql`${schema.notification.matchId} is not null`,
          });
      }

      const groupRows = await tx
        .select()
        .from(schema.notification)
        .where(
          and(
            eq(schema.notification.notifierId, notifierRow.id),
            inArray(
              schema.notification.matchId,
              siblingMatches.map((s) => s.matchId),
            ),
          ),
        );

      // Merging into a row is only valid behind a `sent` primary. A
      // `suppressed`/`failed` row (e.g. its watch was muted on an earlier run)
      // must never become primary for a still-pending sibling — that would
      // mark the sibling `merged` and lose its notification silently.
      let primary: NotificationRow | undefined = groupRows.find((r) => r.status === "sent");
      if (!primary) {
        // lowest watchId among the still-pending rows wins (sibling order is already by watchId asc).
        const bySiblingOrder = siblingMatches
          .map((s) => groupRows.find((r) => r.matchId === s.matchId))
          .filter((r): r is NotificationRow => r !== undefined && r.status === "pending");
        primary = bySiblingOrder[0];
      }
      if (!primary) continue;

      const watchIds = [...new Set(siblingMatches.map((s) => s.watchId))];
      const watchNames = [...new Set(siblingMatches.map((s) => s.watchName))];

      if (primary.status === "pending") {
        // Merge into the existing jsonb (like the digest-scheduling
        // update below) instead of replacing it wholesale — a re-run of this dedup pass for
        // the same (post,user) after digest scheduling must not silently drop `digestBatch`
        // off the row, which would send it as a solo alert instead of as part of its batch.
        await tx
          .update(schema.notification)
          .set({ payload: sql`${schema.notification.payload} || ${JSON.stringify({ postId, userId, watchIds, watchNames })}::jsonb` })
          .where(eq(schema.notification.id, primary.id));
      }

      for (const row of groupRows) {
        if (row.id === primary.id) continue;
        if (row.status !== "pending") continue;
        await tx
          .update(schema.notification)
          .set({ status: "merged", payload: { postId, userId, primaryId: primary.id } })
          .where(eq(schema.notification.id, row.id));
      }

      const [refreshedPrimary] = await tx.select().from(schema.notification).where(eq(schema.notification.id, primary.id)).limit(1);
      if (refreshedPrimary) groups.push({ notifier: notifierRow, rows: [refreshedPrimary] });
    }

    return groups;
  });

  for (const group of notifierGroups) {
    const primary = group.rows[0];
    if (!primary || primary.status !== "pending") continue;

    const feedingWatches = siblingsFeeding(primary);
    const relevantWatches = (
      await handle.db.select().from(schema.watch).where(inArray(schema.watch.id, feedingWatches))
    ) as WatchRow[];

    if (relevantWatches.length > 0 && relevantWatches.every((w) => w.mutedUntil && w.mutedUntil > now)) {
      await handle.db.update(schema.notification).set({ status: "suppressed", lastError: "muted" }).where(eq(schema.notification.id, primary.id));
      continue;
    }

    const quietUntil = relevantWatches
      .map((w) => (w.quietHours ? (w.quietHours as unknown as QuietHours) : null))
      .filter((q): q is QuietHours => q !== null && isQuietNow(q, now, tz))
      .map((q) => quietHoursEndAt(q, now, tz))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    if (quietUntil) {
      // rows released together at the end of quiet
      // hours "are sent as one digest message even in instant mode" — without the same
      // `digestBatch` flag the digest-accumulation branch below sets, `notify_digest`
      // treats every one of them as an individually-scheduled solo row (a quiet-hours
      // release or a retry-backoff row) and sends N separate alerts instead of one batch.
      await handle.db
        .update(schema.notification)
        .set({ nextAttemptAt: quietUntil, payload: sql`${schema.notification.payload} || '{"digestBatch":true,"digestBatchKind":"quiet"}'::jsonb` })
        .where(eq(schema.notification.id, primary.id));
      continue;
    }

    const targetConfig = telegramNotifierConfigSchema.safeParse(group.notifier.config);
    const mode = targetConfig.success ? targetConfig.data.mode : "instant";
    if (mode === "digest") {
      // only schedule once. A rerun of this job for the same
      // (post, user) — e.g. a new sibling match arriving — must not push `nextAttemptAt`
      // further into the future just because it recomputed from the *current* call's
      // `now`; a row that is already scheduled (`nextAttemptAt` set) is left alone.
      if (primary.nextAttemptAt === null) {
        const everyMin = (targetConfig.success ? targetConfig.data.digestEveryMin : undefined) ?? config.digestDefaultEveryMin;
        // `nextAttemptAt = createdAt + digestEveryMin`, where `createdAt` is the
        // Match that created this primary row (`primary.matchId`), not `now` — using
        // `primary.sentAt` (always null pre-send) silently fell back to `now` every time.
        const [primaryMatch] = await handle.db.select({ createdAt: schema.match.createdAt }).from(schema.match).where(eq(schema.match.id, primary.matchId ?? "")).limit(1);
        const createdAt = primaryMatch?.createdAt ?? now;
        await handle.db
          .update(schema.notification)
          .set({
            nextAttemptAt: new Date(createdAt.getTime() + everyMin * 60_000),
            // Marks this row as part of the normal digest-accumulation
            // batch (as opposed to a quiet-hours release or a retry-backoff row, both of
            // which set the same flag themselves at their own call sites) — `notify_digest`
            // only flushes a whole group together for rows sharing this flag, so an
            // unrelated future-scheduled row never gets swept into an unrelated batch's flush.
            payload: sql`${schema.notification.payload} || '{"digestBatch":true,"digestBatchKind":"accumulate"}'::jsonb`,
          })
          .where(eq(schema.notification.id, primary.id));
      }
      continue;
    }

    // a rerun of this job for the same (post, user) must not
    // resend a primary that is already in retry backoff — only send when there
    // is no scheduled retry, or it is already due.
    if (primary.nextAttemptAt && primary.nextAttemptAt.getTime() > now.getTime()) continue;

    await sendAlertRow(deps, primary, group.notifier, config, now);
  }
}

function siblingsFeeding(row: NotificationRow): string[] {
  return row.payload.watchIds ?? [];
}

async function loadAlertMessage(handle: DbHandle, row: NotificationRow, excerptChars: number, now: Date): Promise<OutgoingMessage | undefined> {
  const [post] = await handle.db.select().from(schema.post).where(eq(schema.post.id, row.payload.postId ?? "")).limit(1);
  if (!post) return undefined;
  const [source] = await handle.db.select({ name: schema.source.name }).from(schema.source).where(eq(schema.source.id, post.sourceId)).limit(1);
  const [enrichment] = await handle.db
    .select({ intent: schema.enrichment.intent, priceVnd: schema.enrichment.priceVnd })
    .from(schema.enrichment)
    .where(eq(schema.enrichment.postId, post.id))
    .orderBy(desc(schema.enrichment.revision))
    .limit(1);

  const engagement = post.engagement as { reactions?: number; comments?: number } | null;
  const excerpt = splitTitle(post.text || post.textNormalized || "").rest;
  const { html, buttons } = formatAlert({
    watchNames: row.payload.watchNames ?? [],
    intent: enrichment?.intent ?? null,
    priceVnd: enrichment?.priceVnd ?? null,
    title: post.title,
    excerpt,
    sourceName: source?.name ?? "?",
    authorName: post.authorName,
    postedAt: post.postedAt,
    reactions: engagement?.reactions ?? 0,
    comments: engagement?.comments ?? 0,
    url: post.url,
    notificationId: row.id,
    excerptChars,
    now,
  });
  return { kind: "alert", html, buttons, dedupeKey: row.id };
}

/** Claim -> rate limit -> send -> finalize, with retry/backoff and 429 handling. */
export async function sendAlertRow(
  deps: NotifyRunDeps,
  row: NotificationRow,
  notifierRow: typeof schema.notifier.$inferSelect,
  config: NotifyConfig,
  now: Date,
): Promise<void> {
  const { handle, rateLimiter, notifiers } = deps;

  const [claimed] = await handle.db
    .update(schema.notification)
    .set({ status: "sending", sendingAt: now })
    .where(and(eq(schema.notification.id, row.id), eq(schema.notification.status, "pending")))
    .returning();
  if (!claimed) return;

  // every finalize update below is guarded by `status = 'sending'` — if the stuck-row
  // sweeper ever reclaims this row out from under us (e.g. `sendingAt` refresh below
  // failed to keep up), the update is a no-op instead of clobbering whatever the new owner
  // wrote, and a second delivery of the same row is prevented.
  const sendingGuard = (id: string) => and(eq(schema.notification.id, id), eq(schema.notification.status, "sending"));

  const message = await loadAlertMessage(handle, claimed, config.excerptChars, now);
  if (!message) {
    await handle.db.update(schema.notification).set({ status: "failed", lastError: "post not found", failedAt: now }).where(sendingGuard(row.id));
    return;
  }

  const notifierImpl = notifiers[notifierRow.kind];
  const targetParsed = telegramNotifierConfigSchema.safeParse(notifierRow.config);
  const target: NotifierTarget = targetParsed.success ? targetParsed.data : (notifierRow.config as NotifierTarget);
  const chatId = targetParsed.success ? targetParsed.data.chatId : undefined;

  if (!notifierImpl) {
    await handle.db
      .update(schema.notification)
      .set({ attempts: claimed.attempts + 1, status: "failed", lastError: "not_implemented", failedAt: now })
      .where(sendingGuard(row.id));
    return;
  }

  let cumulative429WaitSec = 0;
  for (;;) {
    if (chatId !== undefined) await rateLimiter.acquire(chatId);

    let result;
    try {
      result = await notifierImpl.send(target, message);
    } catch (err) {
      if (err instanceof NotImplementedError) {
        await handle.db
          .update(schema.notification)
          .set({ attempts: claimed.attempts + 1, status: "failed", lastError: "not_implemented", failedAt: now })
          .where(sendingGuard(row.id));
        return;
      }
      result = { ok: false as const, retryable: true, error: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) {
      await handle.db
        .update(schema.notification)
        .set({ status: "sent", providerMessageId: result.providerMessageId, sentAt: new Date() })
        .where(sendingGuard(row.id));
      return;
    }

    if (result.retryAfterSec !== undefined && chatId !== undefined) {
      const wait = Math.min(MAX_429_WAIT_SEC, result.retryAfterSec);
      cumulative429WaitSec += wait;
      rateLimiter.pause(chatId, wait * 1_000);
      if (cumulative429WaitSec <= MAX_429_CUMULATIVE_WAIT_SEC) {
        // cumulative 429 waits can total up to `MAX_429_CUMULATIVE_WAIT_SEC` (300s),
        // well past `STUCK_SENDING_MINUTES` (2min/120s) — without refreshing `sendingAt` here,
        // the once-a-minute sweeper (`resetStuckSendingRows`) would flip this row back to
        // `pending` mid-wait and a concurrent digest/notify run could claim + send it a second
        // time. use the real wall clock, not `now + cumulative429WaitSec`
        // — that simulated stamp only matches production reality if every 429 wait actually
        // takes exactly its nominal duration; DB/network overhead between waits means real
        // elapsed time can run ahead of the simulated total, so the sweeper's real-time
        // comparison could already judge the row stuck before a stale simulated refresh would.
        // Tests drive this deterministically by not advancing real time during their fake sleeps.
        const refreshedSendingAt = new Date();
        const [stillOwned] = await handle.db
          .update(schema.notification)
          .set({ sendingAt: refreshedSendingAt })
          .where(sendingGuard(row.id))
          .returning({ id: schema.notification.id });
        if (!stillOwned) return; // reclaimed by the sweeper despite the refresh; another owner now handles it.
        continue; // retry without incrementing attempts
      }
      // else falls through to the retryable-failure path below, counted as one attempt.
    }

    const nextAttempts = claimed.attempts + 1;

    if (!result.retryable) {
      const isForbidden = result.error.toLowerCase().includes("forbidden");
      await handle.db
        .update(schema.notification)
        .set({ attempts: nextAttempts, status: "failed", lastError: result.error, failedAt: now })
        .where(sendingGuard(row.id));
      if (isForbidden) {
        await handle.db.update(schema.notifier).set({ enabled: false }).where(eq(schema.notifier.id, notifierRow.id));
        const opsUserId = await loadOpsUserId(handle);
        if (opsUserId) {
          await enqueueOpsNotification(handle, opsUserId, {
            kind: "notifier_blocked",
            text: `notifier ${notifierRow.id} (${notifierRow.kind}) blocked: ${result.error}`,
            dedupeKey: `notifier_blocked:${notifierRow.id}`,
            ttlSec: 86_400,
          }, now);
        }
      }
      return;
    }

    // the ladder has `retryDelaysSec.length` entries (default 5:
    // [5,30,120,600,1800]), one per retry; a failure once every entry has been
    // used (i.e. `nextAttempts` runs past the array) is permanent.
    const delayIndex = nextAttempts - 1;
    if (delayIndex >= config.retryDelaysSec.length) {
      await handle.db
        .update(schema.notification)
        .set({ attempts: nextAttempts, status: "failed", lastError: result.error, failedAt: now })
        .where(sendingGuard(row.id));
      return;
    }

    const delaySec = config.retryDelaysSec[delayIndex]!;
    await handle.db
      .update(schema.notification)
      .set({ attempts: nextAttempts, status: "pending", nextAttemptAt: new Date(now.getTime() + delaySec * 1_000), lastError: result.error })
      .where(sendingGuard(row.id));
    return;
  }
}

/** Recipient of ops-channel `Notification` rows: shared resolver (config email, `SEED_OPERATOR_EMAIL`, oldest operator). */
export async function loadOpsUserId(handle: DbHandle): Promise<string | undefined> {
  return resolveOpsUserId(handle);
}

/**
 * Sends any `pending` ops-channel rows. made consistent with `sendAlertRow` — every
 * finalize update is guarded by `status = 'sending'` (a sweeper reclaim mid-send is a no-op,
 * not a clobber/duplicate) and a retryable failure goes through the same
 * `notify.retry.delaysSec` ladder (says rules 5-7 apply to ops rows too) instead of
 * failing permanently on the first transient error.
 */
/** Bounds one flush run's work; a larger backlog drains over several
 * cron ticks (self-healing, like `notify-digest.ts`'s `PENDING_DUE_SCAN_LIMIT`) instead of
 * one run serially sending an unbounded number of rows behind the 1 msg/s limiter. */
const OPS_FLUSH_LIMIT = 200;

export interface FlushOpsFilter {
  /** Only flush rows owned by this user. */
  userId?: string;
  /** Only flush rows whose `payload.ops.dedupeKey` starts with this prefix. */
  dedupeKeyPrefix?: string;
}

/** b: a still-`pending` ops row older than this is stale and settles as `skipped`. */
const OPS_STALE_MS = 24 * 60 * 60 * 1_000;

export async function flushPendingOpsNotifications(deps: NotifyRunDeps, filter: FlushOpsFilter = {}): Promise<void> {
  const { handle } = deps;
  const now = deps.now ?? new Date();
  const config = deps.config ?? (await fetchNotifyConfig(handle));
  const opsChatId = await fetchOpsChatId(handle);
  const scope = and(
    eq(schema.notification.channel, "ops"),
    eq(schema.notification.status, "pending"),
    filter.userId ? eq(schema.notification.userId, filter.userId) : undefined,
    filter.dedupeKeyPrefix ? sql`starts_with(${schema.notification.payload}->'ops'->>'dedupeKey', ${filter.dedupeKeyPrefix})` : undefined,
  );
  if (opsChatId === undefined) {
    // a: nowhere to send, so every matching pending row settles (also backfills old rows).
    await handle.db.update(schema.notification).set({ status: "skipped", lastError: "notify.ops.chatId unset" }).where(scope);
    return;
  }
  // b: too old to be worth sending.
  await handle.db
    .update(schema.notification)
    .set({ status: "skipped", lastError: "stale" })
    .where(and(scope, sql`${schema.notification.createdAt} < ${new Date(now.getTime() - OPS_STALE_MS).toISOString()}`));

  const rows = await handle.db
    .select()
    .from(schema.notification)
    .where(and(scope, sql`(${schema.notification.nextAttemptAt} is null or ${schema.notification.nextAttemptAt} <= ${now.toISOString()})`))
    .orderBy(schema.notification.id)
    .limit(OPS_FLUSH_LIMIT);
  if (rows.length === 0) return;

  const [notifierRow] = await handle.db
    .select()
    .from(schema.notifier)
    .where(and(eq(schema.notifier.kind, "telegram"), eq(schema.notifier.enabled, true)))
    .limit(1);

  for (const row of rows) {
    // c: `insertOpsAlertOnce` legacy rows carry `{rule, message}` instead of `ops`.
    const opsPayload: { kind?: string; text?: string; dedupeKey?: string } | undefined =
      row.payload.ops ?? (row.payload.rule !== undefined && row.payload.message !== undefined ? { kind: row.payload.rule, text: row.payload.message } : undefined);
    if (!opsPayload) {
      await handle.db
        .update(schema.notification)
        .set({ status: "skipped", lastError: "unsupported ops payload" })
        .where(and(eq(schema.notification.id, row.id), eq(schema.notification.status, "pending")));
      continue;
    }

    const [claimed] = await handle.db
      .update(schema.notification)
      .set({ status: "sending", sendingAt: now })
      .where(and(eq(schema.notification.id, row.id), eq(schema.notification.status, "pending")))
      .returning();
    if (!claimed) continue;
    const sendingGuard = and(eq(schema.notification.id, row.id), eq(schema.notification.status, "sending"));

    const html = formatOps({ kind: opsPayload.kind ?? "unknown", text: opsPayload.text ?? "", ts: now });
    const message: OutgoingMessage = { kind: "ops", html, dedupeKey: opsPayload.dedupeKey ?? row.id };

    const notifierImpl = deps.notifiers.telegram;
    if (!notifierImpl || !notifierRow) {
      await handle.db.update(schema.notification).set({ status: "failed", lastError: "no telegram notifier configured", failedAt: now }).where(sendingGuard);
      continue;
    }
    const target: NotifierTarget = { chatId: opsChatId, mode: "instant" };
    await deps.rateLimiter.acquire(opsChatId);
    const result = await notifierImpl.send(target, message);
    if (result.ok) {
      await handle.db.update(schema.notification).set({ status: "sent", providerMessageId: result.providerMessageId, sentAt: new Date() }).where(sendingGuard);
      continue;
    }

    const nextAttempts = claimed.attempts + 1;
    if (!result.retryable) {
      await handle.db.update(schema.notification).set({ attempts: nextAttempts, status: "failed", lastError: result.error, failedAt: now }).where(sendingGuard);
      continue;
    }
    const delayIndex = nextAttempts - 1;
    if (delayIndex >= config.retryDelaysSec.length) {
      await handle.db.update(schema.notification).set({ attempts: nextAttempts, status: "failed", lastError: result.error, failedAt: now }).where(sendingGuard);
    } else {
      const delaySec = config.retryDelaysSec[delayIndex]!;
      await handle.db
        .update(schema.notification)
        .set({ attempts: nextAttempts, status: "pending", nextAttemptAt: new Date(now.getTime() + delaySec * 1_000), lastError: result.error })
        .where(sendingGuard);
    }
  }
}

/**
 * CR-1 sweeper: matches whose `notify_enqueued_at` was set more than
 * `SWEEP_STALE_MINUTES` ago, with no Notification row at all, are re-claim
 * released (`notify_enqueued_at = null`) so the next `match` job run (or a
 * direct re-enqueue here) can enqueue `notify` again. Runs every minute.
 */
export async function sweepStuckNotifyClaims(handle: DbHandle, boss: Pick<PgBoss, "send">, now: Date): Promise<number> {
  const staleThreshold = new Date(now.getTime() - SWEEP_STALE_MINUTES * 60_000);
  const oldestCreated = new Date(now.getTime() - NOTIFY_MAX_MATCH_AGE_DAYS * 24 * 60 * 60 * 1000);
  const stuck = await handle.sql<{ id: string }[]>`
    select m.id
    from match m
    where m.created_at > ${oldestCreated.toISOString()}
      and m.notify_enqueued_at is not null
      and m.notify_enqueued_at < ${staleThreshold.toISOString()}
      and not exists (select 1 from notification n where n.match_id = m.id)
  `;
  for (const row of stuck) {
    // `singletonKey` stops overlapping sweeper ticks (or a sweep racing a
    // still-in-flight `notify` run for the same match) from stacking up more than one
    // queued job for the same match before the terminal-marker guard above takes effect.
    await boss.send(NOTIFY_QUEUE, { matchId: row.id }, { singletonKey: row.id });
  }
  return stuck.length;
}

/**
 * Resets `sending` rows stuck > 2 min back to `pending` so they are
 * retried. Keyed on `sendingAt` (set on every claim, instant or digest) —
 * unlike `nextAttemptAt`/`sentAt`, which are both null for a row that was
 * mid-way through an instant send when the process crashed, `sendingAt` is
 * never null for a `sending` row, so a crash between claim and the HTTP call
 * is always caught.
 */
export async function resetStuckSendingRows(handle: DbHandle, now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - STUCK_SENDING_MINUTES * 60_000);
  const rows = await handle.db
    .update(schema.notification)
    .set({ status: "pending", nextAttemptAt: now })
    .where(and(eq(schema.notification.status, "sending"), sql`coalesce(${schema.notification.sendingAt}, now()) < ${threshold.toISOString()}`))
    .returning({ id: schema.notification.id });
  return rows.length;
}

/**
 * `rateLimiter` must be the *same instance* passed to
 * `registerNotifyDigestJob`/`registerNotifyOpsJob` (built once in
 * `apps/agent/src/index.ts` from `fetchRateLimitOptions`) — two independent
 * `RateLimiter`s enforcing the same per-chat limit each allow up to N msg/s
 * to one chat when an instant send and a digest tick overlap.
 */
export async function registerNotifyJob(boss: PgBoss, handle: DbHandle, notifiers: NotifierMap, rateLimiter: RateLimiter): Promise<void> {
  await boss.createQueue(NOTIFY_QUEUE);
  await boss.work(NOTIFY_QUEUE, { batchSize: 1 }, async ([job]) => {
    const payload = notifyJobPayloadSchema.parse(job?.data);
    await runNotifyJob({ matchId: payload.matchId }, { handle, notifiers, rateLimiter });
  });

  await boss.createQueue(NOTIFY_SWEEP_QUEUE);
  await boss.schedule(NOTIFY_SWEEP_QUEUE, NOTIFY_SWEEP_CRON, {});
  await boss.work(NOTIFY_SWEEP_QUEUE, async () => {
    const now = new Date();
    const swept = await sweepStuckNotifyClaims(handle, boss, now);
    const reset = await resetStuckSendingRows(handle, now);
    if (swept > 0 || reset > 0) logger.info({ swept, reset }, "notify_sweep run");
  });
}
