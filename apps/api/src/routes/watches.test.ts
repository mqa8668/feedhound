import { createDb, schema, type DbHandle } from "@feedhound/db";
import { seedTaxonomyAndCatalogue } from "@feedhound/db/src/seed";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../index";
import { loadWatchStats } from "../services/watch-stats";

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
    console.warn(`watches.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("watches.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("watches.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("watches routes", () => {
  let handle: DbHandle;
  let teamId: string;
  let userAId: string;
  let userBId: string;
  let keyA: string;
  let keyB: string;
  let sourceId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);

    const [team] = await handle.db.insert(schema.team).values({ name: "watches-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;

    const [userA] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `watches-a-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userAId = userA!.id;
    const [userB] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `watches-b-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userBId = userB!.id;

    keyA = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: userAId,
      name: "a",
      prefix: keyA.slice(0, 8),
      hash: await sha256Hex(keyA),
      scopes: ["watches:read", "watches:write"],
    });
    keyB = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: userBId,
      name: "b",
      prefix: keyB.slice(0, 8),
      hash: await sha256Hex(keyB),
      scopes: ["watches:read", "watches:write"],
    });

    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: "watches-test", name: "Watches test group", url: "https://feeds.example.test/watches-test" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
  });

  afterAll(async () => {
    // FK cascades (migration) delete Match rows when their Watch or Post is deleted.
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userAId));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userBId));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userAId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userBId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userAId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userBId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  // HTTP half: 
  describe("Regex validation on POST /api/watches", () => {
    test("nested quantifier regex -> 422 field regex", async () => {
      const app = createApp(handle);
      const res = await app.request("/api/watches", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad-1", regex: "(a+)+$" }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { field?: string };
      expect(body.field).toBe("regex");
    });

    test("backreference regex -> 422", async () => {
      const app = createApp(handle);
      const res = await app.request("/api/watches", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad-2", regex: "(\\w)\\1" }),
      });
      expect(res.status).toBe(422);
    });

    test("lookahead regex -> 422", async () => {
      const app = createApp(handle);
      const res = await app.request("/api/watches", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad-3", regex: "(?=x)y" }),
      });
      expect(res.status).toBe(422);
    });

    test("safe regex -> 201 and matches via /test", async () => {
      const app = createApp(handle);
      const createRes = await app.request("/api/watches", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ip15", regex: "\\bip(hone)? ?1[45]\\b" }),
      });
      expect(createRes.status).toBe(201);
      const watch = (await createRes.json()) as { id: string };

      const [post] = await handle.db
        .insert(schema.post)
        .values({
          sourceId,
          platformPostId: `ac4-${crypto.randomUUID()}`,
          url: "https://feeds.example.test/watches-test/posts/1",
          text: "ban ip 15 gia tot",
          textNormalized: "ban ip 15 gia tot",
        })
        .returning({ id: schema.post.id });

      const testRes = await app.request(`/api/watches/${watch.id}/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(testRes.status).toBe(200);
      const body = (await testRes.json()) as { posts: { postId: string }[] };
      expect(body.posts.some((p) => p.postId === post!.id)).toBe(true);
    });
  });

  describe("Owner scoping", () => {
    test("cross-owner GET/PATCH/DELETE -> 404; GET list omits; matches log empty", async () => {
      const app = createApp(handle);
      const createRes = await app.request("/api/watches", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "owned-by-a", include: ["laptop"] }),
      });
      expect(createRes.status).toBe(201);
      const watch = (await createRes.json()) as { id: string };

      const getRes = await app.request(`/api/watches/${watch.id}`, { headers: { Authorization: `Bearer ${keyB}` } });
      expect(getRes.status).toBe(404);

      const patchRes = await app.request(`/api/watches/${watch.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${keyB}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(patchRes.status).toBe(404);

      const deleteRes = await app.request(`/api/watches/${watch.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${keyB}` } });
      expect(deleteRes.status).toBe(404);

      const [unchanged] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, watch.id)).limit(1);
      expect(unchanged?.enabled).toBe(true);

      const listRes = await app.request("/api/watches", { headers: { Authorization: `Bearer ${keyB}` } });
      const list = (await listRes.json()) as { watches: { id: string }[] };
      expect(list.watches.some((w) => w.id === watch.id)).toBe(false);

      const matchesRes = await app.request(`/api/matches?watchId=${watch.id}`, { headers: { Authorization: `Bearer ${keyB}` } });
      const matches = (await matchesRes.json()) as { matches: unknown[] };
      expect(matches.matches).toEqual([]);
    });
  });

  // Regression: DELETE cascades to Match history, so
  // a plain DELETE must require explicit confirmation.
  describe("DELETE /api/watches/:id confirmation", () => {
    test("without ?confirm=true -> 400, watch not deleted; with ?confirm=true -> 204, watch gone", async () => {
      const app = createApp(handle);
      const createRes = await app.request("/api/watches", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "finding7", include: ["router"] }),
      });
      expect(createRes.status).toBe(201);
      const watch = (await createRes.json()) as { id: string };

      const withoutConfirm = await app.request(`/api/watches/${watch.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${keyA}` },
      });
      expect(withoutConfirm.status).toBe(400);

      const [stillThere] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, watch.id)).limit(1);
      expect(stillThere).toBeDefined();

      const withConfirm = await app.request(`/api/watches/${watch.id}?confirm=true`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${keyA}` },
      });
      expect(withConfirm.status).toBe(204);

      const [gone] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, watch.id)).limit(1);
      expect(gone).toBeUndefined();
    });
  });

  // Notification.match_id cascades, so deleting a watch that has notified matches works.
  describe("DELETE a watch with notified matches", () => {
    test("204; matches + notifications gone; ops notification kept", async () => {
      const app = createApp(handle);
      const [w] = await handle.db.insert(schema.watch).values({ userId: userAId, name: "ac1-cascade", include: ["x"] }).returning({ id: schema.watch.id });
      const watchId = w!.id;
      const matchIds: string[] = [];
      const postIds: string[] = [];
      for (const status of ["sent", "pending"] as const) {
        const [p] = await handle.db
          .insert(schema.post)
          .values({ sourceId, platformPostId: `ac1-${crypto.randomUUID()}`, url: "https://example.com/x" })
          .returning({ id: schema.post.id });
        const [m] = await handle.db.insert(schema.match).values({ postId: p!.id, watchId, score: 1 }).returning({ id: schema.match.id });
        matchIds.push(m!.id);
        postIds.push(p!.id);
        await handle.db.insert(schema.notification).values({ userId: userAId, matchId: m!.id, channel: "telegram", status });

      }
      const [ops] = await handle.db
        .insert(schema.notification)
        .values({ userId: userAId, channel: "ops", status: "sent" })
        .returning({ id: schema.notification.id });
      try {
        const res = await app.request(`/api/watches/${watchId}?confirm=true`, { method: "DELETE", headers: { Authorization: `Bearer ${keyA}` } });
        expect(res.status).toBe(204);
        const matches = await handle.db.select().from(schema.match).where(inArray(schema.match.id, matchIds));
        const notifs = await handle.db.select().from(schema.notification).where(inArray(schema.notification.matchId, matchIds));
        expect(matches).toHaveLength(0);
        expect(notifs).toHaveLength(0);
        const [opsRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, ops!.id));
        expect(opsRow).toBeDefined();
      } finally {
        await handle.db.delete(schema.notification).where(eq(schema.notification.id, ops!.id));
        await handle.db.delete(schema.post).where(inArray(schema.post.id, postIds));
        await handle.db.delete(schema.watch).where(eq(schema.watch.id, watchId));
      }
    });
  });

  // Regression: malformed query params must return
  // 422, not a raw Postgres error surfacing as 500.
  describe("GET /api/matches query validation", () => {
    test("non-uuid watchId -> 422, not 500", async () => {
      const app = createApp(handle);
      const res = await app.request("/api/matches?watchId=not-a-uuid", { headers: { Authorization: `Bearer ${keyA}` } });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { field?: string };
      expect(body.field).toBe("watchId");
    });

    test("invalid since -> 422", async () => {
      const app = createApp(handle);
      const res = await app.request("/api/matches?since=not-a-date", { headers: { Authorization: `Bearer ${keyA}` } });
      expect(res.status).toBe(422);
    });

    test("limit out of range -> 422; limit within range -> 200", async () => {
      const app = createApp(handle);
      const tooBig = await app.request("/api/matches?limit=201", { headers: { Authorization: `Bearer ${keyA}` } });
      expect(tooBig.status).toBe(422);

      const zero = await app.request("/api/matches?limit=0", { headers: { Authorization: `Bearer ${keyA}` } });
      expect(zero.status).toBe(422);

      const ok = await app.request("/api/matches?limit=10", { headers: { Authorization: `Bearer ${keyA}` } });
      expect(ok.status).toBe(200);
    });

    // `?userId=` was read raw (via `c.req.query`) and
    // compared directly against a uuid column before any validation, so a
    // non-uuid value reached Postgres and errored as a 500.
    test("non-uuid userId -> 422, not 500", async () => {
      const app = createApp(handle);
      const res = await app.request("/api/matches?userId=not-a-uuid", { headers: { Authorization: `Bearer ${keyA}` } });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { field?: string };
      expect(body.field).toBe("userId");
    });
  });

  describe("POST /api/watches/:id/test", () => {
    test("returns matching posts from last 24h only, ordered by score desc; is read-only; hours>168 -> 422", async () => {
      const app = createApp(handle);
      const createRes = await app.request("/api/watches", {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ac10", include: ["macbook"] }),
      });
      const watch = (await createRes.json()) as { id: string };

      const now = new Date();
      const recent = (n: number) => new Date(now.getTime() - n * 60 * 60 * 1000);

      async function insertPost(text: string, firstSeenAt: Date): Promise<string> {
        const [row] = await handle.db
          .insert(schema.post)
          .values({
            sourceId,
            platformPostId: `ac10-${crypto.randomUUID()}`,
            url: "https://feeds.example.test/watches-test/posts/ac10",
            text,
            textNormalized: text,
            firstSeenAt,
          })
          .returning({ id: schema.post.id });
        return row!.id;
      }

      await insertPost("ban macbook pro", recent(1)); // matches, recent
      await insertPost("ban macbook air", recent(2)); // matches, recent
      await insertPost("ban macbook 2015", recent(3)); // matches, recent
      await insertPost("ban dien thoai", recent(4)); // no match, recent
      await insertPost("con moi", recent(5)); // no match, recent
      await insertPost("ban macbook cu", recent(30)); // matches, but > 24h
      await insertPost("ban macbook moi", recent(40)); // matches, but > 24h

      const matchCountBefore = await handle.db.select({ id: schema.match.id }).from(schema.match).where(eq(schema.match.watchId, watch.id));

      const testRes = await app.request(`/api/watches/${watch.id}/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(testRes.status).toBe(200);
      const body = (await testRes.json()) as { posts: { score: number }[]; truncated: boolean };
      expect(body.posts.length).toBe(3);
      // The 20,000-row scan cap was not hit here, so the
      // response must report it was not truncated.
      expect(body.truncated).toBe(false);

      const matchCountAfter = await handle.db.select({ id: schema.match.id }).from(schema.match).where(eq(schema.match.watchId, watch.id));
      expect(matchCountAfter.length).toBe(matchCountBefore.length);

      const badRes = await app.request(`/api/watches/${watch.id}/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${keyA}`, "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 200 }),
      });
      expect(badRes.status).toBe(422);
    });
  });
});

// Session-based owner/operator access and the unsaved-draft
// `/api/watches/test` endpoint.
describe.skipIf(!canRun)("watches routes (dashboard)", () => {
  let handle: DbHandle;
  let teamId: string;
  let hunterAId: string;
  let hunterBId: string;
  let operatorId: string;
  let hunterAEmail: string;
  let hunterBEmail: string;
  let operatorEmail: string;
  let sourceId: string;
  let watchAId: string;
  let originalNodeEnv: string | undefined;
  let originalDevBypass: string | undefined;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    originalDevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.DEV_AUTH_BYPASS = "1"; // the bypass requires this explicit opt-in, not just NODE_ENV

    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "watches-session-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;

    hunterAEmail = `watches-session-a-${crypto.randomUUID()}@example.com`;
    hunterBEmail = `watches-session-b-${crypto.randomUUID()}@example.com`;
    operatorEmail = `watches-session-op-${crypto.randomUUID()}@example.com`;
    const [hunterA] = await handle.db.insert(schema.user).values({ teamId, email: hunterAEmail, role: "hunter" }).returning({ id: schema.user.id });
    hunterAId = hunterA!.id;
    const [hunterB] = await handle.db.insert(schema.user).values({ teamId, email: hunterBEmail, role: "hunter" }).returning({ id: schema.user.id });
    hunterBId = hunterB!.id;
    const [operator] = await handle.db.insert(schema.user).values({ teamId, email: operatorEmail, role: "operator" }).returning({ id: schema.user.id });
    operatorId = operator!.id;

    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: "watches-session-test", name: "Session test group", url: "https://feeds.example.test/watches-session-test" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;

    const [watchA] = await handle.db
      .insert(schema.watch)
      .values({ userId: hunterAId, name: "hunter-a-watch", include: ["iphone"] })
      .returning({ id: schema.watch.id });
    watchAId = watchA!.id;

    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
    const old = new Date(now.getTime() - 30 * 60 * 60 * 1000); // 30h ago
    await handle.db.insert(schema.post).values([
      { sourceId, platformPostId: "p1", url: "https://x/1", text: "iphone 13 for sale", textNormalized: "iphone 13 for sale", firstSeenAt: recent, postedAt: recent },
      { sourceId, platformPostId: "p2", url: "https://x/2", text: "iphone 14 for sale", textNormalized: "iphone 14 for sale", firstSeenAt: recent, postedAt: recent },
      { sourceId, platformPostId: "p3", url: "https://x/3", text: "iphone 15 for sale", textNormalized: "iphone 15 for sale", firstSeenAt: recent, postedAt: recent },
      { sourceId, platformPostId: "p4", url: "https://x/4", text: "iphone old for sale", textNormalized: "iphone old for sale", firstSeenAt: old, postedAt: old },
      { sourceId, platformPostId: "p5", url: "https://x/5", text: "samsung for sale", textNormalized: "samsung for sale", firstSeenAt: recent, postedAt: recent },
    ]);
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DEV_AUTH_BYPASS = originalDevBypass;
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, hunterAId));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, hunterAId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, hunterBId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, operatorId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("hunter B cannot see or touch hunter A's watch (404, not 403); operator can", async () => {
    const app = createApp(handle);

    const listRes = await app.request("/api/watches", { headers: { "X-Dev-User": hunterBEmail } });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { watches: { id: string }[] };
    expect(listBody.watches.find((w) => w.id === watchAId)).toBeUndefined();

    const getRes = await app.request(`/api/watches/${watchAId}`, { headers: { "X-Dev-User": hunterBEmail } });
    expect(getRes.status).toBe(404);

    const patchRes = await app.request(`/api/watches/${watchAId}`, {
      method: "PATCH",
      headers: { "X-Dev-User": hunterBEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hijacked" }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await app.request(`/api/watches/${watchAId}?confirm=true`, { method: "DELETE", headers: { "X-Dev-User": hunterBEmail } });
    expect(deleteRes.status).toBe(404);

    const operatorGetRes = await app.request(`/api/watches/${watchAId}`, { headers: { "X-Dev-User": operatorEmail } });
    expect(operatorGetRes.status).toBe(200);
  });

  // `resolveTargetUserId` let an operator read
  // another team's watches cross-team via `?userId=`.
  test("operator cannot list another team's user's watches via ?userId=", async () => {
    const app = createApp(handle);
    const [otherTeam] = await handle.db.insert(schema.team).values({ name: "watches-other-team" }).returning({ id: schema.team.id });
    const otherEmail = `watches-other-${crypto.randomUUID()}@example.com`;
    const [otherUser] = await handle.db.insert(schema.user).values({ teamId: otherTeam!.id, email: otherEmail, role: "hunter" }).returning({ id: schema.user.id });

    try {
      const res = await app.request(`/api/watches?userId=${otherUser!.id}`, { headers: { "X-Dev-User": operatorEmail } });
      expect(res.status).toBe(404);
    } finally {
      await handle.db.delete(schema.user).where(eq(schema.user.id, otherUser!.id));
      await handle.db.delete(schema.team).where(eq(schema.team.id, otherTeam!.id));
    }
  });

  // sourceIds on `/api/watches/test` were never
  // checked for team ownership — a hunter could read another team's posts.
  test("POST /api/watches/test rejects sourceIds belonging to another team", async () => {
    const app = createApp(handle);
    const [otherTeam] = await handle.db.insert(schema.team).values({ name: "watches-other-source-team" }).returning({ id: schema.team.id });
    const [otherSource] = await handle.db
      .insert(schema.source)
      .values({ teamId: otherTeam!.id, kind: "web", platformId: "watches-other-source", name: "Other", url: "https://feeds.example.test/watches-other-source" })
      .returning({ id: schema.source.id });

    try {
      const res = await app.request("/api/watches/test", {
        method: "POST",
        headers: { "X-Dev-User": hunterAEmail, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "draft", include: ["iphone"], sourceIds: [otherSource!.id] }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { field?: string };
      expect(body.field).toBe("sourceIds");
    } finally {
      await handle.db.delete(schema.source).where(eq(schema.source.id, otherSource!.id));
      await handle.db.delete(schema.team).where(eq(schema.team.id, otherTeam!.id));
    }
  });

  // `checkReferencesExist`'s team check only runs when `sourceIds.length >
  // 0`; `testWatch` itself filtered by `firstSeenAt` (+ optional sourceIds) with no team
  // predicate, so `sourceIds: []` bypassed team scoping entirely and returned another
  // team's post titles/urls/matched terms.
  test("POST /api/watches/test with sourceIds: [] never returns another team's posts", async () => {
    const app = createApp(handle);
    const [otherTeam] = await handle.db.insert(schema.team).values({ name: "watches-empty-sourceids-team" }).returning({ id: schema.team.id });
    const [otherSource] = await handle.db
      .insert(schema.source)
      .values({ teamId: otherTeam!.id, kind: "web", platformId: "watches-empty-sourceids", name: "Other", url: "https://feeds.example.test/watches-empty-sourceids" })
      .returning({ id: schema.source.id });
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    await handle.db.insert(schema.post).values({
      sourceId: otherSource!.id,
      platformPostId: "other-team-secret",
      url: "https://x/secret",
      text: "iphone secret from other team",
      textNormalized: "iphone secret from other team",
      firstSeenAt: recent,
      postedAt: recent,
    });

    try {
      const res = await app.request("/api/watches/test", {
        method: "POST",
        headers: { "X-Dev-User": hunterAEmail, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "draft", include: ["iphone"], sourceIds: [] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { posts: { title: string | null }[] };
      expect(body.posts.some((p) => p.title === "iphone secret from other team")).toBe(false);
    } finally {
      await handle.db.delete(schema.post).where(eq(schema.post.sourceId, otherSource!.id));
      await handle.db.delete(schema.source).where(eq(schema.source.id, otherSource!.id));
      await handle.db.delete(schema.team).where(eq(schema.team.id, otherTeam!.id));
    }
  });

  // `/api/watches/:id/test` used `actor.teamId` (the caller's own team),
  // which is wrong for an operator testing another team's watch — must scope by the
  // watch owner's team instead.
  test("operator's /api/watches/:id/test scopes by the watch owner's team, not the operator's own", async () => {
    const app = createApp(handle);
    const [otherTeam] = await handle.db.insert(schema.team).values({ name: "watches-op-other-team" }).returning({ id: schema.team.id });
    const otherOpEmail = `watches-op-other-${crypto.randomUUID()}@example.com`;
    const [otherOp] = await handle.db.insert(schema.user).values({ teamId: otherTeam!.id, email: otherOpEmail, role: "operator" }).returning({ id: schema.user.id });
    const [otherOpSource] = await handle.db
      .insert(schema.source)
      .values({ teamId: otherTeam!.id, kind: "web", platformId: "watches-op-other-source", name: "Other", url: "https://feeds.example.test/watches-op-other-source" })
      .returning({ id: schema.source.id });
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    await handle.db.insert(schema.post).values({
      sourceId: otherOpSource!.id,
      platformPostId: "op-other-team-secret",
      url: "https://x/op-secret",
      text: "iphone from operator's own other team",
      textNormalized: "iphone from operator's own other team",
      firstSeenAt: recent,
      postedAt: recent,
    });

    try {
      // watchAId belongs to hunterA (in `teamId`); tested by an operator whose own team
      // is `otherTeam` — the result must never include `otherTeam`'s posts.
      const res = await app.request(`/api/watches/${watchAId}/test`, {
        method: "POST",
        headers: { "X-Dev-User": otherOpEmail, "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 24, limit: 50 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { posts: { title: string | null }[] };
      expect(body.posts.some((p) => p.title === "iphone from operator's own other team")).toBe(false);
    } finally {
      await handle.db.delete(schema.post).where(eq(schema.post.sourceId, otherOpSource!.id));
      await handle.db.delete(schema.source).where(eq(schema.source.id, otherOpSource!.id));
      await handle.db.delete(schema.user).where(eq(schema.user.id, otherOp!.id));
      await handle.db.delete(schema.team).where(eq(schema.team.id, otherTeam!.id));
    }
  });

  test("POST /api/watches/test on an unsaved draft matches only posts from the last 24h", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/watches/test", {
      method: "POST",
      headers: { "X-Dev-User": hunterAEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "draft", include: ["iphone"], sourceIds: [sourceId] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; posts: { id: string }[] };
    expect(body.count).toBe(3);
    expect(body.posts.length).toBe(3);
  });

  // Operators create or move watches for same-team users.
  test("Operator creates/moves watches for teammates; hunter and cross-team are refused", async () => {
    const app = createApp(handle);
    const send = async (email: string, method: string, path: string, body: unknown): Promise<Response> =>
      app.request(path, { method, headers: { "X-Dev-User": email, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const [otherTeam] = await handle.db.insert(schema.team).values({ name: `watches-040-t2-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    const [x] = await handle.db.insert(schema.user).values({ teamId: otherTeam!.id, email: `watches-040-x-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const created: string[] = [];
    try {
      const forB = await send(operatorEmail, "POST", "/api/watches", { name: "for-b", include: ["iphone"], userId: hunterBId });
      expect(forB.status).toBe(201);
      const forBRow = (await forB.json()) as { id: string; userId: string };
      created.push(forBRow.id);
      expect(forBRow.userId).toBe(hunterBId);

      const hunterToOp = await send(hunterAEmail, "POST", "/api/watches", { name: "nope", include: ["iphone"], userId: operatorId });
      expect(hunterToOp.status).toBe(403);
      expect(await hunterToOp.json()).toEqual({ error: "forbidden" });
      const hunterToSelf = await send(hunterAEmail, "POST", "/api/watches", { name: "self", include: ["iphone"], userId: hunterAId });
      expect(hunterToSelf.status).toBe(201);
      created.push(((await hunterToSelf.json()) as { id: string }).id);
      const crossTeam = await send(operatorEmail, "POST", "/api/watches", { name: "x-team", include: ["iphone"], userId: x!.id });
      expect(crossTeam.status).toBe(404);
      expect(await crossTeam.json()).toEqual({ error: "not_found" });

      // Move B's watch to the operator: notifierIds reset to [], owner changes.
      await handle.db.update(schema.watch).set({ notifierIds: [crypto.randomUUID()] }).where(eq(schema.watch.id, forBRow.id));
      const moved = await send(operatorEmail, "PATCH", `/api/watches/${forBRow.id}`, { userId: operatorId });
      expect(moved.status).toBe(200);
      expect(await moved.json()).toMatchObject({ userId: operatorId, notifierIds: [] });
      const moveCross = await send(operatorEmail, "PATCH", `/api/watches/${forBRow.id}`, { userId: x!.id });
      expect(moveCross.status).toBe(404);
      const moveByHunter = await send(hunterAEmail, "PATCH", `/api/watches/${watchAId}`, { userId: hunterBId });
      expect(moveByHunter.status).toBe(403);
    } finally {
      if (created.length > 0) await handle.db.delete(schema.watch).where(inArray(schema.watch.id, created));
      await handle.db.delete(schema.user).where(eq(schema.user.id, x!.id));
      await handle.db.delete(schema.team).where(eq(schema.team.id, otherTeam!.id));
    }
  });
});

// Attribute filter validation on POST /api/watches.
describe.skipIf(!canRun)("watches routes attributeFilters", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let key: string;
  let macbookId: string;

  async function post(body: unknown): Promise<Response> {
    return createApp(handle).request("/api/watches", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where slug = 'cars' and attribute_schema <> '[]'::jsonb`;
    if (!seeded?.n) await seedTaxonomyAndCatalogue(TEST_DATABASE_URL);
    const [cat] = await handle.sql<{ id: string }[]>`select id from category where slug = 'macbook'`;
    macbookId = cat!.id;
    const [team] = await handle.db.insert(schema.team).values({ name: "watches-attr-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `watches-attr-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
    key = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({ userId, name: "attr", prefix: key.slice(0, 8), hash: await sha256Hex(key), scopes: ["watches:read", "watches:write"] });
  }, 120_000);

  afterAll(async () => {
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("(a) unknown key, (b) gte on an enum, (c) filters without categories -> 422", async () => {
    const a = await post({ name: "a", categoryIds: [macbookId], attributeFilters: [{ key: "gpu", op: "eq", value: "x" }] });
    expect(a.status).toBe(422);
    expect(((await a.json()) as { field: string }).field).toBe("attributeFilters.0");

    const b = await post({ name: "b", categoryIds: [macbookId], attributeFilters: [{ key: "line", op: "gte", value: "air" }] });
    expect(b.status).toBe(422);
    expect(((await b.json()) as { field: string }).field).toBe("attributeFilters.0");

    const c = await post({ name: "c", include: ["macbook"], attributeFilters: [{ key: "chip", op: "gte", value: "m2" }] });
    expect(c.status).toBe(422);
    expect(((await c.json()) as { field: string }).field).toBe("attributeFilters");
  });

  test("(d) a valid filter is stored canonical and returned by GET; PATCH re-validates", async () => {
    const d = await post({ name: "d", categoryIds: [macbookId], attributeFilters: [{ key: "chip", op: "gte", value: "M2" }] });
    expect(d.status).toBe(201);
    const created = (await d.json()) as { id: string; attributeFilters: unknown[] };
    expect(created.attributeFilters).toEqual([{ key: "chip", op: "gte", value: "m2" }]);

    const get = await createApp(handle).request(`/api/watches/${created.id}`, { headers: { Authorization: `Bearer ${key}` } });
    expect(((await get.json()) as { attributeFilters: unknown[] }).attributeFilters).toEqual([{ key: "chip", op: "gte", value: "m2" }]);

    const bad = await createApp(handle).request(`/api/watches/${created.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ attributeFilters: [{ key: "chip", op: "gte", value: "m99" }] }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { field: string }).field).toBe("attributeFilters.0");

    const ok = await createApp(handle).request(`/api/watches/${created.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ attributeFilters: [{ key: "ram_gb", op: "gte", value: "16" }] }),
    });
    expect(ok.status).toBe(200);
    const patched = (await ok.json()) as { attributeFilters: unknown[]; categoryIds: string[] };
    expect(patched.attributeFilters).toEqual([{ key: "ram_gb", op: "gte", value: 16 }]);
    expect(patched.categoryIds).toEqual([macbookId]); // fields absent from the PATCH body are left alone
  });

  test("A region-only filter needs no category; other keys still do", async () => {
    const r = await post({ name: "region only", include: ["zz051"], attributeFilters: [{ key: "region", op: "in", values: ["hcm"] }] });
    expect(r.status).toBe(201);
    const created = (await r.json()) as { attributeFilters: unknown[]; categoryIds: string[] };
    expect(created.attributeFilters).toEqual([{ key: "region", op: "in", values: ["hcm"] }]);
    expect(created.categoryIds).toEqual([]);
    const bad = await post({ name: "region bad value", include: ["zz051"], attributeFilters: [{ key: "region", op: "in", values: ["atlantis"] }] });
    expect(bad.status).toBe(422);
    const mixed = await post({ name: "region + chip", include: ["zz051"], attributeFilters: [{ key: "region", op: "in", values: ["hcm"] }, { key: "chip", op: "eq", value: "m2" }] });
    expect(mixed.status).toBe(422);
  });
});

describe.skipIf(!canRun)("watches preview window and card stats", () => {
  const DAY = 86_400_000;
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let otherUserId: string;
  let key: string;
  let sourceId: string;
  let watchId: string;
  let emptyWatchId: string;
  let otherWatchId: string;
  const notifierIds: string[] = [];

  async function req(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return createApp(handle).request(path, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "watches-027-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `w027-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    userId = user!.id;
    const [other] = await handle.db.insert(schema.user).values({ teamId, email: `w027-o-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    otherUserId = other!.id;
    key = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({ userId, name: "w027", prefix: key.slice(0, 8), hash: await sha256Hex(key), scopes: ["watches:read", "watches:write"] });
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `w027-${crypto.randomUUID()}`, name: "w027 group", url: "https://feeds.example.test/w027" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;

    const [tg] = await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: {}, enabled: true }).returning({ id: schema.notifier.id });
    const [off] = await handle.db.insert(schema.notifier).values({ userId, kind: "messenger", config: {}, enabled: false }).returning({ id: schema.notifier.id });
    notifierIds.push(tg!.id, off!.id);

    const [w] = await handle.db.insert(schema.watch).values({ userId, name: "w027-main", include: ["zz027"], notifierIds: [tg!.id, off!.id] }).returning({ id: schema.watch.id });
    watchId = w!.id;
    const [e] = await handle.db.insert(schema.watch).values({ userId, name: "w027-empty", include: ["zz027"] }).returning({ id: schema.watch.id });
    emptyWatchId = e!.id;
    const [o] = await handle.db.insert(schema.watch).values({ userId: otherUserId, name: "w027-other", include: ["zz027"] }).returning({ id: schema.watch.id });
    otherWatchId = o!.id;

    // 10 matching posts spread over ~6 days; the first 9 also get a Match on W.
    const now = Date.now();
    const dealPcts: (number | null)[] = [-4, -12, null];
    for (let i = 0; i < 10; i++) {
      const seen = new Date(now - (i * 15 + 1) * 3_600_000);
      const [p] = await handle.db
        .insert(schema.post)
        .values({ sourceId, platformPostId: `w027-${i}-${crypto.randomUUID()}`, url: `https://x/w027/${i}`, title: `zz027 post ${i}`, text: "zz027 sale", textNormalized: "zz027 sale", firstSeenAt: seen, postedAt: seen })
        .returning({ id: schema.post.id });
      if (i < 9) {
        // 2 matches today (now), the other 7 on days 1..5 ago
        const createdAt = i < 2 ? new Date(now - i * 1000) : new Date(now - (1 + ((i - 2) % 5)) * DAY);
        await handle.db.insert(schema.match).values({ postId: p!.id, watchId, score: 1, matchedTerms: ["zz027"], createdAt });
        if (i < 3) {
          await handle.db.insert(schema.enrichment).values({ postId: p!.id, intent: "sell", priceVnd: 10_000_000, dealPct: dealPcts[i] ?? null });
        }
      }
    }
  }, 120_000);

  afterAll(async () => {
    await handle.db.delete(schema.watch).where(inArray(schema.watch.id, [watchId, emptyWatchId, otherWatchId]));
    const posts = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId));
    if (posts.length > 0) await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, posts.map((p) => p.id)));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.notifier).where(inArray(schema.notifier.id, notifierIds));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(inArray(schema.user.id, [userId, otherUserId]));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("POST /api/watches/test?hours=168 returns total, daily (7 entries summing to total) and matchedTerms; hours=169 -> 422", async () => {
    const res = await req("/api/watches/test?hours=168&limit=5", { method: "POST", body: { name: "draft", include: ["zz027"] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; daily: number[]; truncated: boolean; posts: { matchedTerms: string[]; priceVnd: number | null }[] };
    expect(body.total).toBe(10);
    expect(body.daily).toHaveLength(7);
    expect(body.daily.reduce((a, b) => a + b, 0)).toBe(10);
    expect(body.posts).toHaveLength(5);
    expect(body.posts[0]?.matchedTerms).toEqual(["zz027"]);
    expect(body.truncated).toBe(false);

    const bad = await req("/api/watches/test?hours=169", { method: "POST", body: { name: "draft", include: ["zz027"] } });
    expect(bad.status).toBe(422);
  });

  test("POST /api/watches/:id/test: query hours overrides the body and bounds are enforced", async () => {
    const res = await req(`/api/watches/${watchId}/test?hours=24`, { method: "POST", body: { hours: 168 } });
    const body = (await res.json()) as { total: number; daily: number[] };
    expect(body.daily).toHaveLength(1);
    expect(body.total).toBe(body.daily[0]!);
    const wide = await req(`/api/watches/${watchId}/test?hours=168`, { method: "POST", body: {} });
    expect(((await wide.json()) as { total: number }).total).toBe(10);
    expect((await req(`/api/watches/${watchId}/test?hours=169`, { method: "POST", body: {} })).status).toBe(422);
  });

  test("GET /api/watches?stats=1 returns today/last7d/daily/bestDeal/routes for the owner's watches only", async () => {
    const res = await req("/api/watches?stats=1");
    expect(res.status).toBe(200);
    const { watches } = (await res.json()) as {
      watches: { id: string; stats: { today: number; last7d: number; daily: number[]; lastHitAt: string | null; bestDeal: { dealPct: number; priceVnd: number; postId: string } | null; routes: string[]; routesFallback: boolean } }[];
    };
    expect(watches.find((x) => x.id === otherWatchId)).toBeUndefined();
    const w = watches.find((x) => x.id === watchId)!;
    expect(w.stats.today).toBe(2);
    expect(w.stats.last7d).toBe(9);
    expect(w.stats.daily).toHaveLength(7);
    expect(w.stats.daily.reduce((a, b) => a + b, 0)).toBe(9);
    expect(w.stats.bestDeal?.dealPct).toBe(-12);
    expect(w.stats.bestDeal?.priceVnd).toBe(10_000_000);
    expect(w.stats.routes).toEqual(["telegram"]);
    expect(w.stats.lastHitAt).not.toBeNull();
    const e = watches.find((x) => x.id === emptyWatchId)!;
    expect(e.stats.bestDeal).toBeNull();
    expect(e.stats.last7d).toBe(0);
    expect(e.stats.lastHitAt).toBeNull();
    // No notifier picked -> falls back to the owner's enabled notifiers (telegram here).
    expect(e.stats.routes).toEqual(["telegram"]);
    expect(e.stats.routesFallback).toBe(true);
    expect(w.stats.routesFallback).toBe(false);
  });

  test("LoadWatchStats routes and routesFallback for [] with/without an enabled owner notifier, and a picked notifier", async () => {
    const stats = await loadWatchStats(handle, [
      { id: emptyWatchId, userId, notifierIds: [] }, // A: owner has telegram enabled
      { id: otherWatchId, userId: otherUserId, notifierIds: [] }, // B: owner has none
      { id: watchId, userId, notifierIds: [notifierIds[0]!] }, // C: picked, enabled
    ]);
    expect(stats.get(emptyWatchId)).toMatchObject({ routes: ["telegram"], routesFallback: true });
    expect(stats.get(otherWatchId)).toMatchObject({ routes: [], routesFallback: true });
    expect(stats.get(watchId)).toMatchObject({ routes: ["telegram"], routesFallback: false });
  });

  test("bestDeal ignores non-negative deal_pct (price above median is not a deal)", async () => {
    const [w] = await handle.db.insert(schema.watch).values({ userId, name: "w027-pos", include: ["zz027"] }).returning({ id: schema.watch.id });
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: `w027-pos-${crypto.randomUUID()}`, url: "https://x/w027/pos", title: "zz027 pricey", text: "zz027", textNormalized: "zz027" })
      .returning({ id: schema.post.id });
    await handle.db.insert(schema.match).values({ postId: p!.id, watchId: w!.id, score: 1, matchedTerms: ["zz027"] });
    await handle.db.insert(schema.enrichment).values({ postId: p!.id, intent: "sell", priceVnd: 30_000_000, dealPct: 25 });
    try {
      const { watches } = (await (await req("/api/watches?stats=1")).json()) as { watches: { id: string; stats: { bestDeal: unknown } }[] };
      expect(watches.find((x) => x.id === w!.id)!.stats.bestDeal).toBeNull();
    } finally {
      await handle.db.delete(schema.watch).where(eq(schema.watch.id, w!.id));
    }
  });

  test("GET /api/watches without stats=1 is unchanged", async () => {
    const res = await req("/api/watches");
    const { watches } = (await res.json()) as { watches: Record<string, unknown>[] };
    expect(watches.every((x) => !("stats" in x))).toBe(true);
  });
});
