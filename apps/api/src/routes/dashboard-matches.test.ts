import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
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
    console.warn(`dashboard-matches.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("dashboard-matches.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("dashboard-matches.test.ts: skipped — TEST_DATABASE_URL is unset");
}

// /api/dashboard/matches — session auth, hunter
// scoping, MatchRow shape with the notification aggregate, keyset pagination,
// and the unseen/seen counters backed by users.last_seen_matches_at.
describe.skipIf(!canRun)("GET /api/dashboard/matches (scoping, row shape, keyset paging)", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const BASE = Date.UTC(2026, 7, 1, 0, 0, 0); // fixed past instant for deterministic ordering

  let handle: DbHandle;
  let teamId: string;
  let hunterAId: string;
  let hunterAEmail: string;
  let hunterBId: string;
  let hunterBEmail: string;
  let operatorEmail: string;
  let watchAId: string; // 120 matches
  let watchA2Id: string; // 2 matches
  let watchBId: string; // hunterB's watch (never visible to A)
  let sourceId: string;
  let hunterAToken: string;

  async function insertUser(email: string, role: "hunter" | "operator"): Promise<string> {
    const [row] = await handle.db.insert(schema.user).values({ teamId, email, role }).returning({ id: schema.user.id });
    return row!.id;
  }

  async function insertWatch(userId: string, name: string): Promise<string> {
    const [row] = await handle.db.insert(schema.watch).values({ userId, name }).returning({ id: schema.watch.id });
    return row!.id;
  }

  interface MatchedPost {
    platformPostId: string;
    createdAt: Date;
    title?: string;
    score?: number;
    matchedTerms?: string[];
    intent?: "sell" | "buy" | "other";
    priceVnd?: number;
    notificationStatuses?: string[];
  }

  interface MatchedItem {
    watchId: string;
    userId: string;
    spec: MatchedPost;
  }

  // Bulk fixture insert: a handful of statements regardless of item count
  // (RETURNING preserves VALUES order, so ids map back by index).
  async function insertMatchedPosts(items: MatchedItem[]): Promise<void> {
    const posts = await handle.db
      .insert(schema.post)
      .values(
        items.map(({ spec }) => ({
          sourceId,
          platformPostId: spec.platformPostId,
          url: `https://feeds.example.test/g/posts/${spec.platformPostId}`,
          title: spec.title ?? null,
        })),
      )
      .returning({ id: schema.post.id });
    const matches = await handle.db
      .insert(schema.match)
      .values(
        items.map(({ watchId, spec }, i) => ({
          postId: posts[i]!.id,
          watchId,
          score: spec.score ?? 0.5,
          matchedTerms: spec.matchedTerms ?? [],
          createdAt: spec.createdAt,
        })),
      )
      .returning({ id: schema.match.id });
    const enrichments = items.flatMap(({ spec }, i) =>
      spec.intent !== undefined || spec.priceVnd !== undefined
        ? [{ postId: posts[i]!.id, intent: spec.intent ?? null, priceVnd: spec.priceVnd ?? null }]
        : [],
    );
    if (enrichments.length > 0) await handle.db.insert(schema.enrichment).values(enrichments);
    // One notifier per notification: (match_id, notifier_id) is unique per match.
    const notes = items.flatMap(({ userId, spec }, i) =>
      (spec.notificationStatuses ?? []).map((status) => ({ matchId: matches[i]!.id, userId, status })),
    );
    if (notes.length > 0) {
      const notifiers = await handle.db
        .insert(schema.notifier)
        .values(notes.map((n) => ({ userId: n.userId, kind: "telegram" as const })))
        .returning({ id: schema.notifier.id });
      await handle.db
        .insert(schema.notification)
        .values(notes.map((n, i) => ({ matchId: n.matchId, notifierId: notifiers[i]!.id, userId: n.userId, channel: "telegram" as const, status: n.status })));
    }
  }

  async function listAll(email: string, query: string): Promise<{ matches: MatchRow[]; pages: number }> {
    const app = createApp(handle);
    const matches: MatchRow[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await app.request(`/api/dashboard/matches?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
        headers: { "X-Dev-User": email },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { matches: MatchRow[]; nextCursor: string | null };
      matches.push(...body.matches);
      cursor = body.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    return { matches, pages };
  }

  interface MatchRow {
    id: string;
    postId: string;
    watchId: string;
    score: number;
    matchedTerms: string[];
    createdAt: string;
    post: { id: string; title: string | null; url: string; sourceId: string; sourceName: string };
    intent: "sell" | "buy" | "other" | null;
    priceVnd: number | null;
    watch: { id: string; name: string };
    notifications: "none" | "pending" | "partial" | "sent" | "failed";
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);

    const [team] = await handle.db.insert(schema.team).values({ name: `dash-matches-a-${RUN}` }).returning({ id: schema.team.id });
    teamId = team!.id;

    hunterAEmail = `dash-a-${RUN}@example.com`;
    hunterBEmail = `dash-b-${RUN}@example.com`;
    operatorEmail = `dash-op-${RUN}@example.com`;
    hunterAId = await insertUser(hunterAEmail, "hunter");
    hunterBId = await insertUser(hunterBEmail, "hunter");
    await insertUser(operatorEmail, "operator");

    const [source] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: `dash-matches-${RUN}`,
        name: "Dash matches source",
        url: `https://feeds.example.test/dash-matches-${RUN}`,
      })
      .returning({ id: schema.source.id });
    sourceId = source!.id;

    watchAId = await insertWatch(hunterAId, "Watch A");
    watchA2Id = await insertWatch(hunterAId, "Watch A2");
    watchBId = await insertWatch(hunterBId, "Watch B");

    const items: MatchedItem[] = [];
    // Corpus: exactly 120 matches on watchA, unique createdAt each.
    for (let i = 0; i < 120; i++) {
      items.push({
        watchId: watchAId,
        userId: hunterAId,
        spec: { platformPostId: `p-${RUN}-${i}`, createdAt: new Date(BASE + i * 1000), title: `Post ${i}` },
      });
    }
    items.push(
      { watchId: watchA2Id, userId: hunterAId, spec: { platformPostId: `p-${RUN}-a2-0`, createdAt: new Date(BASE + 500_000) } },
      { watchId: watchA2Id, userId: hunterAId, spec: { platformPostId: `p-${RUN}-a2-1`, createdAt: new Date(BASE + 600_000) } },
      // Fixtures on hunterB's watch.
      {
        watchId: watchBId,
        userId: hunterBId,
        spec: {
          platformPostId: `p-${RUN}-partial`,
          createdAt: new Date(BASE + 700_000),
          title: "Iphone 15 gia re",
          score: 0.87,
          matchedTerms: ["iphone", "15"],
          intent: "sell",
          priceVnd: 15_000_000,
          notificationStatuses: ["sent", "failed"],
        },
      },
      { watchId: watchBId, userId: hunterBId, spec: { platformPostId: `p-${RUN}-none`, createdAt: new Date(BASE + 800_000), title: "No notifications" } },
      {
        watchId: watchBId,
        userId: hunterBId,
        spec: { platformPostId: `p-${RUN}-sent`, createdAt: new Date(BASE + 900_000), title: "All sent", notificationStatuses: ["sent", "merged"] },
      },
      {
        watchId: watchBId,
        userId: hunterBId,
        spec: { platformPostId: `p-${RUN}-suppressed`, createdAt: new Date(BASE + 950_000), title: "Suppressed only", notificationStatuses: ["suppressed", "skipped"] },
      },
    );
    await insertMatchedPosts(items);

    hunterAToken = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: hunterAId,
      name: "hunter-a",
      prefix: hunterAToken.slice(0, 8),
      hash: Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hunterAToken))).toString("hex"),
      scopes: ["matches:read"],
    });
  });

  afterAll(async () => {
    const userIds = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, teamId));
    const ids = userIds.map((u) => u.id);
    if (ids.length > 0) {
      await handle.db.delete(schema.notification).where(inArray(schema.notification.userId, ids));
      await handle.db.delete(schema.apiKey).where(inArray(schema.apiKey.userId, ids));
      await handle.db.delete(schema.notifier).where(inArray(schema.notifier.userId, ids));
    }
    await handle.db.delete(schema.enrichment).where(
      inArray(
        schema.enrichment.postId,
        handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId)),
      ),
    );
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.watch).where(inArray(schema.watch.userId, ids));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Hunter sees only own watches; operator sees the team; bearer-only gets 401", async () => {
    const a = await listAll(hunterAEmail, "limit=100");
    expect(a.matches.length).toBe(122);
    const aWatchIds = new Set(a.matches.map((m) => m.watchId));
    expect(aWatchIds).toEqual(new Set([watchAId, watchA2Id]));
    expect(a.matches.some((m) => m.watchId === watchBId)).toBe(false);

    const b = await listAll(hunterBEmail, "limit=100");
    expect(b.matches.length).toBe(4);
    expect(new Set(b.matches.map((m) => m.watchId))).toEqual(new Set([watchBId]));

    const op = await listAll(operatorEmail, "limit=100");
    const opWatchIds = new Set(op.matches.map((m) => m.watchId));
    expect(opWatchIds.has(watchAId)).toBe(true);
    expect(opWatchIds.has(watchBId)).toBe(true);
    expect(op.matches.length).toBe(126);

    const app = createApp(handle);
    const bearer = await app.request("/api/dashboard/matches", { headers: { Authorization: `Bearer ${hunterAToken}` } });
    expect(bearer.status).toBe(401);
    const anon = await app.request("/api/dashboard/matches");
    expect(anon.status).toBe(401);
  });

  test("MatchRow carries post/enrichment/watch fields and the FILTER-count aggregate", async () => {
    const b = await listAll(hunterBEmail, `watch=${watchBId}&limit=100`);
    expect(b.matches.length).toBe(4);

    const partial = b.matches.find((m) => m.post.title === "Iphone 15 gia re")!;
    expect(partial.post.sourceName).toBe("Dash matches source");
    expect(partial.post.url).toContain(`p-${RUN}-partial`);
    expect(partial.intent).toBe("sell");
    expect(partial.priceVnd).toBe(15_000_000);
    expect(partial.score).toBeCloseTo(0.87);
    expect(partial.matchedTerms).toEqual(["iphone", "15"]);
    expect(partial.watch).toEqual({ id: watchBId, name: "Watch B" });
    expect(partial.notifications).toBe("partial");
    expect(new Date(partial.createdAt).getTime()).toBe(BASE + 700_000);
    expect(partial.postId).toBe(partial.post.id);

    const none = b.matches.find((m) => m.post.title === "No notifications")!;
    expect(none.notifications).toBe("none");
    expect(none.intent).toBeNull();
    expect(none.priceVnd).toBeNull();

    const sent = b.matches.find((m) => m.post.title === "All sent")!;
    expect(sent.notifications).toBe("sent");

    const suppressed = b.matches.find((m) => m.post.title === "Suppressed only")!;
    expect(suppressed.notifications).toBe("none");
  });

  test("Keyset paging limit=50 — newest first, no repeats, page 3 has 20 rows and null cursor; bad cursor 400", async () => {
    const app = createApp(handle);

    const page1Res = await app.request(`/api/dashboard/matches?watch=${watchAId}&limit=50`, { headers: { "X-Dev-User": hunterAEmail } });
    const page1 = (await page1Res.json()) as { matches: MatchRow[]; nextCursor: string | null };
    expect(page1.matches.length).toBe(50);
    expect(page1.nextCursor).toBeString();

    const page2Res = await app.request(`/api/dashboard/matches?watch=${watchAId}&limit=50&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
      headers: { "X-Dev-User": hunterAEmail },
    });
    const page2 = (await page2Res.json()) as { matches: MatchRow[]; nextCursor: string | null };
    expect(page2.matches.length).toBe(50);
    expect(page2.nextCursor).toBeString();

    const page3Res = await app.request(`/api/dashboard/matches?watch=${watchAId}&limit=50&cursor=${encodeURIComponent(page2.nextCursor!)}`, {
      headers: { "X-Dev-User": hunterAEmail },
    });
    const page3 = (await page3Res.json()) as { matches: MatchRow[]; nextCursor: string | null };
    expect(page3.matches.length).toBe(20);
    expect(page3.nextCursor).toBeNull();

    const all = [...page1.matches, ...page2.matches, ...page3.matches];
    expect(new Set(all.map((m) => m.id)).size).toBe(120);
    for (let k = 1; k < all.length; k++) {
      expect(new Date(all[k - 1]!.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(all[k]!.createdAt).getTime());
    }
    expect(new Date(all[0]!.createdAt).getTime()).toBe(BASE + 119_000); // newest first

    const badRaw = await app.request(`/api/dashboard/matches?cursor=${encodeURIComponent("!!!not-a-cursor")}`, {
      headers: { "X-Dev-User": hunterAEmail },
    });
    expect(badRaw.status).toBe(400);
    expect(((await badRaw.json()) as { error: string }).error).toBe("validation");

    const badTyped = Buffer.from(JSON.stringify({ createdAt: "nope", id: "x" }), "utf8").toString("base64url");
    const badTypedRes = await app.request(`/api/dashboard/matches?cursor=${encodeURIComponent(badTyped)}`, {
      headers: { "X-Dev-User": hunterAEmail },
    });
    expect(badTypedRes.status).toBe(400);
    expect(((await badTypedRes.json()) as { error: string }).error).toBe("validation");

    const badTimestampButValidUuid = Buffer.from(JSON.stringify({ createdAt: "nope", id: "00000000-0000-0000-0000-000000000000" }), "utf8").toString(
      "base64url",
    );
    const badTimestampRes = await app.request(`/api/dashboard/matches?cursor=${encodeURIComponent(badTimestampButValidUuid)}`, {
      headers: { "X-Dev-User": hunterAEmail },
    });
    expect(badTimestampRes.status).toBe(400);
    expect(((await badTimestampRes.json()) as { error: string }).error).toBe("validation");

    // Shape-valid but calendar-impossible: must be rejected before `::timestamptz` (22008 would surface as 500).
    const impossibleDate = Buffer.from(
      JSON.stringify({ createdAt: "2026-13-45 00:00:00+00", id: "00000000-0000-0000-0000-000000000000" }),
      "utf8",
    ).toString("base64url");
    const impossibleDateRes = await app.request(`/api/dashboard/matches?cursor=${encodeURIComponent(impossibleDate)}`, {
      headers: { "X-Dev-User": hunterAEmail },
    });
    expect(impossibleDateRes.status).toBe(400);
    expect(((await impossibleDateRes.json()) as { error: string }).error).toBe("validation");

    const badLimit = await app.request("/api/dashboard/matches?limit=0", { headers: { "X-Dev-User": hunterAEmail } });
    expect(badLimit.status).toBe(400);
  });

  test("keyset cursor keeps microsecond precision — same-millisecond rows are never skipped", async () => {
    const app = createApp(handle);
    const microWatchId = await insertWatch(hunterAId, "Watch micro");
    const micros = ["2026-09-23T00:00:00.123789Z", "2026-09-23T00:00:00.123456Z", "2026-09-23T00:00:00.123000Z"];
    const postIds: string[] = [];
    for (const ts of micros) {
      const [post] = await handle.db
        .insert(schema.post)
        .values({
          sourceId,
          platformPostId: `p-${RUN}-micro-${ts}`,
          url: `https://feeds.example.test/g/posts/p-${RUN}-micro-${ts}`,
        })
        .returning({ id: schema.post.id });
      postIds.push(post!.id);
      await handle.sql`insert into match (post_id, watch_id, score, matched_terms, created_at)
        values (${post!.id}::uuid, ${microWatchId}::uuid, 0.5, '{}', ${ts}::timestamptz)`;
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await app.request(
        `/api/dashboard/matches?watch=${microWatchId}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: { "X-Dev-User": hunterAEmail } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { matches: MatchRow[]; nextCursor: string | null };
      for (const m of body.matches) seen.add(m.postId);
      cursor = body.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toEqual(new Set(postIds));
  });

  test("?watch= filters to that watch; a foreign watch yields an empty list", async () => {
    const app = createApp(handle);

    const w1 = await listAll(hunterAEmail, `watch=${watchAId}&limit=100`);
    expect(w1.matches.length).toBe(120);
    expect(new Set(w1.matches.map((m) => m.watchId))).toEqual(new Set([watchAId]));

    const w2 = await listAll(hunterAEmail, `watch=${watchA2Id}&limit=100`);
    expect(w2.matches.length).toBe(2);
    expect(new Set(w2.matches.map((m) => m.watchId))).toEqual(new Set([watchA2Id]));

    const res = await app.request(`/api/dashboard/matches?watch=${watchBId}`, { headers: { "X-Dev-User": hunterAEmail } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: MatchRow[]; nextCursor: string | null };
    expect(body.matches).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });
});

describe.skipIf(!canRun)("GET …/unseen + POST …/seen (users.last_seen_matches_at)", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let teamId: string;
  let hunterCEmail: string;
  let operator2Email: string;
  let freshEmail: string;
  let watchCId: string;
  let sourceId: string;
  const seenThreshold = new Date(Date.now() - 60 * 60 * 1000); // T

  async function insertUser(email: string, role: "hunter" | "operator"): Promise<string> {
    const [row] = await handle.db.insert(schema.user).values({ teamId, email, role }).returning({ id: schema.user.id });
    return row!.id;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);

    const [team] = await handle.db.insert(schema.team).values({ name: `dash-seen-${RUN}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    hunterCEmail = `dash-c-${RUN}@example.com`;
    operator2Email = `dash-op2-${RUN}@example.com`;
    freshEmail = `dash-fresh-${RUN}@example.com`;
    const hunterCId = await insertUser(hunterCEmail, "hunter");
    await insertUser(operator2Email, "operator");
    const freshId = await insertUser(freshEmail, "hunter");

    const [source] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: `dash-seen-${RUN}`,
        name: "Dash seen source",
        url: `https://feeds.example.test/dash-seen-${RUN}`,
      })
      .returning({ id: schema.source.id });
    sourceId = source!.id;

    watchCId = (
      await handle.db.insert(schema.watch).values({ userId: hunterCId, name: "Watch C" }).returning({ id: schema.watch.id })
    )[0]!.id;
    const freshWatchId = (
      await handle.db.insert(schema.watch).values({ userId: freshId, name: "Watch fresh" }).returning({ id: schema.watch.id })
    )[0]!.id;

    async function matchOn(watchId: string, platformPostId: string, createdAt: Date): Promise<string> {
      const [post] = await handle.db
        .insert(schema.post)
        .values({ sourceId, platformPostId, url: `https://feeds.example.test/dash-seen-${RUN}/posts/${platformPostId}` })
        .returning({ id: schema.post.id });
      const [match] = await handle.db
        .insert(schema.match)
        .values({ postId: post!.id, watchId, score: 0.5, createdAt })
        .returning({ id: schema.match.id });
      return match!.id;
    }

    // Exactly 3 matches newer than T on the hunter's (and so the team's) watches.
    for (let i = 0; i < 3; i++) await matchOn(watchCId, `seen-${RUN}-${i}`, new Date(Date.now() - 60 * 1000));
    // The never-seen user's only match predates its default lastSeenMatchesAt.
    await matchOn(freshWatchId, `fresh-${RUN}`, new Date(Date.UTC(2026, 7, 1)));

    await handle.db.update(schema.user).set({ lastSeenMatchesAt: seenThreshold }).where(eq(schema.user.id, hunterCId));
    await handle.db.update(schema.user).set({ lastSeenMatchesAt: seenThreshold }).where(eq(schema.user.email, operator2Email));
  });

  afterAll(async () => {
    const userIds = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, teamId));
    const ids = userIds.map((u) => u.id);
    await handle.db.delete(schema.notification).where(inArray(schema.notification.userId, ids));
    await handle.db.delete(schema.enrichment).where(
      inArray(
        schema.enrichment.postId,
        handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId)),
      ),
    );
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.watch).where(inArray(schema.watch.userId, ids));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Unseen counts matches newer than lastSeenMatchesAt; operator counts team watches; fresh user reports 0", async () => {
    const app = createApp(handle);

    const hunterRes = await app.request("/api/dashboard/matches/unseen", { headers: { "X-Dev-User": hunterCEmail } });
    expect(hunterRes.status).toBe(200);
    expect(((await hunterRes.json()) as { count: number }).count).toBe(3);

    const opRes = await app.request("/api/dashboard/matches/unseen", { headers: { "X-Dev-User": operator2Email } });
    expect(((await opRes.json()) as { count: number }).count).toBe(3);

    const freshRes = await app.request("/api/dashboard/matches/unseen", { headers: { "X-Dev-User": freshEmail } });
    expect(((await freshRes.json()) as { count: number }).count).toBe(0);
  });

  test("API half: POST seen writes now() and the following unseen is 0", async () => {
    const app = createApp(handle);

    const seenRes = await app.request("/api/dashboard/matches/seen", { method: "POST", headers: { "X-Dev-User": hunterCEmail } });
    expect(seenRes.status).toBe(200);
    const seen = (await seenRes.json()) as { lastSeenMatchesAt: string };
    expect(new Date(seen.lastSeenMatchesAt).getTime()).toBeGreaterThan(seenThreshold.getTime());

    const after = await app.request("/api/dashboard/matches/unseen", { headers: { "X-Dev-User": hunterCEmail } });
    expect(((await after.json()) as { count: number }).count).toBe(0);
  });

  test("API half: seen {until} only moves forward, never past now, and keeps later matches unseen", async () => {
    const app = createApp(handle);
    const post = async (until: string): Promise<{ at: number }> => {
      const res = await app.request("/api/dashboard/matches/seen", {
        method: "POST",
        headers: { "X-Dev-User": operator2Email, "Content-Type": "application/json" },
        body: JSON.stringify({ until }),
      });
      expect(res.status).toBe(200);
      return { at: new Date(((await res.json()) as { lastSeenMatchesAt: string }).lastSeenMatchesAt).getTime() };
    };
    const unseen = async (): Promise<number> =>
      ((await (await app.request("/api/dashboard/matches/unseen", { headers: { "X-Dev-User": operator2Email } })).json()) as { count: number }).count;

    // older than the stored watermark -> unchanged
    expect((await post(new Date(seenThreshold.getTime() - 3_600_000).toISOString())).at).toBe(seenThreshold.getTime());
    expect(await unseen()).toBe(3);
    // the 3 matches were created ~1 min ago: an `until` before them leaves them unseen
    const before = Date.now() - 2 * 60 * 1000;
    expect((await post(new Date(before).toISOString())).at).toBe(before + 1);
    expect(await unseen()).toBe(3);
    // a future `until` is clamped to now
    const clamped = await post(new Date(Date.now() + 3_600_000).toISOString());
    expect(Math.abs(clamped.at - Date.now())).toBeLessThan(10_000);
    expect(await unseen()).toBe(0);
    // an invalid body is rejected
    const bad = await app.request("/api/dashboard/matches/seen", {
      method: "POST",
      headers: { "X-Dev-User": operator2Email, "Content-Type": "application/json" },
      body: JSON.stringify({ until: "not-a-date" }),
    });
    expect(bad.status).toBe(400);
  });

  test("The newest loaded match (µs created_at > ms until) becomes seen", async () => {
    const app = createApp(handle);
    const ts = Date.now() - 30_000;
    await handle.db.execute(sql`update match set created_at = ${new Date(ts).toISOString()}::timestamptz + interval '456 microseconds'
      where id = (select m.id from match m where m.watch_id = ${watchCId} order by m.created_at limit 1)`);
    await handle.db.update(schema.user).set({ lastSeenMatchesAt: seenThreshold }).where(eq(schema.user.email, operator2Email));
    const headers = { "X-Dev-User": operator2Email, "Content-Type": "application/json" };
    const unseen = async (): Promise<number> =>
      ((await (await app.request("/api/dashboard/matches/unseen", { headers })).json()) as { count: number }).count;
    expect(await unseen()).toBe(3);
    const res = await app.request("/api/dashboard/matches/seen", { method: "POST", headers, body: JSON.stringify({ until: new Date(ts).toISOString() }) });
    expect(res.status).toBe(200);
    // the 30s-old match is the newest of the 3 (others are 60s old): the 60s ones and it are all <= until
    expect(await unseen()).toBe(0);
  });
});

