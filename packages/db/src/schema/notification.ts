import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { desc, sql } from "drizzle-orm";
import { match } from "./match";
import { notifier } from "./notifier";
import { user } from "./user";

// `Notification.payload` shape:
// `{ postId?, userId?, watchIds?, watchNames?, primaryId?, ops?: {kind,text,dedupeKey} }`.
export interface NotificationPayload {
  postId?: string;
  userId?: string;
  watchIds?: string[];
  watchNames?: string[];
  primaryId?: string;
  ops?: { kind?: string; text?: string; dedupeKey?: string };
  rule?: string; // legacy 008 ops payload shape, kept for compat
  message?: string;
  at?: string;
  // Set (true) only by the normal digest-accumulation branch
  // — `notify_digest` only flushes a whole group together
  // for rows sharing this flag. A quiet-hours release or a retry-backoff row
  // never sets it, so it is evaluated individually and never swept into an
  // unrelated batch's flush just because it shares the same (notifierId, watchId) key.
  digestBatch?: boolean;
  // Distinguishes which wave set `digestBatch` — a rule-4
  // digest-accumulation wave ("accumulate", the default) vs a rule-3 quiet-hours release
  // wave ("quiet") — so `notify_digest` never flushes one wave's rows just because an
  // unrelated wave sharing the same (notifierId, primary watchId) group key became due.
  digestBatchKind?: "accumulate" | "quiet";
}

export const notification = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id").references(() => match.id, { onDelete: "cascade" }), // null for ops rows
    notifierId: uuid("notifier_id").references(() => notifier.id), // null for ops rows
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    channel: text("channel").notNull(), // e.g. "ops", "telegram"
    // pending|sending|sent|merged|suppressed|failed|skipped
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").notNull().default({}).$type<NotificationPayload>(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Set alongside every `status = 'failed'` transition — `notify_health`
    // needs a "last 60 min" window over failures too, and `sentAt`
    // is only ever set on success.
    failedAt: timestamp("failed_at", { withTimezone: true }),
    // Set every time a row transitions to `sending` (both the instant/notify
    // path and the digest-claim path). Unlike `nextAttemptAt`/`sentAt` this is
    // never null for a `sending` row, so the stuck-row sweeper can
    // detect a crash between claim and the HTTP call even for "instant" sends
    // that never had a `nextAttemptAt` in the first place.
    sendingAt: timestamp("sending_at", { withTimezone: true }),
    // The only timestamp guaranteed non-null for every row
    // regardless of status — a `pending` instant row (never claimed) has
    // `sentAt`/`failedAt`/`sendingAt`/`nextAttemptAt` all null. Gives `GET
    // /api/notifications` one comparable recency column for a single deterministic total
    // order (`createdAt desc, id desc`) and real keyset pagination, instead of a
    // pending/terminal "bucket swap" with no tiebreak (migration 0017).
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "notification_status_check",
      sql`${t.status} IN ('pending','sending','sent','merged','suppressed','failed','skipped')`,
    ),
    // migration 0016: one llm_budget ops row per dedupeKey.
    uniqueIndex("notification_ops_dedupe_key_unique")
      .on(sql`(${t.payload} -> 'ops' ->> 'dedupeKey')`)
      .where(
        sql`${t.channel} = 'ops' and (${t.payload} -> 'ops' ->> 'kind') = 'llm_budget' and (${t.payload} -> 'ops' ->> 'dedupeKey') is not null`,
      ),
    index("notification_channel_idx").on(t.channel),
    index("notification_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("notification_created_at_id_idx").on(desc(t.createdAt), desc(t.id)),
    uniqueIndex("notification_match_notifier_unique")
      .on(t.matchId, t.notifierId)
      .where(sql`${t.matchId} is not null`),
    // Postgres never treats two `NULL`s as equal for uniqueness, so
    // `notification_match_notifier_unique` above does *not* dedupe two terminal marker rows
    // (`notifier_id is null`) for the same `matchId` — a sweeper-triggered `notify` run
    // racing a plain 003 enqueue (different `singletonKey`s) for the same match can each
    // insert one. This index covers only the `notifier_id is null` marker rows.
    uniqueIndex("notification_match_no_notifier_unique")
      .on(t.matchId)
      .where(sql`${t.matchId} is not null and ${t.notifierId} is null`),
    // Supports `clearNoEnabledNotifierMarkers`
    // (packages/db/src/queries/notifications.ts), which filters on exactly this
    // predicate on every notifier re-enable and bot `/link` before joining `match`.
    index("notification_no_enabled_notifier_marker_idx")
      .on(t.userId)
      .where(sql`${t.status} = 'suppressed' and ${t.lastError} = 'no enabled notifier'`),
  ],
);

