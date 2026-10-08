import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { RateLimiter } from "../../../agent/src/lib/rate-limit";
import { runTopicRollup } from "../../../agent/src/jobs/topic-rollup";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("topics.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);
const NOW = new Date("2026-10-05T12:00:00Z");

describe.skipIf(!canRun)("/api/topics", () => {
  const RUN = crypto.randomUUID().slice(0, 8).replace(/[0-9]/g, "x");
  const U1 = `tp-a-${RUN}@example.com`;
  const U2 = `tp-b-${RUN}@example.com`;
  const U3 = `tp-c-${RUN}@example.com`;
  const U4 = `tp-o-${RUN}@example.com`;
  let handle: DbHandle;
  let u1Id: string;
  let u3Id: string;
  let sourceId: string;
  const sent: { name: string; data: { topicId: string; backfillDays: number } }[] = [];
  const boss = { send: async (name: string, data: { topicId: string; backfillDays: number }) => (sent.push({ name, data }), "job-1") } as unknown as PgBoss;

  const call = (method: string, path: string, who: string, body?: unknown): Response | Promise<Response> =>
    createApp(handle, boss, { now: () => NOW }).request(path, {
      method,
      headers: { "X-Dev-User": who, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const mkSaved = async (name: string, query: Record<string, unknown>): Promise<string> =>
    (await handle.db.insert(schema.savedSearch).values({ userId: u1Id, name, query }).returning({ id: schema.savedSearch.id }))[0]!.id;

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [t] = await handle.db.insert(schema.team).values({ name: `tp-${RUN}` }).returning({ id: schema.team.id });
    const [t2] = await handle.db.insert(schema.team).values({ name: `tp2-${RUN}` }).returning({ id: schema.team.id });
    const users = await handle.db
      .insert(schema.user)
      .values([
        { teamId: t!.id, email: U1, role: "hunter" },
        { teamId: t2!.id, email: U2, role: "hunter" }, // another team
        { teamId: t!.id, email: U3, role: "hunter" }, // teammate of U1
        { teamId: t!.id, email: U4, role: "operator" },
      ])
      .returning({ id: schema.user.id, email: schema.user.email });
    u1Id = users.find((u) => u.email === U1)!.id;
    u3Id = users.find((u) => u.email === U3)!.id;
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId: t!.id, kind: "web", platformId: `tp-${RUN}`, name: "tp", url: `https://feeds.example.test/tp-${RUN}` })
      .returning({ id: schema.source.id });
    sourceId = s!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  test("Promote snapshots params, reports dropped, 404/409 rules, 21st is limit_reached", async () => {
    const S = crypto.randomUUID();
    const saved = await mkSaved("vios search", { q: "vios", categoryIds: [crypto.randomUUID()], sourceIds: [S], from: "2026-01-01T00:00:00Z" });
    const other = await call("POST", "/api/topics", U2, { savedSearchId: saved });
    expect(other.status).toBe(404);
    const res = await call("POST", "/api/topics", U1, { savedSearchId: saved });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; dropped: string[] };
    expect(body.dropped).toEqual(["sourceIds", "from"]);
    const [row] = await handle.db.select().from(schema.topic).where(eq(schema.topic.id, body.id));
    expect(row!.params).not.toHaveProperty("sourceIds");
    expect(row).toMatchObject({ name: "vios search", savedSearchId: saved, enabled: true, alertsEnabled: true });
    expect(sent.at(-1)).toEqual({ name: "topic_rollup", data: { topicId: body.id, backfillDays: 8 } });

    const dup = await call("POST", "/api/topics", U1, { savedSearchId: saved });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("duplicate_name");

    for (let i = 2; i <= 20; i++) {
      const id = await mkSaved(`lim ${i}`, { q: `term${i}` });
      expect((await call("POST", "/api/topics", U1, { savedSearchId: id })).status).toBe(201);
    }
    const id21 = await mkSaved("lim 21", { q: "term21" });
    const over = await call("POST", "/api/topics", U1, { savedSearchId: id21 });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toBe("limit_reached");

    // list, patch, own-only, delete
    const list = (await (await call("GET", "/api/topics", U1)).json()) as { items: { id: string; last7d: number; lastSpikeDay: string | null }[] };
    expect(list.items).toHaveLength(20);
    expect(((await (await call("GET", "/api/topics", U2)).json()) as { items: unknown[] }).items).toHaveLength(0);
    expect((await call("PATCH", `/api/topics/${body.id}`, U2, { enabled: false })).status).toBe(404);
    // A teammate sees it (mine false), reads its series, cannot change it; an operator can
    const listU3 = (await (await call("GET", "/api/topics", U3)).json()) as { items: { id: string; mine: boolean }[] };
    expect(listU3.items.find((i) => i.id === body.id)).toMatchObject({ mine: false });
    expect((await call("GET", `/api/topics/${body.id}/series`, U3)).status).toBe(200);
    const notOwner = await call("PATCH", `/api/topics/${body.id}`, U3, { enabled: false });
    expect(notOwner.status).toBe(403);
    expect(((await notOwner.json()) as { error: string }).error).toBe("not_owner");
    expect((await call("DELETE", `/api/topics/${body.id}`, U3)).status).toBe(403);
    expect((await call("PATCH", `/api/topics/${body.id}`, U4, { alertsEnabled: true })).status).toBe(200);
    // a teammate may promote the creator's saved search; the topic belongs to the caller
    const promoted = await call("POST", "/api/topics", U3, { savedSearchId: saved });
    expect(promoted.status).toBe(201);
    const [pRow] = await handle.db.select().from(schema.topic).where(eq(schema.topic.id, ((await promoted.json()) as { id: string }).id));
    expect(pRow!.userId).toBe(u3Id);
    await handle.db.delete(schema.topic).where(eq(schema.topic.userId, u3Id));
    const patched = await call("PATCH", `/api/topics/${body.id}`, U1, { enabled: false, alertsEnabled: false, name: "renamed" });
    expect(await patched.json()).toMatchObject({ id: body.id, name: "renamed", enabled: false, alertsEnabled: false });
    expect((await call("GET", `/api/topics/${body.id}/series`, U2)).status).toBe(404);
    expect((await call("DELETE", `/api/topics/${body.id}`, U2)).status).toBe(404);
    expect((await call("DELETE", `/api/topics/${body.id}`, U1)).status).toBe(204);
    await handle.db.delete(schema.topic).where(eq(schema.topic.userId, u1Id));
    await handle.db.delete(schema.savedSearch).where(eq(schema.savedSearch.userId, u1Id));
  }, 30_000); // ~45 sequential requests; the DB may be remote

  test("wiring: POST /api/topics -> real runTopicRollup -> GET series returns seeded per-local-day counts", async () => {
    const token = `wire${RUN}`;
    const times = ["2026-10-04T10:00:00Z", "2026-10-04T23:30:00Z", "2026-10-05T03:15:00Z", "2026-10-05T04:15:00Z"];
    await handle.db.insert(schema.post).values(
      times.map((at, i) => ({
        sourceId,
        platformPostId: `tp-${RUN}-w${i}`,
        url: `https://feeds.example.test/g/posts/tp-${RUN}-w${i}`,
        title: token,
        text: `${token} item ${i}`,
        textNormalized: `${token} item ${i}`,
        postedAt: new Date(at),
      })),
    );
    const saved = await mkSaved("wire search", { q: token });
    const created = await call("POST", "/api/topics", U1, { savedSearchId: saved });
    expect(created.status).toBe(201);
    const job = sent.at(-1)!;
    expect(job.data.backfillDays).toBe(8);
    await runTopicRollup(handle, {
      now: NOW,
      topicId: job.data.topicId,
      backfillDays: job.data.backfillDays,
      notifiers: {},
      rateLimiter: new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100_000, globalPerSec: 100_000 }),
      tz: "Asia/Ho_Chi_Minh",
    });
    const series = (await (await call("GET", `/api/topics/${job.data.topicId}/series?bucket=day`, U1)).json()) as { points: { ts: string; posts: number }[]; spikes: unknown[] };
    expect(series.points.map((p) => [p.ts, p.posts])).toEqual([
      ["2026-10-03T17:00:00.000Z", 1],
      ["2026-10-04T17:00:00.000Z", 3],
    ]);
    expect(series.spikes).toEqual([]);
    const hourly = (await (await call("GET", `/api/topics/${job.data.topicId}/series?bucket=hour&from=2026-10-04T00:00:00Z&to=2026-10-06T00:00:00Z`, U1)).json()) as { points: unknown[] };
    expect(hourly.points).toHaveLength(4);
    expect((await call("GET", `/api/topics/${job.data.topicId}/series?bucket=hour&from=2026-09-01T00:00:00Z`, U1)).status).toBe(400);
  });
});
