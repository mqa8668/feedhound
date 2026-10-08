import { trendLift } from "@feedhound/core/trend-entities";
import type { DbHandle } from "@feedhound/db";
import { sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";

/**
 * Analytics read routes. Session auth (any role); every query is scoped to
 * `session.teamId` and reads only `metric_rollup`, `trend_term`, `source`, `category`, `catalog_item`
 * (never `post` / `enrichment` / `match`).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Trending freshness window. The agent rolls up hour H = floor(now) - 1h at ROLLUP_CRON ("5 * * * *"), so right
// after hh:00 the newest row is up to 1h + 5 min + job time old; 3h keeps that gap (and one retry) from blanking the list.
const TRENDING_FRESH_HOURS = 3;
const MAX_RANGE_MS = { hour: 14 * DAY_MS, day: 365 * DAY_MS } as const;

const isoDate = z.string().datetime({ offset: true }).transform((v) => new Date(v));
const uuid = z.string().uuid();
const limitSchema = z.coerce.number().int().min(1).max(50).default(20);

const volumeQuery = z.object({
  bucket: z.enum(["hour", "day"]),
  from: isoDate,
  to: isoDate,
  groupBy: z.enum(["none", "source", "category", "intent"]).default("none"),
  sourceId: uuid.optional(),
  categoryId: uuid.optional(),
  intent: z.enum(["sell", "buy", "other"]).optional(),
});
const priceQuery = z.object({ itemId: uuid, from: isoDate, to: isoDate });
const trendingQuery = z.object({
  window: z.enum(["1h", "24h"]),
  categoryId: uuid.optional(),
  limit: limitSchema,
});
const authorsQuery = z.object({ categoryId: uuid.optional(), from: isoDate, to: isoDate, limit: limitSchema });
const funnelQuery = z.object({ from: isoDate, to: isoDate });

type Env = { Variables: { session: Session } };
type DimKey = "sourceId" | "categoryId" | "intent";
// The volume dims sets that exist: {}, {s}, {c}, {i}, {s,c}, {c,i}.
const VOLUME_KEY_SETS: readonly (readonly DimKey[])[] = [[], ["sourceId"], ["categoryId"], ["intent"], ["sourceId", "categoryId"], ["categoryId", "intent"]];

const validation = (message: string): { error: string; message: string } => ({ error: "validation", message });
const iso = (ms: number): string => new Date(ms).toISOString();
const msOf = (col: string): SQL => sql.raw(`(extract(epoch from ${col}) * 1000)::float8`);

function dimKeysFor(q: z.infer<typeof volumeQuery>): DimKey[] | undefined {
  const keys = new Set<DimKey>();
  if (q.groupBy === "source") keys.add("sourceId");
  if (q.groupBy === "category") keys.add("categoryId");
  if (q.groupBy === "intent") keys.add("intent");
  if (q.sourceId) keys.add("sourceId");
  if (q.categoryId) keys.add("categoryId");
  if (q.intent) keys.add("intent");
  const set = VOLUME_KEY_SETS.find((s) => s.length === keys.size && s.every((k) => keys.has(k)));
  return set ? [...set] : undefined;
}

const num = (v: unknown): number => Number(v ?? 0);

export function analyticsRoute(handle: DbHandle): Hono<Env> {
  const app = new Hono<Env>();
  const exec = async <T>(query: SQL): Promise<T[]> => (await handle.db.execute(query)) as unknown as T[];
  const auth = [cfAccessAuth(handle), requireSession()] as const;

  app.get("/api/analytics/volume", ...auth, async (c) => {
    const parsed = volumeQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(validation("invalid query"), 400);
    const q = parsed.data;
    const span = q.to.getTime() - q.from.getTime();
    if (span < 0 || span > MAX_RANGE_MS[q.bucket]) return c.json(validation("range too large"), 400);
    const keys = dimKeysFor(q);
    if (!keys) return c.json(validation("unsupported groupBy/filter combination"), 400);
    const teamId = c.get("session").teamId;

    const present = (k: DimKey): SQL => (keys.includes(k) ? sql`dims->>${sql.raw(`'${k}'`)} is not null` : sql`dims->>${sql.raw(`'${k}'`)} is null`);
    const filters = (["sourceId", "categoryId", "intent"] as const).flatMap((k) => (q[k] ? [sql`dims->>${sql.raw(`'${k}'`)} = ${q[k]}`] : []));
    const groupKey: DimKey | undefined = q.groupBy === "none" ? undefined : ({ source: "sourceId", category: "categoryId", intent: "intent" } as const)[q.groupBy];
    const rows = await exec<{ ts: number; gk: string | null; posts: number; uniq: number; sell: number; buy: number; other: number }[][number]>(sql`
      select ${msOf("ts")} as ts, ${groupKey ? sql`dims->>${sql.raw(`'${groupKey}'`)}` : sql`null`} as gk,
             (counts->>'posts')::float8 as posts, (counts->>'unique')::float8 as uniq,
             (counts->>'sell')::float8 as sell, (counts->>'buy')::float8 as buy, (counts->>'other')::float8 as other
      from metric_rollup
      where bucket = ${q.bucket} and dims->>'metric' = 'volume' and dims->>'teamId' = ${teamId}
        and ts >= ${q.from.toISOString()}::timestamptz and ts <= ${q.to.toISOString()}::timestamptz
        and ${present("sourceId")} and ${present("categoryId")} and ${present("intent")}
        ${filters.length ? sql`and ${sql.join(filters, sql` and `)}` : sql``}
      order by ts`);

    const labels = new Map<string, string>();
    if (groupKey === "sourceId" || groupKey === "categoryId") {
      const ids = [...new Set(rows.flatMap((r) => (r.gk ? [r.gk] : [])))];
      if (ids.length) {
        const table = groupKey === "sourceId" ? "source" : "category";
        const named = await exec<{ id: string; name: string }>(sql`select id::text as id, name from ${sql.raw(table)} where id::text in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
        for (const n of named) labels.set(n.id, n.name);
      }
    }
    const series = new Map<string, { key: string; label: string; points: { ts: string; posts: number; unique: number; sell: number; buy: number; other: number }[] }>();
    for (const r of rows) {
      const key = r.gk ?? "all";
      let s = series.get(key);
      if (!s) {
        s = { key, label: r.gk === null ? "All" : (labels.get(key) ?? key), points: [] };
        series.set(key, s);
      }
      s.points.push({ ts: iso(r.ts), posts: num(r.posts), unique: num(r.uniq), sell: num(r.sell), buy: num(r.buy), other: num(r.other) });
    }
    return c.json({ bucket: q.bucket, series: [...series.values()] });
  });

  app.get("/api/analytics/price", ...auth, async (c) => {
    const parsed = priceQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(validation("invalid query"), 400);
    const q = parsed.data;
    if (q.to.getTime() < q.from.getTime() || q.to.getTime() - q.from.getTime() > MAX_RANGE_MS.day) return c.json(validation("range too large"), 400);
    const teamId = c.get("session").teamId;
    const [item] = await exec<{ id: string; name: string }>(sql`select id::text as id, name from catalog_item where id = ${q.itemId}::uuid`);
    if (!item) return c.json({ error: "not_found", message: "unknown item" }, 404);
    const base = sql`from metric_rollup where bucket = 'day' and dims->>'metric' = 'price' and dims->>'teamId' = ${teamId} and dims->>'itemId' = ${q.itemId}`;
    const points = await exec<{ ts: number; n: number; median: number; p25: number; p75: number }>(sql`
      select ${msOf("ts")} as ts, (counts->>'n')::float8 as n, (counts->>'median')::float8 as median,
             (counts->>'p25')::float8 as p25, (counts->>'p75')::float8 as p75
      ${base} and ts >= ${q.from.toISOString()}::timestamptz and ts <= ${q.to.toISOString()}::timestamptz order by ts`);
    const out = points.map((p) => ({ ts: iso(p.ts), n: num(p.n), median: num(p.median), p25: num(p.p25), p75: num(p.p75) }));
    const last = out[out.length - 1];
    const vs = async (days: number): Promise<{ median: number; deltaPct: number } | null> => {
      if (!last) return null;
      const lastTs = Date.parse(last.ts);
      const rows = await exec<{ n: number; median: number }>(sql`
        select (counts->>'n')::float8 as n, (counts->>'median')::float8 as median ${base}
        and ts >= ${iso(lastTs - days * DAY_MS)}::timestamptz and ts < ${last.ts}::timestamptz`);
      const total = rows.reduce((a, r) => a + num(r.n), 0);
      if (total === 0) return null;
      const median = rows.reduce((a, r) => a + num(r.n) * num(r.median), 0) / total;
      return { median: Math.round(median), deltaPct: median === 0 ? 0 : ((last.median - median) / median) * 100 };
    };
    return c.json({ item, points: out, latest: last ? { ts: last.ts, median: last.median } : null, vs7d: await vs(7), vs30d: await vs(30) });
  });

  app.get("/api/analytics/trending", ...auth, async (c) => {
    const parsed = trendingQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(validation("invalid query"), 400);
    const q = parsed.data;
    const teamId = c.get("session").teamId;
    const scope = q.categoryId ? sql`category_id = ${q.categoryId}::uuid` : sql`category_id is null`;
    const [latest] = await exec<{ ts: number | null }>(sql`select ${msOf("max(ts)")} as ts from trend_term where team_id = ${teamId}::uuid and "window" = ${q.window} and ts >= now() - ${TRENDING_FRESH_HOURS} * interval '1 hour'`);
    if (!latest || latest.ts === null) return c.json({ ts: null, window: q.window, terms: [] });
    const ts = num(latest.ts);
    const rows = await exec<{ term: string; display: string | null; count: number; baseline: number | null; zscore: number; lift: number | null }>(sql`
      select term, display, count, baseline, zscore, lift from trend_term
      where team_id = ${teamId}::uuid and "window" = ${q.window} and ts = ${iso(ts)}::timestamptz and ${scope}
      order by lift desc nulls last, zscore desc nulls last, term limit ${q.limit}`);
    const spark = new Map<string, number[]>();
    if (rows.length) {
      const hist = await exec<{ term: string; ts: number; count: number }>(sql`
        select term, ${msOf("ts")} as ts, count from trend_term
        where team_id = ${teamId}::uuid and "window" = 'hist' and extractor = 2 and ${scope}
          and ts > ${iso(ts - 24 * HOUR_MS)}::timestamptz and ts <= ${iso(ts)}::timestamptz
          and term in (${sql.join(rows.map((r) => sql`${r.term}`), sql`, `)})`);
      for (const h of hist) {
        const arr = spark.get(h.term) ?? Array<number>(24).fill(0);
        const idx = 23 - Math.round((ts - num(h.ts)) / HOUR_MS);
        if (idx >= 0 && idx < 24) arr[idx] = num(h.count);
        spark.set(h.term, arr);
      }
    }
    return c.json({
      ts: iso(ts),
      window: q.window,
      terms: rows.map((r) => {
        const l = trendLift(num(r.count), r.baseline === null ? 0 : num(r.baseline));
        return {
          term: r.term,
          display: r.display ?? r.term,
          count: num(r.count),
          baseline: r.baseline === null ? null : num(r.baseline),
          zscore: num(r.zscore),
          lift: r.lift === null ? l.lift : num(r.lift),
          isNew: l.isNew,
          deltaPct: l.deltaPct,
          sparkline: spark.get(r.term) ?? Array<number>(24).fill(0),
        };
      }),
    });
  });

  app.get("/api/analytics/authors", ...auth, async (c) => {
    const parsed = authorsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(validation("invalid query"), 400);
    const q = parsed.data;
    if (q.to.getTime() < q.from.getTime() || q.to.getTime() - q.from.getTime() > MAX_RANGE_MS.day) return c.json(validation("range too large"), 400);
    const teamId = c.get("session").teamId;
    const range = sql`bucket = 'day' and dims->>'metric' = 'authors' and dims->>'teamId' = ${teamId}
      and ts >= ${q.from.toISOString()}::timestamptz and ts <= ${q.to.toISOString()}::timestamptz`;
    const catCond = q.categoryId ? sql`dims->>'categoryId' = ${q.categoryId}` : sql`dims->>'categoryId' is null`;
    const top = await exec<{ key: string; name: string | null; posts: number; sell: number }>(sql`
      select dims->>'authorKey' as key, (array_agg(counts->>'name' order by ts desc))[1] as name,
             sum((counts->>'posts')::float8) as posts, sum((counts->>'sell')::float8) as sell
      from metric_rollup where ${range} and ${catCond}
      group by dims->>'authorKey' order by posts desc, key limit ${q.limit}`);
    const cats = new Map<string, { categoryId: string; posts: number }[]>();
    if (top.length) {
      const rows = await exec<{ key: string; cat: string; posts: number }>(sql`
        select dims->>'authorKey' as key, dims->>'categoryId' as cat, sum((counts->>'posts')::float8) as posts
        from metric_rollup where ${range} and dims->>'categoryId' is not null
          and dims->>'authorKey' in (${sql.join(top.map((t) => sql`${t.key}`), sql`, `)})
        group by 1, 2 order by posts desc, cat`);
      for (const r of rows) cats.set(r.key, [...(cats.get(r.key) ?? []), { categoryId: r.cat, posts: num(r.posts) }]);
    }
    return c.json({ authors: top.map((t) => ({ authorKey: t.key, name: t.name ?? "", posts: num(t.posts), sell: num(t.sell), categories: cats.get(t.key) ?? [] })) });
  });

  app.get("/api/analytics/funnel", ...auth, async (c) => {
    const parsed = funnelQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(validation("invalid query"), 400);
    const q = parsed.data;
    if (q.to.getTime() < q.from.getTime() || q.to.getTime() - q.from.getTime() > MAX_RANGE_MS.day) return c.json(validation("range too large"), 400);
    const teamId = c.get("session").teamId;
    const rows = await exec<{ ts: number; collected: number; enriched: number; matched: number; notified: number }>(sql`
      select ${msOf("ts")} as ts, (counts->>'posts')::float8 as collected, (counts->>'enriched')::float8 as enriched,
             (counts->>'matched')::float8 as matched, (counts->>'notified')::float8 as notified
      from metric_rollup
      where bucket = 'day' and dims->>'metric' = 'volume' and dims->>'teamId' = ${teamId}
        and dims->>'sourceId' is null and dims->>'categoryId' is null and dims->>'intent' is null
        and ts >= ${q.from.toISOString()}::timestamptz and ts <= ${q.to.toISOString()}::timestamptz
      order by ts`);
    const days = rows.map((r) => ({ ts: iso(r.ts), collected: num(r.collected), enriched: num(r.enriched), matched: num(r.matched), notified: num(r.notified) }));
    const totals = days.reduce((a, d) => ({ collected: a.collected + d.collected, enriched: a.enriched + d.enriched, matched: a.matched + d.matched, notified: a.notified + d.notified }), { collected: 0, enriched: 0, matched: 0, notified: 0 });
    return c.json({ days, totals });
  });

  return app;
}
