import { savedSearchParamsSchema } from "@feedhound/core/search-query";
import { schema, type DbHandle } from "@feedhound/db";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";

const MAX_PER_USER = 50;

const createSchema = z.object({ name: z.string().min(1).max(60), params: savedSearchParamsSchema });
const patchSchema = z.object({ name: z.string().min(1).max(60).optional(), params: savedSearchParamsSchema.optional() });

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 4; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function view(r: typeof schema.savedSearch.$inferSelect, viewerId: string): { id: string; name: string; params: unknown; mine: boolean; createdAt: string; updatedAt: string } {
  return { id: r.id, name: r.name, params: r.query, mine: r.userId === viewerId, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

/**
 * `/api/saved-searches` CRUD. Team-visible. List/read by team; PATCH/DELETE by the creator
 * or an operator of the team (else 403 `not_owner`); another team's id is 404. Limits and unique names stay per creator.
 */
export function savedSearchesRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();
  const auth = [cfAccessAuth(handle), requireSession()] as const;

  const byId = (id: string) => eq(schema.savedSearch.id, id);
  /** The row when its creator belongs to `teamId`. */
  async function inTeam(id: string, teamId: string): Promise<typeof schema.savedSearch.$inferSelect | undefined> {
    const [row] = await handle.db
      .select({ s: schema.savedSearch })
      .from(schema.savedSearch)
      .innerJoin(schema.user, eq(schema.user.id, schema.savedSearch.userId))
      .where(and(byId(id), eq(schema.user.teamId, teamId)));
    return row?.s;
  }
  const mayChange = (row: { userId: string }, s: Session): boolean => row.userId === s.userId || s.role === "operator";
  const validation = (message: string, issues?: unknown) => ({ error: "validation" as const, message, issues });

  app.get("/api/saved-searches", ...auth, async (c) => {
    const session = c.get("session");
    const rows = await handle.db
      .select({ s: schema.savedSearch })
      .from(schema.savedSearch)
      .innerJoin(schema.user, eq(schema.user.id, schema.savedSearch.userId))
      .where(eq(schema.user.teamId, session.teamId))
      .orderBy(asc(schema.savedSearch.name));
    return c.json({ items: rows.map((r) => view(r.s, session.userId)) });
  });

  app.post("/api/saved-searches", ...auth, async (c) => {
    const { userId } = c.get("session");
    const body = createSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json(validation("invalid body", body.error.issues), 400);
    try {
      // count + insert under a per-user advisory lock so concurrent POSTs cannot pass the 50 limit
      const id = await handle.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`saved_search:${userId}`}))`);
        const [n] = await tx.select({ n: count() }).from(schema.savedSearch).where(eq(schema.savedSearch.userId, userId));
        if ((n?.n ?? 0) >= MAX_PER_USER) return null;
        const [row] = await tx.insert(schema.savedSearch).values({ userId, name: body.data.name, query: body.data.params }).returning({ id: schema.savedSearch.id });
        return row!.id;
      });
      if (id === null) return c.json({ error: "limit_reached" }, 409);
      return c.json({ id }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "duplicate_name" }, 409);
      throw err;
    }
  });

  app.patch("/api/saved-searches/:id", ...auth, async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: "not_found" }, 404);
    const existing = await inTeam(id, session.teamId);
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (!mayChange(existing, session)) return c.json({ error: "not_owner" }, 403);
    const body = patchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json(validation("invalid body", body.error.issues), 400);
    try {
      const [row] = await handle.db
        .update(schema.savedSearch)
        .set({
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
          ...(body.data.params !== undefined ? { query: body.data.params } : {}),
          updatedAt: new Date(),
        })
        .where(byId(id))
        .returning();
      return c.json(view(row!, session.userId));
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "duplicate_name" }, 409);
      throw err;
    }
  });

  app.delete("/api/saved-searches/:id", ...auth, async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: "not_found" }, 404);
    const existing = await inTeam(id, session.teamId);
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (!mayChange(existing, session)) return c.json({ error: "not_owner" }, 403);
    await handle.db.delete(schema.savedSearch).where(byId(id));
    return c.body(null, 204);
  });

  return app;
}
