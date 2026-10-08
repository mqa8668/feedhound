import { createTelegramNotifier } from "@feedhound/bot/notifiers";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { RateLimiter } from "../lib/rate-limit";
import type { NotifierMap } from "./notify";
import { deliverPendingInsights } from "./insight-digest";
import { runTopicRollup } from "./topic-rollup";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("topic-rollup.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);
const TZ = "Asia/Ho_Chi_Minh";
const limiter = () => new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100_000, globalPerSec: 100_000 });

describe.skipIf(!canRun)("topic rollup", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let teamId: string;
  let otherTeamId: string;
  let userId: string;
  let sourceId: string;
  let otherSourceId: string;
  const fake: { calls: { path: string; body: { chat_id: number; text: string } }[]; status: number } = { calls: [], status: 200 };
  let server: ReturnType<typeof Bun.serve>;
  let apiBase: string;
  let seq = 0;

  async function mkPost(src: string, text: string, at: string, sentiment?: "neg" | "neu" | "pos", tags: string[] = []): Promise<string> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId: src, platformPostId: `tr-${RUN}-${++seq}`, url: `https://feeds.example.test/g/posts/tr-${RUN}-${seq}`, title: text.slice(0, 20), text, textNormalized: text.toLowerCase(), postedAt: new Date(at) })
      .returning({ id: schema.post.id });
    if (sentiment || tags.length) await handle.db.insert(schema.enrichment).values({ postId: p!.id, engine: "llm", sentiment: sentiment ?? null, intentTags: tags });
    return p!.id;
  }
  async function mkTopic(name: string, opts: { alerts?: boolean; q?: string } = {}): Promise<string> {
    const [t] = await handle.db.insert(schema.topic).values({ teamId, userId, name, params: { q: opts.q ?? "vios" }, alertsEnabled: opts.alerts ?? true }).returning({ id: schema.topic.id });
    return t!.id;
  }
  const volume = async (topicId: string) =>
    (await handle.db.select().from(schema.topicVolume).where(eq(schema.topicVolume.topicId, topicId)).orderBy(schema.topicVolume.bucket, schema.topicVolume.ts)).map((r) => ({ ...r, ts: r.ts.toISOString() }));

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL!);
    const teams = await handle.db.insert(schema.team).values([{ name: `tr1-${RUN}` }, { name: `tr2-${RUN}` }]).returning({ id: schema.team.id });
    teamId = teams[0]!.id;
    otherTeamId = teams[1]!.id;
    const [u] = await handle.db.insert(schema.user).values({ teamId, email: `tr-${RUN}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    userId = u!.id;
    const mkSrc = async (t: string, n: string) =>
      (await handle.db.insert(schema.source).values({ teamId: t, kind: "web", platformId: `tr-${n}-${RUN}`, name: n, url: `https://feeds.example.test/tr-${n}-${RUN}` }).returning({ id: schema.source.id }))[0]!.id;
    sourceId = await mkSrc(teamId, "one");
    otherSourceId = await mkSrc(otherTeamId, "two");
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        fake.calls.push({ path: new URL(req.url).pathname, body: (await req.json()) as { chat_id: number; text: string } });
        return fake.status === 200 ? Response.json({ ok: true, result: { message_id: 7 } }) : new Response("boom", { status: fake.status });
      },
    });
    apiBase = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await handle.close();
  });

  test("Hour/day buckets with local-day boundary, sentiment counts, idempotent rerun", async () => {
    const topicId = await mkTopic("ac5");
    await mkPost(sourceId, "Toyota Vios 2019 ban", "2026-10-04T10:00:00Z", "neg"); // local 10-04 17:00
    await mkPost(sourceId, "vios sieu luot", "2026-10-04T23:30:00Z", "pos"); // local 10-05 06:30
    await mkPost(sourceId, "can mua vios", "2026-10-05T03:15:00Z"); // local 10-05 10:15, no enrichment
    await mkPost(sourceId, "Honda Civic", "2026-10-05T03:20:00Z");
    await mkPost(otherSourceId, "vios other team", "2026-10-05T03:25:00Z");
    const run = () => runTopicRollup(handle, { topicId, now: new Date("2026-10-05T12:00:00Z"), notifiers: {}, rateLimiter: limiter(), tz: TZ });
    await run();
    const first = await volume(topicId);
    const days = first.filter((r) => r.bucket === "day");
    expect(days.map((d) => [d.ts, d.posts, d.neg, d.neu, d.pos])).toEqual([
      ["2026-10-03T17:00:00.000Z", 1, 1, 0, 0],
      ["2026-10-04T17:00:00.000Z", 2, 0, 0, 1],
    ]);
    const hours = first.filter((r) => r.bucket === "hour");
    expect(hours.map((h) => [h.ts, h.posts])).toEqual([
      ["2026-10-04T10:00:00.000Z", 1],
      ["2026-10-04T23:00:00.000Z", 1],
      ["2026-10-05T03:00:00.000Z", 1],
    ]);
    await run();
    expect(await volume(topicId)).toEqual(first);
  });

  async function setupSpikeTopic(name: string, opts: { alerts?: boolean } = {}): Promise<string> {
    const token = `spk${name.replace(/[^a-z]/gi, "").toLowerCase()}`;
    const topicId = await mkTopic(name, { ...opts, q: token });
    // D = 2026-10-05 local; baseline 09-28..10-04 seeded as daily volume.
    const baseline = [8, 9, 10, 9, 8, 10, 9];
    // baseline 09-28..10-04 local, as real posts (rollup recomputes the window from posts)
    await handle.db.insert(schema.post).values(
      baseline.flatMap((n, d) =>
        Array.from({ length: n }, (_, j) => ({
          sourceId,
          platformPostId: `tr-${RUN}-bl-${name}-${d}-${j}`,
          url: `https://feeds.example.test/g/posts/tr-${RUN}-bl-${name}-${d}-${j}`,
          title: token,
          text: `${token} base ${d} ${j}`,
          textNormalized: `${token} base ${d} ${j}`,
          postedAt: new Date(Date.UTC(2026, 8, 28 + d, 3, j, 0)),
        })),
      ),
    );
    const rows = Array.from({ length: 40 }, (_, i) => ({
      sourceId,
      platformPostId: `tr-${RUN}-sp-${name}-${i}`,
      url: `https://feeds.example.test/g/posts/tr-${RUN}-sp-${name}-${i}`,
      title: token,
      text: `${token} item ${i}`,
      textNormalized: `${token} item ${i}`,
      postedAt: new Date(Date.UTC(2026, 9, 5, 1 + (i % 12), i, 0)),
    }));
    await handle.db.insert(schema.post).values(rows);
    return topicId;
  }
  const NOW_SPIKE = new Date("2026-10-05T23:10:00Z"); // local 06:10 on 10-06
  const spikeRun = (notifiers: NotifierMap) => runTopicRollup(handle, { now: NOW_SPIKE, notifiers, rateLimiter: limiter(), tz: TZ });

  test("Spike -> real telegram notifier; one send, rerun silent, no notification rows", async () => {
    await handle.db.delete(schema.topic).where(eq(schema.topic.userId, userId));
    const [n] = await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: { chatId: 4242 } }).returning({ id: schema.notifier.id });
    const topicId = await setupSpikeTopic("Vios spike");
    const notifications = async () => (await handle.db.select({ n: sql<number>`count(*)::int` }).from(schema.notification))[0]!.n;
    const before = await notifications();
    const notifiers: NotifierMap = { telegram: createTelegramNotifier({ botToken: "TEST", apiBase }) };
    fake.calls.length = 0;
    fake.status = 200;
    const r = await spikeRun(notifiers);
    expect(r.spikes).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.path).toBe("/botTEST/sendMessage");
    expect(fake.calls[0]!.body.chat_id).toBe(4242);
    expect(fake.calls[0]!.body.text).toContain("Vios spike");
    expect(fake.calls[0]!.body.text).toContain("4.4×");
    const [row] = await handle.db.select().from(schema.insight).where(eq(schema.insight.topicId, topicId));
    expect(row).toMatchObject({ kind: "spike", delivery: "sent", day: "2026-10-05", dedupeKey: `spike:${topicId}:2026-10-05` });
    expect(row!.deliveredAt).not.toBeNull();
    await spikeRun(notifiers);
    expect(fake.calls).toHaveLength(1);
    expect(await notifications()).toBe(before);
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.id, n!.id));
  }, 30_000); // unscoped on purpose: spike evaluation needs the whole topic set

  test("A team-visible topic's spike still goes to creator A's notifiers, not a teammate's", async () => {
    await handle.db.delete(schema.topic).where(eq(schema.topic.userId, userId));
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.userId, userId));
    const [b] = await handle.db.insert(schema.user).values({ teamId, email: `tr-b-${RUN}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const [na] = await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: { chatId: 4242 } }).returning({ id: schema.notifier.id });
    const [nb] = await handle.db.insert(schema.notifier).values({ userId: b!.id, kind: "telegram", config: { chatId: 9999 } }).returning({ id: schema.notifier.id });
    const topicId = await setupSpikeTopic("Team visible");
    fake.calls.length = 0;
    fake.status = 200;
    await spikeRun({ telegram: createTelegramNotifier({ botToken: "TEST", apiBase }) });
    const [row] = await handle.db.select().from(schema.insight).where(eq(schema.insight.topicId, topicId));
    expect(row).toMatchObject({ kind: "spike", delivery: "sent", teamId });
    expect(fake.calls.map((c) => c.body.chat_id)).toEqual([4242]);
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.id, na!.id));
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.id, nb!.id));
    await handle.db.delete(schema.topic).where(eq(schema.topic.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, b!.id));
  }, 30_000);

  test("No telegram in the map -> inbox, no HTTP call; alerts_enabled=false -> inbox", async () => {
    await handle.db.delete(schema.topic).where(eq(schema.topic.userId, userId));
    await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: { chatId: 4242 } });
    const a = await setupSpikeTopic("No tg");
    fake.calls.length = 0;
    await spikeRun({});
    expect((await handle.db.select().from(schema.insight).where(eq(schema.insight.topicId, a)))[0]!.delivery).toBe("inbox");
    const b = await setupSpikeTopic("Alerts off", { alerts: false });
    await spikeRun({ telegram: createTelegramNotifier({ botToken: "TEST", apiBase }) });
    expect((await handle.db.select().from(schema.insight).where(eq(schema.insight.topicId, b)))[0]!.delivery).toBe("inbox");
    expect(fake.calls.filter((c) => c.body.text.includes("Alerts off"))).toHaveLength(0);
  }, 30_000);

  test("Fake 500 -> attempts 1 pending; third failure -> failed", async () => {
    await handle.db.delete(schema.topic).where(eq(schema.topic.userId, userId));
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.userId, userId));
    await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: { chatId: 4242 } });
    const topicId = await setupSpikeTopic("Flaky");
    const notifiers: NotifierMap = { telegram: createTelegramNotifier({ botToken: "TEST", apiBase }) };
    fake.status = 500;
    const get = async () => (await handle.db.select().from(schema.insight).where(eq(schema.insight.topicId, topicId)))[0]!;
    await spikeRun(notifiers);
    expect(await get()).toMatchObject({ attempts: 1, delivery: "pending" });
    await spikeRun(notifiers);
    expect(await get()).toMatchObject({ attempts: 2, delivery: "pending" });
    await spikeRun(notifiers);
    expect(await get()).toMatchObject({ attempts: 3, delivery: "failed" });
    expect((await get()).deliveryError).toContain("500");
    fake.status = 200;
  }, 30_000);

  test("review r1: stale bucket corrected, invalid app.tz never throws, daily wide re-roll and new-topic backfill reach old posts", async () => {
    const token = `rr${RUN.replace(/[0-9]/g, "x")}`;
    const topicId = await mkTopic("rr1", { q: token });
    await handle.db.insert(schema.topicVolume).values({ topicId, bucket: "day", ts: new Date("2026-10-04T17:00:00Z"), posts: 99, neg: 0, neu: 0, pos: 0 });
    await mkPost(sourceId, `${token} six days old`, "2026-09-30T05:00:00Z", "neg"); // local 09-30
    const at = (iso: string, tz = TZ) => runTopicRollup(handle, { topicId, now: new Date(iso), notifiers: {}, rateLimiter: limiter(), tz });
    await handle.db.update(schema.topic).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(schema.topic.id, topicId));
    await at("2026-10-05T12:00:00Z"); // local 19:00, 2-day window
    expect((await volume(topicId)).filter((r) => r.bucket === "day")).toEqual([]); // stale 99 deleted, 09-30 not reached
    await at("2026-10-05T23:10:00Z", "+07:00"); // local 06:10 = evalHourLocal; invalid tz falls back to default, no throw
    const days = (await volume(topicId)).filter((r) => r.bucket === "day");
    expect(days.map((d) => [d.ts, d.posts, d.neg])).toEqual([["2026-09-29T17:00:00.000Z", 1, 1]]);

    const t2 = await mkTopic("rr2", { q: token });
    await handle.db.delete(schema.topicVolume).where(eq(schema.topicVolume.topicId, t2));
    const recent = new Date();
    await handle.db.insert(schema.post).values({ sourceId, platformPostId: `tr-${RUN}-new`, url: `https://feeds.example.test/g/posts/tr-${RUN}-new`, title: token, text: `${token} new`, textNormalized: `${token} new`, postedAt: new Date(recent.getTime() - 5 * 86_400_000) });
    await runTopicRollup(handle, { topicId: t2, now: new Date(recent.getTime() + 1_000), notifiers: {}, rateLimiter: limiter(), tz: TZ });
    expect((await volume(t2)).filter((r) => r.bucket === "day").length).toBeGreaterThanOrEqual(1);
  });

  test("review r1: overlapping deliveries send a pending insight once", async () => {
    await handle.db.delete(schema.topic).where(eq(schema.topic.userId, userId));
    const [n] = await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: { chatId: 5151 } }).returning({ id: schema.notifier.id });
    const key = `concurrent:${RUN}`;
    await handle.db.insert(schema.insight).values({ teamId, userId, kind: "digest", day: "2026-10-05", dedupeKey: key, payload: {}, text: "hello", delivery: "pending" });
    const sends: string[] = [];
    const notifiers: NotifierMap = {
      telegram: {
        kind: "telegram",
        send: async (_t, msg) => {
          sends.push(msg.dedupeKey ?? "");
          await Bun.sleep(150);
          return { ok: true, providerMessageId: "1" };
        },
      },
    };
    const deps = { notifiers, rateLimiter: limiter(), maxAttempts: 3 };
    await Promise.all([deliverPendingInsights(handle, deps), deliverPendingInsights(handle, deps)]);
    expect(sends.filter((k) => k === key)).toHaveLength(1);
    const [row] = await handle.db.select().from(schema.insight).where(eq(schema.insight.dedupeKey, key));
    expect(row!.delivery).toBe("sent");
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.id, n!.id));
  });

  test("A topicId-scoped rollup touches exactly one topic even with 50 enabled topics in another team", async () => {
    const [other] = await handle.db.insert(schema.user).values({ teamId: otherTeamId, email: `tr-load-${RUN}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const extra = await handle.db
      .insert(schema.topic)
      .values(Array.from({ length: 50 }, (_, i) => ({ teamId: otherTeamId, userId: other!.id, name: `load-${i}`, params: { q: `load${RUN}${i}` } })))
      .returning({ id: schema.topic.id });
    try {
      const topicId = await mkTopic("scoped", { q: `scoped${RUN}` });
      const started = Date.now();
      const res = await runTopicRollup(handle, { topicId, now: new Date("2026-10-05T12:00:00Z"), notifiers: {}, rateLimiter: limiter(), tz: TZ });
      expect(res.topics).toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await handle.db.delete(schema.topic).where(eq(schema.topic.userId, other!.id));
      await handle.db.delete(schema.user).where(eq(schema.user.id, other!.id));
      expect(extra).toHaveLength(50);
    }
  });
});
