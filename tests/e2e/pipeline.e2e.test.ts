import { runReconcile } from "../../apps/agent/src/jobs/reconcile";
import { createApp } from "../../apps/api/src/index";
import { createDb, type DbHandle } from "../../packages/db/src/index";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PgBoss } from "../../apps/api/node_modules/pg-boss";
import { TelegramMock } from "../helpers/telegram-mock";
import { assertTestDatabase, bossFor, createFixture, spawnAgent, teardown, waitFor, type RunFixture } from "./harness";
import { createLlmMock, type LlmMock } from "./llm-mock";

// Ingest -> enrich -> match -> notification through real pg-boss (agent as a subprocess).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let canRun = false;
if (TEST_DATABASE_URL) {
  assertTestDatabase(TEST_DATABASE_URL);
  canRun = true;
} else if (process.env.CI) {
  throw new Error("pipeline.e2e.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("pipeline.e2e.test.ts: skipped - TEST_DATABASE_URL is unset");
}

type Agent = Awaited<ReturnType<typeof spawnAgent>>;

async function stopAgent(agent: Agent | undefined): Promise<number | null> {
  if (!agent || agent.proc.exitCode !== null) return agent?.proc.exitCode ?? null;
  agent.proc.kill("SIGTERM");
  const timer = setTimeout(() => agent.proc.kill("SIGKILL"), 15_000);
  const code = await agent.proc.exited;
  clearTimeout(timer);
  return code;
}

describe.skipIf(!canRun)("pipeline e2e", () => {
  let handle: DbHandle;
  let fx: RunFixture;
  let schemaName = "";
  let apiBoss: PgBoss;
  let llm: LlmMock;
  let tg: TelegramMock;
  let agent: Agent | undefined;
  const agents: Agent[] = [];
  let tornDown = false;

  async function startAgent(): Promise<Agent> {
    const a = await spawnAgent({
      DATABASE_URL: TEST_DATABASE_URL!,
      PGBOSS_SCHEMA: schemaName,
      SHUTDOWN_TIMEOUT_MS: "500",
      LLM_BASE_URL: llm.baseUrl,
      LLM_API_KEY: "e2e-key",
      TG_BOT_TOKEN: "e2e-token",
      TG_API_BASE: tg.baseUrl,
    });
    agents.push(a);
    return a;
  }

  async function closeAll(): Promise<void> {
    if (tornDown) return;
    tornDown = true;
    try {
      for (const a of agents) await stopAgent(a).catch(() => {});
      await apiBoss?.stop({ graceful: false, close: true }).catch(() => {});
      if (handle && fx) await teardown(handle, fx, schemaName || undefined);
    } finally {
      llm?.close();
      await tg?.close();
      await handle?.close();
    }
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [{ name } = { name: "" }] = await handle.sql<{ name: string }[]>`select current_database() as name`;
    if (!name.endsWith("_test")) throw new Error(`refusing to run against non-test database: ${name}`);
    fx = await createFixture(handle);
    schemaName = `pgboss_e2e_${fx.run}`;
    llm = createLlmMock();
    tg = new TelegramMock();
    apiBoss = bossFor(TEST_DATABASE_URL!, schemaName);
    agent = await startAgent();
    await apiBoss.start();
  }, 40_000);

  afterAll(async () => {
    await closeAll();
  }, 30_000);

  function ingestVia(boss: PgBoss, marker: string): Promise<{ postId: string; res: Response }> {
    const app = createApp(handle, boss);
    const id = `e2e-${crypto.randomUUID()}`;
    return (async () => {
      const res = await app.fetch(
        new Request("http://e2e.local/api/ingest", {
          method: "POST",
          headers: { Authorization: `Bearer ${fx.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceId: fx.sourceId,
            visitId: `v-${id}`,
            posts: [
              {
                platformPostId: id,
                url: `https://example.com/posts/${id}`,
                text: `Can ban ${fx.term} ${marker} con dung tot lien he sau`,
                media: [],
                capturedAt: new Date().toISOString(),
              },
            ],
          }),
        }),
      );
      const rows = await handle.sql<{ id: string }[]>`select id from post where source_id = ${fx.sourceId} and platform_post_id = ${id}`;
      return { postId: rows[0]?.id ?? "", res };
    })();
  }

  async function endState(postId: string): Promise<boolean> {
    const rows = await handle.sql<{ ok: boolean }[]>`
      select (e.engine = 'llm' and p.enrich_state = 'done' and p.match_state = 'done' and n.status = 'sent') as ok
      from post p
      join enrichment e on e.post_id = p.id
      join match m on m.post_id = p.id and m.watch_id = ${fx.watchId}
      join notification n on n.match_id = m.id
      where p.id = ${postId}`;
    return rows.length === 1 && rows[0]!.ok === true;
  }

  async function expectOneSent(postId: string): Promise<void> {
    const m = await handle.sql<{ n: number }[]>`select count(*)::int as n from match where post_id = ${postId} and watch_id = ${fx.watchId}`;
    expect(m[0]!.n).toBe(1);
    const n = await handle.sql<{ n: number }[]>`
      select count(*)::int as n from notification where status = 'sent' and match_id in (select id from match where post_id = ${postId} and watch_id = ${fx.watchId})`;
    expect(n[0]!.n).toBe(1);
  }

  async function waitEnd(postId: string, ms: number): Promise<void> {
    try {
      await waitFor(async () => ((await endState(postId)) ? true : undefined), ms, `end state for post ${postId}`);
    } catch (err) {
      throw new Error(`${String(err)}\n--- agent log tail ---\n${agents.map((a) => a.logTail()).join("\n==\n")}`, { cause: err });
    }
  }

  test("case A: happy path", async () => {
    const { postId, res } = await ingestVia(apiBoss, "alpha");
    expect(res.status).toBe(200);
    await waitEnd(postId, 30_000);
    await expectOneSent(postId);
    const sends = tg.callsFor("sendMessage").filter((c) => (c.body as { chat_id?: unknown }).chat_id === fx.chatId);
    expect(sends.length).toBe(1);
    expect(llm.requests.some((r) => r.auth === "Bearer e2e-key")).toBe(true);
  }, 40_000);

  test("case B: lost enqueue recovered by reconcile", async () => {
    const lossy = new Proxy(apiBoss, {
      get(target, prop) {
        if (prop === "send") return () => Promise.reject(new Error("e2e: send lost"));
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const { postId, res } = await ingestVia(lossy, "bravo");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted?: number }).accepted).toBe(1);
    const jobs = await handle.sql<{ n: number }[]>`select count(*)::int as n from ${handle.sql(schemaName)}.job where data->>'postId' = ${postId}`;
    expect(jobs[0]!.n).toBe(0);
    // pipeline_updated_at is DB now(); a DB clock ahead of the host (docker VM skew) makes a same-instant host cutoff miss the post, so look ahead.
    await runReconcile(handle, apiBoss, { staleAfterSec: 0, now: new Date(Date.now() + 60_000), sourceIds: [fx.sourceId], bossSchema: schemaName });
    await waitEnd(postId, 30_000);
    await expectOneSent(postId);
  }, 40_000);

  test("case C: SIGTERM mid-enrich, restart, reconcile", async () => {
    const marker = `charlie${fx.run}`;
    const held = llm.holdNext(marker, 3000);
    const { postId, res } = await ingestVia(apiBoss, marker);
    expect(res.status).toBe(200);
    await held;
    const first = agent!;
    first.proc.kill("SIGTERM");
    const code = await Promise.race([first.proc.exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 15_000))]);
    expect(code).not.toBe("timeout");
    // The 500 ms shutdown timeout interrupted the held enrich: the post is not enriched yet.
    expect(await endState(postId)).toBe(false);
    agent = await startAgent();
    await runReconcile(handle, apiBoss, { staleAfterSec: 0, sourceIds: [fx.sourceId], bossSchema: schemaName });
    await waitEnd(postId, 45_000);
    await expectOneSent(postId);
    const dlq = await handle.sql<{ n: number }[]>`
      select count(*)::int as n from ${handle.sql(schemaName)}.job where name in ('enrich_dlq', 'match_dlq') and data->>'postId' = ${postId}`;
    expect(dlq[0]!.n).toBe(0);
  }, 60_000);

  test("teardown", async () => {
    await closeAll();
    const probe = createDb(TEST_DATABASE_URL);
    try {
      const gone = await probe.sql<{ n: number }[]>`select count(*)::int as n from information_schema.schemata where schema_name = ${schemaName}`;
      expect(gone[0]!.n).toBe(0);
      expect(agents.every((a) => a.proc.exitCode !== null)).toBe(true);
      const left = await probe.sql<{ n: number }[]>`
        select (
          (select count(*) from notification where user_id = ${fx.userId}) +
          (select count(*) from match where watch_id = ${fx.watchId}) +
          (select count(*) from post where source_id = ${fx.sourceId}) +
          (select count(*) from watch where id = ${fx.watchId}) +
          (select count(*) from notifier where id = ${fx.notifierId}) +
          (select count(*) from api_key where user_id = ${fx.userId}) +
          (select count(*) from source where id = ${fx.sourceId}) +
          (select count(*) from "user" where id = ${fx.userId}) +
          (select count(*) from team where id = ${fx.teamId})
        )::int as n`;
      expect(left[0]!.n).toBe(0);
    } finally {
      await probe.close();
    }
  }, 20_000);
});
