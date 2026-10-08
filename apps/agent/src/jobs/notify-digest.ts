import { formatDigest } from "@feedhound/bot/format";
import { telegramNotifierConfigSchema, type NotifierTarget, type OutgoingMessage } from "@feedhound/core/notifiers";
import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  fetchNotifyConfig,
  sendAlertRow,
  MAX_429_CUMULATIVE_WAIT_SEC,
  MAX_429_WAIT_SEC,
  type NotifierMap,
  type NotifyConfig,
  type NotifyRunDeps,
} from "./notify";
import type { RateLimiter } from "../lib/rate-limit";

const logger = createLogger({ service: "agent" });

const NOTIFY_DIGEST_QUEUE = "notify_digest";
const NOTIFY_DIGEST_CRON = "*/30 * * * * *"; // every 30s (Jobs)
/**
 * bounds the initial "which groups are due" scan instead of loading every `pending`
 * row (full jsonb) in the table on every 30s tick. A due group whose rows fall outside this
 * batch is picked up on a later tick — self-healing, at worst a `PENDING_DUE_SCAN_LIMIT`-row
 * backlog delays a group by one more 30s cycle.
 */
const PENDING_DUE_SCAN_LIMIT = 2_000;

type NotificationRow = typeof schema.notification.$inferSelect;

/**
 * Groups every `pending` row (with a `notifierId`) by
 * `(notifierId, primary watchId)`. Within a group, rows carrying
 * `payload.digestBatch === true` (set only by the normal digest-accumulation branch,
 * `notify.ts`) are flushed together as soon as the earliest of them is due — a
 * genuine digest, even if the later-arriving siblings' own `nextAttemptAt` has not yet
 * elapsed (this is intentional batching, not the bug). Rows *without*
 * that flag (a quiet-hours release, or a retry-backoff row) are evaluated
 * individually and only sent once their own `nextAttemptAt` is due, via the same retry
 * ladder as a single alert (`sendAlertRow`) — never swept into an unrelated group flush.
 */
