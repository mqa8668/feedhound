import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildDealPeerQuery, loadCatalogueAttrs, loadDealComparables, loadDealPeers } from "./deal";
import { createDb, schema, type DbHandle } from "./index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("deal.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);

// One peer query for enrich and the decision API.
describe.skipIf(!canRun)("deal peer query", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let teamId: string;
  let srcId: string;
  let catId: string;
  const created: string[] = [];
  const AT = new Date("2026-09-30T00:00:00Z");

  async function mkPost(key: string, daysAgo: number, e: Partial<typeof schema.enrichment.$inferInsert>): Promise<string> {
    const postedAt = new Date(AT.getTime() - daysAgo * 86_400_000);
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId: srcId, platformPostId: `${key}-${RUN}`, url: `https://feeds.example.test/${key}-${RUN}`, title: key, text: key, textNormalized: key, postedAt })
      .returning({ id: schema.post.id });
    created.push(p!.id);
    await handle.db.insert(schema.enrichment).values({
      postId: p!.id,
      intent: "sell",
      priceVnd: 200_000_000,
      priceQualifier: "exact",
      priceConfidence: 0.9,
      categoryId: catId,
      attributes: { year: 2016 },
      ...e,
    });
    return p!.id;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL!);
    const [t] = await handle.db.insert(schema.team).values({ name: `deal-${RUN}` }).returning({ id: schema.team.id });
    teamId = t!.id;
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `deal-${RUN}`, name: "Nhóm xe", url: `https://feeds.example.test/deal-${RUN}` })
      .returning({ id: schema.source.id });
    srcId = s!.id;
    const [c] = await handle.db
      .insert(schema.category)
      .values({
        slug: `dc${RUN}`,
        name: "Deal cars",
        path: `dc${RUN}`,
        attributeSchema: [{ key: "year", label: "Năm", kind: "number", unit: "year", min: 1990, max: 2030, keyAttr: true, tolerance: 1 }],
      })
      .returning({ id: schema.category.id });
    catId = c!.id;
  });

  afterAll(async () => {
    const { inArray } = await import("drizzle-orm");
    if (created.length > 0) {
      await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, created));
      await handle.db.delete(schema.post).where(inArray(schema.post.id, created));
    }
    await handle.close();
  });

  test("buildDealPeerQuery returns null for non-scoreable posts, a scoped query otherwise", async () => {
    const cat = await loadCatalogueAttrs(handle);
    const base = { postId: crypto.randomUUID(), categoryId: catId, itemId: null, intent: "sell", priceVnd: 1, attributes: { year: 2016 }, at: AT };
    const cfg = { windowDays: 30, limit: 1000 };
    expect(buildDealPeerQuery({ ...base, intent: "buy" }, cat, cfg)).toBeNull();
    expect(buildDealPeerQuery({ ...base, priceVnd: null }, cat, cfg)).toBeNull();
    expect(buildDealPeerQuery({ ...base, attributes: {} }, cat, cfg)).toBeNull();
    expect(buildDealPeerQuery({ ...base, categoryId: null }, cat, cfg)).toBeNull();
    const q = buildDealPeerQuery(base, cat, cfg);
    expect(q?.categoryIds).toEqual([catId]);
    expect(q?.ranges).toEqual([{ key: "year", min: 2015, max: 2017 }]);
  });

  test("12 posts, 9 eligible; comparables and peers agree", async () => {
    for (let i = 0; i < 9; i++) await mkPost(`ok${i}`, 1 + i, { priceVnd: (180 + i) * 1e6 });
    await mkPost("suspect", 2, { priceSuspect: true });
    await mkPost("buy", 2, { intent: "buy" });
    await mkPost("old", 60, {});
    await mkPost("floor", 2, { priceQualifier: "floor", priceConfidence: 0.5 });
    const self = await mkPost("self", 0, { priceVnd: 185_000_000 });
    const cat = await loadCatalogueAttrs(handle);
    const q = buildDealPeerQuery({ postId: self, categoryId: catId, itemId: null, intent: "sell", priceVnd: 185e6, attributes: { year: 2016 }, at: AT }, cat, { windowDays: 30, limit: 1000 });
    expect(q).not.toBeNull();
    const rows = await loadDealComparables(handle, q!);
    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({ sourceName: "Nhóm xe", attributes: { year: 2016 } });
    const peers = await loadDealPeers(handle, q!);
    expect(peers).toEqual(rows.map((r) => r.priceVnd));
    expect(peers).toHaveLength(9);
  });
});
