import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("search.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);

interface Page {
  items: { id: string; title: string | null; snippet: string }[];
  nextCursor: string | null;
  total: number;
  totalIsExact: boolean;
  candidatesTruncated: boolean;
}

// search + save-as-watch.
describe.skipIf(!canRun)("GET /api/search, POST /api/search/watch", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const email = { h1: `se-h1-${RUN}@example.com`, h2: `se-h2-${RUN}@example.com` };
  let handle: DbHandle;
  let team1: string;
  let team2: string;
  let src1: string;
  let src2: string;
  let catId: string;
  let notifier1: string;
  let notifier2: string;

  const get = (path: string, who = email.h1): Response | Promise<Response> => createApp(handle).request(path, { headers: { "X-Dev-User": who } });
  const post = (path: string, body: unknown, who = email.h1): Response | Promise<Response> =>
    createApp(handle).request(path, { method: "POST", headers: { "X-Dev-User": who, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  async function mkPost(sourceId: string, key: string, text: string): Promise<void> {
    await handle.db.insert(schema.post).values({
      sourceId,
      platformPostId: `${key}-${RUN}`,
      url: `https://feeds.example.test/g/posts/${key}-${RUN}`,
      title: key,
      text,
      textNormalized: text.toLowerCase(),
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const teams = await handle.db
      .insert(schema.team)
      .values([{ name: `se1-${RUN}` }, { name: `se2-${RUN}` }])
      .returning({ id: schema.team.id });
    team1 = teams[0]!.id;
    team2 = teams[1]!.id;
    const users = await handle.db
      .insert(schema.user)
      .values([
        { teamId: team1, email: email.h1, role: "hunter" },
        { teamId: team2, email: email.h2, role: "hunter" },
      ])
      .returning({ id: schema.user.id, email: schema.user.email });
    const mkSrc = async (teamId: string, name: string): Promise<string> => {
      const [s] = await handle.db
        .insert(schema.source)
        .values({ teamId, kind: "web", platformId: `se-${name}-${RUN}`, name, url: `https://feeds.example.test/se-${name}-${RUN}` })
        .returning({ id: schema.source.id });
      return s!.id;
    };
    src1 = await mkSrc(team1, "one");
    src2 = await mkSrc(team2, "two");
    await mkPost(src1, "T1", "sharedword ip15 seal mine");
    await mkPost(src2, "T2", "sharedword ip15 other team");
    const [cat] = await handle.db.insert(schema.category).values({ slug: `se${RUN}`, name: "SE", path: `se${RUN}` }).returning({ id: schema.category.id });
    catId = cat!.id;
    const mkNotifier = async (userId: string): Promise<string> => {
      const [n] = await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: { chatId: "1" } }).returning({ id: schema.notifier.id });
      return n!.id;
    };
    notifier1 = await mkNotifier(users.find((u) => u.email === email.h1)!.id);
    notifier2 = await mkNotifier(users.find((u) => u.email === email.h2)!.id);
  });

  afterAll(async () => {
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, [src1, src2]));
    await handle.close();
  });

  test("Results are team-scoped; validation and cursor errors", async () => {
    const res = await get("/api/search?q=sharedword");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(body.items.map((i) => i.title)).toEqual(["T1"]);
    expect(body.total).toBe(1);
    expect(body.totalIsExact).toBe(true);
    expect(body.candidatesTruncated).toBe(false);
    expect(((await (await get("/api/search?q=sharedword", email.h2)).json()) as Page).items.map((i) => i.title)).toEqual(["T2"]);

    expect((await get("/api/search?limit=101")).status).toBe(400);
    expect(((await (await get("/api/search?limit=101")).json()) as { error: string }).error).toBe("validation");
    const badKeys = Buffer.from(JSON.stringify({ v: 1, h: "0123456789abcdef", at: "2026-10-05T00:00:00.000Z", total: 0, te: true, k: ["x", "y"] })).toString("base64url");
    expect((await get(`/api/search?cursor=${badKeys}`)).status).toBe(400);
    expect(((await (await get("/api/search?cursor=zzz")).json()) as { error: string }).error).toBe("invalid_cursor");
    expect((await createApp(handle).request("/api/search?q=x1")).status).toBe(401);
  });

  test("cursor from other params -> 400 cursor_params_mismatch", async () => {
    for (let i = 0; i < 3; i++) await mkPost(src1, `PG${i}`, `pagingword ${i}`);
    const first = (await (await get("/api/search?q=pagingword&limit=1")).json()) as Page;
    expect(first.nextCursor).not.toBeNull();
    const res = await get(`/api/search?q=pagingword&limit=1&intents=sell&cursor=${first.nextCursor}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("cursor_params_mismatch");
    const ok = (await (await get(`/api/search?q=pagingword&limit=1&cursor=${first.nextCursor}`)).json()) as Page;
    expect(ok.total).toBe(first.total);
    expect(ok.items[0]!.id).not.toBe(first.items[0]!.id);
  });

  test("Save-as-watch rejects a source outside the team; maps params", async () => {
    const bad = await post("/api/search/watch", { params: { q: "ip15", sourceIds: [src2] }, name: "x", notifierIds: [] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("validation");

    const res = await post("/api/search/watch", {
      params: { q: "ip15 -seal", categoryIds: [catId], priceMax: 20000000, author: "a3f2c1d0", sort: "newest" },
      name: `w-${RUN}`,
      notifierIds: [notifier1],
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { watchId: string; dropped: string[] };
    expect(out.dropped).toEqual(["author", "sort"]);
    const [w] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, out.watchId));
    expect(w).toMatchObject({ includeAll: ["ip15"], exclude: ["seal"], categoryIds: [catId], priceMax: 20000000, include: [], regex: null, enabled: true, notifierIds: [notifier1] });
    expect(w!.userId).not.toBe("");
    const [owner] = await handle.db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, w!.userId));
    expect(owner!.email).toBe(email.h1);
  });

  test("save-as-watch: foreign notifier and empty watch -> 400 validation", async () => {
    const foreign = await post("/api/search/watch", { params: { q: "ip15" }, name: "n", notifierIds: [notifier2] });
    expect(foreign.status).toBe(400);
    const empty = await post("/api/search/watch", { params: { q: "-seal" }, name: "n", notifierIds: [] });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe("validation");
  });
});
