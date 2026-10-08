import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../index";
import { resetRateLimitState } from "../middleware/rate-limit";

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
    console.warn(`visits.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("visits.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("visits.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("POST /api/visits, GET /api/sources/:id/visits", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let userEmail: string;
  let sourceId: string;
  let sourceId2: string;
  let otherSourceId: string;
  let otherSourceIdForeignTeam: string;
  let foreignTeamId: string;
  let key: string;
  let keyId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `visits-test-team-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    userEmail = `visits-test-${crypto.randomUUID()}@example.com`;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: userEmail, role: "operator" })
      .returning({ id: schema.user.id });
    userId = user!.id;

    key = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const [apiKey] = await handle.db
      .insert(schema.apiKey)
      .values({ userId, name: "visits-test-key", prefix: key.slice(0, 8), hash: await sha256Hex(key), scopes: ["ingest"] })
      .returning({ id: schema.apiKey.id });
    keyId = apiKey!.id;

    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `visits-g1-${crypto.randomUUID()}`, name: "Visits group 1", url: `https://example.com/visits-g1-${crypto.randomUUID()}`, assignedKeyId: keyId })
      .returning({ id: schema.source.id });
    sourceId = source!.id;

    const [source2] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `visits-g1b-${crypto.randomUUID()}`, name: "Visits group 1b", url: `https://example.com/visits-g1b-${crypto.randomUUID()}`, assignedKeyId: keyId })
      .returning({ id: schema.source.id });
    sourceId2 = source2!.id;

    const [other] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `visits-g2-${crypto.randomUUID()}`, name: "Visits group 2", url: `https://example.com/visits-g2-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    otherSourceId = other!.id;

    const [foreignTeam] = await handle.db.insert(schema.team).values({ name: `visits-test-foreign-team-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    foreignTeamId = foreignTeam!.id;
    const [foreignSource] = await handle.db
      .insert(schema.source)
      .values({ teamId: foreignTeamId, kind: "web", platformId: `visits-foreign-${crypto.randomUUID()}`, name: "Foreign", url: `https://example.com/visits-foreign-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    otherSourceIdForeignTeam = foreignSource!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, sourceId));
    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, otherSourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, foreignTeamId));
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, userId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, foreignTeamId));
    await handle.close();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  test("same finished visit posted twice upserts one row and sets source.lastOkVisitAt", async () => {
    const app = createApp(handle);
    const id = crypto.randomUUID();
    const finishedAt = new Date().toISOString();
    const body = { id, sourceId, startedAt: new Date(Date.now() - 1000).toISOString(), finishedAt, outcome: "ok" as const };

    const res1 = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { visit: { id: string } };
    expect(json1.visit.id).toBe(id);

    const res2 = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as { visit: { id: string } };
    expect(json2.visit.id).toBe(id);

    const visitRows = await handle.db.select().from(schema.visit).where(eq(schema.visit.id, id));
    expect(visitRows.length).toBe(1);

    const [source] = await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId));
    expect(source?.lastOkVisitAt?.toISOString()).toBe(new Date(finishedAt).toISOString());
  });

  test("start-only body then a finish body -> one row, earliest startedAt, finish fields applied", async () => {
    const app = createApp(handle);
    const id = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 60_000).toISOString();

    const startRes = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, sourceId, startedAt }),
    });
    expect(startRes.status).toBe(200);

    const finishedAt = new Date().toISOString();
    const finishRes = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, sourceId, finishedAt, outcome: "ok", startedAt: new Date().toISOString() }),
    });
    expect(finishRes.status).toBe(200);

    const [row] = await handle.db.select().from(schema.visit).where(eq(schema.visit.id, id));
    expect(row?.startedAt.toISOString()).toBe(new Date(startedAt).toISOString());
    expect(row?.outcome).toBe("ok");
    expect(row?.finishedAt?.toISOString()).toBe(new Date(finishedAt).toISOString());

    const visitsRes = await app.request(`/api/sources/${sourceId}/visits`);
    // Session-only route; without a session this must 401, not error.
    expect(visitsRes.status).toBe(401);
  });

  test("same id for another source -> 409", async () => {
    const app = createApp(handle);
    const id = crypto.randomUUID();
    const first = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, sourceId }),
    });
    expect(first.status).toBe(200);

    const conflict = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, sourceId: sourceId2 }),
    });
    expect(conflict.status).toBe(409);
  });

  test("outcome without finishedAt -> 400", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), sourceId, outcome: "ok" }),
    });
    expect(res.status).toBe(400);
  });

  test("unknown source and source-not-assigned both -> 403 (no probing signal)", async () => {
    const app = createApp(handle);
    const resUnknown = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), sourceId: crypto.randomUUID() }),
    });
    expect(resUnknown.status).toBe(403);

    const res403 = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), sourceId: otherSourceId }),
    });
    expect(res403.status).toBe(403);
  });

  test("startedAt after finishedAt is clamped down to finishedAt", async () => {
    const app = createApp(handle);
    const id = crypto.randomUUID();
    const finishedAt = new Date(Date.now() - 5000);
    const futureStartedAt = new Date(finishedAt.getTime() + 60_000).toISOString();
    const res = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, sourceId, startedAt: futureStartedAt, finishedAt: finishedAt.toISOString(), outcome: "ok" }),
    });
    expect(res.status).toBe(200);
    const [row] = await handle.db.select().from(schema.visit).where(eq(schema.visit.id, id)).limit(1);
    expect(row?.startedAt.getTime()).toBeLessThanOrEqual(finishedAt.getTime());
  });

  test("GET /api/sources/:id/visits returns the visit with postsIngested (session)", async () => {
    process.env.DEV_AUTH_BYPASS = "1";
    try {
      const app = createApp(handle);
      const id = crypto.randomUUID();
      const finishedAt = new Date().toISOString();
      await app.request("/api/visits", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id, sourceId, finishedAt, outcome: "ok" }),
      });
      await handle.db.insert(schema.post).values({
        sourceId,
        platformPostId: `visits-post-${crypto.randomUUID()}`,
        url: "https://example.com/p/x",
        visitId: id,
      });

      const res = await app.request(`/api/sources/${sourceId}/visits`, {
        headers: { "X-Dev-User": userEmail },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { visits: { id: string; postsIngested: number }[]; nextCursor: string | null };
      const found = json.visits.find((v) => v.id === id);
      expect(found?.postsIngested).toBe(1);

      const foreignRes = await app.request(`/api/sources/${otherSourceIdForeignTeam}/visits`, {
        headers: { "X-Dev-User": userEmail },
      });
      expect(foreignRes.status).toBe(404);
    } finally {
      delete process.env.DEV_AUTH_BYPASS;
    }
  });
  test("page counters are stored, returned by GET, and bounded (-1 / 100001 -> 400)", async () => {
    process.env.DEV_AUTH_BYPASS = "1";
    try {
      const app = createApp(handle);
      const id = crypto.randomUUID();
      const post = (body: Record<string, unknown>) =>
        app.request("/api/visits", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const res = await post({ id, sourceId, finishedAt: new Date().toISOString(), outcome: "ok", postsSeen: 5, pages: 2, reachedKnownTail: true });
      expect(res.status).toBe(200);
      const [row] = await handle.db.select().from(schema.visit).where(eq(schema.visit.id, id));
      expect([row?.postsSeen, row?.pages, row?.reachedKnownTail]).toEqual([5, 2, true]);

      // An omitted counter keeps the stored value.
      expect((await post({ id, sourceId, pages: 3 })).status).toBe(200);
      const [row2] = await handle.db.select().from(schema.visit).where(eq(schema.visit.id, id));
      expect([row2?.postsSeen, row2?.pages, row2?.reachedKnownTail]).toEqual([5, 3, true]);

      const list = await app.request(`/api/sources/${sourceId}/visits`, { headers: { "X-Dev-User": userEmail } });
      const json = (await list.json()) as { visits: { id: string; postsSeen: number | null; pages: number | null; reachedKnownTail: boolean | null }[] };
      const found = json.visits.find((v) => v.id === id);
      expect([found?.postsSeen, found?.pages, found?.reachedKnownTail]).toEqual([5, 3, true]);

      for (const bad of [-1, 100_001]) {
        expect((await post({ id: crypto.randomUUID(), sourceId, postsSeen: bad })).status).toBe(400);
        expect((await post({ id: crypto.randomUUID(), sourceId, pages: bad })).status).toBe(400);
      }
    } finally {
      delete process.env.DEV_AUTH_BYPASS;
    }
  });

  test("two adjacent blocked visits pause the source once; an ok probe resumes it", async () => {
    const app = createApp(handle);
    const post = (body: Record<string, unknown>) =>
      app.request("/api/visits", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const statusOf = async () => (await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId2)))[0]?.status;
    const first = { id: crypto.randomUUID(), sourceId: sourceId2, finishedAt: new Date(Date.now() - 60_000).toISOString(), outcome: "blocked", reason: "blocked:wall" };
    expect((await post(first)).status).toBe(200);
    expect(await statusOf()).toBe("active");
    const blocked = { id: crypto.randomUUID(), sourceId: sourceId2, finishedAt: new Date().toISOString(), outcome: "blocked", reason: "blocked:wall" };
    expect((await post(blocked)).status).toBe(200);
    expect(await statusOf()).toBe("paused_by_health");
    expect((await post(blocked)).status).toBe(200); // replay
    expect(await statusOf()).toBe("paused_by_health");

    const ok = { id: crypto.randomUUID(), sourceId: sourceId2, finishedAt: new Date(Date.now() + 1000).toISOString(), outcome: "ok", mode: "probe", postsSeen: 2 };
    expect((await post(ok)).status).toBe(200);
    expect(await statusOf()).toBe("active");
    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, sourceId2));
  });
});
