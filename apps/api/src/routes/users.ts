import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireRole, requireSession } from "../middleware/session";

const createUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(["hunter", "operator"]),
});

const patchUserSchema = z.object({
  role: z.enum(["hunter", "operator"]).optional(),
  telegramChatId: z.string().nullable().optional(),
});

/** `GET/POST/PATCH/DELETE /api/members`. */
export function usersRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/members", cfAccessAuth(handle), requireRole("operator"), async (c) => {
    const rows = await handle.db
      .select({
        id: schema.user.id,
        email: schema.user.email,
        role: schema.user.role,
        teamId: schema.user.teamId,
        telegramChatId: schema.user.telegramChatId,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .where(eq(schema.user.teamId, c.get("session").teamId));
    return c.json({ users: rows });
  });

  app.post("/api/members", cfAccessAuth(handle), requireRole("operator"), async (c) => {
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = createUserSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", message: "invalid body", issues: parsed.error.issues }, 400);

    const email = parsed.data.email.toLowerCase();
    const [existing] = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email)).limit(1);
    if (existing) return c.json({ error: "conflict", message: "a user with this email already exists" }, 409);

    const session = c.get("session");
    const [row] = await handle.db.insert(schema.user).values({ email, role: parsed.data.role, teamId: session.teamId }).returning();
    return c.json(row, 201);
  });

  app.patch("/api/members/:id", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = patchUserSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", message: "invalid body", issues: parsed.error.issues }, 400);

    const isSelf = id === session.userId;
    if (session.role !== "operator") {
      // Non-operators may only patch their own telegramChatId.
      if (!isSelf || parsed.data.role !== undefined) {
        return c.json({ error: "forbidden", message: "operator role required" }, 403);
      }
    }

    const [existing] = await handle.db.select({ teamId: schema.user.teamId }).from(schema.user).where(eq(schema.user.id, id)).limit(1);
    if (!existing || existing.teamId !== session.teamId) return c.json({ error: "not_found", message: "user not found" }, 404);

    const setValues: Partial<typeof schema.user.$inferInsert> = {};
    if (parsed.data.role !== undefined) setValues.role = parsed.data.role;
    if (parsed.data.telegramChatId !== undefined) setValues.telegramChatId = parsed.data.telegramChatId;

    const [row] = await handle.db.update(schema.user).set(setValues).where(eq(schema.user.id, id)).returning();
    return c.json(row);
  });

  app.delete("/api/members/:id", cfAccessAuth(handle), requireRole("operator"), async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (id === session.userId) return c.json({ error: "validation", message: "cannot delete yourself" }, 400);

    const [existing] = await handle.db.select({ teamId: schema.user.teamId }).from(schema.user).where(eq(schema.user.id, id)).limit(1);
    if (!existing || existing.teamId !== session.teamId) return c.json({ error: "not_found", message: "user not found" }, 404);

    // deleting a user cascades their `watch` rows
    // to `match` (history wiped), same as `DELETE /api/watches/:id` — require
    // the same explicit `?confirm=true` so this can't happen by accident.
    const [ownedWatch] = await handle.db.select({ id: schema.watch.id }).from(schema.watch).where(eq(schema.watch.userId, id)).limit(1);

    // Deleting a user cascades their `api_key` rows (schema
    // `api_key.user_id onDelete: cascade`); any `source` those keys are assigned to
    // (`source.assigned_key_id onDelete: set null`) silently loses its key — the next
    // push 403s (`apps/api/src/routes/ingest.ts`) with no immediate signal,
    // only the delayed `source_silent` alert once the source has been quiet long enough.
    const assignedSources = await handle.db
      .select({ id: schema.source.id })
      .from(schema.source)
      .innerJoin(schema.apiKey, eq(schema.apiKey.id, schema.source.assignedKeyId))
      .where(eq(schema.apiKey.userId, id));

    if ((ownedWatch || assignedSources.length > 0) && c.req.query("confirm") !== "true") {
      const reasons: string[] = [];
      if (ownedWatch) reasons.push("permanently deletes their watches' match history");
      if (assignedSources.length > 0) reasons.push(`detaches the ingest key from ${assignedSources.length} source(s), which will stop accepting pushes until reassigned`);
      return c.json({ error: "confirmation required", reason: `deleting this user ${reasons.join(" and ")}; retry with ?confirm=true` }, 400);
    }

    // The user delete and the now-keyless sources' health writes used to be
    // separate statements — a crash between them left those sources still reporting
    // `health.ok: true` even though their ingest key's owner (and so, via cascade, the
    // key) is already gone. One transaction makes both happen or neither.
    //
    // The `assignedSources` computed above (outside this transaction, with
    // no row lock) can go stale under a concurrent reassignment -- e.g. an operator
    // reassigns a source's `assignedKeyId` to a different, still-valid key between that
    // read and this transaction, and we'd wrongly stamp `health.ok: false` on a source
    // that now has a working key (or the reverse: a source reassigned away from this
    // user's key in the other direction is left un-flagged). Recompute the set inside
    // the transaction with `FOR UPDATE` on `source` so a concurrent reassignment either
    // completes first (and we see its result) or waits until after this delete commits.
    await handle.db.transaction(async (tx) => {
      const lockedAssignedSources = await tx
        .select({ id: schema.source.id })
        .from(schema.source)
        .innerJoin(schema.apiKey, eq(schema.apiKey.id, schema.source.assignedKeyId))
        .where(eq(schema.apiKey.userId, id))
        .for("update");

      await tx.delete(schema.user).where(eq(schema.user.id, id));

      // Mark the now-keyless sources' health immediately instead of leaving
      // them silently broken until the delayed `source_silent` watchdog alert — an operator
      // reassigning a key sees why right away via `GET /api/sources`/`source.health` (WS).
      for (const source of lockedAssignedSources) {
        await tx
          .update(schema.source)
          .set({ health: { ok: false, reason: "ingest key owner deleted" } })
          .where(eq(schema.source.id, source.id));
      }
    });

    return c.body(null, 204);
  });

  return app;
}
