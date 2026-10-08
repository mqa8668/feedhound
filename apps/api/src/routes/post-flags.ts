import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";

const paramsSchema = z.object({ id: z.string().uuid(), kind: z.enum(["saved", "hidden"]) });

/**
 * Per-user `saved` / `hidden` flags. A post of another team is a 404 (never 403).
 * `hidden` also stores the post's `repost_key`, so the same seller's identical listing in other groups is hidden too.
 */
export function postFlagsRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  async function ownPost(teamId: string, id: string): Promise<{ repostKey: string | null } | undefined> {
    const [row] = await handle.db
      .select({ repostKey: schema.post.repostKey })
      .from(schema.post)
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .where(and(eq(schema.post.id, id), eq(schema.source.teamId, teamId)))
      .limit(1);
    return row;
  }

  app.put("/api/posts/:id/flags/:kind", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const params = paramsSchema.safeParse({ id: c.req.param("id"), kind: c.req.param("kind") });
    if (!params.success) return c.json({ error: "validation", message: "invalid id or kind" }, 400);
    const post = await ownPost(session.teamId, params.data.id);
    if (!post) return c.json({ error: "not_found" }, 404);
    await handle.db
      .insert(schema.postUserFlag)
      .values({ userId: session.userId, postId: params.data.id, kind: params.data.kind, repostKey: post.repostKey })
      .onConflictDoNothing();
    return c.body(null, 204);
  });

  app.delete("/api/posts/:id/flags/:kind", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const params = paramsSchema.safeParse({ id: c.req.param("id"), kind: c.req.param("kind") });
    if (!params.success) return c.json({ error: "validation", message: "invalid id or kind" }, 400);
    if (!(await ownPost(session.teamId, params.data.id))) return c.json({ error: "not_found" }, 404);
    await handle.db
      .delete(schema.postUserFlag)
      .where(and(eq(schema.postUserFlag.userId, session.userId), eq(schema.postUserFlag.postId, params.data.id), eq(schema.postUserFlag.kind, params.data.kind)));
    return c.body(null, 204);
  });

  return app;
}