// Matches rows carry ListingFields and honour the user's hidden flags.
describe.skipIf(!canRun)("GET /api/dashboard/matches listing fields", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const h1 = `dm29-h1-${RUN}@example.com`;
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let sourceIds: string[] = [];
  let postIds: string[] = [];

  type Row = { postId: string; post: Record<string, unknown> };
  const list = async (): Promise<Row[]> => {
    const res = await createApp(handle).request("/api/dashboard/matches?limit=100", { headers: { "X-Dev-User": h1 } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { matches: Row[] }).matches.filter((m) => postIds.includes(m.postId));
  };

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [t] = await handle.db.insert(schema.team).values({ name: `dm29-${RUN}` }).returning({ id: schema.team.id });
    teamId = t!.id;
    const [u] = await handle.db.insert(schema.user).values({ teamId, email: h1, role: "hunter" }).returning({ id: schema.user.id });
    userId = u!.id;
    const srcs = await handle.db
      .insert(schema.source)
      .values(["A", "B", "C"].map((n) => ({ teamId, kind: "web" as const, platformId: `dm29-${n}-${RUN}`, name: n, url: `https://feeds.example.test/${n}-${RUN}` })))
      .returning({ id: schema.source.id });
    sourceIds = srcs.map((s) => s.id);
    const key = `rk-${RUN}`;
    const posts = await handle.db
      .insert(schema.post)
      .values(
        sourceIds.map((sourceId, i) => ({
          sourceId,
          platformPostId: `dm29-${i}-${RUN}`,
          url: "u",
          authorId: "u1",
          text: "Ban Santafe 2019 lh 0912345678",
          textNormalized: "ban santafe 2019 lh 0912345678",
          repostKey: key,
          thumbState: "ok",
        })),
      )
      .returning({ id: schema.post.id });
    postIds = posts.map((p) => p.id);
    await handle.db.insert(schema.enrichment).values(
      postIds.map((postId) => ({
        postId,
        intent: "sell",
        priceVnd: 680_000_000,
        engine: "rule",
        displayTitle: "Hyundai Santafe 2019",
        attributes: { make: "Hyundai", year: 2019 },
        dealPct: -8.4,
      })),
    );
    const [w] = await handle.db.insert(schema.watch).values({ userId, name: `dm29-w-${RUN}` }).returning({ id: schema.watch.id });
    await handle.db.insert(schema.match).values(postIds.map((postId) => ({ postId, watchId: w!.id, score: 1, matchedTerms: ["x"] })));
  });

  afterAll(async () => {
    await handle.db.delete(schema.postUserFlag).where(inArray(schema.postUserFlag.postId, postIds));
    await handle.db.delete(schema.match).where(inArray(schema.match.postId, postIds));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, postIds));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, postIds));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("rows carry ListingFields; reposts fold into one card; hiding one copy removes the group", async () => {
    const rows = await list();
    expect(rows.length).toBe(1); // three reposts of one listing in one watch -> one card
    expect((rows[0]!.post.alsoIn as unknown[]).length).toBe(2);
    const p = rows[0]!.post;
    expect(p.displayTitle).toBe("Hyundai Santafe 2019");
    expect(p.thumbUrl).toBe(`/api/media/${rows[0]!.postId}/thumb`);
    expect(p.hasPhone).toBe(true);
    expect(p.dealPct as number).toBeCloseTo(-8.4, 5);
    expect(p.attributes).toMatchObject({ make: "Hyundai" });
    expect(p.saved).toBe(false);
    const hide = await createApp(handle).request(`/api/posts/${postIds[2]}/flags/hidden`, { method: "PUT", headers: { "X-Dev-User": h1 } });
    expect(hide.status).toBe(204);
    expect(await list()).toEqual([]);
  });
});

