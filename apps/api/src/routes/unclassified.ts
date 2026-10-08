import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";

const DEFAULT_LIMIT = 20;
const DEFAULT_RULE_CONFIDENCE_MIN = 0.7;

async function fetchRuleConfidenceMin(handle: DbHandle): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "enrich.ruleConfidenceMin"))
    .orderBy(sql`${schema.config.version} desc`)
    .limit(1);
  return typeof row?.value === "number" ? row.value : DEFAULT_RULE_CONFIDENCE_MIN;
}

/** Team of the user who owns the calling api key (mirrors `sources.ts` `loadCaller`). */
async function fetchTeamId(handle: DbHandle, apiKey: ApiKeyContext): Promise<string | undefined> {
  const [row] = await handle.db.select({ teamId: schema.user.teamId }).from(schema.user).where(eq(schema.user.id, apiKey.userId)).limit(1);
  return row?.teamId;
}

/**
 * `GET /api/enrichment/unclassified`: posts whose
 * Enrichment has `categoryId = null` or `confidence < enrich.ruleConfidenceMin`,
 * newest first.
 */
export function unclassifiedRoute(handle: DbHandle): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  app.get("/api/enrichment/unclassified", apiKeyAuth(["catalogue:read"], handle), async (c) => {
    const apiKey = c.get("apiKey");
    // this endpoint read post id/title/url across
    // every team for any key with `catalogue:read`; scope it to the
    // caller's team the same way `GET /api/posts` does (source.teamId).
    const teamId = await fetchTeamId(handle, apiKey);
    if (!teamId) return c.json({ items: [], nextCursor: null });

    const limitRaw = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : DEFAULT_LIMIT;
    const cursor = c.req.query("cursor");
    const ruleConfidenceMin = await fetchRuleConfidenceMin(handle);

    const clauses = [
      sql`(${schema.enrichment.categoryId} is null or ${schema.enrichment.confidence} < ${ruleConfidenceMin})`,
      eq(schema.source.teamId, teamId),
    ];
    if (cursor) {
      clauses.push(sql`${schema.post.firstSeenAt} < (select first_seen_at from post where id = ${cursor})`);
    }

    const rows = await handle.db
      .select({
        postId: schema.post.id,
        title: schema.post.title,
        url: schema.post.url,
        firstSeenAt: schema.post.firstSeenAt,
        enrichment: schema.enrichment,
      })
      .from(schema.enrichment)
      .innerJoin(schema.post, eq(schema.post.id, schema.enrichment.postId))
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .where(and(...clauses))
      .orderBy(sql`${schema.post.firstSeenAt} desc`)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const items = sliced.map((r) => ({
      post: { id: r.postId, title: r.title, url: r.url, firstSeenAt: r.firstSeenAt },
      enrichment: r.enrichment,
    }));
    const nextCursor = hasMore ? (sliced[sliced.length - 1]?.postId ?? null) : null;
    return c.json({ items, nextCursor });
  });

  return app;
}
