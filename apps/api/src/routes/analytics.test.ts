import { authorLabel, authorRef } from "@feedhound/core/pii";
import { createDb, loadPiiSalt, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { cleanupTeams, createCategory, createTeam, type TeamFixture } from "../../../../tests/fixtures/analytics/flat-baseline";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

let canRun = false;
if (TEST_DATABASE_URL) {
  if (!new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
  }
  const probe = createDb(TEST_DATABASE_URL);
  try {
    await probe.sql`select 1`;
    canRun = true;
  } catch (err) {
    if (MUST_RUN) throw err;
    console.warn(`analytics.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  } finally {
    await probe.close();
  }
} else if (MUST_RUN) {
  throw new Error("analytics.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("analytics.test.ts: skipped — TEST_DATABASE_URL is unset");
}

const RECENT_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
const RECENT = new Date(RECENT_MS).toISOString();
const RECENT_PREV = new Date(RECENT_MS - 3_600_000).toISOString();
const STALE = new Date(RECENT_MS - 3 * 86_400_000).toISOString();
const points = z.array(z.object({ ts: z.string(), posts: z.number(), unique: z.number(), sell: z.number(), buy: z.number(), other: z.number() }));
const volumeShape = z.object({ bucket: z.enum(["hour", "day"]), series: z.array(z.object({ key: z.string(), label: z.string(), points })) });
const priceShape = z.object({
  item: z.object({ id: z.string(), name: z.string() }),
  points: z.array(z.object({ ts: z.string(), n: z.number(), median: z.number(), p25: z.number(), p75: z.number() })),
  latest: z.object({ ts: z.string(), median: z.number() }).nullable(),
  vs7d: z.object({ median: z.number(), deltaPct: z.number() }).nullable(),
  vs30d: z.object({ median: z.number(), deltaPct: z.number() }).nullable(),
});
const trendingShape = z.object({
  ts: z.string().nullable(),
  window: z.enum(["1h", "24h"]),
  terms: z.array(z.object({ term: z.string(), display: z.string(), count: z.number(), baseline: z.number().nullable(), zscore: z.number(), lift: z.number(), isNew: z.boolean(), deltaPct: z.number().nullable(), sparkline: z.array(z.number()).length(24) })),
});
const authorsShape = z.object({
  authors: z.array(z.object({ authorKey: z.string(), name: z.string(), posts: z.number(), sell: z.number(), categories: z.array(z.object({ categoryId: z.string(), posts: z.number() })) })),
});
const funnelShape = z.object({
  days: z.array(z.object({ ts: z.string(), collected: z.number(), enriched: z.number(), matched: z.number(), notified: z.number() })),
  totals: z.object({ collected: z.number(), enriched: z.number(), matched: z.number(), notified: z.number() }),
});

const DAY = "2026-09-10T00:00:00Z";
const RANGE = `from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`;

describe.skipIf(!canRun)("analytics routes", () => {
  let base: DbHandle;
  let handle: DbHandle;
  let t: TeamFixture;
  let t2: TeamFixture;
  let t3: TeamFixture;
  let email3 = "";
  let catId: string;
  let itemId: string;
  const statements: string[] = [];
  const prevBypass = process.env.DEV_AUTH_BYPASS;

  const put = async (bucket: string, ts: string, dims: Record<string, string>, counts: Record<string, number | string>): Promise<void> => {
    await base.sql`insert into metric_rollup (bucket, ts, dims, counts) values (${bucket}, ${ts}::timestamptz, ${JSON.stringify(dims)}::jsonb, ${JSON.stringify(counts)}::jsonb)`;
  };
  const trend = async (teamId: string, window: string, ts: string, term: string, count: number, zscore: number | null): Promise<void> => {
    await base.sql`insert into trend_term (team_id, "window", ts, term, count, zscore, baseline, lift, display, extractor) values (${teamId}::uuid, ${window}, ${ts}::timestamptz, ${term}, ${count}, ${zscore}, ${zscore === null ? null : 1}, ${zscore}, ${term === "airpods" ? "AirPods" : null}, 2)`;
  };
  const get = (path: string, email: string | null): Promise<Response> | Response =>
    createApp(handle).request(path, email ? { headers: { "X-Dev-User": email } } : {});
  let emailT = "";

  beforeAll(async () => {
    process.env.DEV_AUTH_BYPASS = "1";
    base = createDb(TEST_DATABASE_URL);
    handle = { ...base, db: drizzle(base.sql, { schema, logger: { logQuery: (q: string) => void statements.push(q) } }) };
    t = await createTeam(base, "an-t");
    t2 = await createTeam(base, "an-t2");
    t3 = await createTeam(base, "an-t3");
    const [row3] = await base.sql<{ email: string }[]>`select email from "user" where id = ${t3.userId}::uuid`;
    email3 = row3!.email;
    const [row] = await base.sql<{ email: string }[]>`select email from "user" where id = ${t.userId}::uuid`;
    emailT = row!.email;
    catId = await createCategory(base, "An cat");
    const [item] = await base.db.insert(schema.catalogItem).values({ categoryId: catId, name: "An item" }).returning({ id: schema.catalogItem.id });
    itemId = item!.id;
    const s = t.sourceIds[0]!;
    // team T
    await put("hour", "2026-09-10T03:00:00Z", { metric: "volume", teamId: t.teamId }, { posts: 5, unique: 4, sell: 3, buy: 1, other: 1 });
    await put("hour", "2026-09-10T03:00:00Z", { metric: "volume", teamId: t.teamId, sourceId: s }, { posts: 5, unique: 4, sell: 3, buy: 1, other: 1 });
    await put("day", DAY, { metric: "volume", teamId: t.teamId }, { posts: 10, unique: 9, sell: 5, buy: 2, other: 3, enriched: 8, matched: 3, notified: 2 });
    await put("day", DAY, { metric: "volume", teamId: t.teamId, sourceId: s }, { posts: 10, unique: 9, sell: 5, buy: 2, other: 3, enriched: 8, matched: 3, notified: 2 });
    for (const [d, med, n] of [["2026-09-08T00:00:00Z", 10_000_000, 4], ["2026-09-09T00:00:00Z", 12_000_000, 4], [DAY, 11_000_000, 4]] as const) {
      await put("day", d, { metric: "price", teamId: t.teamId, itemId }, { n, nRaw: n, median: med, p25: med - 1_000_000, p75: med + 1_000_000 });
    }
    await put("day", DAY, { metric: "authors", teamId: t.teamId, authorKey: "name:alpha" }, { posts: 4, sell: 4, name: "Alpha" });
    await put("day", DAY, { metric: "authors", teamId: t.teamId, authorKey: "name:alpha", categoryId: catId }, { posts: 4, sell: 4, name: "Alpha" });
    await trend(t.teamId, "1h", RECENT, "airpods", 50, 9.5);
    await trend(t.teamId, "1h", RECENT, "macbook", 12, 4.2);
    await trend(t.teamId, "hist", RECENT, "airpods", 50, null);
    await trend(t.teamId, "hist", RECENT_PREV, "airpods", 3, null);
    // A legacy (extractor 1) hist row must never feed the sparkline.
    await base.sql`insert into trend_term (team_id, "window", ts, term, count, extractor) values (${t.teamId}::uuid, 'hist', ${new Date(Date.parse(RECENT) - 2 * 3_600_000).toISOString()}::timestamptz, 'airpods', 777, 1)`;
    // team T2: must never leak into T responses
    await put("hour", "2026-09-10T03:00:00Z", { metric: "volume", teamId: t2.teamId }, { posts: 999, unique: 999, sell: 999, buy: 0, other: 0 });
    await put("day", DAY, { metric: "volume", teamId: t2.teamId }, { posts: 999, unique: 999, sell: 0, buy: 0, other: 0, enriched: 999, matched: 999, notified: 999 });
    await put("day", DAY, { metric: "price", teamId: t2.teamId, itemId }, { n: 9, nRaw: 9, median: 1, p25: 1, p75: 1 });
    await put("day", DAY, { metric: "authors", teamId: t2.teamId, authorKey: "name:zed" }, { posts: 999, sell: 0, name: "Zed" });
    await trend(t2.teamId, "1h", RECENT, "secret", 99, 50);
    await trend(t3.teamId, "1h", STALE, "ancient", 9, 5);
  });

  afterAll(async () => {
    if (prevBypass === undefined) delete process.env.DEV_AUTH_BYPASS;
    else process.env.DEV_AUTH_BYPASS = prevBypass;
    await base.sql`delete from catalog_item where id = ${itemId}::uuid`;
    await cleanupTeams(base, [t.teamId, t2.teamId, t3.teamId], [catId]);
    await base.close();
  });

  test("401 without a session", async () => {
    expect((await get(`/api/analytics/funnel?${RANGE}`, null)).status).toBe(401);
  });

  test("every route returns a zod-valid, team-scoped body and never reads post/enrichment/match", async () => {
    statements.length = 0;
    const s = t.sourceIds[0]!;
    const res = {
      volumeNone: await get(`/api/analytics/volume?bucket=day&${RANGE}`, emailT),
      volumeSource: await get(`/api/analytics/volume?bucket=hour&from=2026-09-10T00:00:00Z&to=2026-09-11T00:00:00Z&groupBy=source`, emailT),
      price: await get(`/api/analytics/price?itemId=${itemId}&${RANGE}`, emailT),
      trending: await get(`/api/analytics/trending?window=1h`, emailT),
      authors: await get(`/api/analytics/authors?${RANGE}`, emailT),
      funnel: await get(`/api/analytics/funnel?${RANGE}`, emailT),
    };
    for (const r of Object.values(res)) expect(r.status).toBe(200);

    const none = volumeShape.parse(await res.volumeNone.json());
    expect(none.series).toHaveLength(1);
    expect(none.series[0]!.points.map((p) => p.posts)).toEqual([10]);
    const bySource = volumeShape.parse(await res.volumeSource.json());
    expect(bySource.series.map((x) => [x.key, x.label, x.points[0]?.posts])).toEqual([[s, "an-t source 0", 5]]);

    const price = priceShape.parse(await res.price.json());
    expect(price.points.map((p) => p.median)).toEqual([10_000_000, 12_000_000, 11_000_000]);
    expect(price.latest?.median).toBe(11_000_000);
    expect(price.vs7d?.median).toBe(11_000_000); // (10M + 12M) / 2, weighted by equal n
    expect(price.vs7d?.deltaPct).toBeCloseTo(0);

    const trending = trendingShape.parse(await res.trending.json());
    expect(trending.terms.map((x) => x.term)).toEqual(["airpods", "macbook"]);
    expect(trending.terms[0]!.sparkline.slice(-2)).toEqual([3, 50]);
    expect(trending.terms[0]!.sparkline).not.toContain(777);
    expect(trending.terms[0]).toMatchObject({ display: "AirPods", lift: 9.5, isNew: false });
    expect(trending.terms[1]).toMatchObject({ display: "macbook" });

    const authors = authorsShape.parse(await res.authors.json());
    const ref = authorRef(await loadPiiSalt(handle), "name:alpha"); // Pseudonymised
    expect(authors.authors).toEqual([{ authorKey: ref as string, name: authorLabel(ref) as string, posts: 4, sell: 4, categories: [{ categoryId: catId, posts: 4 }] }]);

    const funnel = funnelShape.parse(await res.funnel.json());
    expect(funnel.totals).toEqual({ collected: 10, enriched: 8, matched: 3, notified: 2 });

    expect(statements.length).toBeGreaterThan(6); // the logger really sees the route queries
    const reads = statements.filter((q) => /\b(from|join)\s+"?(public"?\."?)?(post|enrichment|match)"?(\s|$|,)/i.test(q));
    expect(reads).toEqual([]);
  });

  test("trending ignores rows older than 3 hours but keeps a 2.5 h old one", async () => {
    const r = trendingShape.parse(await (await get(`/api/analytics/trending?window=1h`, email3)).json());
    expect(r).toEqual({ ts: null, window: "1h", terms: [] });
    await trend(t3.teamId, "1h", new Date(Date.now() - 2.5 * 3_600_000).toISOString(), "recent", 9, 5);
    const r2 = trendingShape.parse(await (await get(`/api/analytics/trending?window=1h`, email3)).json());
    expect(r2.terms.map((x) => x.term)).toEqual(["recent"]);
  });

  test("validation: hour range over 14 days -> 400; bad params -> 400", async () => {
    const r = await get(`/api/analytics/volume?bucket=hour&from=2026-09-01T00:00:00Z&to=2026-09-16T00:00:01Z`, emailT);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("validation");
    expect((await get(`/api/analytics/trending?window=7d`, emailT)).status).toBe(400);
    expect((await get(`/api/analytics/authors?from=nope&to=nope`, emailT)).status).toBe(400);
  });
});
