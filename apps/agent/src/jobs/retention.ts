import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@feedhound/core/logger";
import { schema, type DbHandle } from "@feedhound/db";
import { desc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { thumbPath } from "./thumbs";

/** A relative MEDIA_DIR resolves against the repo root, matching the thumb job and the api media route. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const logger = createLogger({ service: "agent" });

/**
 * Data retention. The agent's pg-boss cron is the
 * only retention path (infra/retention.sh is gone). Every step is batched (`batchSize` rows per
 * statement, so no run holds a long transaction) and idempotent.
 *  1. `post.raw` older than `retentionDays` is reset to `{}` (the column is NOT NULL) and the
 *     matching `post_revision` rows are deleted. `post` rows are never deleted.
 *  2. `notification` older than `notificationDays`.
 *  3. `match` older than `matchDays` (their notifications go with them: FK ON DELETE CASCADE).
 *  4. `visit` older than `visitDays` (`post.visit_id` -> null through the existing FK).
 *  5. `config` keeps the newest `configVersionsPerKey` versions per key.
 *  6. cached thumbnails of posts first seen more than `thumbDays` ago are unlinked and `thumb_state` becomes `purged`.
 * Windows are constants, not Config.
 */
export const RETENTION_DEFAULTS = {
  retentionDays: 90,
  thumbDays: 90,
  notificationDays: 180,
  matchDays: 180,
  visitDays: 30,
  configVersionsPerKey: 50,
  batchSize: 5000,
} as const;

export interface RetentionResult {
  postsRawCleared: number;
  revisionsDeleted: number;
  notificationsDeleted: number;
  matchesDeleted: number;
  visitsDeleted: number;
  configRowsDeleted: number;
  thumbsPurged: number;
}

export type RetentionOptions = Partial<{ [K in keyof typeof RETENTION_DEFAULTS]: number }> & { now?: Date; mediaDir?: string };

export const RETENTION_QUEUE = "retention";
export const RETENTION_CRON = "0 4 * * *";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs `step` until a batch comes back short; returns the total number of rows touched. */
async function drain(batchSize: number, step: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await step();
    total += n;
    if (n < batchSize) return total;
  }
}

export async function runRetention(handle: DbHandle, opts: RetentionOptions = {}): Promise<RetentionResult> {
  const cfg = { ...RETENTION_DEFAULTS, ...opts };
  const now = opts.now ?? new Date();
  const { sql } = handle;
  const batch = cfg.batchSize;
  const cutoff = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
  const rawCutoff = cutoff(cfg.retentionDays);

  const postsRawCleared = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      update post set raw = '{}'::jsonb
      where id in (
        select id from post
        where first_seen_at < ${rawCutoff}::timestamptz and raw <> '{}'::jsonb
        limit ${batch}
      )
      returning id`;
    return rows.length;
  });

  const revisionsDeleted = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      delete from post_revision
      where id in (
        select pr.id from post_revision pr join post p on p.id = pr.post_id
        where p.first_seen_at < ${rawCutoff}::timestamptz
        limit ${batch}
      )
      returning id`;
    return rows.length;
  });

  const notifCutoff = cutoff(cfg.notificationDays);
  const notificationsDeleted = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      delete from notification
      where id in (select id from notification where created_at < ${notifCutoff}::timestamptz limit ${batch})
      returning id`;
    return rows.length;
  });

  const matchCutoff = cutoff(cfg.matchDays);
  const matchesDeleted = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      delete from match
      where id in (select id from match where created_at < ${matchCutoff}::timestamptz limit ${batch})
      returning id`;
    return rows.length;
  });

  const visitCutoff = cutoff(cfg.visitDays);
  const visitsDeleted = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      delete from visit
      where id in (select id from visit where started_at < ${visitCutoff}::timestamptz limit ${batch})
      returning id`;
    return rows.length;
  });

  const keep = cfg.configVersionsPerKey;
  const configRowsDeleted = await drain(batch, async () => {
    const rows = await sql<{ key: string }[]>`
      delete from config c
      using (
        select key, version from (
          select key, version, row_number() over (partition by key order by version desc) as rn from config
        ) ranked
        where rn > ${keep}
        limit ${batch}
      ) old
      where c.key = old.key and c.version = old.version
      returning c.key`;
    return rows.length;
  });

  const thumbCutoff = cutoff(cfg.thumbDays);
  const mediaDir = opts.mediaDir ?? resolve(REPO_ROOT, process.env.MEDIA_DIR ?? "./data/media");
  const thumbsPurged = await drain(batch, async () => {
    const rows = await sql<{ id: string }[]>`
      select id from post
      where thumb_state = 'ok' and first_seen_at < ${thumbCutoff}::timestamptz
      limit ${batch}`;
    for (const r of rows) {
      await unlink(thumbPath(mediaDir, r.id)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") logger.warn({ err, postId: r.id }, "retention: could not unlink thumbnail, marking purged anyway");
      });
      await sql`update post set thumb_state = 'purged' where id = ${r.id}::uuid`;
    }
    return rows.length;
  });

  const result: RetentionResult = {
    postsRawCleared,
    revisionsDeleted,
    notificationsDeleted,
    matchesDeleted,
    visitsDeleted,
    configRowsDeleted,
    thumbsPurged,
  };
  logger.info(result, "retention run");
  return result;
}

async function fetchAppTz(handle: DbHandle): Promise<string> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "app.tz"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "string" ? row.value : "Asia/Ho_Chi_Minh";
}

export async function registerRetentionJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(RETENTION_QUEUE);
  await boss.schedule(RETENTION_QUEUE, RETENTION_CRON, null, { tz: await fetchAppTz(handle) });
  await boss.work(RETENTION_QUEUE, async () => {
    await runRetention(handle);
  });
}