// Filters, sorts and the capability flags on the matches inbox.
describe.skipIf(!canRun)("GET /api/dashboard/matches (filters and sorts)", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let email: string;
  const ids: Record<string, string> = {};

  interface Card {
    postId: string;
    priceVnd: number | null;
    post: { dealPct: number | null; dealMedianVnd: number | null; dealN: number | null; priceQualifier: string | null };
  }
  async function get(query: string): Promise<{ status: number; body: { matches: Card[]; nextCursor: string | null; capabilities: Record<string, boolean>; error?: string } }> {
    const res = await createApp(handle).request(`/api/dashboard/matches?${query}`, { headers: { "X-Dev-User": email } });
    return { status: res.status, body: (await res.json()) as never };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [team] = await handle.db.insert(schema.team).values({ name: `m052-${RUN}` }).returning({ id: schema.team.id });
    email = `m052-${RUN}@example.com`;
    const [user] = await handle.db.insert(schema.user).values({ teamId: team!.id, email, role: "hunter" }).returning({ id: schema.user.id });
    const [src] = await handle.db
      .insert(schema.source)
      .values({ teamId: team!.id, kind: "web", platformId: `m052-${RUN}`, name: "m052", url: `https://feeds.example.test/m052-${RUN}` })
      .returning({ id: schema.source.id });
    const [w] = await handle.db.insert(schema.watch).values({ userId: user!.id, name: "W" }).returning({ id: schema.watch.id });
    const specs = [
      { k: "a", price: 150e6, year: 2012, odo: 40_000, region: "TP.HCM", pct: -12 },
      { k: "b", price: 200e6, year: 2016, odo: 90_000, region: "TP.HCM", pct: 3 },
      { k: "c", price: 260e6, year: 2019, odo: 90_000, region: "Đồng Nai", pct: null },
      { k: "hidden", price: 100e6, year: 2018, odo: 10_000, region: "TP.HCM", pct: -30 },
    ];
    for (const [i, s] of specs.entries()) {
      const [p] = await handle.db
        .insert(schema.post)
        .values({ sourceId: src!.id, platformPostId: `${s.k}-${RUN}`, url: `https://feeds.example.test/${s.k}-${RUN}`, title: s.k })
        .returning({ id: schema.post.id });
      ids[s.k] = p!.id;
      await handle.db.insert(schema.enrichment).values({
        postId: p!.id,
        intent: "sell",
        priceVnd: s.price,
        priceQualifier: "exact",
        attributes: { year: s.year, odo_km: s.odo, region: s.region },
        dealPct: s.pct,
        dealMedianVnd: s.pct === null ? null : 200e6,
        dealN: s.pct === null ? null : 13,
      });
      await handle.db.insert(schema.match).values({ postId: p!.id, watchId: w!.id, score: 0.5, matchedTerms: [], createdAt: new Date(Date.UTC(2026, 7, 1, 0, i)) });
    }
    await handle.db.insert(schema.postUserFlag).values({ userId: user!.id, postId: ids.hidden!, kind: "hidden" });
  });

  afterAll(async () => {
    await handle.close();
  });

  test("price and year filters, hidden excluded, capabilities and card fields", async () => {
    const r = await get("priceMax=200000000&yearMin=2015");
    expect(r.status).toBe(200);
    expect(r.body.matches.map((m) => m.postId)).toEqual([ids.b!]);
    expect(r.body.capabilities).toEqual({ listing: false, dealV2: false, risk: false, seller: false });
    expect(r.body.matches[0]!.post).toMatchObject({ dealMedianVnd: 200e6, dealN: 13, priceQualifier: "exact" });
    expect((await get("odoMax=50000")).body.matches.map((m) => m.postId)).toEqual([ids.a!]);
    expect((await get("priceMin=160000000")).body.matches.map((m) => m.postId).sort()).toEqual([ids.b!, ids.c!].sort());
    expect((await get("yearMax=2013")).body.matches.map((m) => m.postId)).toEqual([ids.a!]);
  });

  test("region is case-insensitive", async () => {
    expect((await get("region=tp.hcm")).body.matches.map((m) => m.postId).sort()).toEqual([ids.a!, ids.b!].sort());
  });

  test("sort=deal orders -12, 3, null; sort=price pages by offset cursor", async () => {
    expect((await get("sort=deal")).body.matches.map((m) => m.post.dealPct)).toEqual([-12, 3, null]);
    const p1 = await get("sort=price&limit=1");
    expect(p1.body.matches.map((m) => m.priceVnd)).toEqual([150e6]);
    expect(JSON.parse(Buffer.from(p1.body.nextCursor!, "base64url").toString())).toEqual({ sort: "price", offset: 1 });
    const p2 = await get(`sort=price&limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.matches.map((m) => m.priceVnd)).toEqual([200e6]);
    expect((await get("sort=deal&cursor=abc")).status).toBe(400);
  });

  test("saved=1 keeps only saved posts", async () => {
    const [u] = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
    await handle.db.insert(schema.postUserFlag).values({ userId: u!.id, postId: ids.c!, kind: "saved" });
    expect((await get("saved=1")).body.matches.map((m) => m.postId)).toEqual([ids.c!]);
  });

  test("invalid params are 400 validation; false capabilities are 400 capability_unavailable", async () => {
    const bad = await get("priceMin=abc");
    expect([bad.status, bad.body.error]).toEqual([400, "validation"]);
    expect((await get("sort=bogus")).status).toBe(400);
    const drop = await get("sort=drop");
    expect([drop.status, drop.body.error]).toEqual([400, "capability_unavailable"]);
    expect((await get("band=great")).body.error).toBe("capability_unavailable");
  });
});
