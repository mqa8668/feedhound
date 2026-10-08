import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { RateLimiter } from "../lib/rate-limit";
import { corpusLink, fitHtml, runInsightDigest } from "./insight-digest";
import { loadInsightsConfig, runTopicRollup } from "./topic-rollup";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("insight-digest.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);
const TZ = "Asia/Ho_Chi_Minh";
const limiter = () => new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100_000, globalPerSec: 100_000 });

describe("fitHtml", () => {
  test("escaped output stays within 4096 chars (3000 ampersands)", () => {
    const html = fitHtml("&".repeat(3000));
    expect(html.length).toBeLessThanOrEqual(4096);
    expect(html.startsWith("&amp;")).toBe(true);
    expect(fitHtml("short <b>")).toBe("short &lt;b&gt;");
  });
});

describe.skipIf(!canRun)("insight digest", () => {
  const RUN = crypto.randomUUID().slice(0, 8).replace(/[0-9]/g, "x");
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let userId: string;
  let quietUserId: string;
  let complainPostId: string;

  async function mkPosts(token: string, n: number, complainOne = false): Promise<void> {
    const rows = Array.from({ length: n }, (_, i) => ({
      sourceId,
      platformPostId: `dg-${RUN}-${token}-${i}`,
      url: `https://feeds.example.test/g/posts/dg-${RUN}-${token}-${i}`,
      title: `${token} post ${i}`,
      text: `${token} body ${i}`,
      textNormalized: `${token} body ${i}`,
      postedAt: new Date(Date.UTC(2026, 9, 5, 1 + (i % 10), i, 0)), // local 10-05
    }));
    const ids = await handle.db.insert(schema.post).values(rows).returning({ id: schema.post.id });
    if (complainOne) {
      complainPostId = ids[0]!.id;
      await handle.db.insert(schema.enrichment).values({ postId: complainPostId, engine: "llm", sentiment: "neg", intentTags: ["complain"] });
    }
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL!);
    const [t] = await handle.db.insert(schema.team).values({ name: `dg-${RUN}` }).returning({ id: schema.team.id });
    teamId = t!.id;
    const users = await handle.db
      .insert(schema.user)
      .values([
        { teamId, email: `dg-a-${RUN}@example.com`, role: "hunter" },
        { teamId, email: `dg-b-${RUN}@example.com`, role: "hunter" },
      ])
      .returning({ id: schema.user.id });
    userId = users[0]!.id;
    quietUserId = users[1]!.id;
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `dg-${RUN}`, name: "dg", url: `https://feeds.example.test/dg-${RUN}` })
      .returning({ id: schema.source.id });
    sourceId = s!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  test("one digest per user per day: topics ordered by volume, spike line, complain post first; zero-volume user gets one zero-day digest", async () => {
    const t1 = `dgone${RUN}`;
    const t2 = `dgtwo${RUN}`;
    await handle.db.insert(schema.topic).values([
      { teamId, userId, name: "T1 big", params: { q: t1 } },
      { teamId, userId, name: "T2 small", params: { q: t2 } },
      { teamId, userId: quietUserId, name: "Quiet", params: { q: `dgnone${RUN}` } },
    ]);
    await mkPosts(t1, 30);
    await mkPosts(t2, 5, true);
    const notifs = async () => (await handle.db.select({ n: sql<number>`count(*)::int` }).from(schema.notification))[0]!.n;
    const before = await notifs();
    // 06:10 local on 10-06: rollup + spike evaluation for D = 10-05
    const rollup = await runTopicRollup(handle, { now: new Date("2026-10-05T23:10:00Z"), notifiers: {}, rateLimiter: limiter(), tz: TZ });
    expect(rollup.spikes).toBeGreaterThanOrEqual(1);
    // 08:05 local, twice
    // The digest is stored raw (Telegram and the stored text stay unmasked); /api/insights masks it on read
    await handle.db.update(schema.post).set({ title: "t2 hỏng lh 0912 345 678" }).where(eq(schema.post.id, complainPostId));
    const digestAt = new Date("2026-10-06T01:05:00Z");
    const first = await runInsightDigest(handle, { now: digestAt, notifiers: {}, rateLimiter: limiter(), tz: TZ });
    expect(first.created).toBeGreaterThanOrEqual(1); // other test files share the DB and may own topics too
    const second = await runInsightDigest(handle, { now: digestAt, notifiers: {}, rateLimiter: limiter(), tz: TZ });
    expect(second.created).toBe(0);

    const digests = await handle.db.select().from(schema.insight).where(and(eq(schema.insight.userId, userId), eq(schema.insight.kind, "digest")));
    expect(digests).toHaveLength(1);
    const d = digests[0]!;
    expect(d).toMatchObject({ day: "2026-10-05", delivery: "inbox", dedupeKey: `digest:${userId}:2026-10-05` });
    expect(d.text.indexOf("T1 big")).toBeGreaterThan(-1);
    expect(d.text.indexOf("T1 big")).toBeLessThan(d.text.indexOf("T2 small"));
    expect(d.text).toContain("Spikes");
    expect(d.text).toContain("T1 big: 30 posts vs 7-day avg 0.0");
    const notable = (d.payload as { notable: { id: string }[] }).notable;
    expect(notable[0]!.id).toBe(complainPostId);
    expect(d.text).toContain(`/corpus/${complainPostId}`);
    expect(d.text).toContain("0912 345 678");
    expect(d.text).not.toContain("[SĐT ẩn]");
    expect(corpusLink("p1", "feedhound.example.test")).toBe("https://feedhound.example.test/corpus/p1");
    expect(corpusLink("p1", "")).toBe("/corpus/p1");
    const zero = await handle.db.select().from(schema.insight).where(and(eq(schema.insight.userId, quietUserId), eq(schema.insight.kind, "digest")));
    expect(zero).toHaveLength(1); // the rerun above did not add a second one
    expect(zero[0]!.payload).toEqual({ day: "2026-10-05", topics: [], spikes: [], notable: [], zero: true });
    expect(zero[0]!.text).toContain("No new posts for 1 topics yesterday. The system collected");
    expect(await notifs()).toBe(before);
  }, 30_000); // unscoped rollup (spike evaluation) walks every enabled topic

  test("zero-day digest waits for the finished rollup when posts were collected", async () => {
    const [t2] = await handle.db.insert(schema.team).values({ name: `dgz-${RUN}` }).returning({ id: schema.team.id });
    const [u] = await handle.db.insert(schema.user).values({ teamId: t2!.id, email: `dg-z-${RUN}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const [src] = await handle.db
      .insert(schema.source)
      .values({ teamId: t2!.id, kind: "web", platformId: `dgz-${RUN}`, name: "dgz", url: `https://feeds.example.test/dgz-${RUN}` })
      .returning({ id: schema.source.id });
    await handle.db.insert(schema.post).values({
      sourceId: src!.id, platformPostId: `dgz-${RUN}-0`, url: `https://feeds.example.test/g/posts/dgz-${RUN}-0`,
      title: "unrelated", text: "unrelated", textNormalized: "unrelated", postedAt: new Date("2026-10-05T03:00:00Z"),
    });
    await handle.db.insert(schema.topic).values({ teamId: t2!.id, userId: u!.id, name: "Zed", params: { q: `dgzzz${RUN}` } });
    const cfg = { ...(await loadInsightsConfig(handle)), evalHourLocal: 6, digestHourLocal: 6 };
    const digests = () => handle.db.select().from(schema.insight).where(and(eq(schema.insight.userId, u!.id), eq(schema.insight.kind, "digest")));
    await runInsightDigest(handle, { now: new Date("2026-10-05T23:05:00Z"), notifiers: {}, rateLimiter: limiter(), tz: TZ, cfg }); // 06:05 local: rollup not final
    expect(await digests()).toHaveLength(0);
    await runInsightDigest(handle, { now: new Date("2026-10-06T00:05:00Z"), notifiers: {}, rateLimiter: limiter(), tz: TZ, cfg }); // 07:05 local
    expect(await digests()).toHaveLength(1);
  }, 30_000);

  test("before digest.hourLocal nothing is created", async () => {
    const r = await runInsightDigest(handle, { now: new Date("2026-10-07T00:00:00Z"), notifiers: {}, rateLimiter: limiter(), tz: TZ }); // 07:00 local
    expect(r.created).toBe(0);
  });
});
