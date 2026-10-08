import { healthRequestSchema } from "@feedhound/core/sources";
import { createLogger } from "@feedhound/core/logger";
import type { Db, DbHandle } from "@feedhound/db";
import { enqueueOpsNotification, schema } from "@feedhound/db";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";
import { rateLimit } from "../middleware/rate-limit";

const logger = createLogger({ service: "api" });

// `/api/health` bodies are tiny (sourceId, ok, reason,
// visitId); cap the raw request well above any legitimate payload but far
// below `ingest`'s 5 MB, so a misbehaving/hostile key can't send an
// oversized body.
const HEALTH_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Inserts an ops Notification (channel "ops") attributed to the team's
 * operator user. No-op (logged only) if the team has no operator user yet.
 */
/** Anything that can run select/insert: a handle or a transaction wrapper. */
export interface DbExec {
  db: Pick<Db, "select" | "insert">;
}

export async function insertOpsAlert(handle: DbExec, teamId: string, text: string): Promise<void> {
  logger.warn({ teamId, text }, "ops alert");
  const [operator] = await handle.db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(and(eq(schema.user.teamId, teamId), eq(schema.user.role, "operator")))
    .orderBy(asc(schema.user.createdAt))
    .limit(1);
  if (!operator) return;
  const kind = "source_health";
  // Goes through the shared enqueue so an unset chat is born `skipped`.
  await enqueueOpsNotification(handle, operator.id, { kind, text, dedupeKey: `${kind}:${teamId}:${text}`, ttlSec: 0 }, new Date());
}

/** `POST /api/health` — (source silence/pause reporting). */
export function healthRoute(handle: DbHandle): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  app.post(
    "/api/health",
    apiKeyAuth(["ingest"], handle),
    rateLimit(),
    bodyLimit({ maxSize: HEALTH_BODY_LIMIT_BYTES, onError: (c) => c.json({ error: "payload too large" }, 413) }),
    async (c) => {
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = healthRequestSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const { sourceId } = parsed.data;

    const apiKey = c.get("apiKey");
    if (!apiKey.sourceIds.includes(sourceId)) return c.json({ error: "source not assigned to key" }, 403);

    const [source] = await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId)).limit(1);
    if (!source) return c.json({ error: "unknown source" }, 404);

    // Stamp only. Pause/resume/alerts are decided from the visit
    // ledger (`POST /api/visits` -> `applyVisitOutcome`).
    await handle.db.update(schema.source).set({ lastHealthAt: new Date() }).where(eq(schema.source.id, sourceId));

      return c.json({ ok: true });
    },
  );

  return app;
}
