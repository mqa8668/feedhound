// Structured API hints drive enrichment without an LLM call; precedence survives attributes_backfill.

import { ingestPosts } from "@feedhound/api/corpus";
import type { ServerRawPost } from "@feedhound/core/sources";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { seedTaxonomyAndCatalogue } from "@feedhound/db/src/seed";
import type { LlmClient } from "@feedhound/llm/client";
import { createBudget } from "@feedhound/llm/budget";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { AliasCache } from "../services/alias-cache";
import { runAttributesBackfill } from "./attributes-backfill";
import { runEnrichJob, type CatalogueSnapshot, type EnrichConfig } from "./enrich";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

const CONFIG: EnrichConfig = { ruleConfidenceMin: 0.7, llmConfidenceMin: 0.5, enrichAll: true, modelCheap: "cheap", modelStrong: "strong" };

function apiPost(id: string, text: string, structured: ServerRawPost["structured"]): ServerRawPost {
  return {
    platformPostId: id,
    url: `https://feeds.example.test/items/${id}`,
    text,
    media: [],
    capturedAt: "2026-10-06T00:00:00.000Z",
    postedAt: "2026-10-06T00:00:00.000Z",
    capture: "api",
    structured,
  };
}

describe.skipIf(!TEST_DATABASE_URL)("enrich with structured hints", () => {
  let handle: DbHandle;
  let cache: AliasCache;
  let teamId: string;
  let sourceId: string;
  const postIds: string[] = [];
  let llmCalls = 0;
  const spy: LlmClient = {
    async complete() {
      llmCalls++;
      throw new Error("LLM must not be called for structured posts");
    },
  };

  const snapshot = (): CatalogueSnapshot => ({ dict: cache.get(), categories: cache.getCategories(), items: cache.getItems(), attrs: cache.getAttrs() });

  async function ingest(post: ServerRawPost): Promise<{ id: string; editCount: number }> {
    await ingestPosts(handle, undefined, sourceId, [post]);
    const [row] = await handle.db
      .select({ id: schema.post.id, editCount: schema.post.editCount })
      .from(schema.post)
      .where(eq(schema.post.platformPostId, post.platformPostId));
    postIds.push(row!.id);
    return row!;
  }

  async function enrich(p: { id: string; editCount: number }) {
    const budget = createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 });
    return runEnrichJob({
      handle,
      catalogue: snapshot(),
      prefilterTerms: new Set<string>(),
      llmClient: spy,
      budget,
      config: CONFIG,
      payload: { postId: p.id, revision: p.editCount },
    });
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where slug = 'cars' and attribute_schema <> '[]'::jsonb`;
    if (!seeded?.n) await seedTaxonomyAndCatalogue(TEST_DATABASE_URL);
    const [cars] = await handle.sql<{ id: string }[]>`select id from category where slug = 'cars'`;
    const [team] = await handle.db.insert(schema.team).values({ name: "enrich-053-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `example-list:topic=t${crypto.randomUUID()}`, name: "053", url: "https://feeds.example.test/api/items?topic=gpu", defaults: { categoryId: cars!.id } })
      .returning({ id: schema.source.id });
    sourceId = s!.id;
    cache = new AliasCache({ handle });
    await cache.start();
  }, 120_000);

  afterAll(async () => {
    await cache.stop();
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, postIds));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, postIds));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("rule engine, exact API price and attributes, zero LLM calls", async () => {
    const p = await ingest(
      apiPost("t053-1", "TOYOTA HIACE 2009 MÁY DẦU VAN 03 CHỖ", {
        intent: "sell",
        priceVnd: 175_000_000,
        attributes: { make: "Toyota", model: "Hiace", year: 2009, odo_km: 123, transmission: "mt", fuel: "diesel", region: "Hồ Chí Minh" },
        sellerType: "dealer",
      }),
    );
    expect((await enrich(p)).outcome).toBe("written");
    expect(llmCalls).toBe(0);
    const [e] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, p.id));
    expect(e).toMatchObject({ engine: "rule", intent: "sell", priceVnd: 175_000_000, priceQualifier: "exact" });
    expect(e!.attributes).toMatchObject({ make: "toyota", model: "hiace", year: 2009, odo_km: 123, transmission: "mt", fuel: "diesel", region: "hcm" });
  });

  test("structured year beats the text year, also after attributes_backfill", async () => {
    const p = await ingest(apiPost("t053-2", "Toyota Hiace đời 2015 máy dầu", { intent: "sell", priceVnd: 300_000_000, attributes: { year: 2009 } }));
    await enrich(p);
    const read = async () => (await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, p.id)))[0]!;
    expect((await read()).attributes.year).toBe(2009);
    await handle.sql`update enrichment set attributes_version = 0 where post_id = ${p.id}::uuid`;
    expect(await runAttributesBackfill(handle, snapshot(), { batch: 5, maxPerRun: 5, dealWindowDays: 30, dealMinPeers: 5 }, [p.id])).toBe(1);
    const after = await read();
    expect(after.attributes.year).toBe(2009);
    expect(after.priceVnd).toBe(300_000_000);
    expect(llmCalls).toBe(0);
  });
});
