import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireRole } from "../middleware/session";
import { generateApiKey } from "../services/keys";

const SCOPES = ["ingest", "sources:read", "sources:write"] as const;

const createKeySchema = z.object({
  name: z.string().min(1),
  userId: z.string().uuid(),
  scopes: z.array(z.enum(SCOPES)).min(1),
});

/** `GET/POST/DELETE /api/keys` (operator only). */
export function keysRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/keys", cfAccessAuth(handle), requireRole("operator"), async (c) => {
    const session = c.get("session");
    const rows = await handle.db
      .select({
        id: schema.apiKey.id,
        userId: schema.apiKey.userId,
        name: schema.apiKey.name,
        prefix: schema.apiKey.prefix,
        scopes: schema.apiKey.scopes,
        lastUsedAt: schema.apiKey.lastUsedAt,
        createdAt: schema.apiKey.createdAt,
        revokedAt: schema.apiKey.revokedAt,
      })
      .from(schema.apiKey)
      .innerJoin(schema.user, eq(schema.apiKey.userId, schema.user.id))
      .where(eq(schema.user.teamId, session.teamId));
    return c.json({ keys: rows });
  });

  app.post("/api/keys", cfAccessAuth(handle), requireRole("operator"), async (c) => {
    const session = c.get("session");
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = createKeySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", message: "invalid body", issues: parsed.error.issues }, 400);

    const [targetUser] = await handle.db
      .select({ id: schema.user.id, teamId: schema.user.teamId })
      .from(schema.user)
      .where(eq(schema.user.id, parsed.data.userId))
      .limit(1);
    if (!targetUser || targetUser.teamId !== session.teamId) return c.json({ error: "validation", message: "userId does not exist" }, 400);

    const generated = await generateApiKey();
    const [row] = await handle.db
      .insert(schema.apiKey)
      .values({
        userId: parsed.data.userId,
        name: parsed.data.name,
        prefix: generated.prefix,
        hash: generated.hash,
        scopes: parsed.data.scopes,
      })
      .returning({ id: schema.apiKey.id, prefix: schema.apiKey.prefix });
    // Plaintext key returned exactly once.
    return c.json({ id: row?.id, prefix: row?.prefix, key: generated.key }, 201);
  });

  app.delete("/api/keys/:id", cfAccessAuth(handle), requireRole("operator"), async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const [existing] = await handle.db
      .select({ id: schema.apiKey.id, teamId: schema.user.teamId })
      .from(schema.apiKey)
      .innerJoin(schema.user, eq(schema.apiKey.userId, schema.user.id))
      .where(eq(schema.apiKey.id, id))
      .limit(1);
    if (!existing || existing.teamId !== session.teamId) return c.json({ error: "not_found", message: "key not found" }, 404);

    await handle.db.update(schema.apiKey).set({ revokedAt: new Date() }).where(eq(schema.apiKey.id, id));
    return c.body(null, 204);
  });

  return app;
}
