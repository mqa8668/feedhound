// wire test across boundaries -- the real `enrich` handler, then the real `match` handler,
// against the real WatchIndex, with watches created through the real API. The LLM is a mock.

import { createBudget } from "@feedhound/llm/budget";
import { createMockLlmClient, type MockLlmClient, type ScriptedResponse } from "@feedhound/llm/mock";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { seedTaxonomyAndCatalogue } from "@feedhound/db/src/seed";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { createApp } from "../../../api/src/index";
import { AliasCache } from "../services/alias-cache";
import { WatchIndex } from "../watch-index";
import { runEnrichJob, type EnrichConfig } from "./enrich";
import { runMatchJob } from "./match";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
if (MUST_RUN && !TEST_DATABASE_URL) throw new Error("attributes.e2e.test.ts: TEST_DATABASE_URL is required (CI is set)");

const CONFIG: EnrichConfig = {
  ruleConfidenceMin: 0.7,
  llmConfidenceMin: 0.5,
  enrichAll: false,
  modelCheap: "cheap-model",
  modelStrong: "strong-model",
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fakeBoss(): PgBoss {
  return { send: async () => null } as unknown as PgBoss;
}

describe.skipIf(!TEST_DATABASE_URL)("attributes end to end", () => {
  let handle: DbHandle;
  let cache: AliasCache;
  let index: WatchIndex;
  let teamId: string;
  let userId: string;
  let apiKey: string;
  let plainSourceId: string;
  let carSourceId: string;
  const ids: Record<string, string> = {};
  const postIds: string[] = [];

  async function insertPost(sourceId: string, text: string): Promise<{ id: string; editCount: number }> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: `e2e026-${crypto.randomUUID()}`, url: "https://feeds.example.test/e2e-026/posts/1", text, textNormalized: text.toLowerCase() })
      .returning({ id: schema.post.id, editCount: schema.post.editCount });
    postIds.push(p!.id);
    return p!;
  }

  async function enrichThenMatch(post: { id: string; editCount: number }, engine: "rule" | "llm", client?: MockLlmClient): Promise<void> {
    const budget = createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 });
    const result = await runEnrichJob({
      handle,
      catalogue: { dict: cache.get(), categories: cache.getCategories(), items: cache.getItems(), attrs: cache.getAttrs() },
      prefilterTerms: new Set<string>(),
      llmClient: client,
      budget: client ? budget : undefined,
      config: CONFIG,
      payload: { postId: post.id, revision: post.editCount, force: true, engine },
    });
    expect(result.outcome).toBe("written");
    await runMatchJob({ handle, boss: fakeBoss(), watchIndex: index, postId: post.id, trigger: "enrich" });
  }

  async function matchedPostsOf(watchId: string): Promise<string[]> {
    const rows = await handle.db.select({ postId: schema.match.postId }).from(schema.match).where(eq(schema.match.watchId, watchId));
    return rows.map((r) => r.postId);
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where slug = 'cars' and attribute_schema <> '[]'::jsonb`;
    if (!seeded?.n) await seedTaxonomyAndCatalogue(TEST_DATABASE_URL);
    for (const c of await handle.sql<{ id: string; slug: string }[]>`select id, slug from category where slug in ('cars','macbook')`) ids[c.slug] = c.id;

    const [team] = await handle.db.insert(schema.team).values({ name: "e2e-026-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `e2e-026-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
    apiKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({ userId, name: "e2e", prefix: apiKey.slice(0, 8), hash: await sha256Hex(apiKey), scopes: ["watches:read", "watches:write"] });
    const mkSource = async (name: string, defaults: Record<string, string | number>): Promise<string> => {
      const [s] = await handle.db
        .insert(schema.source)
        .values({ teamId, kind: "web", platformId: `e2e-026-${crypto.randomUUID()}`, name, url: "https://feeds.example.test/e2e-026", defaults })
        .returning({ id: schema.source.id });
      return s!.id;
    };
    plainSourceId = await mkSource("e2e plain", {});
    carSourceId = await mkSource("e2e cars", { region: "hcm", categoryId: ids.cars as string });
    cache = new AliasCache({ handle });
    await cache.start();
    index = new WatchIndex({ handle });
  }, 120_000);

  afterAll(async () => {
    await cache.stop();
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, postIds));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, postIds));
    await handle.db.delete(schema.source).where(inArray(schema.source.id, [plainSourceId, carSourceId]));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Chip gte m2 matches the M2 MacBook post only", async () => {
    const [w] = await handle.db
      .insert(schema.watch)
      .values({ userId, name: "m2+", categoryIds: [ids.macbook as string], intents: ["sell"], attributeFilters: [{ key: "chip", op: "gte", value: "m2" }] })
      .returning({ id: schema.watch.id });
    await index.reload();
    const m2 = await insertPost(plainSourceId, "Bán MacBook Air M2 16/256 pin 92% giá 17tr9");
    const m1 = await insertPost(plainSourceId, "Bán MacBook Air M1 8/256 giá 12tr");
    await enrichThenMatch(m2, "rule");
    await enrichThenMatch(m1, "rule");
    expect(await matchedPostsOf(w!.id)).toEqual([m2.id]);
  }, 60_000);

  test("Used-car watch created through the API matches exactly post (a)", async () => {
    const res = await createApp(handle).request("/api/watches", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "vios hcm",
        categoryIds: [ids.cars],
        intents: ["sell"],
        priceMax: 200_000_000,
        attributeFilters: [
          { key: "make", op: "eq", value: "toyota" },
          { key: "model", op: "eq", value: "Vios" },
          { key: "year", op: "gte", value: 2015 },
          { key: "region", op: "eq", value: "hcm" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const watch = (await res.json()) as { id: string };
    await index.reload();

    const texts = {
      a: "Bán Toyota Vios số sàn sx 2016 odo 8v giá 185tr",
      b: "Bán Toyota Vios số sàn sx 2013 odo 8v giá 185tr",
      c: "Toyota Vios 2017 xe ở Biên Hòa giá 190tr",
      d: "Toyota Vios 2018 giá 260tr",
      e: "Toyota Vios 2017 giá 952.941.444",
      f: "Honda City 2017 giá 180tr",
    };
    const posts: Record<string, { id: string; editCount: number }> = {};
    for (const [k, text] of Object.entries(texts)) {
      posts[k] = await insertPost(carSourceId, text);
      const scripted: ScriptedResponse = {
        ok: true,
        data: { intent: "sell", priceVnd: null, condition: "used", categorySlug: "cars", itemName: null, confidence: 0.9, attributes: {} },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: CONFIG.modelCheap,
        latencyMs: 1,
      };
      await enrichThenMatch(posts[k]!, "llm", createMockLlmClient([scripted]));
    }
    expect(await matchedPostsOf(watch.id)).toEqual([posts.a!.id]);
  }, 120_000);
});
