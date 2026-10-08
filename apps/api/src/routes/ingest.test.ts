import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createApp } from "../index";
import { resetRateLimitState } from "../middleware/rate-limit";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// In CI (or whenever TEST_DATABASE_URL is explicitly set) a DB test that can't
// reach its database is a failure, not a skip — otherwise CI can go green
// while silently running zero DB tests.
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
    console.warn(`ingest.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("ingest.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("ingest.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("POST /api/ingest, POST /api/health (integration)", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let operatorUserId: string;
  let sourceId: string;
  let otherSourceId: string;
  let key: string;
  let boss: PgBoss;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();
    await boss.createQueue("enrich");
    const [team] = await handle.db.insert(schema.team).values({ name: "ingest-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `ingest-test-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
    const [operator] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `ingest-test-op-${crypto.randomUUID()}@example.com`, role: "operator" })
      .returning({ id: schema.user.id });
    operatorUserId = operator!.id;

    key = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const [apiKey] = await handle.db
      .insert(schema.apiKey)
      .values({ userId, name: "ingest", prefix: key.slice(0, 8), hash: await sha256Hex(key), scopes: ["ingest"] })
      .returning({ id: schema.apiKey.id });

    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: "g1", name: "Group 1", url: "https://example.com/g1", assignedKeyId: apiKey!.id })
      .returning({ id: schema.source.id });
    sourceId = source!.id;

    const [other] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: "g2", name: "Group 2", url: "https://example.com/g2" })
      .returning({ id: schema.source.id });
    otherSourceId = other!.id;
  });

  afterAll(async () => {
    const posts = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId));
    const postIds = posts.map((p) => p.id);
    if (postIds.length > 0) {
      await handle.sql`delete from pgboss.job where name = 'enrich' and data->>'postId' = any(${postIds})`;
    }
    for (const p of posts) {
      await handle.db.delete(schema.postRevision).where(eq(schema.postRevision.postId, p.id));
    }
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, operatorUserId));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await boss.stop({ graceful: false });
    await handle.close();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  // boss.getQueueStats() is cache-backed (pg-boss cacheBudget >= 3600s; `force`
  // only lowers it to 60s), so it can't be used for in-test assertions — count
  // enrich job rows directly, scoped to this test's own post ids.
  async function enrichJobCount(postIds: string[]): Promise<number> {
    if (postIds.length === 0) return 0;
    const rows = await handle.sql<{ count: number }[]>`
      select count(*)::int as count from pgboss.job where name = 'enrich' and data->>'postId' = any(${postIds})
    `;
    return rows[0]?.count ?? 0;
  }

  function rawPost(platformPostId: string, text: string): Record<string, unknown> {
    return {
      platformPostId,
      url: `https://example.com/posts/${platformPostId}`,
      text,
      media: [],
      capturedAt: new Date().toISOString(),
    };
  }

  test("Ingest 3 new posts -> accepted:3, 3 Post rows, 3 enrich jobs; replay -> all duplicates, no new rows/jobs", async () => {
    const app = createApp(handle, boss);
    const posts = [rawPost("p1", "hello 1"), rawPost("p2", "hello 2"), rawPost("p3", "hello 3")];

    const res1 = await app.request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, posts, visitId: "v1" }),
    });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ accepted: 3, duplicates: 0, updated: 0 });

    const rows = await handle.db.select().from(schema.post).where(eq(schema.post.sourceId, sourceId));
    expect(rows.length).toBe(3);
    const postIds = rows.map((r) => r.id);

    // boss.getQueueStats() is cache-backed (pg-boss cacheBudget >= 3600s, `force`
    // only lowers it to 60s) so two reads in the same test always land in the
    // same cache window and the delta is 0. Count enrich job rows directly.
    expect(await enrichJobCount(postIds)).toBe(3);

    const res2 = await app.request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, posts, visitId: "v2" }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ accepted: 0, duplicates: 3, updated: 0 });

    const rowsAfter = await handle.db.select().from(schema.post).where(eq(schema.post.sourceId, sourceId));
    expect(rowsAfter.length).toBe(3);

    expect(await enrichJobCount(postIds)).toBe(3);
  });

  test("capture api -> 400; an extra structured key -> 200 and is not stored", async () => {
    const app = createApp(handle, boss);
    const post = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({ ...rawPost(id, `post ${id}`), ...extra });
    const send = (posts: Record<string, unknown>[]): Promise<Response> =>
      Promise.resolve(
        app.request("/api/ingest", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId, posts, visitId: "v053" }),
        }),
      );
    expect((await send([post("s053a", { capture: "api" })])).status).toBe(400);
    expect((await send([post("s053b", { structured: { priceVnd: 5, attributes: {} } })])).status).toBe(200);
    const [row] = await handle.db
      .select({ raw: schema.post.raw })
      .from(schema.post)
      .where(and(eq(schema.post.sourceId, sourceId), eq(schema.post.platformPostId, "s053b")));
    expect(row).toBeDefined();
    expect("structured" in (row!.raw as Record<string, unknown>)).toBe(false);
  });

  test("Same postId with different text -> updated:1, one PostRevision, editCount=1", async () => {
    const app = createApp(handle, boss);
    await app.request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, posts: [rawPost("edit1", "original text")], visitId: "v1" }),
    });

    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, posts: [rawPost("edit1", "edited text")], visitId: "v2" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0, duplicates: 0, updated: 1 });

    const [post] = await handle.db
      .select()
      .from(schema.post)
      .where(and(eq(schema.post.sourceId, sourceId), eq(schema.post.platformPostId, "edit1")));
    expect(post?.editCount).toBe(1);
    expect(post?.text).toBe("edited text");

    const revisions = await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, post!.id));
    expect(revisions.length).toBe(1);
    expect(revisions[0]?.text).toBe("original text");
  });

  test("Key not assigned to source -> 403, nothing stored", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: otherSourceId, posts: [rawPost("forbidden", "text")], visitId: "v1" }),
    });
    expect(res.status).toBe(403);

    const rows = await handle.db.select().from(schema.post).where(eq(schema.post.sourceId, otherSourceId));
    expect(rows.length).toBe(0);
  });

  test("code-review finding #5: /api/ingest returns 503 (not a silent no-op) when the enrich queue is unavailable", async () => {
    const app = createApp(handle, undefined);
    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, posts: [rawPost("no-boss", "text")], visitId: "v-no-boss" }),
    });
    expect(res.status).toBe(503);

    const rows = await handle.db
      .select()
      .from(schema.post)
      .where(and(eq(schema.post.sourceId, sourceId), eq(schema.post.platformPostId, "no-boss")));
    expect(rows.length).toBe(0);
  });

  test("/api/health ok=false is stamp-only -> source stays active, no ops Notification row", async () => {
    const app = createApp(handle);

    const res1 = await app.request("/api/health", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, ok: false, reason: "wall", visitId: "v1" }),
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request("/api/health", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, ok: false, reason: "wall", visitId: "v2" }),
    });
    expect(res2.status).toBe(200);

    const [source] = await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId));
    // Pause/alerts moved to the visit ledger; /api/health only stamps last_health_at.
    expect(source?.status).toBe("active");

    const opsRows = await handle.db.select().from(schema.notification).where(eq(schema.notification.userId, operatorUserId));
    expect(opsRows.length).toBe(0);
  });

  test("Ingest with uuid visitId tags posts and stubs a visit row; non-uuid visitId leaves visit_id null", async () => {
    const app = createApp(handle, boss);
    const visitId = crypto.randomUUID();
    const posts = [rawPost("visit-p1", "hello visit 1"), rawPost("visit-p2", "hello visit 2"), rawPost("visit-p3", "hello visit 3")];

    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, posts, visitId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 3, duplicates: 0, updated: 0 });

    const tagged = await handle.db
      .select()
      .from(schema.post)
      .where(and(eq(schema.post.sourceId, sourceId), eq(schema.post.platformPostId, "visit-p1")));
    expect(tagged[0]?.visitId).toBe(visitId);

    const [visitRow] = await handle.db.select().from(schema.visit).where(eq(schema.visit.id, visitId));
    expect(visitRow?.sourceId).toBe(sourceId);
    expect(visitRow?.outcome).toBeNull();

    // A later POST /api/visits for the same id completes the stub row.
    const finishRes = await app.request("/api/visits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: visitId, sourceId, finishedAt: new Date().toISOString(), outcome: "ok" }),
    });
    expect(finishRes.status).toBe(200);
    const [completed] = await handle.db.select().from(schema.visit).where(eq(schema.visit.id, visitId));
    expect(completed?.outcome).toBe("ok");
    expect(completed?.sourceId).toBe(sourceId);

    // Non-uuid visitId (legacy client) -> ingests fine, visit_id stays null.
    const legacyRes = await app.request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, posts: [rawPost("legacy-p1", "legacy")], visitId: "legacy-not-a-uuid" }),
    });
    expect(legacyRes.status).toBe(200);
    const [legacyPost] = await handle.db
      .select()
      .from(schema.post)
      .where(and(eq(schema.post.sourceId, sourceId), eq(schema.post.platformPostId, "legacy-p1")));
    expect(legacyPost?.visitId).toBeNull();

    await handle.db.delete(schema.visit).where(eq(schema.visit.id, visitId));
  });
});
