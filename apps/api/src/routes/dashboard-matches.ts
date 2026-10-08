import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { NO_CAPABILITIES } from "@feedhound/core/deal-decision";
import { and, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";
import { buildListingFields, groupReposts, notHiddenFor, savedFor, savedPostIds } from "../services/listing";
import { readableWatches } from "../services/scope";

/**
 * Session-facing matches inbox.
 *
 * Lives under `/api/dashboard/` — `GET /api/matches` is 003's API-key route for
 * machines and its contract stays untouched. Session auth only (`cfAccessAuth` +
 * `requireSession`): a bearer API key does not satisfy it (401).
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const matchesQuerySchema = z.object({
  watch: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
  sort: z.enum(["newest", "deal", "price", "drop"]).default("newest"),
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  yearMin: z.coerce.number().int().optional(),
  yearMax: z.coerce.number().int().optional(),
  odoMax: z.coerce.number().int().min(0).optional(),
  region: z.string().min(1).max(60).optional(),
  saved: z.literal("1").optional(),
  band: z.string().min(1).max(60).optional(),
});

/** `sort != newest` pages by offset; cursor = base64url `{"sort":"deal","offset":50}`. */
const offsetCursorSchema = z.object({ sort: z.enum(["deal", "price", "drop"]), offset: z.number().int().min(0).max(100_000) });

function encodeOffsetCursor(sort: "deal" | "price" | "drop", offset: number): string {
  return Buffer.from(JSON.stringify({ sort, offset }), "utf8").toString("base64url");
}

function decodeOffsetCursor(raw: string, sort: string): number | undefined {
  try {
    const parsed = offsetCursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success && parsed.data.sort === sort ? parsed.data.offset : undefined;
  } catch {
    return undefined;
  }
}

/** Numeric attribute `key` (a JSON number only; text such as "90k" never casts). `key` is a code constant. */
function numericAttr(key: "year" | "odo_km"): SQL {
  const col = sql.raw(`"enrichment"."attributes"`);
  return sql`(case when jsonb_typeof(${col} -> ${sql.raw(`'${key}'`)}) = 'number' then (${col} ->> ${sql.raw(`'${key}'`)})::numeric end)`;
}

// Cursor = base64url of {"createdAt":"<full-precision timestamptz text>","id":"<uuid>"}
// taken from the last row of a page ("createdAt" is the raw `created_at::text` value —
// microsecond precision, not a JS Date/ISO-ms string — so same-millisecond rows never
// get skipped). Anything else → 400 `validation`.
const CREATED_AT_TEXT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?([+-])(\d{2})(:\d{2})?$/;

/**
 * The regex only checks shape; `2026-13-45 00:00:00+00` still reaches
 * `::timestamptz`, which raises 22008 and would surface as a 500 instead of
 * the 400 `validation` required for an ill-typed cursor.
 */
function isCalendarValidCreatedAt(v: string): boolean {
  const m = CREATED_AT_TEXT_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  const tzH = Number(m[9]);
  const tzM = m[10] ? Number(m[10].slice(1)) : 0;
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 60 || tzH > 15 || tzM > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const cursorSchema = z.object({
  createdAt: z.string().regex(CREATED_AT_TEXT_RE).refine(isCalendarValidCreatedAt, "createdAt is not a valid timestamp"),
  id: z.string().uuid(),
});

type Cursor = z.infer<typeof cursorSchema>;

function encodeCursor(row: { createdAtText: string; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAtText, id: row.id }), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = cursorSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Notification aggregate from FILTER counts of one grouped
 * query. `suppressed`/`skipped` rows are not applicable — they neither count as
 * delivered nor keep a match "pending" forever — so they are excluded from
 * `applicable` up front.
 */
function aggregateStatus(applicable: number, okCount: number, failedCount: number, pendingCount: number): "none" | "pending" | "partial" | "sent" | "failed" {
  if (applicable === 0) return "none";
  if (okCount > 0) return failedCount > 0 || pendingCount > 0 ? "partial" : "sent";
  return failedCount > 0 ? "failed" : "pending";
}

/** Enrichment.intent is free text in the db; narrow it to the declared union. */
function narrowIntent(intent: string | null): "sell" | "buy" | "other" | null {
  return intent === "sell" || intent === "buy" || intent === "other" ? intent : null;
}

export function dashboardMatchesRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/dashboard/matches", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const parsed = matchesQuerySchema.safeParse({
      watch: c.req.query("watch") || undefined,
      limit: c.req.query("limit") || undefined,
      cursor: c.req.query("cursor") || undefined,
      sort: c.req.query("sort") || undefined,
      priceMin: c.req.query("priceMin") || undefined,
      priceMax: c.req.query("priceMax") || undefined,
      yearMin: c.req.query("yearMin") || undefined,
      yearMax: c.req.query("yearMax") || undefined,
      odoMax: c.req.query("odoMax") || undefined,
      region: c.req.query("region") || undefined,
      saved: c.req.query("saved") || undefined,
      band: c.req.query("band") || undefined,
    });
    if (!parsed.success) return c.json({ error: "validation", message: "invalid query", issues: parsed.error.issues }, 400);
    const q = parsed.data;
    // A 052-owned param whose upstream data is not wired in is refused, never ignored.
    const capabilities = NO_CAPABILITIES;
    if ((q.sort === "drop" && !capabilities.listing) || (q.band !== undefined && !capabilities.dealV2)) {
      return c.json({ error: "capability_unavailable", message: q.sort === "drop" ? "sort=drop" : "band" }, 400);
    }

    let cursor: Cursor | undefined;
    let offset = 0;
    if (q.cursor) {
      if (q.sort === "newest") {
        cursor = decodeCursor(q.cursor);
        if (!cursor) return c.json({ error: "validation", message: "invalid cursor" }, 400);
      } else {
        const off = decodeOffsetCursor(q.cursor, q.sort);
        if (off === undefined) return c.json({ error: "validation", message: "invalid cursor" }, 400);
        offset = off;
      }
    }

    // The session user's hidden posts (and same-seller reposts) never show up.
    const conditions = [readableWatches(handle, session), notHiddenFor(session.userId)];
    if (q.watch) conditions.push(eq(schema.watch.id, q.watch));
    const e = schema.enrichment;
    if (q.priceMin !== undefined) conditions.push(sql`${e.priceVnd} >= ${q.priceMin}`);
    if (q.priceMax !== undefined) conditions.push(sql`${e.priceVnd} <= ${q.priceMax}`);
    if (q.yearMin !== undefined) conditions.push(sql`${numericAttr("year")} >= ${q.yearMin}`);
    if (q.yearMax !== undefined) conditions.push(sql`${numericAttr("year")} <= ${q.yearMax}`);
    if (q.odoMax !== undefined) conditions.push(sql`${numericAttr("odo_km")} <= ${q.odoMax}`);
    if (q.region !== undefined) conditions.push(sql`lower(${e.attributes} ->> 'region') = lower(${q.region})`);
    if (q.saved) conditions.push(savedFor(session.userId));
    if (cursor) {
      // Row comparison `(createdAt, id) < (cursor…)` — no OFFSET anywhere.
      conditions.push(sql`(${schema.match.createdAt}, ${schema.match.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
    }

    // `deal` = cheapest vs market first, unscored last; `price` = asking price asc, unpriced last.
    const newest = [desc(schema.match.createdAt), desc(schema.match.id)];
    const orderBy =
      q.sort === "deal" ? [sql`${e.dealPct} asc nulls last`, ...newest] : q.sort === "price" ? [sql`${e.priceVnd} asc nulls last`, ...newest] : newest;
    const rows = await handle.db
      .select({
        id: schema.match.id,
        postId: schema.match.postId,
        watchId: schema.match.watchId,
        score: schema.match.score,
        matchedTerms: schema.match.matchedTerms,
        createdAt: schema.match.createdAt,
        createdAtText: sql<string>`${schema.match.createdAt}::text`,
        intent: schema.enrichment.intent,
        priceVnd: schema.enrichment.priceVnd,
        post: { id: schema.post.id, title: schema.post.title, url: schema.post.url, sourceId: schema.post.sourceId },
        text: schema.post.text,
        textNormalized: schema.post.textNormalized,
        repostKey: schema.post.repostKey,
        thumbState: schema.post.thumbState,
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
        sourceName: schema.source.name,
        watchName: schema.watch.name,
      })
      .from(schema.match)
      .innerJoin(schema.watch, eq(schema.watch.id, schema.match.watchId))
      .innerJoin(schema.post, eq(schema.post.id, schema.match.postId))
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .leftJoin(schema.enrichment, eq(schema.enrichment.postId, schema.post.id))
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(q.limit)
      .offset(offset);

    // Notification status computed in SQL over `notification`
    // rows with `match_id = m.id` — one grouped FILTER-count query per page (the
    // page ids come from the list query above), never one query per row.
    const matchIds = rows.map((r) => r.id);
    const aggRows =
      matchIds.length === 0
        ? []
        : await handle.db
            .select({
              matchId: schema.notification.matchId,
              applicable: sql<string>`count(*) filter (where ${schema.notification.status} not in ('suppressed', 'skipped'))`,
              okCount: sql<string>`count(*) filter (where ${schema.notification.status} in ('sent', 'merged'))`,
              failedCount: sql<string>`count(*) filter (where ${schema.notification.status} = 'failed')`,
              pendingCount: sql<string>`count(*) filter (where ${schema.notification.status} in ('pending', 'sending'))`,
            })
            .from(schema.notification)
            .where(inArray(schema.notification.matchId, matchIds))
            .groupBy(schema.notification.matchId);
    const aggByMatch = new Map(
      aggRows.map((r) => [
        r.matchId,
        { applicable: Number(r.applicable), okCount: Number(r.okCount), failedCount: Number(r.failedCount), pendingCount: Number(r.pendingCount) },
      ]),
    );

    const saved = await savedPostIds(
      handle,
      session.userId,
      rows.map((r) => r.postId),
    );
    const allMatches = rows.map((row) => {
      const agg = aggByMatch.get(row.id) ?? { applicable: 0, okCount: 0, failedCount: 0, pendingCount: 0 };
      return {
        id: row.id,
        postId: row.postId,
        watchId: row.watchId,
        score: row.score,
        matchedTerms: row.matchedTerms,
        createdAt: row.createdAt.toISOString(),
        post: {
          ...row.post,
          sourceName: row.sourceName,
          ...buildListingFields(
            { id: row.postId, title: row.post.title, text: row.text, textNormalized: row.textNormalized, repostKey: row.repostKey, thumbState: row.thumbState, categoryId: row.categoryId, attributes: row.attributes, dealPct: row.dealPct, priceVnd: row.priceVnd, priceSuspect: row.priceSuspect ?? false, priceRaw: row.priceRaw, displayTitle: row.displayTitle, priceQualifier: row.priceQualifier, priceMaxVnd: row.priceMaxVnd, dealMedianVnd: row.dealMedianVnd, dealN: row.dealN },
            saved.has(row.postId),
          ),
        },
        intent: narrowIntent(row.intent),
        priceVnd: row.priceVnd,
        watch: { id: row.watchId, name: row.watchName },
        notifications: aggregateStatus(agg.applicable, agg.okCount, agg.failedCount, agg.pendingCount),
      };
    });

    // Within one watch, a repost of an already-listed post folds into its `alsoIn`.
    const byWatch = new Map<string, typeof allMatches>();
    for (const m of allMatches) byWatch.set(m.watchId, [...(byWatch.get(m.watchId) ?? []), m]);
    const kept = new Set<string>();
    for (const group of byWatch.values()) {
      for (const g of groupReposts(group.map((m) => ({ id: m.postId, sourceId: m.post.sourceId, url: m.post.url, listing: m.post, m })))) kept.add(g.m.id);
    }
    const matches = allMatches.filter((m) => kept.has(m.id));

    const last = rows.at(-1);
    const full = last !== undefined && rows.length === q.limit;
    const nextCursor = !full ? null : q.sort === "newest" ? encodeCursor({ createdAtText: last.createdAtText, id: last.id }) : encodeOffsetCursor(q.sort, offset + q.limit);
    return c.json({ matches, nextCursor, capabilities });
  });

  app.get("/api/dashboard/matches/unseen", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const [row] = await handle.db
      .select({ count: sql<string>`count(*)` })
      .from(schema.match)
      .innerJoin(schema.watch, eq(schema.watch.id, schema.match.watchId))
      .innerJoin(schema.user, eq(schema.user.id, session.userId))
      .where(and(readableWatches(handle, session), gt(schema.match.createdAt, schema.user.lastSeenMatchesAt)));
    return c.json({ count: Number(row?.count ?? 0) });
  });

  // The watermark only moves forward and never past `now()`; `until` (the newest card the user
  // loaded) keeps matches that arrived after the page rendered unseen. `until` is ISO (ms precision) but created_at has µs, so 1 ms is added or the newest loaded card would stay unseen. No body = "everything up to now" (legacy).
  const seenBodySchema = z.object({ until: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: "must be an ISO date" }).optional() });
  app.post("/api/dashboard/matches/seen", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const raw: unknown = await c.req.json().catch(() => ({}));
    const parsed = seenBodySchema.safeParse(raw ?? {});
    if (!parsed.success) return c.json({ error: "validation", message: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
    const until = parsed.data.until === undefined ? null : new Date(parsed.data.until).toISOString();
    const [row] = await handle.db
      .update(schema.user)
      .set({ lastSeenMatchesAt: sql`GREATEST(${schema.user.lastSeenMatchesAt}, LEAST(coalesce(${until}::timestamptz + interval '1 ms', now()), now()))` })
      .where(eq(schema.user.id, session.userId))
      .returning({ lastSeenMatchesAt: schema.user.lastSeenMatchesAt });
    return c.json({ lastSeenMatchesAt: row!.lastSeenMatchesAt.toISOString() });
  });

  return app;
}
