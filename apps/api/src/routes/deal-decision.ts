import { attributeFilterSchema, renderValue, resolveSchema, type AttributeFilter, type Attributes } from "@feedhound/core/attributes";
import { NO_CAPABILITIES, percentileOf, priceDistribution, verdictText, watchFit, type Capabilities, type FitItem, type PriceDistribution } from "@feedhound/core/deal-decision";
import { CAR_CHIP_KEYS } from "@feedhound/core/listing";
import { authorKey } from "@feedhound/core/normalize";
import { authorLabel, authorRef, maskPii } from "@feedhound/core/pii";
import type { PriceQualifier } from "@feedhound/core/price";
import { deriveSnippet } from "@feedhound/core/snippet";
import { buildDealPeerQuery, loadCatalogueAttrs, loadDealComparables, loadPiiSalt, schema, type DbHandle } from "@feedhound/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";
import { readableWatches } from "../services/scope";

/** Constants (no config). */
const COMPARABLES_MAX = 10;
const PEER_LIMIT = 1000;
const SELLER_WINDOW_DAYS = 90;
const COMPARE_MIN = 2;
const COMPARE_MAX = 4;

/** Latest Config values of `keys` (numbers only), falling back to `fallback`. Shared with `insights-overview`. */
export async function readConfigNumbers<K extends string>(handle: DbHandle, fallback: Record<K, number>): Promise<Record<K, number>> {
  const keys = Object.keys(fallback) as K[];
  const rows = await handle.db
    .select({ key: schema.config.key, value: schema.config.value })
    .from(schema.config)
    .where(inArray(schema.config.key, keys))
    .orderBy(desc(schema.config.version));
  const out = { ...fallback };
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    if (typeof r.value === "number") out[r.key as K] = r.value;
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function narrowQualifier(q: string | null): PriceQualifier | null {
  return q === "exact" || q === "floor" || q === "ceiling" || q === "approx" || q === "range" ? q : null;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

interface DecisionDto {
  postId: string;
  capabilities: Capabilities;
  price: { vnd: number | null; qualifier: PriceQualifier | null; suspect: boolean };
  verdict: { text: string; pct: number | null; n: number; medianVnd: number | null; confidence: "high" | "medium" | "low" | null };
  specs: { key: string; label: string; value: string }[];
  comparables: {
    postId: string;
    title: string;
    url: string;
    sourceName: string;
    priceVnd: number;
    deltaPct: number;
    year: number | null;
    odoKm: number | null;
    region: string | null;
    at: string;
  }[];
  distribution: PriceDistribution | null;
  percentile: number | null;
  fit: { watchId: string; watchName: string; items: FitItem[] }[];
  seller: { label: string | null; sellPosts90: number; repostCount: number };
}

/** Posts of the team that duplicate `p` (same fingerprint or same repost key), excluding `p`. */
async function duplicateCounts(
  handle: DbHandle,
  teamId: string,
  posts: { id: string; fingerprint: string | null; repostKey: string | null }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const p of posts) {
    if (p.fingerprint === null && p.repostKey === null) {
      out.set(p.id, 0);
      continue;
    }
    const [row] = await handle.sql<{ n: string }[]>`
      select count(*)::text as n from post d join source s on s.id = d.source_id
      where s.team_id = ${teamId}::uuid and d.id <> ${p.id}::uuid
        and ((${p.fingerprint}::text is not null and d.fingerprint = ${p.fingerprint}::text)
          or (${p.repostKey}::text is not null and d.repost_key = ${p.repostKey}::text))`;
    out.set(p.id, Number(row?.n ?? 0));
  }
  return out;
}

/**
 * `GET /api/posts/:id/decision` and `GET /api/compare`. Reads stored scores and computes comparables
 * on read from the enrich peer query. Every query is team-scoped; another team's id is a 404. Authors appear only as
 * `Member #ref` pseudonyms and every free-text title passes `maskPii`.
 */
export function dealDecisionRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();
  const auth = [cfAccessAuth(handle), requireSession()] as const;
  const uuid = z.string().uuid();

  app.get("/api/posts/:id/decision", ...auth, async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (!uuid.safeParse(id).success) return c.json({ error: "validation", message: "id must be a uuid" }, 400);

    const [row] = await handle.db
      .select({
        postedAt: schema.post.postedAt,
        firstSeenAt: schema.post.firstSeenAt,
        authorId: schema.post.authorId,
        authorName: schema.post.authorName,
        fingerprint: schema.post.fingerprint,
        repostKey: schema.post.repostKey,
        intent: schema.enrichment.intent,
        priceVnd: schema.enrichment.priceVnd,
        priceQualifier: schema.enrichment.priceQualifier,
        priceSuspect: schema.enrichment.priceSuspect,
        categoryId: schema.enrichment.categoryId,
        itemId: schema.enrichment.itemId,
        attributes: schema.enrichment.attributes,
        dealPct: schema.enrichment.dealPct,
        dealN: schema.enrichment.dealN,
        dealMedianVnd: schema.enrichment.dealMedianVnd,
      })
      .from(schema.post)
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .leftJoin(schema.enrichment, eq(schema.enrichment.postId, schema.post.id))
      .where(and(eq(schema.post.id, id), eq(schema.source.teamId, session.teamId)))
      .limit(1);
    if (!row) return c.json({ error: "not_found" }, 404);

    const cfg = await readConfigNumbers(handle, { "deal.windowDays": 30, "deal.minPeers": 5 });
    const minPeers = cfg["deal.minPeers"];
    const attributes: Attributes = row.attributes ?? {};
    const priceVnd = row.priceVnd;
    const qualifier = narrowQualifier(row.priceQualifier);
    const cat = await loadCatalogueAttrs(handle);
    const schemaOf = row.categoryId ? resolveSchema(row.categoryId, cat.tree, cat.schemas) : [];

    // Comparables from the same peer query enrich uses.
    const query = buildDealPeerQuery(
      { postId: id, categoryId: row.categoryId, itemId: row.itemId, intent: row.intent, priceVnd, attributes, at: row.postedAt ?? row.firstSeenAt },
      cat,
      { windowDays: cfg["deal.windowDays"], limit: PEER_LIMIT },
    );
    const peers = query ? await loadDealComparables(handle, { ...query, teamId: session.teamId }) : [];
    const myYear = num(attributes.year);
    const myOdo = num(attributes.odo_km);
    const gap = (mine: number | null, theirs: number | null): number => (mine === null ? 0 : theirs === null ? Number.POSITIVE_INFINITY : Math.abs(theirs - mine));
    const ordered = [...peers].sort(
      (a, b) =>
        gap(myYear, num(a.attributes.year)) - gap(myYear, num(b.attributes.year)) ||
        gap(myOdo, num(a.attributes.odo_km)) - gap(myOdo, num(b.attributes.odo_km)) ||
        b.at.getTime() - a.at.getTime(),
    );
    const comparables = ordered.slice(0, COMPARABLES_MAX).map((p) => ({
      postId: p.postId,
      title: maskPii(p.displayTitle ?? p.title ?? ""),
      url: p.url,
      sourceName: p.sourceName,
      priceVnd: p.priceVnd,
      deltaPct: priceVnd !== null && priceVnd > 0 ? round1(((p.priceVnd - priceVnd) / priceVnd) * 100) : 0,
      year: num(p.attributes.year),
      odoKm: num(p.attributes.odo_km),
      region: str(p.attributes.region),
      at: p.at.toISOString(),
    }));
    const prices = peers.map((p) => p.priceVnd);
    const distribution = priceDistribution(prices, minPeers);
    const percentile = priceVnd !== null ? percentileOf(priceVnd, prices) : null;

    // `car` when the category sits under `cars`.
    let noun: "car" | "listing" = "listing";
    if (row.categoryId) {
      const [car] = await handle.sql<{ car: boolean }[]>`
        select exists (select 1 from category k where k.slug = 'cars' and c.path <@ k.path) as car from category c where c.id = ${row.categoryId}::uuid`;
      if (car?.car) noun = "car";
    }
    const dealN = row.dealN ?? 0;
    const verdict = {
      text: verdictText({ pct: row.dealPct, n: dealN, minPeers, noun, qualifier, priceVnd }),
      pct: row.dealPct,
      n: dealN,
      medianVnd: row.dealMedianVnd,
      confidence: null,
    };

    // Schema order, car chip keys first.
    const rank = (k: string): number => {
      const i = (CAR_CHIP_KEYS as readonly string[]).indexOf(k);
      return i < 0 ? CAR_CHIP_KEYS.length : i;
    };
    const specs = schemaOf
      .map((def, i) => ({ def, i }))
      .filter(({ def }) => attributes[def.key] !== undefined)
      .sort((a, b) => rank(a.def.key) - rank(b.def.key) || a.i - b.i)
      .map(({ def }) => ({ key: def.key, label: def.label, value: maskPii(renderValue(def, attributes[def.key] as string | number)) }));

    // Fit per readable matched watch.
    const watches = await handle.db
      .selectDistinct({
        id: schema.watch.id,
        name: schema.watch.name,
        priceMin: schema.watch.priceMin,
        priceMax: schema.watch.priceMax,
        intents: schema.watch.intents,
        attributeFilters: schema.watch.attributeFilters,
      })
      .from(schema.match)
      .innerJoin(schema.watch, eq(schema.watch.id, schema.match.watchId))
      .where(and(eq(schema.match.postId, id), readableWatches(handle, session)))
      .orderBy(schema.watch.name);
    const fit = watches.map((w) => {
      const filters = z.array(attributeFilterSchema).safeParse(w.attributeFilters);
      const attributeFilters: AttributeFilter[] = filters.success ? filters.data : [];
      return {
        watchId: w.id,
        watchName: w.name,
        items: watchFit(
          { priceMin: w.priceMin, priceMax: w.priceMax, intents: w.intents, attributeFilters },
          { priceVnd, priceSuspect: row.priceSuspect ?? false, qualifier, intent: row.intent, attributes },
          schemaOf,
        ),
      };
    });

    // Pseudonymous seller panel; the raw author key never leaves the backend.
    const key = authorKey({ authorId: row.authorId, authorName: row.authorName });
    const label = authorLabel(authorRef(await loadPiiSalt(handle), key));
    let sellPosts90 = 0;
    if (key !== "") {
      const since = new Date(Date.now() - SELLER_WINDOW_DAYS * 86_400_000).toISOString();
      const base = handle.sql`from post p join source s on s.id = p.source_id join enrichment e on e.post_id = p.id
        where s.team_id = ${session.teamId}::uuid and e.intent = 'sell' and p.effective_at >= ${since}::timestamptz`;
      if (row.authorId) {
        const [n] = await handle.sql<{ n: string }[]>`select count(*)::text as n ${base} and p.author_id = ${row.authorId}`;
        sellPosts90 = Number(n?.n ?? 0);
      } else {
        // The pseudonym keys on the normalised name, so count by the same key: group raw names, then match in code.
        const names = await handle.sql<{ name: string; n: string }[]>`
          select p.author_name as name, count(*)::text as n ${base} and p.author_id is null and p.author_name is not null group by p.author_name`;
        sellPosts90 = names.filter((r) => authorKey({ authorName: r.name }) === key).reduce((sum, r) => sum + Number(r.n), 0);
      }
    }
    const repostCount = (await duplicateCounts(handle, session.teamId, [{ id, fingerprint: row.fingerprint, repostKey: row.repostKey }])).get(id) ?? 0;

    const dto: DecisionDto = {
      postId: id,
      capabilities: NO_CAPABILITIES,
      price: { vnd: priceVnd, qualifier, suspect: row.priceSuspect ?? false },
      verdict,
      specs,
      comparables,
      distribution,
      percentile,
      fit,
      seller: { label, sellPosts90, repostCount },
    };
    return c.json(dto);
  });

  app.get("/api/compare", ...auth, async (c) => {
    const session = c.get("session");
    const ids = (c.req.query("ids") ?? "").split(",").map((s) => s.trim());
    const parsed = z.array(uuid).min(COMPARE_MIN).max(COMPARE_MAX).safeParse(ids);
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
      return c.json({ error: "validation", message: `ids must be ${COMPARE_MIN}-${COMPARE_MAX} distinct uuids` }, 400);
    }
    const rows = await handle.db
      .select({
        id: schema.post.id,
        url: schema.post.url,
        title: schema.post.title,
        textNormalized: schema.post.textNormalized,
        thumbState: schema.post.thumbState,
        postedAt: schema.post.postedAt,
        authorId: schema.post.authorId,
        authorName: schema.post.authorName,
        fingerprint: schema.post.fingerprint,
        repostKey: schema.post.repostKey,
        sourceName: schema.source.name,
        displayTitle: schema.enrichment.displayTitle,
        priceVnd: schema.enrichment.priceVnd,
        priceQualifier: schema.enrichment.priceQualifier,
        priceSuspect: schema.enrichment.priceSuspect,
        attributes: schema.enrichment.attributes,
        dealPct: schema.enrichment.dealPct,
        dealN: schema.enrichment.dealN,
        dealMedianVnd: schema.enrichment.dealMedianVnd,
      })
      .from(schema.post)
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .leftJoin(schema.enrichment, eq(schema.enrichment.postId, schema.post.id))
      .where(and(inArray(schema.post.id, parsed.data), eq(schema.source.teamId, session.teamId)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (parsed.data.some((id) => !byId.has(id))) return c.json({ error: "not_found" }, 404);

    const matchedRows = await handle.db
      .selectDistinct({ postId: schema.match.postId })
      .from(schema.match)
      .innerJoin(schema.watch, eq(schema.watch.id, schema.match.watchId))
      .where(and(inArray(schema.match.postId, parsed.data), readableWatches(handle, session)));
    const matched = new Set(matchedRows.map((m) => m.postId));
    const salt = await loadPiiSalt(handle);
    const dups = await duplicateCounts(handle, session.teamId, rows);

    const items = parsed.data.map((id) => {
      const r = byId.get(id)!;
      const attributes = r.attributes ?? {};
      const region = attributes.region;
      return {
        postId: id,
        url: r.url,
        title: maskPii(r.displayTitle ?? (r.title?.trim() ? r.title.trim() : (deriveSnippet(r.textNormalized, maskPii) ?? ""))),
        thumbUrl: r.thumbState === "ok" ? `/api/media/${id}/thumb` : null,
        priceVnd: r.priceVnd,
        qualifier: narrowQualifier(r.priceQualifier),
        suspect: r.priceSuspect ?? false,
        dealMedianVnd: r.dealMedianVnd,
        dealN: r.dealN,
        dealPct: r.dealPct,
        attributes,
        region: typeof region === "string" ? region : null,
        sourceName: r.sourceName,
        postedAt: r.postedAt?.toISOString() ?? null,
        alsoInCount: dups.get(id) ?? 0,
        sellerLabel: authorLabel(authorRef(salt, authorKey({ authorId: r.authorId, authorName: r.authorName }))),
        matched: matched.has(id),
      };
    });
    return c.json({ capabilities: NO_CAPABILITIES, items });
  });

  return app;
}
