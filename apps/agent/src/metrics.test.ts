import { createDb, schema, type DbHandle } from "@feedhound/db";
import { ALLOWED_LABELS, METRICS_CONTENT_TYPE } from "@feedhound/core/metrics";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { runRollup } from "./jobs/rollup";
import { agentMetricsApp, createAgentMetrics } from "./metrics";

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
    console.warn(`agent metrics.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("agent metrics.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("agent metrics.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("agent /metrics", () => {
  // pg-boss queue names allow letters, digits, `_`; keep it lowercase and unique per run.
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const QUEUE = `metrics_test_${suffix}`;
  let handle: DbHandle;
  let boss: PgBoss;
  let teamId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();
    await boss.createQueue(QUEUE);
    await boss.send(QUEUE, { n: 1 });
    await boss.send(QUEUE, { n: 2 });
    const [team] = await handle.db.insert(schema.team).values({ name: `agent-metrics-${suffix}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `agent-metrics-${suffix}@example.com`, role: "operator" }).returning({ id: schema.user.id });
    for (const status of ["sent", "sent", "failed"]) {
      await handle.db.insert(schema.notification).values({ userId: user!.id, channel: "telegram", status });
    }
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(
      eq(schema.notification.userId, (await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, teamId)))[0]!.id),
    );
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await boss.deleteQueue(QUEUE);
    await boss.stop({ graceful: false, close: true });
    await handle.close();
  });

  test("serves pgboss jobs, LLM usage and notification outcomes", async () => {
    const app = agentMetricsApp(
      createAgentMetrics({ handle, budget: { getUsageToday: async () => ({ prompt: 10, completion: 5, total: 15, calls: 2 }) } }),
    );
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain(`pgboss_jobs{queue="${QUEUE}",state="created"} 2`);
    const [row] = await handle.sql<{ n: string }[]>`select count(*) as n from pgboss.job where name = ${QUEUE} and state = 'created'`;
    expect(Number(row!.n)).toBe(2);
    expect(body).toContain('llm_tokens_today{kind="total"} 15');
    expect(body).toContain("llm_calls_today 2");
    const sent = Number(/notifications\{status="sent"\} (\d+)/.exec(body)?.[1]);
    const failed = Number(/notifications\{status="failed"\} (\d+)/.exec(body)?.[1]);
    expect(sent).toBeGreaterThanOrEqual(2);
    expect(failed).toBeGreaterThanOrEqual(1);
    expect(body).toContain('metrics_collector_up{collector="pgboss"} 1');
  });

  test("rollup lag gauge follows the last successful run, not volume rows", async () => {
    const app = agentMetricsApp(createAgentMetrics({ handle, budget: { getUsageToday: async () => undefined } }));
    const before = await (await app.request("/metrics")).text();
    expect(before).toContain("analytics_rollup_errors 0");
    await runRollup(handle, { hourTs: new Date("2026-08-23T10:00:00Z"), now: new Date("2026-08-23T10:00:00Z"), teamIds: [teamId] });
    const fresh = agentMetricsApp(createAgentMetrics({ handle, budget: { getUsageToday: async () => undefined } }));
    const lag = Number(/^analytics_rollup_lag_seconds (\S+)$/m.exec(await (await fresh.request("/metrics")).text())?.[1]);
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThan(60);
  });

  test("emits no llm_* samples when no budget exists", async () => {
    const app = agentMetricsApp(createAgentMetrics({ handle, budget: { getUsageToday: async () => undefined } }));
    const body = await (await app.request("/metrics")).text();
    expect(body).not.toContain("llm_tokens_today{");
    expect(body).not.toMatch(/^llm_calls_today /m);
  });
  test("posts_pending_pipeline / posts_failed_pipeline match the stranded SQL and use allowed labels", async () => {
    const [src] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `pipe-${suffix}`, name: "pipe", url: "https://feeds.example.test/pipe" })
      .returning({ id: schema.source.id });
    try {
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
      for (let n = 0; n < 4; n++) {
        await handle.db.insert(schema.post).values({
          sourceId: src!.id,
          platformPostId: `pipe-${suffix}-${n}`,
          url: "https://example.com/x",
          text: `pipe ${n}`,
          enrichState: n < 3 ? "pending" : "done",
          matchState: n < 3 ? "pending" : "failed",
          pipelineUpdatedAt: old,
        });
      }
      const body = await (await agentMetricsApp(createAgentMetrics({ handle })).request("/metrics")).text();
      const [count] = await handle.sql<{ n: number }[]>`
        select count(*)::int as n from post
        where enrich_state = 'pending' and pipeline_updated_at < now() - interval '600 seconds'
          and (pipeline_reconciled_at is null or pipeline_reconciled_at < now() - interval '600 seconds')`;
      const pending = Number(/posts_pending_pipeline\{kind="enrich"\} (\d+)/.exec(body)?.[1]);
      expect(count!.n).toBeGreaterThanOrEqual(3);
      expect(pending).toBeGreaterThanOrEqual(3);
      expect(Math.abs(pending - count!.n)).toBeLessThanOrEqual(0); // nothing else touches this DB mid-test
      expect(Number(/posts_failed_pipeline\{kind="match"\} (\d+)/.exec(body)?.[1])).toBeGreaterThanOrEqual(1);
      const allowed: readonly string[] = ALLOWED_LABELS;
      for (const line of body.split("\n").filter((l) => l.startsWith("posts_"))) {
        for (const m of line.matchAll(/(\w+)="/g)) expect(allowed).toContain(m[1]!);
      }
    } finally {
      await handle.db.delete(schema.post).where(eq(schema.post.sourceId, src!.id));
      await handle.db.delete(schema.source).where(eq(schema.source.id, src!.id));
    }
  }, 30_000);
});
