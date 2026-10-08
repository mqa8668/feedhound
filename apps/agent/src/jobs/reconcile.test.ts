import { buildAliasDict } from "@feedhound/core/classify";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { registerEnrichJob, type EnrichConfig } from "./enrich";
import { runMatchJob } from "./match";
import { RECONCILE_QUEUE, registerReconcileJob, runReconcile } from "./reconcile";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

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
    console.warn(`reconcile.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("reconcile.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("reconcile.test.ts: skipped — TEST_DATABASE_URL is unset");
}

const CONFIG: EnrichConfig = { ruleConfidenceMin: 0.7, llmConfidenceMin: 0.5, enrichAll: false, modelCheap: "c", modelStrong: "s" };
const OPS_RULES = ["pipeline_failed", "pipeline_stranded"];

describe.skipIf(!canRun)("pipeline reconciler (integration)", () => {
  let handle: DbHandle;
  let boss: PgBoss;
  let teamId: string;
  let opsUserId: string;
  const sourceIds: string[] = [];
  const postIds: string[] = [];

  const noopBoss = { send: async () => "j" } as unknown as PgBoss;

  async function newSource(): Promise<string> {
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `rec-${crypto.randomUUID()}`, name: "rec", url: "https://feeds.example.test/rec" })
      .returning({ id: schema.source.id });
    sourceIds.push(s!.id);
    return s!.id;
  }

  async function newPost(
    sourceId: string,
    over: Partial<typeof schema.post.$inferInsert> = {},
  ): Promise<string> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `rec-${crypto.randomUUID()}`,
        url: "https://example.com/x",
        text: "can ban iphone 15 con moi 100%",
        textNormalized: "can ban iphone 15 con moi 100%",
        ...over,
      })
      .returning({ id: schema.post.id });
    postIds.push(p!.id);
    return p!.id;
  }

  const old = () => new Date(Date.now() - 3 * 60 * 60 * 1000);
  const later = (min: number) => new Date(Date.now() + min * 60 * 1000);

  async function jobsFor(postId: string, queue: string): Promise<number> {
    const rows = await handle.sql<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = ${queue} and data ->> 'postId' = ${postId}`;
    return rows[0]!.n;
  }

  async function opsCount(rule: string): Promise<number> {
    const rows = await handle.sql<{ n: number }[]>`select count(*)::int as n from notification where channel = 'ops' and payload ->> 'rule' = ${rule}`;
    return rows[0]!.n;
  }

  async function clearOps(): Promise<void> {
    await handle.sql`delete from notification where channel = 'ops' and payload ->> 'rule' in ${handle.sql(OPS_RULES)}`;
  }

  async function stateOf(id: string) {
    const [r] = await handle.sql<{ enrich_state: string; match_state: string; pipeline_attempts: number }[]>`
      select enrich_state, match_state, pipeline_attempts from post where id = ${id}`;
    return r!;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();
    await boss.createQueue("enrich");
    await boss.createQueue("match");
    const [team] = await handle.db.insert(schema.team).values({ name: `reconcile-015-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `reconcile-015-${crypto.randomUUID()}@example.com`, role: "operator" })
      .returning({ id: schema.user.id });
    opsUserId = user!.id;
    await clearOps();
  });

  afterAll(async () => {
    await clearOps();
    if (postIds.length > 0) {
      await handle.sql`delete from pgboss.job where data ->> 'postId' in ${handle.sql(postIds)}`;
      await handle.sql`delete from enrichment where post_id in ${handle.sql(postIds)}`;
    }
    for (const sid of sourceIds) await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sid));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, opsUserId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await boss.stop({ graceful: false, close: true });
    await handle.close();
  });

  test("Enrich done but match enqueue lost -> reconcile re-sends exactly one match, runMatchJob finishes the state", async () => {
    const sid = await newSource();
    const postId = await newPost(sid);
    const sent: string[] = [];
    let handler: ((jobs: { id: string; data: unknown }[]) => Promise<void>) | undefined;
    const rejectingBoss = {
      createQueue: async () => undefined,
      work: async (_q: string, h: typeof handler) => {
        handler = h;
      },
      send: async (name: string) => {
        sent.push(name);
        if (name === "match") throw new Error("match send rejected");
        return "j";
      },
    } as unknown as PgBoss;
    await registerEnrichJob({
      boss: rejectingBoss,
      handle,
      catalogueSnapshot: () => ({ dict: buildAliasDict([], []), categories: [], items: [] }),
      llmClient: undefined,
      budget: undefined,
      fetchConfig: async () => CONFIG,
      fetchOpsUserId: async () => undefined,
    });
    await handler!([{ id: "job-1", data: { postId, revision: 0 } }]);
    expect(sent).toContain("match");
    expect(await stateOf(postId)).toMatchObject({ enrich_state: "done", match_state: "pending" });

    const res = await runReconcile(handle, boss, { now: later(11), sourceIds: [sid] });
    expect(res.matchSent).toBe(1);
    expect(await jobsFor(postId, "match")).toBe(1);

    await runMatchJob({ handle, boss, watchIndex: { getForTeam: () => [] }, postId, trigger: "enrich" });
    expect((await stateOf(postId)).match_state).toBe("done");
  }, 60_000);

  test("A lost enrich is re-sent once; a post with a live enrich job is skipped, not re-sent", async () => {
    const sid = await newSource();
    const lost = await newPost(sid);
    const r1 = await runReconcile(handle, boss, { now: later(11), sourceIds: [sid] });
    expect(r1.enrichSent).toBe(1);
    // 22 min later the post is stale again (attempt 1 consumed) but its job is still `created`.
    const r2 = await runReconcile(handle, boss, { now: later(22), sourceIds: [sid] });
    expect(r2.enrichSent).toBe(0);
    expect(r2.skippedLive).toBe(1);
    expect(await jobsFor(lost, "enrich")).toBe(1);

    const sid2 = await newSource();
    const live = await newPost(sid2);
    await boss.send("enrich", { postId: live, revision: 0 });
    const r3 = await runReconcile(handle, boss, { now: later(11), sourceIds: [sid2] });
    expect(r3.skippedLive).toBe(1);
    expect(r3.enrichSent).toBe(0);
    expect(await jobsFor(live, "enrich")).toBe(1);
    expect((await stateOf(live)).pipeline_attempts).toBe(0);
  }, 60_000);

  test("Exhausted enrich -> failed + match sent + one pipeline_failed alert (deduped); exhausted match -> failed, nothing sent", async () => {
    await clearOps();
    const sid = await newSource();
    const e = await newPost(sid, { pipelineAttempts: 3, pipelineUpdatedAt: old() });
    const res = await runReconcile(handle, boss, { now: new Date(), sourceIds: [sid] });
    expect(res.failedEnrich).toBe(1);
    expect(res.matchSent).toBe(1);
    expect(await stateOf(e)).toMatchObject({ enrich_state: "failed", match_state: "pending" });
    expect(await jobsFor(e, "match")).toBe(1);
    expect(await opsCount("pipeline_failed")).toBe(1);

    const again = await runReconcile(handle, boss, { now: new Date(), sourceIds: [sid] });
    expect(again.failedEnrich).toBe(0);
    expect(await opsCount("pipeline_failed")).toBe(1);

    const sid2 = await newSource();
    const m = await newPost(sid2, { enrichState: "done", pipelineAttempts: 3, pipelineUpdatedAt: old() });
    const res2 = await runReconcile(handle, boss, { now: new Date(), sourceIds: [sid2] });
    expect(res2.failedMatch).toBe(1);
    expect(res2.matchSent).toBe(0);
    expect(await stateOf(m)).toMatchObject({ enrich_state: "done", match_state: "failed" });
    expect(await jobsFor(m, "match")).toBe(0);
    await clearOps();
  }, 60_000);

  test("review 1: exhausted stage with a live job is not failed", async () => {
    const sid = await newSource();
    const id = await newPost(sid, { pipelineAttempts: 3, pipelineUpdatedAt: old() });
    await boss.send("enrich", { postId: id, revision: 0 });
    const res = await runReconcile(handle, boss, { now: new Date(), sourceIds: [sid] });
    expect(res.failedEnrich).toBe(0);
    expect(await stateOf(id)).toMatchObject({ enrich_state: "pending" });
  }, 60_000);

  test("51 stale pending posts raise pipeline_stranded; 50 do not", async () => {
    await clearOps();
    const mk = async (n: number): Promise<string> => {
      const sid = await newSource();
      for (let i = 0; i < n; i++) await newPost(sid, { pipelineUpdatedAt: old() });
      return sid;
    };
    const s51 = await mk(51);
    const r51 = await runReconcile(handle, noopBoss, { now: new Date(), sourceIds: [s51] });
    expect(r51.stranded.enrich).toBe(51);
    expect(await opsCount("pipeline_stranded")).toBe(1);

    await clearOps();
    const s50 = await mk(50);
    const r50 = await runReconcile(handle, noopBoss, { now: new Date(), sourceIds: [s50] });
    expect(r50.stranded.enrich).toBe(50);
    expect(await opsCount("pipeline_stranded")).toBe(0);
    await clearOps();
  }, 120_000);

  test("No enrich-backfill symbol remains except the unschedule call; registerReconcileJob schedules */5 and drops the old schedule", async () => {
    const pattern = new RegExp(["Enrich" + "Backfill", "enrich" + "_backfill", "ENRICH" + "_BACKFILL"].join("|"));
    const hits: string[] = [];
    for await (const file of new Bun.Glob("apps/**/*.ts").scan({ cwd: `${import.meta.dir}/../../../..`, absolute: true })) {
      if (file.includes("/node_modules/") || file.includes("/dist/")) continue;
      const lines = (await Bun.file(file).text()).split("\n");
      lines.forEach((line, i) => {
        if (pattern.test(line) && !line.includes("unschedule(") && !line.includes("LEGACY_QUEUE =")) hits.push(`${file}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);

    const legacy = "enrich" + "_backfill";
    await boss.createQueue(legacy);
    await boss.schedule(legacy, "*/10 * * * *", {});
    await boss.send(legacy, { x: 1 });
    try {
      await registerReconcileJob(boss, handle);
      const left = await handle.sql<{ n: number }[]>`select count(*)::int as n from pgboss.job where name = ${legacy} and state in ('created', 'retry')`;
      expect(left[0]!.n).toBe(0);
      const rows = await handle.sql<{ name: string; cron: string }[]>`select name, cron from pgboss.schedule where name in (${RECONCILE_QUEUE}, ${legacy})`;
      expect(rows.find((r) => r.name === RECONCILE_QUEUE)?.cron).toBe("*/5 * * * *");
      expect(rows.find((r) => r.name === legacy)).toBeUndefined();
    } finally {
      await boss.unschedule(RECONCILE_QUEUE).catch(() => undefined);
      await boss.deleteQueue(legacy).catch(() => undefined);
    }
  }, 60_000);
  test("registerReconcileJob purges legacy jobs in the given boss schema", async () => {
    const fake = { createQueue: async () => undefined, unschedule: async () => undefined, schedule: async () => undefined, work: async () => "w" } as unknown as PgBoss;
    const sch = `pgboss_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const legacy = "enrich" + "_backfill";
    await handle.sql.unsafe(`create schema "${sch}"; create table "${sch}".job (name text, state text)`);
    try {
      await handle.sql.unsafe(`insert into "${sch}".job values ('${legacy}', 'created'), ('other', 'created')`);
      await registerReconcileJob(fake, handle, sch);
      const rows = await handle.sql.unsafe(`select name from "${sch}".job`);
      expect(rows.map((r) => r.name)).toEqual(["other"]);
    } finally {
      await handle.sql.unsafe(`drop schema "${sch}" cascade`);
    }
  });
});
