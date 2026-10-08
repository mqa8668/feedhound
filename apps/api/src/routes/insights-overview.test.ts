import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
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

if (TEST_DATABASE_URL && !isTestDbUrl(TEST_DATABASE_URL)) throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  try {
    await probe.sql`select 1`;
    canRun = true;
  } catch (err) {
    if (MUST_RUN) throw err;
  } finally {
    await probe.close();
  }
} else if (MUST_RUN) {
  throw new Error("insights-overview.test.ts: TEST_DATABASE_URL is required (CI is set)");
}

// GET /api/insights/overview.
describe.skipIf(!canRun)("GET /api/insights/overview", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const TOKEN = `ovw${RUN}`;
  const NOW = new Date("2026-10-05T05:00:00Z"); // Monday 12:00 in Asia/Ho_Chi_Minh
  let handle: DbHandle;
  let email: string;
  let topicId: string;
  let otherTopicId: string;
  const created: string[] = [];

  async function mkPost(key: string, srcId: string, postedAt: string, price: number, firstSeenAt: string = postedAt): Promise<void> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId: srcId, platformPostId: `${key}-${RUN}`, url: `https://feeds.example.test/${key}-${RUN}`, title: `${TOKEN} ${key}`, text: `${TOKEN} ${key}`, textNormalized: `${TOKEN} ${key}`, postedAt: new Date(postedAt), firstSeenAt: new Date(firstSeenAt) })
      .returning({ id: schema.post.id });
    created.push(p!.id);
    await handle.db.insert(schema.enrichment).values({ postId: p!.id, intent: "sell", priceVnd: price, priceQualifier: "exact", priceConfidence: 0.9 });
  }

  const overview = async (query: string): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await createApp(handle, undefined, { now: () => NOW }).request(`/api/insights/overview${query}`, { headers: { "X-Dev-User": email } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [ta, tb] = await handle.db
      .insert(schema.team)
      .values([{ name: `ov-a-${RUN}` }, { name: `ov-b-${RUN}` }])
      .returning({ id: schema.team.id });
    email = `ov-a-${RUN}@example.com`;
    const [ua, ub] = await handle.db
      .insert(schema.user)
      .values([
        { teamId: ta!.id, email, role: "hunter" },
        { teamId: tb!.id, email: `ov-b-${RUN}@example.com`, role: "hunter" },
      ])
      .returning({ id: schema.user.id });
    const [src] = await handle.db
      .insert(schema.source)
      .values({ teamId: ta!.id, kind: "web", platformId: `ov-${RUN}`, name: "ov", url: `https://feeds.example.test/ov-${RUN}` })
      .returning({ id: schema.source.id });
    const [t, o] = await handle.db
      .insert(schema.topic)
      .values([
        { teamId: ta!.id, userId: ua!.id, name: `Morning ${RUN}`, params: { q: TOKEN } },
        { teamId: tb!.id, userId: ub!.id, name: `Foreign ${RUN}`, params: { q: TOKEN } },
      ])
      .returning({ id: schema.topic.id });
    topicId = t!.id;
    otherTopicId = o!.id;

    // three weeks (Monday-start, local) of 3 priced posts each, descending prices, then a new low yesterday
    for (const [i, d] of ["2026-09-15", "2026-09-16", "2026-09-17"].entries()) await mkPost(`w1-${i}`, src!.id, `${d}T05:00:00Z`, 210e6);
    for (const [i, d] of ["2026-09-22", "2026-09-23", "2026-09-24"].entries()) await mkPost(`w2-${i}`, src!.id, `${d}T05:00:00Z`, 200e6);
    for (const [i, d] of ["2026-09-29", "2026-09-30", "2026-10-01"].entries()) await mkPost(`w3-${i}`, src!.id, `${d}T05:00:00Z`, 190e6);
    await mkPost("low", src!.id, "2026-10-04T10:00:00Z", 170e6);
    // posted long ago but first seen by the crawler in the last 24 h: a new low by first_seen_at
    await mkPost("oldfind", src!.id, "2026-09-20T05:00:00Z", 160e6, "2026-10-04T12:00:00Z");
    // day rows: 10-03 -> 2 posts, 10-04 -> 5 posts (local midnights)
    await handle.db.insert(schema.topicVolume).values([
      { topicId, bucket: "day", ts: new Date("2026-10-02T17:00:00Z"), posts: 2, neg: 0, neu: 0, pos: 0 },
      { topicId, bucket: "day", ts: new Date("2026-10-03T17:00:00Z"), posts: 5, neg: 0, neu: 0, pos: 0 },
    ]);
  });

  afterAll(async () => {
    await handle.db.delete(schema.topicVolume).where(inArray(schema.topicVolume.topicId, [topicId, otherTopicId]));
    await handle.db.delete(schema.topic).where(inArray(schema.topic.id, [topicId, otherTopicId]));
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, created));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, created));
    await handle.close();
  });

  test("weekly medians descend, a new low is reported, volume counts the week, other teams' topics are absent", async () => {
    const r = await overview("?days=30");
    expect(r.status).toBe(200);
    const j = r.json as {
      days: number;
      volume: { posts7d: number; perDay: number; lastPostAt: string; spikeMinVolume: number };
      changes: string[];
      topics: {
        id: string;
        weekly: { week: string; medianVnd: number | null; n: number }[];
        series: { day: string; posts: number }[];
        yesterday: { posts: number; prevPosts: number };
        median7d: number | null;
        medianPrev7d: number | null;
        newLows: { priceVnd: number; prevMinVnd: number }[];
      }[];
    };
    expect(j.topics.map((t) => t.id)).toEqual([topicId]);
    const t = j.topics[0]!;
    expect(t.weekly.map((w) => w.week)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(t.weekly.map((w) => w.medianVnd)).toEqual([210e6, 200e6, 190e6]);
    expect(t.series).toHaveLength(30);
    expect(t.yesterday).toEqual({ posts: 5, prevPosts: 2 });
    expect(t.newLows.map((l) => [l.priceVnd, l.prevMinVnd])).toEqual([[160e6, 190e6], [170e6, 190e6]]);
    expect([t.median7d, t.medianPrev7d]).toEqual([190e6, 200e6]);
    expect(j.changes).toContain("new low price 170M (previous low 190M)".replace(/^/, `Morning ${RUN}: `));
    expect(j.changes).toContain(`Morning ${RUN}: 5 posts yesterday (+3 vs the day before)`);
    expect(j.changes.some((c) => c.includes("7-day median price ↓5% (200M → 190M)"))).toBe(true);
    expect(j.volume.posts7d).toBe(4);
    expect(j.volume.spikeMinVolume).toBeGreaterThan(0);
    expect(j.volume.lastPostAt).toBe("2026-10-04T10:00:00.000Z");
  });

  test("days outside 7-90 is a 400", async () => {
    expect((await overview("?days=5")).status).toBe(400);
    expect((await overview("?days=91")).status).toBe(400);
    expect((await overview("?days=x")).status).toBe(400);
  });
});
