import { createMockLlmClient } from "@feedhound/llm/mock";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { seedTaxonomyAndCatalogue } from "@feedhound/db/src/seed";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { AliasCache } from "../services/alias-cache";
import { runAttributesBackfill } from "./attributes-backfill";

// + amendment A: source defaults and rule titles in the backfill: 
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
if (MUST_RUN && !TEST_DATABASE_URL) throw new Error("attributes-backfill.test.ts: TEST_DATABASE_URL is required (CI is set)");

describe.skipIf(!TEST_DATABASE_URL)("attributes_backfill", () => {
  let handle: DbHandle;
  let cache: AliasCache;
  let teamId: string;
  let sourceId: string;
  let carSourceId: string;
  const ids: Record<string, string> = {};
  const postIds: string[] = [];

  const snapshot = () => ({ dict: cache.get(), categories: cache.getCategories(), items: cache.getItems(), attrs: cache.getAttrs() });

  async function legacyRow(
    src: string,
    text: string,
    e: { engine: "rule" | "llm"; priceVnd: number | null; priceRaw?: string | null; categoryId: string | null; itemId?: string | null; version?: number | null; attributes?: Record<string, string | number> },
  ): Promise<string> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId: src, platformPostId: `bf026-${crypto.randomUUID()}`, url: "https://feeds.example.test/bf-026/posts/1", text, textNormalized: text.toLowerCase() })
      .returning({ id: schema.post.id });
    postIds.push(p!.id);
    await handle.db.insert(schema.enrichment).values({
      postId: p!.id,
      intent: "sell",
      priceVnd: e.priceVnd,
      priceRaw: e.priceRaw ?? null,
      engine: e.engine,
      categoryId: e.categoryId,
      itemId: e.itemId ?? null,
      attributes: e.attributes ?? {},
      attributesVersion: e.version ?? null,
      promptVersion: "enrich@2",
    });
    return p!.id;
  }

  async function row(postId: string) {
    const [r] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, postId));
    return r!;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where slug = 'cars' and attribute_schema <> '[]'::jsonb`;
    if (!seeded?.n) await seedTaxonomyAndCatalogue(TEST_DATABASE_URL);
    for (const c of await handle.sql<{ id: string; slug: string }[]>`select id, slug from category where slug in ('cars','macbook','iphone','laptops','honda')`) ids[c.slug] = c.id;
    const [team] = await handle.db.insert(schema.team).values({ name: "bf-026-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const mk = async (defaults: Record<string, string | number>): Promise<string> => {
      const [s] = await handle.db
        .insert(schema.source)
        .values({ teamId, kind: "web", platformId: `bf-026-${crypto.randomUUID()}`, name: "bf", url: "https://feeds.example.test/bf-026", defaults })
        .returning({ id: schema.source.id });
      return s!.id;
    };
    sourceId = await mk({});
    carSourceId = await mk({ region: "hcm", categoryId: ids.cars as string });
    cache = new AliasCache({ handle });
    await cache.start();
  }, 120_000);

  afterAll(async () => {
    await cache.stop();
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, postIds));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, postIds));
    await handle.db.delete(schema.source).where(inArray(schema.source.id, [sourceId, carSourceId]));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Resumable batches, price repair, attributes; current row untouched; no LLM, no jobs", async () => {
    const phone = await legacyRow(sourceId, "Bán iPhone X 64gb 982.990.099", { engine: "rule", priceVnd: 982_990_099, categoryId: ids.iphone as string });
    const laptop = await legacyRow(sourceId, "Bán laptop cũ 2019", { engine: "llm", priceVnd: 2019, priceRaw: null, categoryId: ids.laptops as string });
    const mac1 = await legacyRow(sourceId, "Bán MacBook Air M2 16/256 pin 92% giá 17tr9", { engine: "rule", priceVnd: 17_900_000, priceRaw: "17tr9", categoryId: ids.macbook as string });
    const mac2 = await legacyRow(sourceId, "MBP 14 M3 Pro 18/512 fullbox", { engine: "rule", priceVnd: null, categoryId: ids.macbook as string });
    const current = await legacyRow(sourceId, "Bán MacBook Air M2 16/256", { engine: "rule", priceVnd: 1, categoryId: ids.macbook as string, version: 2, attributes: { chip: "m9" } });
    const legacy = [phone, laptop, mac1, mac2];
    const before = await Promise.all(legacy.map(row));
    const llm = createMockLlmClient([]);
    const sent: string[] = [];
    const cfg = { batch: 2, maxPerRun: 2, dealWindowDays: 30, dealMinPeers: 5 };
    const done = async (): Promise<number> => (await Promise.all(legacy.map(row))).filter((r) => r.attributesVersion === 2).length;

    expect(await runAttributesBackfill(handle, snapshot(), cfg, postIds)).toBe(2);
    expect(await done()).toBe(2);
    expect(await runAttributesBackfill(handle, snapshot(), cfg, postIds)).toBe(2);
    expect(await done()).toBe(4);
    expect(await runAttributesBackfill(handle, snapshot(), { ...cfg, maxPerRun: 0 }, postIds)).toBe(0);

    const [p, l, m1, m2] = await Promise.all(legacy.map(row));
    expect([p?.priceVnd, p?.priceSuspect]).toEqual([null, true]);
    expect(p?.priceRaw).toBe("982.990.099");
    expect([l?.priceVnd, l?.priceSuspect]).toEqual([null, true]);
    expect(m1?.attributes).toEqual({ chip: "m2", ram_gb: 16, ssd_gb: 256, battery_pct: 92 });
    expect([m1?.priceVnd, m1?.priceSuspect]).toEqual([17_900_000, false]);
    expect(m2?.attributes).toEqual({ chip: "m3_pro", ram_gb: 18, ssd_gb: 512 });

    const cur = await row(current);
    expect([cur.priceVnd, cur.attributes]).toEqual([1, { chip: "m9" }]);

    // never touches the pipeline: prompt_version / updated_at unchanged, no LLM call, nothing enqueued
    for (const [i, id] of legacy.entries()) {
      const after = await row(id);
      expect(after.promptVersion).toBe("enrich@2");
      expect(after.updatedAt.getTime()).toBe(before[i]?.updatedAt.getTime() as number);
    }
    expect(llm.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const states = await handle.db.select({ e: schema.post.enrichState, m: schema.post.matchState }).from(schema.post).where(inArray(schema.post.id, legacy));
    expect(states.every((s) => s.e === "pending" && s.m === "pending")).toBe(true);
  }, 60_000);

  test("hotfix: an empty attribute-schema snapshot skips the run and leaves rows untouched", async () => {
    const id = await legacyRow(sourceId, "Bán MacBook Air M2 16/256", { engine: "rule", priceVnd: null, categoryId: ids.macbook as string });
    const empty = { ...snapshot(), attrs: { ...cache.getAttrs(), schemas: new Map() } };
    expect(await runAttributesBackfill(handle, empty, { batch: 10, maxPerRun: 10, dealWindowDays: 30, dealMinPeers: 5 }, postIds)).toBe(0);
    expect((await row(id)).attributesVersion).toBeNull();
    expect(await runAttributesBackfill(handle, snapshot(), { batch: 10, maxPerRun: 10, dealWindowDays: 30, dealMinPeers: 5 }, postIds)).toBeGreaterThanOrEqual(1);
    expect((await row(id)).attributesVersion).toBe(2);
  }, 60_000);

  test("amendment A: source defaults (category, region) and the rule title are applied to a legacy car row", async () => {
    const car = await legacyRow(carSourceId, "Bán Toyota Vios số sàn sx 2016 giá 185tr", { engine: "rule", priceVnd: 185_000_000, priceRaw: "185tr", categoryId: null });
    expect(await runAttributesBackfill(handle, snapshot(), { batch: 10, maxPerRun: 10, dealWindowDays: 30, dealMinPeers: 5 }, postIds)).toBeGreaterThanOrEqual(1);
    const r = await row(car);
    expect(r.categoryId).toBe(ids.cars as string);
    expect(r.attributes).toMatchObject({ make: "toyota", model: "vios", year: 2016, transmission: "mt", region: "hcm" });
    expect(r.displayTitle).toBe("Toyota Vios 2016 · MT");
    expect(r.priceVnd).toBe(185_000_000);
  }, 60_000);

  test("review r1: the final category is written back, overriding a mismatching stored one", async () => {
    const id = await legacyRow(carSourceId, "Bán Honda City 2017 giá 400tr", { engine: "rule", priceVnd: 400_000_000, priceRaw: "400tr", categoryId: ids.honda as string });
    await runAttributesBackfill(handle, snapshot(), { batch: 10, maxPerRun: 10, dealWindowDays: 30, dealMinPeers: 5 }, postIds);
    const r = await row(id);
    expect(r.categoryId).not.toBe(ids.honda as string);
    expect(r.categoryId).toBe(ids.cars as string);
    expect(r.attributes).toMatchObject({ make: "honda", year: 2017 });
  }, 60_000);

  test("review r1: a poison row is skipped and stamped; the rest of the batch completes", async () => {
    const [item] = await handle.sql<{ id: string }[]>`select id from catalog_item limit 1`;
    const poison = await legacyRow(carSourceId, "Bán Toyota Vios 2016 giá 185tr", { engine: "rule", priceVnd: 185_000_000, priceRaw: "185tr", categoryId: ids.cars as string, itemId: item!.id });
    const good = await legacyRow(sourceId, "Bán MacBook Air M2 16/256", { engine: "rule", priceVnd: null, categoryId: ids.macbook as string });
    const base = snapshot();
    const throwing = {
      ...base,
      get items(): never {
        throw new Error("boom");
      },
    };
    const n = await runAttributesBackfill(handle, throwing as unknown as ReturnType<typeof snapshot>, { batch: 50, maxPerRun: 50, dealWindowDays: 30, dealMinPeers: 5 }, postIds);
    expect(n).toBeGreaterThanOrEqual(2);
    expect((await row(poison)).attributesVersion).toBe(2);
    const g = await row(good);
    expect(g.attributesVersion).toBe(2);
    expect(g.attributes).toMatchObject({ chip: "m2" });
  }, 60_000);

  test("V1 rows are re-parsed (asking price, expiry year, LLM price), idempotently, without LLM or jobs", async () => {
    const rush = await legacyRow(carSourceId, "Toyota Rush 2019 trả trước 50tr bán 390tr", { engine: "rule", priceVnd: 50_000_000, priceRaw: "50tr", categoryId: ids.cars as string, version: 1 });
    const vf3 = await legacyRow(carSourceId, "VinFast VF3 2025 đăng kiểm 2027", { engine: "rule", priceVnd: null, categoryId: ids.cars as string, version: 1, attributes: { year: 2027 } });
    const llmRow = await legacyRow(sourceId, "iphone 16 Pro Max 19tr500", { engine: "llm", priceVnd: 20_000_000, priceRaw: null, categoryId: ids.iphone as string, version: 1 });
    const mine = [rush, vf3, llmRow];
    const llm = createMockLlmClient([]);
    const cfg = { batch: 10, maxPerRun: 10, dealWindowDays: 30, dealMinPeers: 5 };
    expect(await runAttributesBackfill(handle, snapshot(), cfg, mine)).toBe(3);
    const [r, v, l] = await Promise.all(mine.map(row));
    expect([r?.priceVnd, r?.priceQualifier, r?.priceConfidence]).toEqual([390_000_000, "exact", 0.9]);
    expect(v?.attributes).toMatchObject({ year: 2025 });
    expect([l?.priceVnd, l?.priceQualifier]).toEqual([19_500_000, "exact"]);
    expect([r?.attributesVersion, v?.attributesVersion, l?.attributesVersion]).toEqual([2, 2, 2]);
    expect(await runAttributesBackfill(handle, snapshot(), cfg, mine)).toBe(0);
    expect(llm.calls).toHaveLength(0);
  }, 60_000);
});
