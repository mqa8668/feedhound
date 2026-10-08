import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../index";
import * as schema from "../schema/index";

export interface OpsAlertInput {
  kind: string;
  text: string;
  dedupeKey: string;
  ttlSec: number;
}

/** `notify.ops.chatId` (config), or `undefined` if unset. */
export async function fetchOpsChatId(exec: { db: Pick<Db, "select"> }): Promise<number | undefined> {
  const [row] = await exec.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "notify.ops.chatId"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "number" ? row.value : undefined;
}

/**
 * Inserts a `Notification` (channel `ops`) unless a `sent`
 * ops row with the same `dedupeKey` exists within `ttlSec`, or
 * `notify.ops.chatId` is unset — either case inserts a `skipped` row instead
 * (never silently drops the alert) and returns without sending.
 */
export async function enqueueOpsNotification(exec: { db: Pick<Db, "select" | "insert"> }, opsUserId: string, input: OpsAlertInput, now: Date): Promise<"pending" | "skipped"> {
  const windowStart = new Date(now.getTime() - input.ttlSec * 1_000);
  const windowEnd = new Date(now.getTime() + input.ttlSec * 1_000);
  const dup = await exec.db
    .select({ id: schema.notification.id })
    .from(schema.notification)
    .where(
      and(
        eq(schema.notification.channel, "ops"),
        sql`${schema.notification.payload} ->> 'ops' is not null`,
        sql`(${schema.notification.payload} -> 'ops' ->> 'dedupeKey') = ${input.dedupeKey}`,
        // Dedupe against a `sent` row within `ttlSec` (as before) OR a row still
        // outstanding (`pending`/`sending`) with the same key that is about to fire —
        // otherwise two triggers close together (e.g. two `notify_health` ticks 10 min
        // apart, before the first alert's periodic flush ran) would queue a second alert
        // that fires alongside the first once flushed.
        // "about to fire" is bounded by `ttlSec`, same as the `sent`
        // half above — a fresh row (`attempts = 0`, not yet attempted) always counts, but a
        // row parked in retry backoff (`attempts > 0`) only counts while its
        // `nextAttemptAt` falls within the `ttlSec` horizon; a row backed off further out
        // than that no longer blocks a distinct later trigger of the same key.
        sql`(
          (${schema.notification.status} = 'sent' and ${schema.notification.sentAt} > ${windowStart.toISOString()})
          or (
            ${schema.notification.status} in ('pending', 'sending')
            and (
              ${schema.notification.attempts} = 0
              or (${schema.notification.nextAttemptAt} is not null and ${schema.notification.nextAttemptAt} <= ${windowEnd.toISOString()})
            )
          )
        )`,
      ),
    )
    .limit(1);

  const opsChatId = await fetchOpsChatId(exec);
  const status = dup.length > 0 || opsChatId === undefined ? "skipped" : "pending";

  await exec.db.insert(schema.notification).values({
    userId: opsUserId,
    channel: "ops",
    status,
    payload: { ops: { kind: input.kind, text: input.text, dedupeKey: input.dedupeKey } },
  });
  return status;
}
