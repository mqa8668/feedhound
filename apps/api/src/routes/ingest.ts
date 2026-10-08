import { createLogger } from "@feedhound/core/logger";
import { ingestRequestSchema } from "@feedhound/core/sources";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";
import { rateLimit } from "../middleware/rate-limit";
import { ingestPosts } from "../services/corpus";

const logger = createLogger({ service: "api" });

// Code-review finding #6: cap the raw request body so a misbehaving/hostile
// key can't exhaust memory before zod validation even runs.
const INGEST_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

const uuidSchema = z.string().uuid();

/**
 * Tag this batch's posts with the visit that ingested
 * them, and stub a `visit` row for `visitId` if none exists yet (a later
 * `POST /api/visits` for the same id completes it). Non-uuid `visitId`
 * (legacy clients) is ignored by the caller before this runs. A `visitId`
 * that already belongs to a different source is left untagged (logged) —
 * that source's own `/api/visits` conflict guard is the source of truth.
 */
async function tagVisit(handle: DbHandle, visitId: string, sourceId: string, platformPostIds: string[]): Promise<void> {
  await handle.db.insert(schema.visit).values({ id: visitId, sourceId, startedAt: new Date() }).onConflictDoNothing({ target: schema.visit.id });

  const [visitRow] = await handle.db.select({ sourceId: schema.visit.sourceId }).from(schema.visit).where(eq(schema.visit.id, visitId)).limit(1);
  if (!visitRow) return;
  if (visitRow.sourceId !== sourceId) {
    logger.warn({ visitId, sourceId, actualSourceId: visitRow.sourceId }, "ingest visitId belongs to another source; skipping post tagging");
    return;
  }
  if (platformPostIds.length === 0) return;

  await handle.db
    .update(schema.post)
    .set({ visitId })
    .where(and(eq(schema.post.sourceId, sourceId), inArray(schema.post.platformPostId, platformPostIds), isNull(schema.post.visitId)));
}

/** `POST /api/ingest` — behaviour rules 1, 2, 3 (corpus write path). */
export function ingestRoute(handle: DbHandle, boss: PgBoss | undefined): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  app.post(
    "/api/ingest",
    apiKeyAuth(["ingest"], handle),
    rateLimit(),
    bodyLimit({ maxSize: INGEST_BODY_LIMIT_BYTES, onError: (c) => c.json({ error: "payload too large" }, 413) }),
    async (c) => {
      const json: unknown = await c.req.json().catch(() => undefined);
      const parsed = ingestRequestSchema.safeParse(json);
      if (!parsed.success) return c.json({ error: "invalid body" }, 400);
      const { sourceId, posts, visitId } = parsed.data;

      const apiKey = c.get("apiKey");
      if (!apiKey.sourceIds.includes(sourceId)) return c.json({ error: "source not assigned to key" }, 403);

      // Finding #5: fail fast (503) rather than silently dropping enrich jobs
      // when pg-boss is unavailable — documented choice over losing enrichment.
      if (!boss) return c.json({ error: "enrich queue unavailable" }, 503);

      const result = await ingestPosts(handle, boss, sourceId, posts);
      await handle.db.update(schema.source).set({ lastIngestAt: new Date() }).where(eq(schema.source.id, sourceId));

      if (uuidSchema.safeParse(visitId).success) {
        await tagVisit(
          handle,
          visitId,
          sourceId,
          posts.map((p) => p.platformPostId),
        );
      }

      return c.json(result);
    },
  );

  return app;
}