export async function runNotifyDigestJob(deps: NotifyRunDeps): Promise<number> {
  const { handle } = deps;
  const now = deps.now ?? new Date();
  const config = deps.config ?? (await fetchNotifyConfig(handle));

  // step 1: cheap, bounded, indexed scan (`(status, next_attempt_at)`) for only the
  // columns needed to determine *which* (notifierId, primary watchId) groups are due —
  // no jsonb payload pulled here.
  const dueCandidates = await handle.db
    .select({
      notifierId: schema.notification.notifierId,
      primaryWatchId: sql<string | null>`${schema.notification.payload} -> 'watchIds' ->> 0`,
    })
    .from(schema.notification)
    .where(and(eq(schema.notification.status, "pending"), sql`${schema.notification.nextAttemptAt} is not null and ${schema.notification.nextAttemptAt} <= ${now.toISOString()}`))
    .orderBy(schema.notification.nextAttemptAt)
    .limit(PENDING_DUE_SCAN_LIMIT);
  if (dueCandidates.length === 0) return 0;

  const dueNotifierIds = [...new Set(dueCandidates.map((r) => r.notifierId).filter((id): id is string => id !== null))];
  if (dueNotifierIds.length === 0) return 0;

  // step 2: full rows, but only for notifiers that have at least one due group — a
  // group's not-yet-due sibling rows must still be included so a digest-batch is flushed
  // *entirely*, but this is now bounded to the due notifiers' backlog instead of
  // every pending row in the system.
  const pending = await handle.db
    .select()
    .from(schema.notification)
    .where(and(eq(schema.notification.status, "pending"), inArray(schema.notification.notifierId, dueNotifierIds)));
  if (pending.length === 0) return 0;

  const notifierRows = await handle.db.select().from(schema.notifier).where(inArray(schema.notifier.id, dueNotifierIds));
  const notifierById = new Map(notifierRows.map((n) => [n.id, n]));

  const groups = new Map<string, NotificationRow[]>();
  for (const row of pending) {
    if (!row.notifierId || !row.nextAttemptAt) continue;
    const primaryWatchId = row.payload.watchIds?.[0] ?? "unknown";
    const key = `${row.notifierId}:${primaryWatchId}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let sent = 0;
  for (const rows of groups.values()) {
    const notifierRow = notifierById.get(rows[0]!.notifierId!);
    if (!notifierRow) continue;

    const batchRows = rows.filter((r) => r.payload.digestBatch === true);
    const soloRows = rows.filter((r) => r.payload.digestBatch !== true);

    // A group whose min(nextAttemptAt) is due is only flushed for the
    // rows that are genuinely part of that batch (`digestBatch === true`); rows scheduled
    // separately (quiet hours / retry backoff) are never pulled in just because they share
    // the same (notifierId, watchId) key.
    //
    // `batchRows` can still mix two independent waves that happen to
    // share this group key — an ongoing rule-4 digest-accumulation wave and a rule-3
    // quiet-hours release wave for the same watch — because both set `digestBatch = true`.
    // Flushing them as one `sendBatchGroup` call as soon as *either* wave's earliest row is
    // due would send the other wave's rows early (e.g. a quiet row scheduled for 07:00 sent
    // at 22:03 alongside a due accumulation row). Sub-cluster by `digestBatchKind` — set at
    // the point each wave is scheduled — so each wave's
    // "flush together once earliest due" batching (the intended behaviour) only ever
    // considers its own rows.
    const batchClusters = new Map<string, NotificationRow[]>();
    for (const row of batchRows) {
      const kind = row.payload.digestBatchKind ?? "accumulate";
      const list = batchClusters.get(kind) ?? [];
      list.push(row);
      batchClusters.set(kind, list);
    }
    for (const clusterRows of batchClusters.values()) {
      // The retryable-failure path in `sendBatchGroup` resets a failed row's
      // `nextAttemptAt` to a short backoff without clearing `digestBatch`/`digestBatchKind`,
      // so it stays in this same cluster. Using `Math.min` over *every* row (as before) let
      // that backed-off row's near-future `nextAttemptAt` act as the cluster's trigger,
      // flushing a genuinely fresh sibling row (own `nextAttemptAt` still `digestEveryMin`
      // away) far too early. Per-row due check, applied in two tiers:
      //  1. Never-yet-attempted rows (`attempts === 0`) are this window's natural
      //     accumulation members (their own `nextAttemptAt`s can legitimately differ
      //     by up to `digestEveryMin`, and all flush together once the earliest is due) —
      //     when any exist, they alone decide whether the *whole* cluster (fresh + any
      //     already-overdue retried siblings) is due yet.
      //  2. Only when a cluster has no fresh rows left (every row here is a leftover retry,
      //     as in ladder retries) does each retried row's own `nextAttemptAt`
      //     decide inclusion, independent of any not-yet-due fresh sibling — so a fresh
      //     row's future schedule can never be used to *stall* an already-due retry either.
      //
      // Tier 1 previously flushed *all* `clusterRows` once any fresh row was
      // due, sweeping in a retried sibling still in backoff (own `nextAttemptAt` still in
      // the future) and incrementing its `attempts` off-ladder. Only fresh rows plus
      // already-due retried rows are sent here; a not-yet-due retried row is left for a
      // later tick, same as tier 2.
      const freshRows = clusterRows.filter((r) => r.attempts === 0);
      const retriedRows = clusterRows.filter((r) => r.attempts > 0);
      let clusterHandled = false;
      if (freshRows.length > 0) {
        const minFresh = Math.min(...freshRows.map((r) => r.nextAttemptAt!.getTime()));
        if (minFresh <= now.getTime()) {
          const dueRetried = retriedRows.filter((r) => r.nextAttemptAt!.getTime() <= now.getTime());
          sent += await sendBatchGroup(deps, [...freshRows, ...dueRetried], notifierRow, config, now);
          clusterHandled = true;
        }
      }
      if (!clusterHandled) {
        const dueRetried = retriedRows.filter((r) => r.nextAttemptAt!.getTime() <= now.getTime());
        if (dueRetried.length > 0) {
          sent += await sendBatchGroup(deps, dueRetried, notifierRow, config, now);
        }
      }
    }

    for (const row of soloRows) {
      if (!row.nextAttemptAt || row.nextAttemptAt.getTime() > now.getTime()) continue; // not yet individually due.
      await sendAlertRow(deps, row, notifierRow, config, now);
      const [after] = await handle.db.select({ status: schema.notification.status }).from(schema.notification).where(eq(schema.notification.id, row.id)).limit(1);
      if (after?.status === "sent") sent += 1;
    }
  }

  return sent;
}

/**
 * Sends a group of `digestBatch` rows as one or more digest messages. Each
 * rendered message is finalized (rows marked `sent`) immediately after a
 * successful send and *before* the next message in the group is sent — so a crash between
 * chunks, or a retry after a partial failure, can never resend an already-delivered chunk or
 * leave delivered rows permanently stuck. On the first failed chunk, that chunk's rows and
 * every still-unsent row in the group go through the same retry ladder as a single alert
 *; rows already marked `sent` from earlier chunks in this same run are untouched.
 */
async function sendBatchGroup(deps: NotifyRunDeps, rows: NotificationRow[], notifierRow: typeof schema.notifier.$inferSelect, config: NotifyConfig, now: Date): Promise<number> {
  const { handle, rateLimiter, notifiers } = deps;

  const claimedIds: string[] = [];
  for (const row of rows) {
    const [claimed] = await handle.db
      .update(schema.notification)
      .set({ status: "sending", sendingAt: now })
      .where(and(eq(schema.notification.id, row.id), eq(schema.notification.status, "pending")))
      .returning({ id: schema.notification.id });
    if (claimed) claimedIds.push(claimed.id);
  }
  if (claimedIds.length === 0) return 0;

  const claimedRows = await handle.db.select().from(schema.notification).where(inArray(schema.notification.id, claimedIds));
  const sendingGuard = (ids: string[]) => and(inArray(schema.notification.id, ids), eq(schema.notification.status, "sending"));

  // `nextAttemptAt` only equals `Match.createdAt + digestEveryMin`
  // for a fresh row. This deliberately admits `dueRetried` rows here too, and
  // those rows' `nextAttemptAt` is backoff-derived, not offset from their match's
  // `createdAt` — sorting on it put them in an arbitrary position (wrong order)
  // ("entries sorted by Match.createdAt"). Join `match.created_at` directly instead. Ops
  // rows have no `matchId`; they never reach `sendBatchGroup` (only rows with
  // a `notifierId` derived from a match), but fall back to their own `createdAt` for safety.
  const matchIds = [...new Set(claimedRows.map((r) => r.matchId).filter((id): id is string => id !== null))];
  const matchRows = matchIds.length > 0 ? await handle.db.select({ id: schema.match.id, createdAt: schema.match.createdAt }).from(schema.match).where(inArray(schema.match.id, matchIds)) : [];
  const matchCreatedAtById = new Map(matchRows.map((m) => [m.id, m.createdAt]));
  const createdAtOf = (row: NotificationRow): number => (row.matchId ? (matchCreatedAtById.get(row.matchId)?.getTime() ?? row.createdAt.getTime()) : row.createdAt.getTime());
  const sortedByCreatedAt = [...claimedRows].sort((a, b) => createdAtOf(a) - createdAtOf(b));

  const pairs = await Promise.all(
    sortedByCreatedAt.map(async (row) => {
      const postId = row.payload.postId;
      if (!postId) return undefined;
      const [post] = await handle.db.select().from(schema.post).where(eq(schema.post.id, postId)).limit(1);
      if (!post) return undefined;
      const [source] = await handle.db.select({ name: schema.source.name }).from(schema.source).where(eq(schema.source.id, post.sourceId)).limit(1);
      const [enrichment] = await handle.db
        .select({ priceVnd: schema.enrichment.priceVnd })
        .from(schema.enrichment)
        .where(eq(schema.enrichment.postId, post.id))
        .orderBy(desc(schema.enrichment.revision))
        .limit(1);
      return { row, entry: { id: row.id, url: post.url, title: post.title, priceVnd: enrichment?.priceVnd ?? null, sourceName: source?.name ?? "?" } };
    }),
  );
  const validPairs = pairs.filter((p): p is NonNullable<typeof p> => p !== undefined);
  const missingIds = sortedByCreatedAt.filter((r) => !validPairs.some((p) => p.row.id === r.id)).map((r) => r.id);
  if (missingIds.length > 0) {
    await handle.db.update(schema.notification).set({ status: "failed", lastError: "post not found", failedAt: now }).where(sendingGuard(missingIds));
  }
  if (validPairs.length === 0) return 0;

  const rowById = new Map(validPairs.map((p) => [p.row.id, p.row]));
  const watchName = sortedByCreatedAt[0]?.payload.watchNames?.[0] ?? "watch";
  const messages = formatDigest({ watchName, entries: validPairs.map((p) => p.entry), maxEntries: config.digestMaxEntries, notificationId: claimedIds[0]! });

  const targetParsed = telegramNotifierConfigSchema.safeParse(notifierRow.config);
  const chatId = targetParsed.success ? targetParsed.data.chatId : undefined;
  const notifierImpl = notifiers[notifierRow.kind];
  if (!notifierImpl || chatId === undefined) {
    await handle.db
      .update(schema.notification)
      .set({ status: "failed", lastError: "notifier unavailable", failedAt: now })
      .where(sendingGuard(validPairs.map((p) => p.row.id)));
    return 0;
  }

  let sentCount = 0;
  let cumulative429WaitSec = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    await rateLimiter.acquire(chatId);
    const outgoing: OutgoingMessage = { kind: "digest", html: msg.html, buttons: msg.buttons, dedupeKey: msg.entryIds[0] ?? claimedIds[0]! };
    const target: NotifierTarget = targetParsed.success ? targetParsed.data : (notifierRow.config as NotifierTarget);
    const result = await notifierImpl.send(target, outgoing);

    if (result.ok) {
      // Persisted (committed) here, before the next chunk's send call — a crash
      // between chunks can never resend an already-delivered chunk, and only rows whose
      // entries were actually in this delivered chunk are marked `sent`.
      await handle.db
        .update(schema.notification)
        .set({ status: "sent", providerMessageId: result.providerMessageId, sentAt: new Date() })
        .where(sendingGuard(msg.entryIds));
      sentCount += msg.entryIds.length;
      // Refresh `sendingAt` for the not-yet-sent chunks after every
      // successful chunk — a long run (many chunks, or stacked 429 pauses below) can exceed
      // `STUCK_SENDING_MINUTES`, and without this the sweeper would flip still-unsent rows
      // back to `pending` mid-run and a concurrent run could claim + send the same chunk twice.
      const remainingAfterSend = messages.slice(i + 1).flatMap((m) => m.entryIds);
      if (remainingAfterSend.length > 0) {
        await handle.db.update(schema.notification).set({ sendingAt: now }).where(sendingGuard(remainingAfterSend));
      }
      continue;
    }

    // First failure: this chunk's rows plus every not-yet-sent chunk's rows go through the
    // retry ladder together; rows already marked `sent` above are untouched.
    const remainingIds = messages.slice(i).flatMap((m) => m.entryIds);

    // Mirrors notify.ts's 429 handling — pause the chat's rate limiter for
    // `retryAfterSec` and retry the same chunk without burning a ladder step ("429
    // never increments attempts"). `sendingAt` is refreshed (simulated elapsed time, like
    // notify.ts) so the sweeper doesn't reclaim rows mid-wait across repeated 429s.
    if (result.retryAfterSec !== undefined) {
      const wait = Math.min(MAX_429_WAIT_SEC, result.retryAfterSec);
      cumulative429WaitSec += wait;
      rateLimiter.pause(chatId, wait * 1_000);
      if (cumulative429WaitSec <= MAX_429_CUMULATIVE_WAIT_SEC) {
        const refreshedSendingAt = new Date(now.getTime() + cumulative429WaitSec * 1_000);
        const [stillOwned] = await handle.db
          .update(schema.notification)
          .set({ sendingAt: refreshedSendingAt })
          .where(sendingGuard(remainingIds))
          .returning({ id: schema.notification.id });
        if (!stillOwned) return sentCount; // reclaimed by the sweeper despite the refresh.
        i -= 1; // retry the same chunk without incrementing attempts
        continue;
      }
      // else falls through to the retryable-failure path below, counted as one attempt.
    }

    const groupAttempts = Math.max(0, ...remainingIds.map((id) => rowById.get(id)?.attempts ?? 0));
    const nextAttempts = groupAttempts + 1;

    if (!result.retryable) {
      await handle.db.update(schema.notification).set({ attempts: nextAttempts, status: "failed", lastError: result.error, failedAt: now }).where(sendingGuard(remainingIds));
    } else {
      const delayIndex = nextAttempts - 1;
      if (delayIndex >= config.retryDelaysSec.length) {
        await handle.db.update(schema.notification).set({ attempts: nextAttempts, status: "failed", lastError: result.error, failedAt: now }).where(sendingGuard(remainingIds));
      } else {
        const delaySec = config.retryDelaysSec[delayIndex]!;
        await handle.db
          .update(schema.notification)
          .set({ attempts: nextAttempts, status: "pending", nextAttemptAt: new Date(now.getTime() + delaySec * 1_000), lastError: result.error })
          .where(sendingGuard(remainingIds));
      }
    }
    break;
  }

  return sentCount;
}

export async function registerNotifyDigestJob(boss: PgBoss, handle: DbHandle, notifiers: NotifierMap, rateLimiter: RateLimiter): Promise<void> {
  await boss.createQueue(NOTIFY_DIGEST_QUEUE);
  await boss.schedule(NOTIFY_DIGEST_QUEUE, NOTIFY_DIGEST_CRON, {});
  await boss.work(NOTIFY_DIGEST_QUEUE, async () => {
    const now = new Date();
    const sent = await runNotifyDigestJob({ handle, notifiers, rateLimiter, now });
    if (sent > 0) logger.info({ sent }, "notify_digest run");
  });
}
