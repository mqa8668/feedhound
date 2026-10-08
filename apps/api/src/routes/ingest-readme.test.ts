// Mirrors the README "Adding sources" curl: a key scoped to a source posts to /api/ingest, and the post then matches a watch.
import { compileWatch, type Watch } from "@feedhound/core/matcher";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { runMatchJob } from "../../../agent/src/jobs/match";
import { createApp } from "../index";
import { resetRateLimitState } from "../middleware/rate-limit";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe.skipIf(!TEST_DATABASE_URL)("README push ingest: curl -H 'Authorization: Bearer <key>' -d ... /api/ingest", () => {
  let handle: DbHandle;
  let boss: PgBoss;
  let teamId: string;
  let userId: string;
  let sourceId: string;
  let key: string;
  let watchId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL!);
    boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();
    await boss.createQueue("enrich");
    const [team] = await handle.db.insert(schema.team).values({ name: `readme-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `readme-${crypto.randomUUID()}@example.com`, role: "operator" }).returning({ id: schema.user.id });
    userId = user!.id;
    key = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const [apiKey] = await handle.db
      .insert(schema.apiKey)
      .values({ userId, name: "readme", prefix: key.slice(0, 8), hash: await sha256Hex(key), scopes: ["ingest"] })
      .returning({ id: schema.apiKey.id });
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `readme-${crypto.randomUUID()}`, name: "Pushed source", url: "https://example.com/pushed", assignedKeyId: apiKey!.id })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
    watchId = crypto.randomUUID();
  });

  afterAll(async () => {
    const posts = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId));
    for (const p of posts) {
      await handle.sql`delete from pgboss.job where name = 'enrich' and data->>'postId' = ${p.id}`;
      await handle.db.delete(schema.postRevision).where(eq(schema.postRevision.postId, p.id));
    }
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await boss.stop({ graceful: false });
    await handle.close();
  });

  test("the key ingests a post for its source and the post matches a watch include term", async () => {
    resetRateLimitState();
    const watch: Watch = {
      id: watchId, userId, name: "readme", enabled: true, include: ["mechanical keyboard"], includeAll: [], exclude: [], regex: null,
      categoryIds: [], itemIds: [], priceMin: null, priceMax: null, intents: [], sourceIds: [], notifierIds: [],
      quietHours: null, mutedUntil: null, createdAt: new Date().toISOString(),
    };
    await handle.db.insert(schema.watch).values({ ...watch, mutedUntil: null, createdAt: new Date() });

    const res = await createApp(handle, boss).request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId,
        visitId: "readme-1",
        posts: [{ platformPostId: "kb-1", url: "https://example.com/posts/kb-1", text: "Selling a Mechanical Keyboard, barely used", media: [], capturedAt: new Date().toISOString() }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, duplicates: 0, updated: 0 });

    const [post] = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId));
    const sent: unknown[] = [];
    const fakeBoss = { send: async (...args: unknown[]) => (sent.push(args), null) } as unknown as PgBoss;
    await runMatchJob({ handle, boss: fakeBoss, watchIndex: { getForTeam: () => [compileWatch(watch, new Map())] }, postId: post!.id, trigger: "ingest" });
    const matches = await handle.db.select().from(schema.match).where(eq(schema.match.postId, post!.id));
    expect(matches.map((m) => m.watchId)).toEqual([watchId]);
  });

  test("a key cannot ingest for a source it is not assigned to", async () => {
    resetRateLimitState();
    const res = await createApp(handle, boss).request("/api/ingest", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: crypto.randomUUID(), visitId: "x", posts: [] }),
    });
    expect(res.status).toBe(403);
  });
});
