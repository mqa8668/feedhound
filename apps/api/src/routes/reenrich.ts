import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";
import { rateLimit } from "../middleware/rate-limit";

const ENRICH_QUEUE = "enrich";

const reenrichSchema = z.object({
  force: z.boolean().optional(),
  engine: z.enum(["rule", "llm"]).optional(),
});

const idParamSchema = z.string().uuid();

export interface ReenrichBoss {
  send(name: string, data: object, opts?: Record<string, unknown>): Promise<string | null>;
}

/** Team of the user who owns the calling api key (mirrors `sources.ts` `loadCaller`). */
async function fetchTeamId(handle: DbHandle, apiKey: ApiKeyContext): Promise<string | undefined> {
  const [row] = await handle.db.select({ teamId: schema.user.teamId }).from(schema.user).where(eq(schema.user.id, apiKey.userId)).limit(1);
  return row?.teamId;
}

/**
 * `POST /api/posts/:id/reenrich`: enqueues `enrich`
 * with `force=true`; `engine` passthrough.
 */
export function reenrichRoute(handle: DbHandle, boss?: ReenrichBoss): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  app.post("/api/posts/:id/reenrich", apiKeyAuth(["catalogue:write"], handle), rateLimit(), async (c) => {
    const idRaw = c.req.param("id");
    // a non-uuid id used to fall through to
    // Postgres and error as a 22P02 -> unhandled 500.
    const idParsed = idParamSchema.safeParse(idRaw);
    if (!idParsed.success) return c.json({ error: "validation", message: "id must be a uuid" }, 400);
    const id = idParsed.data;

    const json: unknown = await c.req.json().catch(() => ({}));
    const parsed = reenrichSchema.safeParse(json ?? {});
    if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);

    const apiKey = c.get("apiKey");
    const teamId = await fetchTeamId(handle, apiKey);
    if (!teamId) return c.json({ error: "not_found" }, 404);

    // no team scoping let any `catalogue:write`
    // key re-enrich another team's post (and 404-vs-202 probe post ids
    // across teams). Join through source.teamId, same as `unclassified.ts`.
    const [post] = await handle.db
      .select({ id: schema.post.id, editCount: schema.post.editCount })
      .from(schema.post)
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .where(and(eq(schema.post.id, id), eq(schema.source.teamId, teamId)))
      .limit(1);
    if (!post) return c.json({ error: "not_found" }, 404);

    if (!boss) return c.json({ error: "unavailable", message: "job queue not configured" }, 503);

    const jobId = await boss.send(
      ENRICH_QUEUE,
      { postId: post.id, revision: post.editCount, force: true, engine: parsed.data.engine },
      { singletonKey: `enrich:${post.id}:${post.editCount}:${Date.now()}`, retryLimit: 3, retryBackoff: true },
    );
    return c.json({ jobId }, 202);
  });

  return app;
}
