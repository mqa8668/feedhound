import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// `watchId`/`since`/`limit` were parsed by hand
// (`Number(limitParam) || DEFAULT_LIMIT`, an unvalidated string passed
// straight into a uuid-typed `eq()`) — a non-uuid `watchId` reached Postgres
// and errored as a 500 instead of a 422. Validate all three up front.
const matchesQuerySchema = z.object({
  watchId: z.uuid().optional(),
  since: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "since must be a valid ISO datetime" })
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  // Was read raw via `c.req.query("userId")` and used
  // directly in a uuid-typed `eq()` before any validation ran — a malformed
  // `?userId=` reached Postgres and errored as a 500 instead of a 422.
  userId: z.uuid().optional(),
});

async function isOperator(handle: DbHandle, userId: string): Promise<boolean> {
  const [row] = await handle.db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  return row?.role === "operator";
}

/**
 * `GET /api/matches?watchId?&since?&limit?`: own
 * watches only (operator may pass `?userId=`), newest first, `limit` <= 200.
 */
export function matchesRoute(handle: DbHandle): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  app.get("/api/matches", apiKeyAuth(["watches:read"], handle), async (c) => {
    const apiKey = c.get("apiKey");

    const parsed = matchesQuerySchema.safeParse({
      watchId: c.req.query("watchId") || undefined,
      since: c.req.query("since") || undefined,
      limit: c.req.query("limit") || undefined,
      userId: c.req.query("userId") || undefined,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: "invalid query", field: issue?.path.join(".") || undefined, reason: issue?.message }, 422);
    }
    const { watchId: watchIdParam, since: sinceParam, limit, userId: queryUserId } = parsed.data;
    const targetUserId = queryUserId && (await isOperator(handle, apiKey.userId)) ? queryUserId : apiKey.userId;

    const clauses = [eq(schema.watch.userId, targetUserId)];
    if (watchIdParam) clauses.push(eq(schema.match.watchId, watchIdParam));
    if (sinceParam) clauses.push(gte(schema.match.createdAt, new Date(sinceParam)));

    const rows = await handle.db
      .select({
        id: schema.match.id,
        postId: schema.match.postId,
        watchId: schema.match.watchId,
        score: schema.match.score,
        matchedTerms: schema.match.matchedTerms,
        createdAt: schema.match.createdAt,
        postTitle: schema.post.title,
        postUrl: schema.post.url,
        postSourceId: schema.post.sourceId,
        postPostedAt: schema.post.postedAt,
        watchName: schema.watch.name,
      })
      .from(schema.match)
      .innerJoin(schema.watch, eq(schema.match.watchId, schema.watch.id))
      .innerJoin(schema.post, eq(schema.match.postId, schema.post.id))
      .where(and(...clauses))
      .orderBy(desc(schema.match.createdAt))
      .limit(limit);

    const matches = rows.map((r) => ({
      id: r.id,
      postId: r.postId,
      watchId: r.watchId,
      score: r.score,
      matchedTerms: r.matchedTerms,
      createdAt: r.createdAt,
      post: { id: r.postId, title: r.postTitle, url: r.postUrl, sourceId: r.postSourceId, postedAt: r.postPostedAt },
      watch: { id: r.watchId, name: r.watchName },
    }));

    return c.json({ matches });
  });

  return app;
}
