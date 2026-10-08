import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Match the DB's actual value sets (schema/notification.ts comments) so an
// unrecognized filter value is a 422 validation error, not a query that silently matches
// nothing (or, for `:id`, a malformed uuid reaching Postgres and raising a 500).
const notificationStatusSchema = z.enum(["pending", "sending", "sent", "merged", "suppressed", "failed", "skipped"]);
// `"none"` (marker rows — `notify.ts`'s `markNoTarget`/watch-disabled
// terminal markers) is a real value this table stores and the list endpoint returns; it was
// missing here, so `?channel=none` was a 422 even though those rows are otherwise visible.
const notificationChannelSchema = z.enum(["ops", "telegram", "none"]);
const idParamSchema = z.uuid();

const listQuerySchema = z.object({
  status: notificationStatusSchema.optional(),
  watchId: z.uuid().optional(),
  channel: notificationChannelSchema.optional(),
  since: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "since must be a valid ISO datetime" })
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  // Opaque keyset cursor (`base64("<createdAt ISO>_<id>")`), paired with
  // `nextCursor` in the response — real pagination instead of a single unbounded page.
  cursor: z.string().optional(),
});

// `created_at` is microsecond-precision; the cursor carries it as text (never a JS
// `Date`, which truncates to ms and made keyset paging skip rows sharing a millisecond).
interface ListCursor {
  createdAt: string;
  id: string;
}

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(`${createdAtText}_${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): ListCursor | undefined {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("_");
    if (sep < 0) return undefined;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!CURSOR_TS_RE.test(createdAt) || Number.isNaN(Date.parse(createdAt)) || !idParamSchema.safeParse(id).success) {
      return undefined;
    }
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

async function isOperator(handle: DbHandle, userId: string): Promise<boolean> {
  const [row] = await handle.db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  return row?.role === "operator";
}

/**
 * `/api/notifications`: `GET` own rows (operator sees
 * all), `GET /:id`, `POST /:id/retry` (operator, `failed -> pending`).
 */
export function notificationsRoute(handle: DbHandle, boss?: PgBoss): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  app.get("/api/notifications", apiKeyAuth(["notifications:read"], handle), async (c) => {
    const apiKey = c.get("apiKey");
    const parsed = listQuerySchema.safeParse({
      status: c.req.query("status") || undefined,
      watchId: c.req.query("watchId") || undefined,
      channel: c.req.query("channel") || undefined,
      since: c.req.query("since") || undefined,
      limit: c.req.query("limit") || undefined,
      cursor: c.req.query("cursor") || undefined,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: "invalid query", field: issue?.path.join(".") || undefined, reason: issue?.message }, 422);
    }
    const { status, watchId, channel, since, limit, cursor: cursorRaw } = parsed.data;
    const operator = await isOperator(handle, apiKey.userId);

    let cursor: ListCursor | undefined;
    if (cursorRaw !== undefined) {
      cursor = decodeCursor(cursorRaw);
      if (!cursor) return c.json({ error: "invalid query", field: "cursor", reason: "malformed cursor" }, 422);
    }

    const clauses = operator ? [] : [eq(schema.notification.userId, apiKey.userId)];
    if (status) clauses.push(eq(schema.notification.status, status));
    if (channel) clauses.push(eq(schema.notification.channel, channel));
    // Filters on `createdAt` (always set, every status) instead of `sentAt`
    // (null for every row that hasn't terminally succeeded yet) — `since` used to hide
    // exactly the fresh `pending`/`sending` rows it should surface.
    if (since) clauses.push(gte(schema.notification.createdAt, new Date(since)));
    if (cursor) {
      clauses.push(sql`(${schema.notification.createdAt}, ${schema.notification.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
    }

    // A single deterministic total order (`createdAt desc, id desc` — every
    // row has a non-null `createdAt` set at insert time, migration 0017) replaces the
    // former pending/terminal "bucket swap", which put every `pending` row ahead of all
    // `sent`/`failed` history with no id tiebreak — unbounded and nondeterministic. Fetch
    // one extra row to detect whether a further page exists.
    const rows = await handle.db
      .select({
        id: schema.notification.id,
        matchId: schema.notification.matchId,
        notifierId: schema.notification.notifierId,
        userId: schema.notification.userId,
        channel: schema.notification.channel,
        status: schema.notification.status,
        attempts: schema.notification.attempts,
        nextAttemptAt: schema.notification.nextAttemptAt,
        lastError: schema.notification.lastError,
        providerMessageId: schema.notification.providerMessageId,
        sentAt: schema.notification.sentAt,
        createdAtText: sql<string>`to_char(${schema.notification.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        postTitle: schema.post.title,
        postUrl: schema.post.url,
        watchName: schema.watch.name,
        watchId: schema.match.watchId,
      })
      .from(schema.notification)
      .leftJoin(schema.match, eq(schema.notification.matchId, schema.match.id))
      .leftJoin(schema.post, eq(schema.match.postId, schema.post.id))
      .leftJoin(schema.watch, eq(schema.match.watchId, schema.watch.id))
      .where(and(...clauses, ...(watchId ? [eq(schema.match.watchId, watchId)] : [])))
      .orderBy(sql`${schema.notification.createdAt} desc`, sql`${schema.notification.id} desc`)
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(last.createdAtText, last.id) : null;

    const notifications = page.map((r) => ({
      id: r.id,
      matchId: r.matchId,
      notifierId: r.notifierId,
      userId: r.userId,
      channel: r.channel,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      lastError: r.lastError,
      providerMessageId: r.providerMessageId,
      sentAt: r.sentAt,
      post: r.postTitle !== null || r.postUrl !== null ? { title: r.postTitle, url: r.postUrl } : undefined,
      watch: r.watchName !== null ? { id: r.watchId, name: r.watchName } : undefined,
    }));

    return c.json({ notifications, nextCursor });
  });

  app.get("/api/notifications/:id", apiKeyAuth(["notifications:read"], handle), async (c) => {
    const idParsed = idParamSchema.safeParse(c.req.param("id"));
    if (!idParsed.success) return c.json({ error: "not found" }, 404);
    const apiKey = c.get("apiKey");
    const operator = await isOperator(handle, apiKey.userId);
    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, idParsed.data)).limit(1);
    if (!row || (!operator && row.userId !== apiKey.userId)) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.post("/api/notifications/:id/retry", apiKeyAuth(["notifications:write"], handle), async (c) => {
    const idParsed = idParamSchema.safeParse(c.req.param("id"));
    if (!idParsed.success) return c.json({ error: "not found" }, 404);
    const apiKey = c.get("apiKey");
    const operator = await isOperator(handle, apiKey.userId);
    if (!operator) return c.json({ error: "operator role required" }, 403);

    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, idParsed.data)).limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "failed") return c.json({ error: "conflict", reason: "only failed notifications can be retried" }, 409);

    // `failedAt` (set by `notify.ts` alongside every `status = 'failed'`
    // transition) was left in place after a retry, so a row that later succeeds is counted
    // as both a failure and a success by `/status`'s `failedAt >= since OR sentAt >= since`.
    // Clearing it here matches the other retry-reset fields.
    const [updated] = await handle.db
      .update(schema.notification)
      .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null, failedAt: null })
      .where(eq(schema.notification.id, row.id))
      .returning();

    // An ops row (`matchId` null) has no `notify` job to re-send — resetting it
    // to `pending` above is enough, the `notify_ops_flush` cron (`notify-ops.ts`, every
    // minute) picks up any pending ops row regardless of how it got there.
    if (boss && row.matchId) await boss.send("notify", { matchId: row.matchId });

    return c.json(updated);
  });

  return app;
}
