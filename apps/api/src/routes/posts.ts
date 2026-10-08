import type { DbHandle } from "@feedhound/db";
import { maskPii } from "@feedhound/core/pii";
import { deriveSnippet } from "@feedhound/core/snippet";
import { schema } from "@feedhound/db";
import { and, asc, desc, eq, exists, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";
import { buildListingFields, groupReposts, notHiddenFor, savedFor, savedPostIds } from "../services/listing";
import { readableWatches, teamSourceIds } from "../services/scope";

const MAX_DUPLICATES = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// A non-numeric / out-of-range `limit` keeps the old lenient behaviour; the new filters are strict.
const flag = z.literal("1").optional();
const feedQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v ?? DEFAULT_LIMIT);
      return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
    }),
  make: z.string().trim().min(1).max(60).optional(),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  region: z.string().trim().min(1).max(60).optional(),
  matched: flag.transform((v) => v === "1"),
  hideOther: flag.transform((v) => v === "1"),
  saved: flag.transform((v) => v === "1"),
});

/**
 * `GET /api/posts?limit=` — read-only subset backing Overview's live feed
 * (full corpus explorer is 006). Team-scoped, newest first.
 */
export function postsRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/posts", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const parsed = feedQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "validation", message: "invalid query", issues: parsed.error.issues }, 400);
    const q = parsed.data;

    const sourceRows = await handle.db.select({ id: schema.source.id }).from(schema.source).where(eq(schema.source.teamId, session.teamId));
    if (sourceRows.length === 0) return c.json({ posts: [] });

    const latestEnrichment = handle.db
      .selectDistinctOn([schema.enrichment.postId], {
        postId: schema.enrichment.postId,
        intent: schema.enrichment.intent,
        priceVnd: schema.enrichment.priceVnd,
        priceRaw: schema.enrichment.priceRaw,
        priceQualifier: schema.enrichment.priceQualifier,
        priceMaxVnd: schema.enrichment.priceMaxVnd,
        priceSuspect: schema.enrichment.priceSuspect,
        displayTitle: schema.enrichment.displayTitle,
        categoryId: schema.enrichment.categoryId,
        attributes: schema.enrichment.attributes,
        dealPct: schema.enrichment.dealPct,
        dealMedianVnd: schema.enrichment.dealMedianVnd,
        dealN: schema.enrichment.dealN,
      })
      .from(schema.enrichment)
      .orderBy(schema.enrichment.postId, desc(schema.enrichment.revision))
      .as("latest_enrichment");

    const conditions: SQL[] = [
      inArray(
        schema.post.sourceId,
        sourceRows.map((s) => s.id),
      ),
      notHiddenFor(session.userId),
    ];
    if (q.make) conditions.push(sql`lower(${latestEnrichment.attributes}->>'make') = lower(${q.make})`);
    if (q.priceMin !== undefined) conditions.push(gte(latestEnrichment.priceVnd, q.priceMin));
    if (q.priceMax !== undefined) conditions.push(lte(latestEnrichment.priceVnd, q.priceMax));
    if (q.region) conditions.push(sql`${latestEnrichment.attributes}->>'region' = ${q.region}`);
    if (q.hideOther) conditions.push(sql`(${latestEnrichment.intent} is null or ${latestEnrichment.intent} <> 'other')`);
    if (q.saved) conditions.push(savedFor(session.userId));
    if (q.matched) {
      conditions.push(
        exists(
          handle.db
            .select({ one: sql`1` })
            .from(schema.match)
            .innerJoin(schema.watch, eq(schema.watch.id, schema.match.watchId))
            .where(and(eq(schema.match.postId, schema.post.id), readableWatches(handle, session))),
        ),
      );
    }

    const rows = await handle.db
      .select({
        id: schema.post.id,
        sourceId: schema.post.sourceId,
        title: schema.post.title,
        url: schema.post.url,
        firstSeenAt: schema.post.firstSeenAt,
        intent: latestEnrichment.intent,
        priceVnd: latestEnrichment.priceVnd,
        priceRaw: latestEnrichment.priceRaw,
        priceQualifier: latestEnrichment.priceQualifier,
        priceMaxVnd: latestEnrichment.priceMaxVnd,
        priceSuspect: latestEnrichment.priceSuspect,
        displayTitle: latestEnrichment.displayTitle,
        categoryId: latestEnrichment.categoryId,
        attributes: latestEnrichment.attributes,
        dealPct: latestEnrichment.dealPct,
        dealMedianVnd: latestEnrichment.dealMedianVnd,
        dealN: latestEnrichment.dealN,
        text: schema.post.text,
        textNormalized: schema.post.textNormalized,
        repostKey: schema.post.repostKey,
        thumbState: schema.post.thumbState,
      })
      .from(schema.post)
      .leftJoin(latestEnrichment, eq(latestEnrichment.postId, schema.post.id))
      .where(and(...conditions))
      .orderBy(desc(schema.post.firstSeenAt))
      .limit(q.limit);

    const saved = await savedPostIds(
      handle,
      session.userId,
      rows.map((r) => r.id),
    );
    // `snippet` from text_normalized; ListingFields + repost grouping.
    const posts = groupReposts(
      rows.map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        title: r.title,
        url: r.url,
        firstSeenAt: r.firstSeenAt,
        intent: r.intent,
        priceVnd: r.priceVnd,
        snippet: deriveSnippet(r.textNormalized, maskPii),
        listing: buildListingFields(
          { ...r, priceSuspect: r.priceSuspect ?? false, attributes: r.attributes, dealPct: r.dealPct },
          saved.has(r.id),
        ),
      })),
    ).map(({ listing, ...r }) => ({ ...r, ...listing }));
    return c.json({ posts });
  });

  // Post detail + permalink. Team-scoped (other team = 404, never 403).
  app.get("/api/posts/:id", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: "validation", message: "id must be a uuid" }, 400);
    const operator = session.role === "operator";

    const [row] = await handle.db
      .select({ post: schema.post, source: { id: schema.source.id, name: schema.source.name, kind: schema.source.kind, url: schema.source.url } })
      .from(schema.post)
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .where(and(eq(schema.post.id, id), eq(schema.source.teamId, session.teamId)))
      .limit(1);
    if (!row) return c.json({ error: "not_found" }, 404);
    const p = row.post;

    const revisions = await handle.db
      .select({ id: schema.postRevision.id, seenAt: schema.postRevision.seenAt, text: schema.postRevision.text, engagement: schema.postRevision.engagement })
      .from(schema.postRevision)
      .where(eq(schema.postRevision.postId, id))
      .orderBy(asc(schema.postRevision.seenAt), asc(schema.postRevision.id));

    const [enr] = await handle.db
      .select({
        revision: schema.enrichment.revision,
        intent: schema.enrichment.intent,
        priceVnd: schema.enrichment.priceVnd,
        priceRaw: schema.enrichment.priceRaw,
        priceQualifier: schema.enrichment.priceQualifier,
        priceMaxVnd: schema.enrichment.priceMaxVnd,
        priceConfidence: schema.enrichment.priceConfidence,
        condition: schema.enrichment.condition,
        confidence: schema.enrichment.confidence,
        sentiment: schema.enrichment.sentiment,
        intentTags: schema.enrichment.intentTags,
        engine: schema.enrichment.engine,
        model: schema.enrichment.model,
        displayTitle: schema.enrichment.displayTitle,
        updatedAt: schema.enrichment.updatedAt,
        categoryId: schema.category.id,
        categoryName: schema.category.name,
        categoryPath: sql<string | null>`${schema.category.path}::text`,
        itemId: schema.catalogItem.id,
        itemName: schema.catalogItem.name,
      })
      .from(schema.enrichment)
      .leftJoin(schema.category, eq(schema.category.id, schema.enrichment.categoryId))
      .leftJoin(schema.catalogItem, eq(schema.catalogItem.id, schema.enrichment.itemId))
      .where(eq(schema.enrichment.postId, id))
      .limit(1);

    const matches = await handle.db
      .select({
        id: schema.match.id,
        watchId: schema.match.watchId,
        watchName: schema.watch.name,
        score: schema.match.score,
        matchedTerms: schema.match.matchedTerms,
        createdAt: schema.match.createdAt,
      })
      .from(schema.match)
      .innerJoin(schema.watch, eq(schema.watch.id, schema.match.watchId))
      .where(and(eq(schema.match.postId, id), readableWatches(handle, session)))
      .orderBy(desc(schema.match.createdAt), desc(schema.match.id));

    let duplicates: { id: string; sourceId: string; sourceName: string; url: string; firstSeenAt: Date }[] = [];
    if (p.fingerprint !== null) {
      const sourceIds = await teamSourceIds(handle, session.teamId);
      duplicates = await handle.db
        .select({ id: schema.post.id, sourceId: schema.post.sourceId, sourceName: schema.source.name, url: schema.post.url, firstSeenAt: schema.post.firstSeenAt })
        .from(schema.post)
        .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
        .where(and(inArray(schema.post.sourceId, sourceIds), eq(schema.post.fingerprint, p.fingerprint), ne(schema.post.id, id)))
        .orderBy(asc(schema.post.firstSeenAt), asc(schema.post.id))
        .limit(MAX_DUPLICATES);
    }

    return c.json({
      post: {
        id: p.id,
        sourceId: p.sourceId,
        platformPostId: p.platformPostId,
        url: p.url,
        authorName: p.authorName,
        authorId: p.authorId,
        title: p.title,
        text: p.text,
        media: Array.isArray(p.media) ? p.media : [],
        engagement: p.engagement,
        postedAt: p.postedAt,
        firstSeenAt: p.firstSeenAt,
        lastSeenAt: p.lastSeenAt,
        editCount: p.editCount,
        capture: p.capture,
        fingerprint: p.fingerprint,
        ...(operator ? { raw: p.raw } : {}),
      },
      source: row.source,
      revisions,
      enrichment: enr
        ? {
            revision: enr.revision,
            intent: enr.intent,
            priceVnd: enr.priceVnd,
            priceRaw: enr.priceRaw,
            priceQualifier: enr.priceQualifier,
            priceMaxVnd: enr.priceMaxVnd,
            priceConfidence: enr.priceConfidence,
            condition: enr.condition,
            confidence: enr.confidence,
            sentiment: enr.sentiment,
            intentTags: enr.intentTags,
            engine: enr.engine,
            model: enr.model,
            displayTitle: enr.displayTitle,
            updatedAt: enr.updatedAt,
            category: enr.categoryId && enr.categoryName !== null ? { id: enr.categoryId, name: enr.categoryName, path: enr.categoryPath ?? "" } : null,
            item: enr.itemId && enr.itemName !== null ? { id: enr.itemId, name: enr.itemName } : null,
          }
        : null,
      matches,
      duplicates,
      ...(operator ? { pipeline: { enrichState: p.enrichState, matchState: p.matchState, pipelineVersion: p.pipelineVersion } } : {}),
    });
  });

  return app;
}
