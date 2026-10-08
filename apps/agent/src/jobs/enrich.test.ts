import { buildAliasDict, type CatalogItem, type Category } from "@feedhound/core/classify";
import { createBudget } from "@feedhound/llm/budget";
import type { LlmClient, LlmCompleteRequest, LlmResult } from "@feedhound/llm/client";
import { createMockLlmClient, type ScriptedResponse } from "@feedhound/llm/mock";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { isQuotaFailure, registerEnrichJob, runEnrichJob, resetLlmQuotaBreaker, runInsightBackfill, type EnrichConfig, type RunEnrichJobOptions } from "./enrich";
import type { PgBoss } from "pg-boss";
import { compileWatch, matchPost } from "@feedhound/core/matcher";
import { seedTaxonomyAndCatalogue as seed } from "@feedhound/db/src/seed";
import { AliasCache } from "../services/alias-cache";

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
    console.warn(`enrich.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) {
      await probe.close();
      throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    }
    canRun = true;
  }
  await probe.close();
} else if (MUST_RUN) {
  throw new Error("enrich.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("enrich.test.ts: skipped — TEST_DATABASE_URL is unset");
}

const CONFIG: EnrichConfig = {
  ruleConfidenceMin: 0.7,
  llmConfidenceMin: 0.5,
  enrichAll: false,
  modelCheap: "cheap-model",
  modelStrong: "strong-model",
};

describe.skipIf(!canRun)("runEnrichJob", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let sourceId: string;
  let categoryId: string;
  let itemId: string;
  let category: Category;
  let item: CatalogItem;

  async function insertPost(text: string): Promise<{ id: string; editCount: number }> {
    const [post] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `enrich-${crypto.randomUUID()}`,
        url: "https://feeds.example.test/enrich-job-test/posts/1",
        text,
        textNormalized: text.toLowerCase(),
      })
      .returning({ id: schema.post.id, editCount: schema.post.editCount });
    return { id: post!.id, editCount: post!.editCount };
  }

  function baseOptions(overrides: Partial<RunEnrichJobOptions>): RunEnrichJobOptions {
    const dict = buildAliasDict([category], [item]);
    return {
      handle,
      catalogue: { dict, categories: [category], items: [item] },
      prefilterTerms: new Set<string>(),
      llmClient: undefined,
      budget: undefined,
      config: CONFIG,
      payload: { postId: "", revision: 0 },
      ...overrides,
    };
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "enrich-job-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `enrich-job-test-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `enrich-job-test-${crypto.randomUUID()}`, name: "Enrich job test", url: "https://feeds.example.test/enrich-job-test" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
    const [cat] = await handle.db
      .insert(schema.category)
      .values({ slug: `enrich-phones-${crypto.randomUUID()}`, name: "Enrich Phones", path: `electronics.enrich_${Date.now()}` })
      .returning({ id: schema.category.id, slug: schema.category.slug, name: schema.category.name, parentId: schema.category.parentId });
    categoryId = cat!.id;
    category = { id: cat!.id, parentId: cat!.parentId, slug: cat!.slug, name: cat!.name };
    const [it] = await handle.db
      .insert(schema.catalogItem)
      .values({ categoryId, name: "iPhone 15", aliases: ["ip15", "iphone 15"] })
      .returning({ id: schema.catalogItem.id, categoryId: schema.catalogItem.categoryId, name: schema.catalogItem.name, aliases: schema.catalogItem.aliases });
    itemId = it!.id;
    item = { id: it!.id, categoryId: it!.categoryId, name: it!.name, aliases: it!.aliases };
  });

  afterAll(async () => {
    const posts = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId));
    for (const p of posts) {
      await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, p.id));
    }
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    // The budget tests use fixed fake-clock dates (2026-01-01/02 UTC) for the budget
    // bucket -- clean those up so repeated runs don't accumulate stray
    // MetricRollup rows in the shared feedhound_test database.
    await handle.sql`delete from metric_rollup where bucket = 'day' and dims = '{"metric":"llm_tokens"}'::jsonb and ts in ('2026-01-01T00:00:00.000Z'::timestamptz, '2026-01-02T00:00:00.000Z'::timestamptz)`;
    await handle.db.delete(schema.catalogItem).where(eq(schema.catalogItem.id, itemId));
    await handle.db.delete(schema.category).where(eq(schema.category.id, categoryId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Rule confidence >= threshold -> no LLM call, engine=rule, tokens=0", async () => {
    const post = await insertPost("can ban iphone 15 con moi 100%");
    const client = createMockLlmClient([]);
    const result = await runEnrichJob(
      baseOptions({ llmClient: client, budget: undefined, payload: { postId: post.id, revision: post.editCount } }),
    );
    expect(result.outcome).toBe("written");
    expect(result.engine).toBe("rule");
    expect(client.calls.length).toBe(0);

    const [row] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, post.id));
    expect(row?.engine).toBe("rule");
    expect(row?.tokens).toBe(0);
  });

  test("Low rule confidence + prefilter hit -> cheap model accepted", async () => {
    const post = await insertPost("hoi ve iphone 15 con hang"); // item hit but no sell/buy phrase -> low confidence
    const responses: ScriptedResponse[] = [
      {
        ok: true,
        data: { intent: "sell", priceVnd: 5_000_000, condition: "used", categorySlug: category.slug, itemName: item.name, confidence: 0.9 },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: CONFIG.modelCheap,
        latencyMs: 5,
      },
    ];
    const client = createMockLlmClient(responses);
    const budget = createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 });

    const result = await runEnrichJob(
      baseOptions({
        llmClient: client,
        budget,
        prefilterTerms: new Set([categoryId]),
        payload: { postId: post.id, revision: post.editCount, force: true },
      }),
    );

    expect(client.calls.length).toBe(1);
    expect(result.engine).toBe("llm");
    expect(result.model).toBe(CONFIG.modelCheap);
    expect(result.tokens).toBe(15);

    const [row] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, post.id));
    expect(row?.promptVersion).toMatch(/^enrich@\d+$/);
  });

  test("Cheap non-schema -> strong called once; strong ok -> engine=llm,model=strong", async () => {
    const post = await insertPost("hoi ve iphone 15 con hang nhe");
    const responses: ScriptedResponse[] = [
      { ok: false, reason: "schema", raw: "not json", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      {
        ok: true,
        data: { intent: "sell", priceVnd: null, condition: "unknown", categorySlug: null, itemName: null, confidence: 0.3 },
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        model: CONFIG.modelStrong,
        latencyMs: 5,
      },
    ];
    const client = createMockLlmClient(responses);
    const budget = createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 });

    const result = await runEnrichJob(
      baseOptions({
        llmClient: client,
        budget,
        prefilterTerms: new Set([categoryId]),
        payload: { postId: post.id, revision: post.editCount, force: true },
      }),
    );

    expect(client.calls.length).toBe(2);
    expect(result.engine).toBe("llm");
    expect(result.model).toBe(CONFIG.modelStrong);
  });

  test("cheap and strong both fail -> engine=rule", async () => {
    const post = await insertPost("hoi ve iphone 15 nua nhe");
    const responses: ScriptedResponse[] = [
      { ok: false, reason: "http", status: 500 },
      { ok: false, reason: "http", status: 500 },
    ];
    const client = createMockLlmClient(responses);
    const budget = createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 });

    const result = await runEnrichJob(
      baseOptions({
        llmClient: client,
        budget,
        prefilterTerms: new Set([categoryId]),
        payload: { postId: post.id, revision: post.editCount, force: true },
      }),
    );

    expect(client.calls.length).toBe(2);
    expect(result.engine).toBe("rule");
  });

  test("Low confidence, no watch term/category -> enrichAll=false skips LLM; enrichAll=true calls it", async () => {
    const post = await insertPost("hoi ve mot san pham linh tinh");
    const client1 = createMockLlmClient([]);
    const budget = createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 });

    const result1 = await runEnrichJob(
      baseOptions({ llmClient: client1, budget, prefilterTerms: new Set(), payload: { postId: post.id, revision: post.editCount } }),
    );
    expect(client1.calls.length).toBe(0);
    expect(result1.engine).toBe("rule");

    const responses: ScriptedResponse[] = [
      {
        ok: true,
        data: { intent: "other", priceVnd: null, condition: "unknown", categorySlug: null, itemName: null, confidence: 0.9 },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: CONFIG.modelCheap,
        latencyMs: 1,
      },
    ];
    const client2 = createMockLlmClient(responses);
    const result2 = await runEnrichJob(
      baseOptions({
        llmClient: client2,
        budget,
        prefilterTerms: new Set(),
        config: { ...CONFIG, enrichAll: true },
        payload: { postId: post.id, revision: post.editCount, force: true },
      }),
    );
    expect(client2.calls.length).toBe(1);
    expect(result2.engine).toBe("llm");
  });

  test("Budget exhausted -> 0 LLM calls, engine=rule; resumes next day", async () => {
    const post = await insertPost("hoi ve mot san pham can llm");
    let currentDay = new Date("2026-01-01T01:00:00Z");
    const budget = createBudget({ handle, tz: "UTC", dailyTokenBudget: 100, budgetAlertPct: 80, now: () => currentDay });

    // Push usage to 100% of budget directly.
    await budget.recordUsage({ promptTokens: 60, completionTokens: 40, totalTokens: 100 });
    expect(await budget.isExhausted()).toBe(true);

    const client = createMockLlmClient([]);
    const result = await runEnrichJob(
      baseOptions({
        llmClient: client,
        budget,
        prefilterTerms: new Set([categoryId]),
        payload: { postId: post.id, revision: post.editCount, force: true },
      }),
    );
    expect(client.calls.length).toBe(0);
    expect(result.engine).toBe("rule");

    // Next day: budget resets (new bucket).
    currentDay = new Date("2026-01-02T01:00:00Z");
    expect(await budget.isExhausted()).toBe(false);
  });

  test("concurrent budget-crossing calls insert exactly one ops notification", async () => {
    const postX = await insertPost("hoi ve san pham can llm x");
    const postY = await insertPost("hoi ve san pham can llm y");
    const day = new Date("2026-02-01T01:00:00Z");
    const bucketTs = "2026-02-01T00:00:00.000Z";
    const dedupeKey = `llm_budget:${day.toISOString().slice(0, 10)}`;
    // A leftover row from a previous interrupted run (this bucket is unique
    // to this test) would make `isExhausted()` trip immediately -- start
    // from a clean slate every time, and clean up in `finally` so a failed
    // assertion never leaks state into the next run.
    await handle.sql`delete from metric_rollup where bucket = 'day' and dims = '{"metric":"llm_tokens"}'::jsonb and ts = ${bucketTs}::timestamptz`;
    await handle.sql`delete from notification where channel = 'ops' and payload -> 'ops' ->> 'dedupeKey' = ${dedupeKey}`;

    // dailyTokenBudget=100, alert at 80%: usage starts at 0, so both a 79-token
    // call and a following 5-token call individually cross the 80% line only
    // once each -- run two jobs concurrently that both push past it.
    const budget = createBudget({ handle, tz: "UTC", dailyTokenBudget: 100, budgetAlertPct: 80, now: () => day });
    const responses: ScriptedResponse[] = [
      { ok: true, data: { intent: "sell", priceVnd: null, condition: "unknown", categorySlug: null, itemName: null, confidence: 0.9 }, usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 }, model: CONFIG.modelCheap, latencyMs: 5 },
      { ok: true, data: { intent: "sell", priceVnd: null, condition: "unknown", categorySlug: null, itemName: null, confidence: 0.9 }, usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 }, model: CONFIG.modelCheap, latencyMs: 5 },
    ];
    const client = createMockLlmClient(responses);

    try {
      await Promise.all([
        runEnrichJob(baseOptions({ llmClient: client, budget, opsUserId: userId, now: () => day, prefilterTerms: new Set([categoryId]), payload: { postId: postX.id, revision: postX.editCount, engine: "llm" } })),
        runEnrichJob(baseOptions({ llmClient: client, budget, opsUserId: userId, now: () => day, prefilterTerms: new Set([categoryId]), payload: { postId: postY.id, revision: postY.editCount, engine: "llm" } })),
      ]);

      const rows = await handle.sql<{ n: number }[]>`select count(*)::int as n from notification where channel = 'ops' and payload -> 'ops' ->> 'dedupeKey' = ${dedupeKey}`;
      expect(rows[0]?.n).toBe(1);
    } finally {
      await handle.sql`delete from notification where channel = 'ops' and payload -> 'ops' ->> 'dedupeKey' = ${dedupeKey}`;
      await handle.sql`delete from metric_rollup where bucket = 'day' and dims = '{"metric":"llm_tokens"}'::jsonb and ts = ${bucketTs}::timestamptz`;
    }
  });

  test("Same (postId, revision) enqueued twice -> one row, at most one ladder run", async () => {
    const post = await insertPost("can ban iphone 15 gia tot");
    const budget = createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 });
    const responses: ScriptedResponse[] = [
      {
        ok: true,
        data: { intent: "sell", priceVnd: 5_000_000, condition: "used", categorySlug: category.slug, itemName: item.name, confidence: 0.9 },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: CONFIG.modelCheap,
        latencyMs: 5,
      },
    ];
    const client = createMockLlmClient(responses);
    const opts = baseOptions({
      llmClient: client,
      budget,
      prefilterTerms: new Set([categoryId]),
      payload: { postId: post.id, revision: post.editCount, force: true, engine: "llm" },
    });

    const r1 = await runEnrichJob(opts);
    expect(r1.outcome).toBe("written");
    expect(client.calls.length).toBe(1);

    // second run WITHOUT force: same revision + same promptVersion -> no-op.
    const r2 = await runEnrichJob({ ...opts, payload: { ...opts.payload, force: false } });
    expect(r2.outcome).toBe("noop");
    expect(client.calls.length).toBe(1);

    const rows = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, post.id));
    expect(rows.length).toBe(1);
  });

  test("stale revision (post edited since enqueue) is skipped", async () => {
    const post = await insertPost("can ban macbook cu");
    await handle.db.update(schema.post).set({ editCount: post.editCount + 1 }).where(eq(schema.post.id, post.id));

    const client = createMockLlmClient([]);
    const result = await runEnrichJob(baseOptions({ llmClient: client, payload: { postId: post.id, revision: post.editCount } }));
    expect(result.outcome).toBe("stale");
    expect(client.calls.length).toBe(0);
  });

  test("upsert never downgrades a newer revision (TOCTOU guard)", async () => {
    const post = await insertPost("can ban dien thoai cu");
    // The write also requires post.edit_count = payload.revision, so line the post up with each job.
    await handle.sql`update post set edit_count = 5 where id = ${post.id}`;

    // A "fast" job for revision 5 lands first...
    const fast = await runEnrichJob(baseOptions({ payload: { postId: post.id, revision: 5, force: true, engine: "rule" } }));
    expect(fast.outcome).toBe("written");

    // ...then a "slow" job for an older revision 3 finally lands. Without
    // the `where enrichment.revision <= excluded.revision` guard on the
    // upsert, this would silently clobber the newer row.
    await handle.sql`update post set edit_count = 3 where id = ${post.id}`;
    const slow = await runEnrichJob(baseOptions({ payload: { postId: post.id, revision: 3, force: true, engine: "rule" } }));
    // This asserted "written" until the enrich -> match trigger was wired.
    // Reporting a write that the `where` guard dropped is not just cosmetic:
    // the worker enqueues a `match` job on "written", so a stale job would
    // re-match a post whose enrichment never changed. The guard's real
    // assertion is the revision check below, which is unchanged.
    expect(slow.outcome).toBe("stale");

    const [row] = await handle.db.select({ revision: schema.enrichment.revision }).from(schema.enrichment).where(eq(schema.enrichment.postId, post.id));
    expect(row?.revision).toBe(5);
  });

  // LLM client whose calls park on a promise the test releases.
  function gatedClient(): { client: LlmClient; release: () => void; started: () => number } {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: LlmClient = {
      async complete<T>(_req: LlmCompleteRequest<T>): Promise<LlmResult<T>> {
        calls++;
        await gate;
        return {
          ok: true,
          data: { intent: "sell", priceVnd: 5_000_000, condition: "used", categorySlug: category.slug, itemName: item.name, confidence: 0.9 } as T,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: CONFIG.modelCheap,
          latencyMs: 1,
        };
      },
    };
    return { client, release, started: () => calls };
  }

  const fakeBudget = {
    getUsageToday: async () => ({ prompt: 0, completion: 0, total: 0, calls: 0 }),
    recordUsage: async () => {
      const zero = { prompt: 0, completion: 0, total: 0, calls: 0 };
      return { before: zero, after: zero };
    },
    isExhausted: async () => false,
    crossedAlertPct: () => false,
  };

  async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  }

  async function upgradeText(postId: string, text: string): Promise<void> {
    await handle.db.update(schema.post).set({ text, textNormalized: text.toLowerCase() }).where(eq(schema.post.id, postId));
  }

  async function enrichmentOf(postId: string) {
    const [row] = await handle.sql<{ engine: string; text_hash: string | null; hash: string }[]>`
      select e.engine, e.text_hash, md5(p.text) as hash from enrichment e join post p on p.id = e.post_id where e.post_id = ${postId}`;
    return row;
  }

  test("a slow LLM job on the pre-upgrade text is stale; the upgrade's enrichment wins", async () => {
    const post = await insertPost("hoi ve iphone 15 con hang");
    const gated = gatedClient();
    const a = runEnrichJob(
      baseOptions({ llmClient: gated.client, budget: fakeBudget, payload: { postId: post.id, revision: post.editCount, engine: "llm" } }),
    );
    await waitFor(() => gated.started() > 0);
    await upgradeText(post.id, "can ban iphone 15 con moi 100%, giay to day du, bao hanh chinh hang");
    const b = await runEnrichJob(
      baseOptions({ payload: { postId: post.id, revision: post.editCount, force: true, reason: "capture_upgrade" } }),
    );
    expect(b.outcome).toBe("written");
    gated.release();
    expect((await a).outcome).toBe("stale");
    const row = await enrichmentOf(post.id);
    expect(row?.engine).toBe("rule");
    expect(row?.text_hash).toBe(row?.hash);
  }, 30_000);

  test("reverse order -- the job that finished before the upgrade is overwritten by the upgrade job", async () => {
    const post = await insertPost("hoi ve iphone 15 con hang");
    const gated = gatedClient();
    gated.release();
    const a = await runEnrichJob(
      baseOptions({ llmClient: gated.client, budget: fakeBudget, payload: { postId: post.id, revision: post.editCount, engine: "llm" } }),
    );
    expect(a.outcome).toBe("written");
    expect((await enrichmentOf(post.id))?.engine).toBe("llm");
    await upgradeText(post.id, "can ban iphone 15 con moi 100%, giay to day du, bao hanh chinh hang");
    const b = await runEnrichJob(
      baseOptions({ payload: { postId: post.id, revision: post.editCount, force: true, reason: "capture_upgrade" } }),
    );
    expect(b.outcome).toBe("written");
    const row = await enrichmentOf(post.id);
    expect(row?.engine).toBe("rule");
    expect(row?.text_hash).toBe(row?.hash);
  }, 30_000);

  test("a revision-0 job on a post already edited to revision 1 is stale", async () => {
    const post = await insertPost("can ban iphone 15 con moi 100%");
    await handle.sql`update post set edit_count = 1 where id = ${post.id}`;
    const r = await runEnrichJob(baseOptions({ payload: { postId: post.id, revision: 0 } }));
    expect(r.outcome).toBe("stale");
    expect(await handle.sql`select 1 from enrichment where post_id = ${post.id}`).toHaveLength(0);
  });

  test("015 review 1: an upgrade committing between the enrichment insert and the state update leaves the post pending", async () => {
    const post = await insertPost("can ban iphone 15 con moi 100%");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => {
      locked = r;
    });
    const upgrader = handle.sql.begin(async (tx) => {
      await tx`update post set text = 'can ban iphone 15 con moi 100% full text', edit_count = edit_count + 1 where id = ${post.id}`;
      locked();
      await gate;
    });
    await lockedP;
    const job = runEnrichJob(baseOptions({ payload: { postId: post.id, revision: post.editCount, engine: "rule" } }));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await upgrader;
    await job;
    const [row] = await handle.sql<{ enrich_state: string }[]>`select enrich_state from post where id = ${post.id}`;
    expect(row!.enrich_state).toBe("pending");
  });

  test("a text_hash mismatch re-enriches; an equal hash on a pending post is a noop that finishes the state and enqueues one match", async () => {
    const post = await insertPost("can ban iphone 15 con moi 100%");
    // Only LLM writes carry a promptVersion, so only they can be a noop (rule writes always re-run).
    const payload = { postId: post.id, revision: post.editCount };
    const llmOpts = () => {
      const g = gatedClient();
      g.release();
      return baseOptions({ llmClient: g.client, budget: fakeBudget, payload: { ...payload, engine: "llm" } });
    };
    expect((await runEnrichJob(llmOpts())).outcome).toBe("written");
    expect((await runEnrichJob(llmOpts())).outcome).toBe("noop");

    await handle.sql`update enrichment set text_hash = null where post_id = ${post.id}`;
    expect((await runEnrichJob(llmOpts())).outcome).toBe("written");
    await handle.sql`update enrichment set text_hash = 'deadbeef' where post_id = ${post.id}`;
    expect((await runEnrichJob(llmOpts())).outcome).toBe("written");

    // Equal hash + pending: run through the worker so the match enqueue is observable.
    await handle.sql`update post set enrich_state = 'pending', match_state = 'pending' where id = ${post.id}`;
    const sent: { name: string; data: unknown }[] = [];
    let handler: ((jobs: { id: string; data: unknown }[]) => Promise<void>) | undefined;
    const fakeBoss = {
      createQueue: async () => undefined,
      work: async (_q: string, h: typeof handler) => {
        handler = h;
      },
      send: async (name: string, data: unknown) => {
        sent.push({ name, data });
        return "j";
      },
    } as unknown as PgBoss;
    await registerEnrichJob({
      boss: fakeBoss,
      handle,
      catalogueSnapshot: () => baseOptions({}).catalogue,
      llmClient: undefined,
      budget: undefined,
      fetchConfig: async () => CONFIG,
      fetchOpsUserId: async () => undefined,
    });
    await handler!([{ id: "job-1", data: payload }]);
    const matches = sent.filter((m) => m.name === "match" && (m.data as { postId: string }).postId === post.id);
    expect(matches).toHaveLength(1);
    const [state] = await handle.sql<{ enrich_state: string; match_state: string }[]>`select enrich_state, match_state from post where id = ${post.id}`;
    expect(state?.enrich_state).toBe("done");
    expect(state?.match_state).toBe("pending");
  }, 30_000);

  test("capture_upgrade re-enriches the same revision on the upgraded text", async () => {
    const post = await insertPost("ban dien thoai cu gia re");
    const first = await runEnrichJob(baseOptions({ payload: { postId: post.id, revision: post.editCount } }));
    expect(first.outcome).toBe("written");
    const [before] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, post.id));
    expect(before?.itemId).toBeNull();

    // In-place text upgrade: same revision, no edit_count bump.
    await handle.db
      .update(schema.post)
      .set({ text: "can ban iphone 15 con moi 100%", textNormalized: "can ban iphone 15 con moi 100%" })
      .where(eq(schema.post.id, post.id));

    const upgraded = await runEnrichJob(
      baseOptions({ payload: { postId: post.id, revision: post.editCount, force: true, reason: "capture_upgrade" } }),
    );
    expect(upgraded.outcome).toBe("written");
    const [after] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, post.id));
    expect(after?.itemId).toBe(itemId);
    expect(after?.revision).toBe(before?.revision);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Attributes, price bounds, deal score, source defaults, display titles (seeded taxonomy + catalogue).
// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!canRun)("runEnrichJob", () => {
  let handle: DbHandle;
  let cache: AliasCache;
  let teamId: string;
  let carSourceId: string; // defaults { region: "hcm", categoryId: cars }
  let plainSourceId: string; // no defaults
  const ids: Record<string, string> = {};
  const peerPostIds: string[] = [];
  const CFG026: EnrichConfig = { ...CONFIG, dealWindowDays: 30, dealMinPeers: 5 };

  function snapshot() {
    return { dict: cache.get(), categories: cache.getCategories(), items: cache.getItems(), attrs: cache.getAttrs() };
  }

  async function insertPost(sourceId: string, text: string, firstSeenAt?: Date): Promise<{ id: string; editCount: number }> {
    const [post] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `enrich026-${crypto.randomUUID()}`,
        url: "https://feeds.example.test/enrich-026-test/posts/1",
        text,
        textNormalized: text.toLowerCase(),
        ...(firstSeenAt ? { firstSeenAt } : {}),
      })
      .returning({ id: schema.post.id, editCount: schema.post.editCount });
    peerPostIds.push(post!.id);
    return { id: post!.id, editCount: post!.editCount };
  }

  async function enrich(postId: string, editCount: number, opts: { engine: "rule" | "llm"; client?: ReturnType<typeof createMockLlmClient> }) {
    const budget = createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 });
    return runEnrichJob({
      handle,
      catalogue: snapshot(),
      prefilterTerms: new Set<string>(),
      llmClient: opts.client,
      budget: opts.client ? budget : undefined,
      config: CFG026,
      payload: { postId, revision: editCount, force: true, engine: opts.engine },
    });
  }

  async function row(postId: string) {
    const [r] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, postId));
    return r!;
  }

  function llmOk(data: Record<string, unknown>): ScriptedResponse {
    return {
      ok: true,
      data: { intent: "sell", priceVnd: null, condition: "used", categorySlug: null, itemName: null, confidence: 0.9, attributes: {}, ...data },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: CONFIG.modelCheap,
      latencyMs: 5,
    };
  }

  /** A comparable sell post + enrichment row inserted directly (deal peers). */
  async function insertPeer(p: { attrs: Record<string, string | number>; price: number; itemId?: string | null; categoryId?: string | null; daysAgo?: number; suspect?: boolean; qualifier?: "floor" }): Promise<void> {
    const seen = new Date(Date.now() - (p.daysAgo ?? 5) * 24 * 60 * 60 * 1000);
    const post = await insertPost(carSourceId, `peer ${crypto.randomUUID()}`, seen);
    await handle.db.insert(schema.enrichment).values({
      postId: post.id,
      revision: post.editCount,
      intent: "sell",
      priceVnd: p.price,
      priceQualifier: p.qualifier ?? "exact",
      priceConfidence: p.qualifier ? 0.5 : 0.9,
      engine: "rule",
      itemId: p.itemId ?? null,
      categoryId: p.categoryId ?? null,
      attributes: p.attrs,
      attributesVersion: 1,
      priceSuspect: p.suspect ?? false,
    });
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where (slug = 'cars' and attribute_schema <> '[]'::jsonb) or slug = 'car-parts'`;
    if ((seeded?.n ?? 0) < 2) await seed(TEST_DATABASE_URL);
    const cats = await handle.sql<{ id: string; slug: string }[]>`select id, slug from category where slug in ('cars','sedan','iphone','macbook','car-parts')`;
    for (const c of cats) ids[c.slug] = c.id;
    const items = await handle.sql<{ id: string; name: string }[]>`select id, name from catalog_item where name in ('MacBook Air','Toyota Vios','iPhone X','iPhone 15')`;
    for (const i of items) ids[i.name] = i.id;
    const [team] = await handle.db.insert(schema.team).values({ name: "enrich-026-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const mk = async (name: string, defaults: Record<string, string | number>) => {
      const [s] = await handle.db
        .insert(schema.source)
        .values({ teamId, kind: "web", platformId: `enrich-026-${crypto.randomUUID()}`, name, url: "https://feeds.example.test/enrich-026-test", defaults })
        .returning({ id: schema.source.id });
      return s!.id;
    };
    carSourceId = await mk("Enrich 026 cars", { region: "hcm", categoryId: ids.cars as string });
    plainSourceId = await mk("Enrich 026 plain", {});
    cache = new AliasCache({ handle });
    await cache.start();
  }, 120_000);

  afterAll(async () => {
    await cache.stop();
    for (const id of peerPostIds) await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, id));
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, [carSourceId, plainSourceId]));
    await handle.db.delete(schema.source).where(inArray(schema.source.id, [carSourceId, plainSourceId]));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Merge item > regex > llm, invalid LLM values dropped, enrich@5 prompt carries the macbook schema", async () => {
    const post = await insertPost(plainSourceId, "mba ssd 256 bán gấp");
    const client = createMockLlmClient([
      llmOk({ categorySlug: "macbook", itemName: "MacBook Air", attributes: { chip: "M2 Pro", ram_gb: "16", foo: 1, battery_pct: 150, ssd_gb: 512 } }),
    ]);
    const r = await enrich(post.id, post.editCount, { engine: "llm", client });
    expect(r.engine).toBe("llm");
    const e = await row(post.id);
    expect(e.attributes).toEqual({ line: "air", chip: "m2_pro", ram_gb: 16, ssd_gb: 256 });
    expect(e.promptVersion).toBe("enrich@5");
    expect(e.attributesVersion).toBe(2);
    expect(client.calls[0]?.prompt.user).toContain("macbook");
    expect(client.calls[0]?.prompt.user).toContain("m2_pro");
  });

  test("Out-of-bounds and phone-shaped prices are nulled and flagged, raw kept; in-bounds kept; priceMax watch skips suspects", async () => {
    const phone = await insertPost(plainSourceId, "Bán iPhone X 64gb 354.305.693");
    const mac = await insertPost(plainSourceId, "Bán MacBook Air M1 giá 1.500.000");
    const ok = await insertPost(plainSourceId, "Bán iPhone 15 giá 17tr");
    for (const p of [phone, mac, ok]) await enrich(p.id, p.editCount, { engine: "rule" });
    const [a, b, c] = [await row(phone.id), await row(mac.id), await row(ok.id)];
    expect([a.priceVnd, a.priceSuspect, a.priceRaw]).toEqual([null, true, "354.305.693"]);
    expect([b.priceVnd, b.priceSuspect, b.priceRaw]).toEqual([null, true, "1.500.000"]);
    expect([c.priceVnd, c.priceSuspect]).toEqual([17_000_000, false]);

    const w = compileWatch(
      { id: "w", userId: "u", name: "w", enabled: true, include: ["x"], includeAll: [], exclude: [], regex: null, categoryIds: [], itemIds: [], priceMin: null, priceMax: 20_000_000, intents: [], sourceIds: [], notifierIds: [], quietHours: null, mutedUntil: null, createdAt: new Date().toISOString() },
      new Map(),
    );
    const hit = (e: typeof a) => matchPost({ post: { id: "p", sourceId: "s", textNormalized: "x" }, enrichment: { intent: e.intent as "sell", priceVnd: e.priceVnd, categoryId: e.categoryId, itemId: e.itemId } }, [w], new Date()).length;
    expect([hit(a), hit(b), hit(c)]).toEqual([0, 0, 1]);
  });

  test("Deal score uses same-config peers in the window, trims the outlier, needs minPeers and every key attribute", async () => {
    const attrs = { chip: "m2", ram_gb: 16, ssd_gb: 256 };
    const air = ids["MacBook Air"] as string;
    for (const price of [17, 18, 19, 20, 21, 90]) await insertPeer({ attrs, price: price * 1_000_000, itemId: air, categoryId: ids.macbook });
    await insertPeer({ attrs: { ...attrs, ssd_gb: 512 }, price: 30_000_000, itemId: air });
    await insertPeer({ attrs, price: 5_000_000, itemId: air, daysAgo: 31 });
    await insertPeer({ attrs, price: 6_000_000, itemId: air, suspect: true });

    const post = await insertPost(plainSourceId, "Bán MacBook Air M2 16/256 giá 17tr1");
    await enrich(post.id, post.editCount, { engine: "rule" });
    const e = await row(post.id);
    expect([e.dealN, e.dealMedianVnd, e.dealPct]).toEqual([5, 19_000_000, -10]);

    const noRam = await insertPost(plainSourceId, "Bán MacBook Air M2 256 giá 17tr1");
    await enrich(noRam.id, noRam.editCount, { engine: "rule" });
    const n = await row(noRam.id);
    expect([n.dealN, n.dealMedianVnd, n.dealPct]).toEqual([null, null, null]);

    // only 4 usable peers -> null
    await handle.sql`delete from enrichment where price_vnd in (20000000, 21000000) and attributes_version = 1 and post_id = any(${peerPostIds}::uuid[])`;
    await enrich(post.id, post.editCount, { engine: "rule" });
    const f = await row(post.id);
    expect([f.dealN, f.dealMedianVnd, f.dealPct]).toEqual([null, null, null]);
  });

  test("enrich: source defaults fill region for cars only; a location in the text wins", async () => {
    const noLoc = await insertPost(carSourceId, "Bán Toyota Vios 2016 số sàn giá 185tr");
    const bh = await insertPost(carSourceId, "Bán Toyota Vios 2016 số sàn giá 185tr Biên Hòa");
    const phone = await insertPost(carSourceId, "Bán iPhone 15 giá 17tr");
    for (const p of [noLoc, bh, phone]) await enrich(p.id, p.editCount, { engine: "rule" });
    expect((await row(noLoc.id)).attributes).toMatchObject({ region: "hcm", make: "toyota", model: "vios" });
    expect((await row(bh.id)).attributes).toMatchObject({ region: "dong_nai" });
    expect(Object.keys((await row(phone.id)).attributes)).not.toContain("region");
  });

  test("source default category: an uncategorised post in a car group is categorised as cars and gets car attributes", async () => {
    const post = await insertPost(carSourceId, "Bán Honda City 2017 giá 180tr");
    await enrich(post.id, post.editCount, { engine: "rule" });
    const e = await row(post.id);
    expect(e.categoryId).toBe(ids.cars as string);
    expect(e.attributes).toMatchObject({ make: "honda", model: "city", year: 2017, region: "hcm" });
    expect(e.priceVnd).toBe(180_000_000);
  });

  test("LLM title kept only when grounded; otherwise the rule title; long titles cut to 80", async () => {
    const text = "Bán Toyota Vios 1.5E số sàn sx 2016, odo 6v, xe gia đình Q7";
    const grounded = "Toyota Vios 2016 1.5E · số sàn";
    const long = `Toyota Vios 2016 ${"số sàn rất đẹp ".repeat(7)}`.trim();
    const expected: (string | null)[] = [grounded, "Toyota Vios 2016 · MT · 60.000 km", null];
    const inputs = [grounded, "Toyota Vios 2018 · số sàn", long];
    for (const [i, title] of inputs.entries()) {
      const post = await insertPost(carSourceId, text);
      await enrich(post.id, post.editCount, { engine: "llm", client: createMockLlmClient([llmOk({ displayTitle: title })]) });
      const t = (await row(post.id)).displayTitle;
      if (expected[i] !== null) expect(t).toBe(expected[i] as string);
      else {
        expect(t).not.toBeNull();
        expect((t as string).length).toBeLessThanOrEqual(80);
      }
    }
    const mac = await insertPost(plainSourceId, "Bán MacBook Air M2 16/256");
    await enrich(mac.id, mac.editCount, { engine: "rule" });
    expect((await row(mac.id)).displayTitle).toBe("MacBook Air · M2 · 16GB · 256GB");
  });

  test("Phone-shaped and sub-bound car prices are suspect; 185tr is kept", async () => {
    const posts = [
      await insertPost(carSourceId, "Bán Toyota Vios 2017 giá 952.941.444"),
      await insertPost(carSourceId, "Bán Toyota Vios 2017 giá 25tr"),
      await insertPost(carSourceId, "Bán Toyota Vios 2017 giá 185tr"),
    ];
    for (const p of posts) await enrich(p.id, p.editCount, { engine: "rule" });
    const rows = await Promise.all(posts.map((p) => row(p.id)));
    expect(rows.map((r) => [r.priceVnd, r.priceSuspect])).toEqual([[null, true], [null, true], [185_000_000, false]]);
    expect(rows[0]?.priceRaw).toBe("952.941.444");
    expect(rows[1]?.priceRaw).toBe("25tr");
  });

  test("Cars deal peers: make+model exact, year +-1, transmission when known; missing year -> no deal", async () => {
    await handle.sql`delete from enrichment where post_id = any(${peerPostIds}::uuid[])`;
    const vios = ids["Toyota Vios"] as string;
    const base = { make: "toyota", model: "vios" };
    for (const price of [170, 180, 185, 190, 200]) await insertPeer({ attrs: { ...base, year: 2016, transmission: "mt" }, price: price * 1_000_000, itemId: vios });
    await insertPeer({ attrs: { ...base, year: 2017, transmission: "mt" }, price: 175_000_000, itemId: vios });
    await insertPeer({ attrs: { ...base, year: 2014, transmission: "mt" }, price: 120_000_000, itemId: vios });
    await insertPeer({ attrs: { make: "toyota", model: "innova", year: 2016, transmission: "mt" }, price: 300_000_000, itemId: vios });
    await insertPeer({ attrs: { ...base, year: 2016, transmission: "mt" }, price: 100_000_000, itemId: vios, daysAgo: 31 });
    await insertPeer({ attrs: { ...base, year: 2016, transmission: "mt" }, price: 100_000_000, itemId: vios, suspect: true });
    await insertPeer({ attrs: { ...base, year: 2016, transmission: "at" }, price: 195_000_000, itemId: vios });

    const withTx = await insertPost(carSourceId, "Bán Toyota Vios 2016 số sàn giá 171tr");
    await enrich(withTx.id, withTx.editCount, { engine: "rule" });
    const a = await row(withTx.id);
    expect([a.dealN, a.dealMedianVnd, a.dealPct]).toEqual([6, 182_500_000, -6.3]);

    await handle.sql`delete from enrichment where post_id = ${withTx.id}::uuid`;
    const noTx = await insertPost(carSourceId, "Bán Toyota Vios 2016 giá 171tr");
    await enrich(noTx.id, noTx.editCount, { engine: "rule" });
    expect((await row(noTx.id)).dealN).toBe(7);

    const noYear = await insertPost(carSourceId, "Bán Toyota Vios số sàn giá 171tr");
    await enrich(noYear.id, noYear.editCount, { engine: "rule" });
    const c = await row(noYear.id);
    expect([c.dealN, c.dealMedianVnd, c.dealPct]).toEqual([null, null, null]);
  });

  test("A car post without a catalogue item is compared inside the cars subtree", async () => {
    await handle.sql`delete from enrichment where post_id = any(${peerPostIds}::uuid[])`;
    const attrs = { make: "honda", model: "city", year: 2017 };
    for (const price of [170, 175, 180, 185, 190]) await insertPeer({ attrs, price: price * 1_000_000, categoryId: ids.sedan });
    const post = await insertPost(carSourceId, "Bán Honda City 2017 giá 160tr");
    await enrich(post.id, post.editCount, { engine: "rule" });
    const e = await row(post.id);
    expect([e.dealN, e.dealMedianVnd]).toEqual([5, 180_000_000]);
  });

  test("Rule price wins over an LLM price; ungrounded LLM price is dropped; floor is stored and never a peer", async () => {
    const p1 = await insertPost(plainSourceId, "iphone 16 Pro Max 19tr500");
    await enrich(p1.id, p1.editCount, { engine: "llm", client: createMockLlmClient([llmOk({ priceVnd: 20_000_000, categorySlug: "iphone" })]) });
    const a = await row(p1.id);
    expect([a.priceVnd, a.priceQualifier]).toEqual([19_500_000, "exact"]);

    const p2 = await insertPost(plainSourceId, "Bán Vios 2016 xe đẹp lắm");
    await enrich(p2.id, p2.editCount, { engine: "llm", client: createMockLlmClient([llmOk({ priceVnd: 230_000_000, categorySlug: "cars" })]) });
    const b = await row(p2.id);
    expect([b.priceVnd, b.priceQualifier, b.priceConfidence]).toEqual([null, null, null]);

    const p3 = await insertPost(plainSourceId, "Bán Vios 2016 xe đẹp giá 230 củ");
    await enrich(p3.id, p3.editCount, { engine: "llm", client: createMockLlmClient([llmOk({ priceVnd: null, categorySlug: "cars" })]) });
    expect([(await row(p3.id)).priceVnd, (await row(p3.id)).priceQualifier]).toEqual([230_000_000, "exact"]);

    await handle.sql`delete from enrichment where post_id = any(${peerPostIds}::uuid[])`;
    const attrs = { make: "kia", model: "morning", year: 2018 };
    for (const price of [180, 185, 190, 195, 200]) await insertPeer({ attrs, price: price * 1_000_000, categoryId: ids.cars });
    await insertPeer({ attrs, price: 1_000_000, categoryId: ids.cars, qualifier: "floor" });
    const floor = await insertPost(carSourceId, "Kia Morning 2018 bán hơn 200 triệu");
    await enrich(floor.id, floor.editCount, { engine: "rule" });
    const f = await row(floor.id);
    expect([f.priceVnd, f.priceQualifier, f.priceConfidence, f.dealN, f.dealPct]).toEqual([200_000_000, "floor", 0.5, null, null]);
    const exact = await insertPost(carSourceId, "Bán Kia Morning 2018 giá 200tr");
    await enrich(exact.id, exact.editCount, { engine: "rule" });
    const e = await row(exact.id);
    expect([e.priceQualifier, e.dealN]).toEqual(["exact", 5]); // the floor row (and the floor post) are not peers
  });

  test("In a cars group an iPhone/MacBook stays electronics; parts go to car-parts; a car stays in cars", async () => {
    const cat = async (text: string): Promise<string | null> => {
      const p = await insertPost(carSourceId, text);
      await enrich(p.id, p.editCount, { engine: "rule" });
      return (await row(p.id)).categoryId;
    };
    expect(await cat("Bán iPhone 13 giá 8tr")).toBe(ids.iphone as string);
    expect(await cat("Thanh lý MacBook Air M1")).toBe(ids.macbook as string);
    expect(await cat("Chuyên rã xác, phụ tùng Toyota")).toBe(ids["car-parts"] as string);
    const city = await cat("Honda City 2019 giá 380tr");
    expect([ids.cars, ids.sedan]).toContain(city as string);
  });

  test("review r1: a phone-shaped number elsewhere does not void a real price (185 củ + 909.123.456)", async () => {
    const post = await insertPost(carSourceId, "Vios 2016 giá 185 củ, 909.123.456 Tuấn");
    await enrich(post.id, post.editCount, { engine: "rule" });
    const e = await row(post.id);
    expect([e.priceVnd, e.priceSuspect]).toEqual([185_000_000, false]);

    const llm = await insertPost(carSourceId, "Bán Vios 2016 giá chốt 185 xíu thương lượng, 909.123.456 Tuấn");
    const client = createMockLlmClient([llmOk({ priceVnd: 185_000_000, categorySlug: "cars" })]);
    await enrich(llm.id, llm.editCount, { engine: "llm", client });
    const l = await row(llm.id);
    expect([l.priceVnd, l.priceSuspect]).toEqual([185_000_000, false]);
  });

  test("review r1: LLM-only year / odo_km / seats must appear in the text as whole digit runs", async () => {
    const post = await insertPost(carSourceId, "Bán Toyota Vios số sàn đi 62.000 km");
    const client = createMockLlmClient([llmOk({ categorySlug: "cars", attributes: { year: 2018, odo_km: 62000, seats: 5 } })]);
    await enrich(post.id, post.editCount, { engine: "llm", client });
    const a = (await row(post.id)).attributes;
    expect(a).toMatchObject({ odo_km: 62000 });
    expect(a).not.toHaveProperty("year");
    expect(a).not.toHaveProperty("seats");
  });
});

describe("isQuotaFailure (gateway-wrapped 429)", () => {
  test("503 with [429] body is quota", () => {
    expect(isQuotaFailure({ ok: false, reason: "http", status: 503, raw: '{"error":{"message":"[glm/glm-5.2] [429]: Usage limit reached"}}' })).toBe(true);
  });
  test("503 with plain upstream down is not quota", () => {
    expect(isQuotaFailure({ ok: false, reason: "http", status: 503, raw: "upstream down" })).toBe(false);
  });
  test("plain 429 is quota", () => {
    expect(isQuotaFailure({ ok: false, reason: "http", status: 429 })).toBe(true);
  });
});

describe("enrich@5 prompt", () => {
  test("Registry resolves enrich@5, render carries the new schema keys, output parsing is lenient", async () => {
    const { getPrompt, promptVersionOf } = await import("@feedhound/llm/registry");
    const { EnrichOutputV2 } = await import("@feedhound/llm/prompts/enrich.v2");
    const def = getPrompt("enrich");
    expect(def.version).toBe(5);
    expect(promptVersionOf(def)).toBe("enrich@5");
    const rendered = def.render({
      text: "bán vios",
      candidates: { categories: [], items: [] },
      ruleHint: { intent: "sell", priceVnd: null, condition: "unknown", categoryId: null, itemId: null, confidence: 0.3, hits: [] },
    });
    expect(rendered.user).toContain("sentiment");
    expect(rendered.user).toContain("intentTags");
    expect(rendered.user).toContain("trendTerms");
    const base = { intent: "sell", priceVnd: null, condition: "used", categorySlug: null, itemName: null, confidence: 0.9, attributes: {} };
    const ok = EnrichOutputV2.parse({ ...base, sentiment: "pos", intentTags: ["ask", "foo", "ask"] });
    expect([ok.sentiment, ok.intentTags]).toEqual(["pos", ["ask"]]);
    const bad = EnrichOutputV2.safeParse({ ...base, sentiment: "angry" });
    expect(bad.success).toBe(true);
    expect(bad.success && bad.data.sentiment).toBeNull();
  });
});

describe.skipIf(!canRun)("enrich sentiment + intent tags", () => {
  let handle: DbHandle;
  let cache: AliasCache;
  let teamId: string;
  let sourceId: string;
  const postIds: string[] = [];
  const DAY = 24 * 60 * 60 * 1000;

  function snapshot() {
    return { dict: cache.get(), categories: cache.getCategories(), items: cache.getItems(), attrs: cache.getAttrs() };
  }
  async function insertPost(text: string, ageDays = 0): Promise<{ id: string; editCount: number }> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `enrich038-${crypto.randomUUID()}`,
        url: "https://feeds.example.test/enrich-038-test/posts/1",
        text,
        textNormalized: text.toLowerCase(),
        firstSeenAt: new Date(Date.now() - ageDays * DAY),
      })
      .returning({ id: schema.post.id, editCount: schema.post.editCount });
    postIds.push(p!.id);
    return { id: p!.id, editCount: p!.editCount };
  }
  async function seedRow(ageDays: number, engine: "rule" | "llm", promptVersion: string | null, intent: string, tags: string[]): Promise<string> {
    const p = await insertPost(`backfill ${crypto.randomUUID()}`, ageDays);
    await handle.db.insert(schema.enrichment).values({ postId: p.id, revision: p.editCount, intent, engine, promptVersion, intentTags: tags });
    return p.id;
  }
  const BASE = { intent: "buy", priceVnd: null, condition: "used", categorySlug: null, itemName: null, confidence: 0.9, attributes: {} };

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "enrich-038-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `enrich-038-${crypto.randomUUID()}`, name: "Enrich 038", url: "https://feeds.example.test/enrich-038-test", defaults: {} })
      .returning({ id: schema.source.id });
    sourceId = s!.id;
    cache = new AliasCache({ handle });
    await cache.start();
  }, 120_000);

  afterAll(async () => {
    await cache.stop();
    for (const id of postIds) await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, id));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Real runEnrichJob + enrich@5 + mock client; LLM path 1 call, rule path 0 calls", async () => {
    const run = (postId: string, revision: number, engine: "rule" | "llm", client?: ReturnType<typeof createMockLlmClient>) =>
      runEnrichJob({
        handle,
        catalogue: snapshot(),
        prefilterTerms: new Set<string>(),
        llmClient: client,
        budget: client ? createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 }) : undefined,
        config: { ...CONFIG, dealWindowDays: 30, dealMinPeers: 5 },
        payload: { postId, revision, force: true, engine },
      });
    const row = async (id: string) => (await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, id)))[0]!;

    const a = await insertPost("Shop giao hàng chậm, thất vọng quá, cần mua lại");
    const client = createMockLlmClient([
      { ok: true, data: { ...BASE, sentiment: "neg", intentTags: ["complain"] }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: CONFIG.modelCheap, latencyMs: 5 },
    ]);
    await run(a.id, a.editCount, "llm", client);
    const ra = await row(a.id);
    expect([ra.sentiment, [...ra.intentTags].sort(), ra.promptVersion, client.calls.length]).toEqual(["neg", ["buy", "complain"], "enrich@5", 1]);
    expect(client.calls[0]!.model).toBe(CONFIG.modelCheap);

    const b = await insertPost("Bán iPhone 15 giá 10tr");
    const idle = createMockLlmClient([{ ok: false, reason: "http_error", latencyMs: 1 } as unknown as ScriptedResponse]);
    await run(b.id, b.editCount, "rule", idle);
    const rb = await row(b.id);
    expect([rb.intent, rb.intentTags, rb.sentiment, idle.calls.length]).toEqual(["sell", ["sell"], null, 0]);
  });

  test("TrendTerms sanitised (phone, author, generic dropped), stored once per LLM call; bad value keeps the rest; rule write stores null", async () => {
    const run = (postId: string, revision: number, engine: "rule" | "llm", client?: ReturnType<typeof createMockLlmClient>) =>
      runEnrichJob({
        handle,
        catalogue: snapshot(),
        prefilterTerms: new Set<string>(),
        llmClient: client,
        budget: client ? createBudget({ handle, tz: "Asia/Ho_Chi_Minh", dailyTokenBudget: 1_000_000, budgetAlertPct: 80 }) : undefined,
        config: { ...CONFIG, dealWindowDays: 30, dealMinPeers: 5, trendMaxTerms: 5 },
        payload: { postId, revision, force: true, engine },
      });
    const row = async (id: string) => (await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, id)))[0]!;
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

    const a = await insertPost("Cần bán iPhone 15 Pro Max đẹp lắm");
    await handle.db.update(schema.post).set({ authorName: "Nguyễn Văn A" }).where(eq(schema.post.id, a.id));
    const client = createMockLlmClient([
      { ok: true, data: { ...BASE, trendTerms: ["iPhone 15 Pro Max", "0912345678", "Nguyễn Văn A", "xe"] }, usage, model: CONFIG.modelCheap, latencyMs: 5 },
    ]);
    await run(a.id, a.editCount, "llm", client);
    const ra = await row(a.id);
    expect([ra.trendTerms, ra.promptVersion, client.calls.length]).toEqual([["iPhone 15 Pro Max"], "enrich@5", 1]);

    const b = await insertPost("Cần mua laptop cũ");
    const parsed = (await import("@feedhound/llm")).EnrichOutputV3.parse({ ...BASE, sentiment: "pos", trendTerms: "oops" });
    expect([parsed.trendTerms, parsed.sentiment]).toEqual([[], "pos"]);
    const client2 = createMockLlmClient([{ ok: true, data: { ...BASE, sentiment: "pos", trendTerms: [] }, usage, model: CONFIG.modelCheap, latencyMs: 5 }]);
    await run(b.id, b.editCount, "llm", client2);
    const rb = await row(b.id);
    expect([rb.trendTerms, rb.sentiment]).toEqual([[], "pos"]);

    const c = await insertPost("Bán iPhone 15 giá 10tr");
    await run(c.id, c.editCount, "rule", createMockLlmClient([]));
    expect((await row(c.id)).trendTerms).toBeNull();
  });

  test("Backfill enqueues only recent pre-current LLM rows, tags rule rows, respects budget", async () => {
    const A = await seedRow(2, "llm", "enrich@4", "sell", []);
    const B = await seedRow(8, "llm", "enrich@4", "sell", []);
    const D = await seedRow(1, "llm", "enrich@5", "sell", ["sell"]);
    const C = await seedRow(1, "rule", null, "buy", []);
    const sent: { name: string; data: { postId: string; engine?: string } }[] = [];
    const boss = { send: async (name: string, data: unknown) => (sent.push({ name, data: data as { postId: string; engine?: string } }), null) } as unknown as PgBoss;
    const mine = new Set([A, B, D, C]);
    const ours = () => sent.filter((s) => mine.has(s.data.postId));

    const r1 = await runInsightBackfill(handle, boss, { now: new Date(), budget: undefined });
    expect(ours().map((s) => [s.name, s.data.postId, s.data.engine])).toEqual([["enrich", A, "llm"]]);
    expect(r1.ruleTagged).toBeGreaterThanOrEqual(1);
    const [c] = await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, C));
    expect(c!.intentTags).toEqual(["buy"]);

    await handle.db.update(schema.enrichment).set({ promptVersion: "enrich@5" }).where(eq(schema.enrichment.postId, A));
    sent.length = 0;
    await runInsightBackfill(handle, boss, { now: new Date(), budget: undefined });
    expect(ours()).toHaveLength(0);

    await handle.db.update(schema.enrichment).set({ promptVersion: "enrich@4" }).where(eq(schema.enrichment.postId, A));
    await runInsightBackfill(handle, boss, { now: new Date(), budget: { isExhausted: async () => true } });
    expect(ours()).toHaveLength(0);
  });

  test("review r1: queued backfill jobs skip the run; singletonSeconds is set; stale revision not enqueued", async () => {
    const A = await seedRow(2, "llm", "enrich@3", "sell", []);
    const opts: { name: string; o: Record<string, unknown> }[] = [];
    const boss = { send: async (name: string, _d: unknown, o: Record<string, unknown>) => (opts.push({ name, o }), null) } as unknown as PgBoss;
    const skipped = await runInsightBackfill(handle, boss, { now: new Date(), budget: undefined, countQueued: async () => 3 });
    expect(skipped.enqueued).toBe(0);
    expect(opts).toHaveLength(0);
    await runInsightBackfill(handle, boss, { now: new Date(), budget: undefined, countQueued: async () => 0 });
    const mineSent = opts.filter((x) => String(x.o.singletonKey).endsWith(A));
    expect(mineSent).toHaveLength(1);
    expect(mineSent[0]!.o.singletonSeconds).toBe(3600);
    await handle.sql`update post set edit_count = edit_count + 1 where id = ${A}::uuid`;
    opts.length = 0;
    await runInsightBackfill(handle, boss, { now: new Date(), budget: undefined, countQueued: async () => 0 });
    expect(opts.filter((x) => String(x.o.singletonKey).endsWith(A))).toHaveLength(0);
  });

  test("review r1: backfill job with exhausted budget leaves the existing LLM row unchanged", async () => {
    const run = (postId: string, revision: number, exhausted: boolean) =>
      runEnrichJob({
        handle,
        catalogue: snapshot(),
        prefilterTerms: new Set<string>(),
        llmClient: createMockLlmClient([{ ok: false, reason: "http_error", latencyMs: 1 } as unknown as ScriptedResponse]),
        budget: { isExhausted: async () => exhausted, recordUsage: async () => ({ before: 0, after: 0 }) } as unknown as ReturnType<typeof createBudget>,
        config: { ...CONFIG, dealWindowDays: 30, dealMinPeers: 5 },
        payload: { postId, revision, engine: "llm", reason: "insights_backfill" },
      });
    const p = await insertPost("Bán iPhone 15 giá 10tr");
    await handle.db.insert(schema.enrichment).values({ postId: p.id, revision: p.editCount, intent: "buy", engine: "llm", model: "m", promptVersion: "enrich@3", confidence: 0.9, textHash: (await handle.sql`select md5(text) as h from post where id = ${p.id}::uuid`)[0]!.h as string });
    const snap = async () => JSON.stringify({ ...(await handle.db.select().from(schema.enrichment).where(eq(schema.enrichment.postId, p.id)))[0], updatedAt: null });
    const before = await snap();
    await run(p.id, p.editCount, true);
    expect(await snap()).toBe(before);
    await run(p.id, p.editCount, false); // LLM failure on both rungs
    expect(await snap()).toBe(before);
  });

  test("hotfix: failed backfill attempt backs off 12h, then is re-selected", async () => {
    resetLlmQuotaBreaker();
    const A = await seedRow(2, "llm", "enrich@3", "sell", []);
    const sent: string[] = [];
    const boss = { send: async (_n: string, d: { postId: string }) => (sent.push(d.postId), null) } as unknown as PgBoss;
    const go = (now: Date) => runInsightBackfill(handle, boss, { now, budget: undefined, countQueued: async () => 0 });
    const t0 = new Date();
    await go(t0);
    expect(sent.filter((x) => x === A)).toHaveLength(1);
    // a failed attempt touches updated_at
    await handle.sql`update enrichment set updated_at = ${t0.toISOString()}::timestamptz + interval '1 second' where post_id = ${A}::uuid`;
    sent.length = 0;
    await go(new Date(t0.getTime() + 11 * 3600 * 1000));
    expect(sent.filter((x) => x === A)).toHaveLength(0);
    await go(new Date(t0.getTime() + 13 * 3600 * 1000));
    expect(sent.filter((x) => x === A)).toHaveLength(1);
  });

  test("hotfix: LLM 429 trips the breaker, backfill pass and jobs stop calling the LLM", async () => {
    resetLlmQuotaBreaker();
    const A = await seedRow(2, "llm", "enrich@3", "sell", []);
    const B = await seedRow(2, "llm", "enrich@3", "sell", []);
    const client = createMockLlmClient([{ ok: false, reason: "http", status: 429, latencyMs: 1 } as unknown as ScriptedResponse]);
    const run = (postId: string) =>
      runEnrichJob({
        handle,
        catalogue: snapshot(),
        prefilterTerms: new Set<string>(),
        llmClient: client,
        budget: { isExhausted: async () => false, recordUsage: async () => ({ before: 0, after: 0 }) } as unknown as ReturnType<typeof createBudget>,
        config: { ...CONFIG, dealWindowDays: 30, dealMinPeers: 5 },
        payload: { postId, revision: 0, engine: "llm", reason: "insights_backfill" },
      });
    await run(A);
    expect(client.calls).toHaveLength(1); // no strong-model retry after 429
    await run(B);
    expect(client.calls).toHaveLength(1); // breaker open: no LLM call
    const sent: string[] = [];
    const boss = { send: async (_n: string, d: { postId: string }) => (sent.push(d.postId), null) } as unknown as PgBoss;
    await runInsightBackfill(handle, boss, { now: new Date(), budget: undefined, countQueued: async () => 0 });
    expect(sent).toHaveLength(0);
    resetLlmQuotaBreaker();
  });

  test("hotfix: live post escalates to strong after a cheap 429", async () => {
    resetLlmQuotaBreaker();
    const A = await seedRow(2, "llm", "enrich@3", "sell", []);
    const r429 = { ok: false, reason: "http", status: 429, latencyMs: 1 } as unknown as ScriptedResponse;
    const client = createMockLlmClient([r429, r429]);
    await runEnrichJob({
      handle,
      catalogue: snapshot(),
      prefilterTerms: new Set<string>(),
      llmClient: client,
      budget: { isExhausted: async () => false, recordUsage: async () => ({ before: 0, after: 0 }) } as unknown as ReturnType<typeof createBudget>,
      config: { ...CONFIG, dealWindowDays: 30, dealMinPeers: 5 },
      payload: { postId: A, revision: 0, engine: "llm" },
    });
    expect(client.calls).toHaveLength(2);
    resetLlmQuotaBreaker();
  });
});
