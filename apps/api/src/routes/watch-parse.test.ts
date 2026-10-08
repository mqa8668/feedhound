import { createDb, schema, type DbHandle } from "@feedhound/db";
import { seedTaxonomyAndCatalogue } from "@feedhound/db/src/seed";
import { createBudget, createMockLlmClient, type LlmResult, type MockLlmClient, type WatchParseOutput } from "@feedhound/llm";
import type { z } from "zod";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

function isTestDbUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/^\//, "").endsWith("_test");
  } catch {
    return false;
  }
}

if (TEST_DATABASE_URL && !isTestDbUrl(TEST_DATABASE_URL)) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  let reachable = true;
  try {
    await probe.sql`select 1`;
  } catch (err) {
    reachable = false;
    if (MUST_RUN) {
      await probe.close();
      throw err;
    }
    console.warn(`watch-parse.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  canRun = reachable;
  await probe.close();
} else if (MUST_RUN) {
  throw new Error("watch-parse.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("watch-parse.test.ts: skipped — TEST_DATABASE_URL is unset");
}

type WatchParseOutputT = z.input<typeof WatchParseOutput>;

const TEST_BY = "watch-parse.test.ts";
// Fixed far-future clock: budget day bucket and price window never collide with real data in the test DB.
const NOW = new Date("2031-03-03T05:00:00.000Z");
const DAY = 86_400_000;

const MAC_OUTPUT: WatchParseOutputT = {
  name: "MacBook M2+",
  categorySlugs: ["macbook", "espresso"],
  itemNames: ["MacBook Air", "MacBook Pro", "Mac mini"],
  include: [],
  exclude: [],
  intents: ["sell"],
  priceMinVnd: null,
  priceMaxVnd: 25_000_000,
  attributeFilters: [{ key: "chip", op: "gte", value: "m2" }],
};

function ok(data: WatchParseOutputT): LlmResult<unknown> {
  return { ok: true, data, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: "m", latencyMs: 1 };
}
const SCHEMA_FAIL: LlmResult<unknown> = { ok: false, reason: "schema", raw: "{", usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 } };

describe.skipIf(!canRun)("POST /api/watches/parse", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let key: string;
  let sourceId: string;
  let macbookId: string;
  let airId: string;
  const clock = { t: NOW };
  const configVersions: { key: string; version: number }[] = [];

  async function setConfig(k: string, value: unknown): Promise<void> {
    const [row] = await handle.sql<{ v: number | null }[]>`select max(version) as v from config where key = ${k}`;
    const version = (row?.v ?? 0) + 1;
    await handle.db.insert(schema.config).values({ key: k, version, value, updatedBy: TEST_BY });
    configVersions.push({ key: k, version });
  }

  async function parse(a: ReturnType<typeof appWithClock>, text: string): Promise<Response> {
    return a.request("/api/watches/parse", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  async function clearUsage(): Promise<void> {
    await handle.sql`delete from metric_rollup where bucket = 'day' and ts = ${new Date("2031-03-03T00:00:00.000Z").toISOString()}::timestamptz and dims = '{"metric":"llm_tokens"}'::jsonb`;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where slug = 'macbook'`;
    if (!seeded?.n) await seedTaxonomyAndCatalogue(TEST_DATABASE_URL);
    const [cat] = await handle.sql<{ id: string }[]>`select id from category where slug = 'macbook'`;
    macbookId = cat!.id;
    const [air] = await handle.sql<{ id: string }[]>`select id from catalog_item where name = 'MacBook Air' and category_id = ${macbookId}::uuid`;
    airId = air!.id;
    await setConfig("llm.model.cheap", "test-cheap");
    await setConfig("llm.model.strong", "test-strong");
    await setConfig("llm.dailyTokenBudget", 1000);
    await setConfig("app.tz", "Asia/Ho_Chi_Minh");

    const [team] = await handle.db.insert(schema.team).values({ name: "watch-parse-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `watch-parse-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
    key = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({ userId, name: "parse", prefix: key.slice(0, 8), hash: await sha256Hex(key), scopes: ["watches:read", "watches:write"] });
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `watch-parse-${crypto.randomUUID()}`, name: "parse test group", url: "https://feeds.example.test/parse-test" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
  }, 120_000);

  afterAll(async () => {
    const posts = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId));
    if (posts.length > 0) await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, posts.map((p) => p.id)));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    for (const c of configVersions) await handle.db.delete(schema.config).where(and(eq(schema.config.key, c.key), eq(schema.config.version, c.version)));
    await clearUsage();
    await handle.close();
  });

  async function watchCount(): Promise<number> {
    const [r] = await handle.sql<{ n: number }[]>`select count(*)::int as n from watch`;
    return r?.n ?? 0;
  }

  test("maps LLM output to a draft, warns on the unknown category and writes nothing", async () => {
    clearRate();
    await clearUsage();
    const before = await watchCount();
    const llm = createMockLlmClient([ok(MAC_OUTPUT)]);
    const res = await parse(appWithClock(llm), "macbook air/pro/mini chip m2 trở lên dưới 25tr, bán");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: Record<string, unknown>; warnings: string[] };
    expect(body.draft.categoryIds).toEqual([macbookId]);
    expect((body.draft.itemIds as string[]).length).toBe(3);
    expect(body.draft.attributeFilters).toEqual([{ key: "chip", op: "gte", value: "m2" }]);
    expect(body.draft.priceMax).toBe(25_000_000);
    expect(body.draft.intents).toEqual(["sell"]);
    expect(body.warnings.some((w) => w.includes("espresso"))).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.model).toBe("test-cheap");
    expect(await watchCount()).toBe(before);
  });

  test("schema failure twice -> 422 parse_failed with one cheap and one strong call", async () => {
    clearRate();
    await clearUsage();
    const llm = createMockLlmClient([SCHEMA_FAIL]);
    const res = await parse(appWithClock(llm), "something unparseable");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("parse_failed");
    expect(llm.calls.map((c) => c.model)).toEqual(["test-cheap", "test-strong"]);
  });

  test("a cheap-model schema failure is rescued by the strong model", async () => {
    clearRate();
    await clearUsage();
    const llm = createMockLlmClient([SCHEMA_FAIL, ok(MAC_OUTPUT)]);
    const res = await parse(appWithClock(llm), "macbook m2");
    expect(res.status).toBe(200);
    expect(llm.calls.map((c) => c.model)).toEqual(["test-cheap", "test-strong"]);
  });

  test("no LLM env -> 503 llm_unavailable; text of 301 chars or 2 chars -> 422 validation", async () => {
    clearRate();
    const none = await parse(appWithClock(null), "macbook m2");
    expect(none.status).toBe(503);
    expect(((await none.json()) as { error: string }).error).toBe("llm_unavailable");
    const llm = createMockLlmClient([ok(MAC_OUTPUT)]);
    for (const text of ["x".repeat(301), "ab"]) {
      const res = await parse(appWithClock(llm), text);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("validation");
    }
    expect(llm.calls).toHaveLength(0);
  });

  test("exhausted daily budget -> 503 llm_budget without calling the model", async () => {
    clearRate();
    await clearUsage();
    await createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1000, budgetAlertPct: 80, now: () => NOW }).recordUsage({
      promptTokens: 900,
      completionTokens: 200,
      totalTokens: 1100,
    });
    const llm = createMockLlmClient([ok(MAC_OUTPUT)]);
    const res = await parse(appWithClock(llm), "macbook m2");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("llm_budget");
    expect(llm.calls).toHaveLength(0);
    await clearUsage();
  });

  test("the 21st call within a minute -> 429 rate_limited", async () => {
    clearRate();
    await clearUsage();
    const llm = createMockLlmClient([ok(MAC_OUTPUT)]);
    const a = appWithClock(llm);
    for (let i = 0; i < 20; i++) expect((await parse(a, "macbook m2")).status).toBe(200);
    const res = await parse(a, "macbook m2");
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    clock.t = new Date(NOW.getTime() + 61_000);
    expect((await parse(a, "macbook m2")).status).toBe(200);
    await clearUsage();
  }, 30_000);

  describe("suggestions", () => {
    const AIR_OUTPUT: WatchParseOutputT = { ...MAC_OUTPUT, categorySlugs: ["macbook"], itemNames: ["MacBook Air"], include: ["mba"], attributeFilters: [] };

    async function seedPrices(prices: number[]): Promise<void> {
      const old = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId));
      if (old.length > 0) {
        await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, old.map((p) => p.id)));
        await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
      }
      for (const [i, price] of prices.entries()) {
        const seenAt = new Date(NOW.getTime() - (i + 1) * DAY);
        const [p] = await handle.db
          .insert(schema.post)
          .values({ sourceId, platformPostId: `wp-${crypto.randomUUID()}`, url: `https://x/${i}`, text: "macbook air", textNormalized: "macbook air", firstSeenAt: seenAt, postedAt: seenAt })
          .returning({ id: schema.post.id });
        await handle.db.insert(schema.enrichment).values({ postId: p!.id, intent: "sell", priceVnd: price, itemId: airId, categoryId: macbookId });
      }
    }

    test("aliases not already in include, config exclude list, price range with >= 5 peers", async () => {
      clearRate();
      await clearUsage();
      await seedPrices([20e6, 21e6, 22e6, 23e6, 24e6, 25e6]);
      const res = await parse(appWithClock(createMockLlmClient([ok(AIR_OUTPUT)])), "macbook air bán");
      const body = (await res.json()) as { suggestions: { aliases: string[]; exclude: string[]; priceRange: { n: number; median: number } | null } };
      expect(body.suggestions.aliases).toEqual(["macbook air", "mac air"]);
      expect(body.suggestions.exclude).toEqual(["wtb", "want to buy", "looking to buy", "looking for"]);
      expect(body.suggestions.priceRange?.n).toBeGreaterThanOrEqual(5);
      expect(body.suggestions.priceRange?.median).toBe(22_500_000);
    });

    test("4 prices -> priceRange null; buy intent -> no exclude suggestions", async () => {
      clearRate();
      await clearUsage();
      await seedPrices([20e6, 21e6, 22e6, 23e6]);
      const res = await parse(appWithClock(createMockLlmClient([ok({ ...AIR_OUTPUT, intents: ["buy"] })])), "macbook air mua");
      const body = (await res.json()) as { suggestions: { exclude: string[]; priceRange: unknown } };
      expect(body.suggestions.priceRange).toBeNull();
      expect(body.suggestions.exclude).toEqual([]);
    });

    test("suggestExcludePreset vi plus a custom list is the union", async () => {
      clearRate();
      await clearUsage();
      await seedPrices([20e6, 21e6, 22e6, 23e6]);
      await setConfig("watch.suggestExcludePreset", "vi");
      await setConfig("watch.suggestExcludeSell", ["scam"]);
      try {
        const res = await parse(appWithClock(createMockLlmClient([ok(AIR_OUTPUT)])), "macbook air bán");
        const body = (await res.json()) as { suggestions: { exclude: string[] } };
        expect(body.suggestions.exclude).toEqual(["thu mua", "cầm đồ", "cần mua", "tìm mua", "scam"]);
      } finally {
        await setConfig("watch.suggestExcludePreset", "en");
        await setConfig("watch.suggestExcludeSell", []);
      }
    });
  });

  // Resets the fixed clock. The rate limiter lives in the route instance, so each fresh app starts with an empty window.
  function clearRate(): void {
    clock.t = NOW;
  }
  function appWithClock(llm: MockLlmClient | null) {
    return createApp(handle, undefined, { llm: async () => llm, now: () => clock.t });
  }
});
