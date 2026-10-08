import { repostKey } from "@feedhound/core/listing";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("post-flags.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

type FeedRow = { id: string; saved: boolean; alsoIn: { postId: string; sourceId: string; url: string }[]; repostKey: string | null };

// Repost grouping, hidden/saved flags.
describe.skipIf(!TEST_DATABASE_URL)("post flags + repost grouping", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const h1 = `pf-h1-${RUN}@example.com`;
  const h2 = `pf-h2-${RUN}@example.com`;
  const foreign = `pf-x-${RUN}@example.com`;
  let handle: DbHandle;
  let teamId: string;
  let team2: string;
  let sourceIds: string[] = [];
  let postIds: string[] = [];
  let foreignPost: string;
  const text = "Ban Santafe 2019 gia 680tr";

  async function call(method: string, path: string, as: string): Promise<Response> {
    return createApp(handle).request(path, { method, headers: { "X-Dev-User": as } });
  }
  async function feed(as: string, query = ""): Promise<FeedRow[]> {
    const res = await call("GET", `/api/posts?limit=100${query}`, as);
    expect(res.status).toBe(200);
    return ((await res.json()) as { posts: FeedRow[] }).posts.filter((p) => [...postIds].includes(p.id) || p.alsoIn.some((a) => postIds.includes(a.postId)));
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const teams = await handle.db
      .insert(schema.team)
      .values([{ name: `pf29-1-${RUN}` }, { name: `pf29-2-${RUN}` }])
      .returning({ id: schema.team.id });
    teamId = teams[0]!.id;
    team2 = teams[1]!.id;
    await handle.db.insert(schema.user).values([
      { teamId, email: h1, role: "hunter" },
      { teamId, email: h2, role: "hunter" },
      { teamId: team2, email: foreign, role: "hunter" },
    ]);
    const srcs = await handle.db
      .insert(schema.source)
      .values(["A", "B", "C"].map((n) => ({ teamId, kind: "web" as const, platformId: `pf29-${n}-${RUN}`, name: n, url: `https://feeds.example.test/${n}-${RUN}` })))
      .returning({ id: schema.source.id });
    sourceIds = srcs.map((s) => s.id);
    const [fs] = await handle.db
      .insert(schema.source)
      .values({ teamId: team2, kind: "web", platformId: `pf29-F-${RUN}`, name: "F", url: `https://feeds.example.test/F-${RUN}` })
      .returning({ id: schema.source.id });
    const key = repostKey({ authorId: "u1", text });
    const now = Date.now();
    const rows = await handle.db
      .insert(schema.post)
      .values(
        sourceIds.map((sourceId, i) => ({
          sourceId,
          platformPostId: `rp-${i}-${RUN}`,
          url: `https://feeds.example.test/g/posts/${i}`,
          authorId: "u1",
          text,
          textNormalized: text.toLowerCase(),
          repostKey: key,
          firstSeenAt: new Date(now - i * 1000),
        })),
      )
      .returning({ id: schema.post.id });
    postIds = rows.map((r) => r.id);
    const [fp] = await handle.db
      .insert(schema.post)
      .values({ sourceId: fs!.id, platformPostId: `fp-${RUN}`, url: "u", text, repostKey: key })
      .returning({ id: schema.post.id });
    foreignPost = fp!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.postUserFlag).where(inArray(schema.postUserFlag.postId, [...postIds, foreignPost]));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, [...postIds, foreignPost]));
    await handle.db.delete(schema.source).where(inArray(schema.source.teamId, [teamId, team2]));
    await handle.db.delete(schema.user).where(inArray(schema.user.teamId, [teamId, team2]));
    await handle.db.delete(schema.team).where(inArray(schema.team.id, [teamId, team2]));
    await handle.close();
  });

  test("three reposts collapse to one row with two alsoIn entries", async () => {
    const rows = await feed(h1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.alsoIn.length).toBe(2);
    expect(new Set([rows[0]!.id, ...rows[0]!.alsoIn.map((a) => a.postId)])).toEqual(new Set(postIds));
    expect(new Set(rows[0]!.alsoIn.map((a) => a.sourceId)).size).toBe(2);
  });

  test("hiding one copy hides all three for that user only", async () => {
    expect((await call("PUT", `/api/posts/${postIds[1]}/flags/hidden`, h1)).status).toBe(204);
    expect(await feed(h1)).toEqual([]);
    expect((await feed(h2)).length).toBe(1);
    expect((await call("DELETE", `/api/posts/${postIds[1]}/flags/hidden`, h1)).status).toBe(204);
    expect((await feed(h1)).length).toBe(1);
  });

  test("saved flag round-trips and drives saved=1", async () => {
    expect((await feed(h1, "&saved=1")).length).toBe(0);
    expect((await call("PUT", `/api/posts/${postIds[0]}/flags/saved`, h1)).status).toBe(204);
    expect((await call("PUT", `/api/posts/${postIds[0]}/flags/saved`, h1)).status).toBe(204); // idempotent
    const saved = await feed(h1, "&saved=1");
    expect(saved.length).toBe(1);
    expect(saved[0]!.saved).toBe(true);
    expect((await feed(h2))[0]!.saved).toBe(false);
    expect((await call("DELETE", `/api/posts/${postIds[0]}/flags/saved`, h1)).status).toBe(204);
    expect((await feed(h1, "&saved=1")).length).toBe(0);
    expect((await feed(h1))[0]!.saved).toBe(false);
  });

  test("another team's post is 404, bad kind/id is 400, no session is 401", async () => {
    expect((await call("PUT", `/api/posts/${foreignPost}/flags/hidden`, h1)).status).toBe(404);
    expect((await call("DELETE", `/api/posts/${foreignPost}/flags/saved`, h1)).status).toBe(404);
    expect((await call("PUT", `/api/posts/${postIds[0]}/flags/nope`, h1)).status).toBe(400);
    expect((await call("PUT", `/api/posts/not-a-uuid/flags/saved`, h1)).status).toBe(400);
    const anon = await createApp(handle).request(`/api/posts/${postIds[0]}/flags/saved`, { method: "PUT" });
    expect(anon.status).toBe(401);
    const rows = await handle.db.select().from(schema.postUserFlag).where(eq(schema.postUserFlag.postId, foreignPost));
    expect(rows).toEqual([]);
  });
});
