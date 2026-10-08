import { schema, type DbHandle } from "@feedhound/db";
import { and, desc, eq, isNull, or, sql, count } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT), cursor: z.string().max(200).optional() });

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(raw: string): { createdAt: string; id: string } | undefined {
  const [iso, id, extra] = Buffer.from(raw, "base64url").toString().split("|");
  if (extra !== undefined || !iso || !id) return undefined;
  if (Number.isNaN(Date.parse(iso)) || !z.string().uuid().safeParse(id).success) return undefined;
  return { createdAt: iso, id };
}

/**
 * `/api/insights` inbox: keyset by (created_at desc, id desc). Team-visible;
 * read state is shared (any team member may mark an insight read); delivery stays with the creator.
 */
export function insightsRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();
  const auth = [cfAccessAuth(handle), requireSession()] as const;

  app.get("/api/insights", ...auth, async (c) => {
    const { userId, teamId } = c.get("session");
    const q = querySchema.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "validation", message: "invalid query", issues: q.error.issues }, 400);
    const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : undefined;
    if (q.data.cursor && !cursor) return c.json({ error: "invalid_cursor" }, 400);
    const rows = await handle.db
      .select()
      .from(schema.insight)
      .where(
        and(
          eq(schema.insight.teamId, teamId),
          cursor
            ? or(
                sql`${schema.insight.createdAt} < ${cursor.createdAt}::timestamptz`,
                and(sql`${schema.insight.createdAt} = ${cursor.createdAt}::timestamptz`, sql`${schema.insight.id} < ${cursor.id}::uuid`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.insight.createdAt), desc(schema.insight.id))
      .limit(q.data.limit + 1);
    const page = rows.slice(0, q.data.limit);
    const last = page[page.length - 1];
    const [u] = await handle.db.select({ n: count() }).from(schema.insight).where(and(eq(schema.insight.teamId, teamId), isNull(schema.insight.readAt)));
    return c.json({
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        topicId: r.topicId,
        day: r.day,
        text: r.text,
        payload: r.payload,
        delivery: r.delivery,
        deliveryError: r.deliveryError,
        mine: r.userId === userId,
        readAt: r.readAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > q.data.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      unread: u?.n ?? 0,
    });
  });

  app.post("/api/insights/:id/read", ...auth, async (c) => {
    const { teamId } = c.get("session");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: "not_found" }, 404);
    const rows = await handle.db
      .update(schema.insight)
      .set({ readAt: sql`coalesce(${schema.insight.readAt}, now())` })
      .where(and(eq(schema.insight.id, id), eq(schema.insight.teamId, teamId)))
      .returning({ id: schema.insight.id });
    if (rows.length === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
