import { validateConfigWrite } from "@feedhound/core/config-registry";
import { allConfigJsonSchemas } from "@feedhound/core/config-schema";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireRole, requireSession } from "../middleware/session";

const putConfigSchema = z.object({
  value: z.unknown(),
  baseVersion: z.number().int().min(0),
});

/** Postgres unique-violation (SQLSTATE 23505), as surfaced by the `postgres` driver. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Human label for `updatedBy`: user email, "seed", "migration", else the raw value. */
async function withUpdatedByLabel<T extends { updatedBy: string }>(handle: DbHandle, rows: T[]): Promise<(T & { updatedByLabel: string })[]> {
  const ids = [...new Set(rows.map((r) => r.updatedBy).filter((v) => UUID_RE.test(v)))];
  const emails = new Map<string, string>();
  if (ids.length > 0) {
    const users = await handle.db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(inArray(schema.user.id, ids));
    for (const u of users) emails.set(u.id, u.email);
  }
  return rows.map((r) => ({
    ...r,
    updatedByLabel: emails.get(r.updatedBy) ?? (r.updatedBy.startsWith("migration:") ? "migration" : r.updatedBy),
  }));
}

/** `GET/PUT /api/config*`. Read: any session; write: operator. */
export function configRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/config/schema", cfAccessAuth(handle), requireSession(), (c) => {
    return c.json(allConfigJsonSchemas());
  });

  app.get("/api/config/:key/versions", cfAccessAuth(handle), requireSession(), async (c) => {
    const key = c.req.param("key");
    const rows = await handle.db
      .select()
      .from(schema.config)
      .where(eq(schema.config.key, key))
      .orderBy(desc(schema.config.version));
    return c.json({ versions: await withUpdatedByLabel(handle, rows) });
  });

  app.get("/api/config", cfAccessAuth(handle), requireSession(), async (c) => {
    // Current value per key = the row with max(version) (append-only schema).
    const rows = await handle.db
      .selectDistinctOn([schema.config.key], {
        key: schema.config.key,
        version: schema.config.version,
        value: schema.config.value,
        updatedBy: schema.config.updatedBy,
        updatedAt: schema.config.updatedAt,
      })
      .from(schema.config)
      .orderBy(schema.config.key, desc(schema.config.version));
    return c.json({ config: await withUpdatedByLabel(handle, rows) });
  });

  app.put("/api/config/:key", cfAccessAuth(handle), requireRole("operator"), async (c) => {
    const key = c.req.param("key");
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = putConfigSchema.safeParse(json);
    const keyCheck = validateConfigWrite(key, parsed.success ? parsed.data.value : undefined);
    if (!keyCheck.ok && keyCheck.error === "unknown_key") return c.json({ error: "validation", message: `unknown config key: ${key}` }, 400);
    if (!keyCheck.ok && keyCheck.error === "internal_key") return c.json({ error: "internal_key", message: `${key} is managed by the system and cannot be edited` }, 403);
    if (!parsed.success) return c.json({ error: "validation", message: "invalid body", issues: parsed.error.issues }, 400);
    if (!keyCheck.ok) return c.json({ error: "validation", message: "value does not match schema", issues: keyCheck.issues }, 400);
    const valueParsed = { data: keyCheck.value };

    const [current] = await handle.db
      .select({ version: schema.config.version })
      .from(schema.config)
      .where(eq(schema.config.key, key))
      .orderBy(desc(schema.config.version))
      .limit(1);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== parsed.data.baseVersion) {
      return c.json({ error: "conflict", message: "baseVersion is stale", currentVersion }, 409);
    }

    const session = c.get("session");
    const nextVersion = currentVersion + 1;
    let row: typeof schema.config.$inferSelect | undefined;
    try {
      [row] = await handle.db
        .insert(schema.config)
        .values({ key, version: nextVersion, value: valueParsed.data as unknown, updatedBy: session.userId })
        .returning();
    } catch (err) {
      // read-max-version-then-insert is not
      // atomic. Two concurrent PUTs with the same baseVersion both pass the
      // check above and collide on the (key, version) PK; the loser must
      // get the documented 409, not an unhandled 500.
      if (isUniqueViolation(err)) return c.json({ error: "conflict", message: "baseVersion is stale", currentVersion }, 409);
      throw err;
    }
    await handle.sql.notify("config_changed", key);
    return c.json(row);
  });

  return app;
}
