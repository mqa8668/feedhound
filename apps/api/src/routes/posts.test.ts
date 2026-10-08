import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("posts.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);

interface Detail {
  post: Record<string, unknown> & { id: string; capture: string | null };
  source: { id: string; name: string };
  revisions: { id: string; text: string }[];
  enrichment: { category: { name: string } | null; item: { name: string } | null } | null;
  matches: { watchId: string; watchName: string; createdAt: string }[];
  duplicates: { id: string; sourceName: string }[];
  pipeline?: Record<string, unknown>;
}

// GET /api/posts/:id .
describe.skipIf(!canRun)("GET /api/posts/:id", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let team1: string;
  let team2: string;
  let source1: string;
  let source1b: string;
  let source2: string;
  let categoryId: string;
  const emails = { op: `pd-op-${RUN}@example.com`, h1: `pd-h1-${RUN}@example.com`, h2: `pd-h2-${RUN}@example.com`, t2: `pd-t2-${RUN}@example.com` };
  let h1Id: string;
  let h2Id: string;
  let postP: string;
  let postQ: string;
  let postR: string;
  let postS: string;
  let postEmpty: string;
  let w1: string;
  let w2: string;

  async function get(id: string, email?: string): Promise<Response> {
    return createApp(handle).request(`/api/posts/${id}`, email ? { headers: { "X-Dev-User": email } } : {});
  }

  async function mkSource(teamId: string, name: string): Promise<string> {
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `pd-${name}-${RUN}`, name, url: `https://feeds.example.test/pd-${name}-${RUN}` })
      .returning({ id: schema.source.id });
    return s!.id;
  }

  async function mkPost(sourceId: string, key: string, extra: Partial<typeof schema.post.$inferInsert> = {}): Promise<string> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: `${key}-${RUN}`, url: `https://feeds.example.test/g/posts/${key}-${RUN}`, text: `text ${key}`, ...extra })
      .returning({ id: schema.post.id });
    return p!.id;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const teams = await handle.db
      .insert(schema.team)
      .values([{ name: `pd-1-${RUN}` }, { name: `pd-2-${RUN}` }])
      .returning({ id: schema.team.id });
    team1 = teams[0]!.id;
    team2 = teams[1]!.id;
    const users = await handle.db
      .insert(schema.user)
      .values([
        { teamId: team1, email: emails.op, role: "operator" },
        { teamId: team1, email: emails.h1, role: "hunter" },
        { teamId: team1, email: emails.h2, role: "hunter" },
        { teamId: team2, email: emails.t2, role: "hunter" },
      ])
      .returning({ id: schema.user.id, email: schema.user.email });
    h1Id = users.find((u) => u.email === emails.h1)!.id;
    h2Id = users.find((u) => u.email === emails.h2)!.id;
    source1 = await mkSource(team1, "alpha");
    source1b = await mkSource(team1, "beta");
    source2 = await mkSource(team2, "other");

    const fp = `fp-${RUN}`;
    postP = await mkPost(source1, "P", { capture: "api", fingerprint: fp, media: [{ type: "image", url: "https://x.test/a.jpg" }], editCount: 2, firstSeenAt: new Date(Date.UTC(2026, 0, 1)) });
    postQ = await mkPost(source1b, "Q", { fingerprint: fp, firstSeenAt: new Date(Date.UTC(2026, 0, 2)) });
    postR = await mkPost(source2, "R", { fingerprint: fp });
    postS = await mkPost(source1, "S");
    postEmpty = await mkPost(source1, "E");

    await handle.db.insert(schema.postRevision).values([
      { postId: postP, text: "second", seenAt: new Date(Date.UTC(2026, 0, 3)) },
      { postId: postP, text: "first", seenAt: new Date(Date.UTC(2026, 0, 2)) },
    ]);
    const [cat] = await handle.db
      .insert(schema.category)
      .values({ slug: `pd${RUN}`, name: `Cat ${RUN}`, path: `pd${RUN}` })
      .returning({ id: schema.category.id });
    categoryId = cat!.id;
    const [item] = await handle.db.insert(schema.catalogItem).values({ categoryId, name: `Item ${RUN}` }).returning({ id: schema.catalogItem.id });
    await handle.db.insert(schema.enrichment).values({ postId: postP, intent: "sell", priceVnd: 1000, categoryId, itemId: item!.id, engine: "rule", displayTitle: "Item title", sentiment: "neg", intentTags: ["complain", "ask"] });

    const watches = await handle.db
      .insert(schema.watch)
      .values([
        { userId: h1Id, name: "W1" },
        { userId: h2Id, name: "W2" },
      ])
      .returning({ id: schema.watch.id, name: schema.watch.name });
    w1 = watches.find((w) => w.name === "W1")!.id;
    w2 = watches.find((w) => w.name === "W2")!.id;
    await handle.db.insert(schema.match).values([
      { postId: postP, watchId: w1, score: 0.5, matchedTerms: ["a"], createdAt: new Date(Date.UTC(2026, 0, 5)) },
      { postId: postP, watchId: w2, score: 0.7, matchedTerms: ["b"], createdAt: new Date(Date.UTC(2026, 0, 6)) },
    ]);
  });

  afterAll(async () => {
    const postIds = (await handle.db.select({ id: schema.post.id }).from(schema.post).where(inArray(schema.post.sourceId, [source1, source1b, source2]))).map((p) => p.id);
    await handle.db.delete(schema.match).where(inArray(schema.match.postId, postIds));
    await handle.db.delete(schema.postRevision).where(inArray(schema.postRevision.postId, postIds));
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, postIds));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, postIds));
    await handle.db.delete(schema.catalogItem).where(eq(schema.catalogItem.categoryId, categoryId));
    await handle.db.delete(schema.category).where(eq(schema.category.id, categoryId));
    const userIds = (await handle.db.select({ id: schema.user.id }).from(schema.user).where(inArray(schema.user.teamId, [team1, team2]))).map((u) => u.id);
    await handle.db.delete(schema.watch).where(inArray(schema.watch.userId, userIds));
    await handle.db.delete(schema.user).where(inArray(schema.user.teamId, [team1, team2]));
    await handle.db.delete(schema.source).where(inArray(schema.source.teamId, [team1, team2]));
    await handle.db.delete(schema.team).where(inArray(schema.team.id, [team1, team2]));
    await handle.close();
  });

  test("operator sees full detail incl. raw and pipeline, no internals", async () => {
    const res = await get(postP, emails.op);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Detail;
    expect(body.revisions.map((r) => r.text)).toEqual(["first", "second"]);
    expect(body.enrichment?.category?.name).toBe(`Cat ${RUN}`);
    expect(body.enrichment?.item?.name).toBe(`Item ${RUN}`);
    expect((body.enrichment as { sentiment?: string; intentTags?: string[] } | null)?.sentiment).toBe("neg");
    expect((body.enrichment as { intentTags?: string[] } | null)?.intentTags).toEqual(["complain", "ask"]);
    expect((body.enrichment as { displayTitle?: string | null } | null)?.displayTitle).toBe("Item title");
    expect(body.post.capture).toBe("api");
    expect("raw" in body.post).toBe(false); // Raw never reaches the browser
    expect("authorId" in body.post).toBe(false);
    expect(body.pipeline).toBeDefined();
    for (const k of ["tsv", "textNormalized", "visitId"]) {
      expect(k in body.post).toBe(false);
      expect(k in body).toBe(false);
    }
  });

  test("hunter response lacks raw and pipeline, rest equal", async () => {
    const op = (await (await get(postP, emails.op)).json()) as Detail;
    const hunter = (await (await get(postP, emails.h1)).json()) as Detail;
    expect("raw" in hunter.post).toBe(false);
    expect("pipeline" in hunter).toBe(false);
    const opPost = { ...op.post };
    delete opPost.raw;
    expect(hunter.post).toEqual(opPost);
    expect(hunter.revisions).toEqual(op.revisions);
    expect(hunter.enrichment).toEqual(op.enrichment);
    expect(hunter.duplicates).toEqual(op.duplicates);
  });

  test("matches are scoped to readable watches, createdAt desc", async () => {
    const h1 = (await (await get(postP, emails.h1)).json()) as Detail;
    expect(h1.matches.map((m) => [m.watchId, m.watchName])).toEqual([[w1, "W1"]]);
    const op = (await (await get(postP, emails.op)).json()) as Detail;
    expect(op.matches.map((m) => m.watchId)).toEqual([w2, w1]);
  });

  test("other team 404, unknown 404, bad id 400, no session 401", async () => {
    const other = await get(postR, emails.h1);
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error: string }).error).toBe("not_found");
    expect((await get(crypto.randomUUID(), emails.h1)).status).toBe(404);
    const bad = await get("abc", emails.h1);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("validation");
    expect((await get(postP)).status).toBe(401);
  });

  test("duplicates = same-team same-fingerprint posts only; null fingerprint = []", async () => {
    const body = (await (await get(postP, emails.h1)).json()) as Detail;
    expect(body.duplicates.map((d) => [d.id, d.sourceName])).toEqual([[postQ, "beta"]]);
    const s = (await (await get(postS, emails.h1)).json()) as Detail;
    expect(s.duplicates).toEqual([]);
  });

  test("bare post: enrichment null and empty arrays", async () => {
    const res = await get(postEmpty, emails.h1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Detail;
    expect(body.enrichment).toBeNull();
    expect(body.revisions).toEqual([]);
    expect(body.matches).toEqual([]);
    expect(body.duplicates).toEqual([]);
  });
});

// Snippet + priceSuspect on the feed rows.
describe.skipIf(!canRun)("GET /api/posts snippet and priceSuspect", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const email = `pf-${RUN}@example.com`;
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    const [t] = await handle.db.insert(schema.team).values({ name: `pf-${RUN}` }).returning({ id: schema.team.id });
    teamId = t!.id;
    await handle.db.insert(schema.user).values({ teamId, email, role: "hunter" });
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `pf-${RUN}`, name: "pf", url: `https://feeds.example.test/pf-${RUN}` })
      .returning({ id: schema.source.id });
    sourceId = s!.id;
    const specs: [string, string][] = [
      ["multi", "\n  \nFirst  line\nsecond"],
      ["long", "y".repeat(300)],
      ["blank", "  \n "],
      ["suspect", "x"],
      ["fine", "x"],
    ];
    for (const [key, textNormalized] of specs) {
      const [p] = await handle.db
        .insert(schema.post)
        .values({ sourceId, platformPostId: `${key}-${RUN}`, url: `https://feeds.example.test/g/posts/${key}-${RUN}`, textNormalized })
        .returning({ id: schema.post.id });
      ids[key] = p!.id;
    }
    await handle.db.insert(schema.enrichment).values({ postId: ids.suspect!, intent: "sell", priceVnd: null, priceRaw: "982.990.099", engine: "rule" });
    await handle.db.insert(schema.enrichment).values({ postId: ids.fine!, intent: "sell", priceVnd: 5000000, priceRaw: "5tr", engine: "rule", displayTitle: "Toyota Vios 2016 · MT" });
  });

  afterAll(async () => {
    const postIds = Object.values(ids);
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, postIds));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, postIds));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("snippet and priceSuspect per row", async () => {
    const res = await createApp(handle).request("/api/posts?limit=100", { headers: { "X-Dev-User": email } });
    expect(res.status).toBe(200);
    const { posts } = (await res.json()) as { posts: { id: string; snippet: string | null; priceSuspect: boolean; displayTitle: string | null }[] };
    const by = (k: string) => posts.find((p) => p.id === ids[k]);
    expect(by("multi")?.snippet).toBe("First line");
    const long = by("long")?.snippet ?? "";
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
    expect(by("blank")?.snippet).toBeNull();
    expect(by("suspect")?.priceSuspect).toBe(true);
    expect(by("fine")?.priceSuspect).toBe(false);
    expect(by("multi")?.priceSuspect).toBe(false);
    // displayTitle = enrichment title, else the post title, else the snippet
    expect(by("fine")?.displayTitle).toBe("Toyota Vios 2016 · MT");
    expect(by("multi")?.displayTitle).toBe("First line");
    expect(by("suspect")?.displayTitle).toBe(by("suspect")?.snippet ?? null);
    expect(Object.keys(by("multi") ?? {})).not.toContain("textNormalized");
  });
});

// ListingFields on the feed + the new filters.
describe.skipIf(!canRun)("GET /api/posts listing fields and filters", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let carPost: string;
  let otherPost: string;
  const email = `lf-h1-${RUN}@example.com`;
  const otherEmail = `lf-h2-${RUN}@example.com`;
  let userId: string;

  async function feed(query: string, as = email): Promise<{ posts: Record<string, unknown>[] }> {
    const res = await createApp(handle).request(`/api/posts?${query}`, { headers: { "X-Dev-User": as } });
    expect(res.status).toBe(200);
    return (await res.json()) as { posts: Record<string, unknown>[] };
  }
  const ids = (r: { posts: Record<string, unknown>[] }): string[] => r.posts.map((p) => p.id as string);

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [t] = await handle.db.insert(schema.team).values({ name: `lf-${RUN}` }).returning({ id: schema.team.id });
    teamId = t!.id;
    const users = await handle.db
      .insert(schema.user)
      .values([
        { teamId, email, role: "hunter" },
        { teamId, email: otherEmail, role: "hunter" },
      ])
      .returning({ id: schema.user.id, email: schema.user.email });
    userId = users.find((u) => u.email === email)!.id;
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `lf-${RUN}`, name: "lf", url: `https://feeds.example.test/lf-${RUN}` })
      .returning({ id: schema.source.id });
    sourceId = s!.id;
    const now = Date.now();
    const [car, other] = await handle.db
      .insert(schema.post)
      .values([
        { sourceId, platformPostId: `car-${RUN}`, url: "https://feeds.example.test/lf/posts/1", title: "ban xe", text: "Ban Santafe 2019 lh 0912.345.678", textNormalized: "ban santafe 2019 lh 0912.345.678", thumbState: "ok", firstSeenAt: new Date(now) },
        { sourceId, platformPostId: `oth-${RUN}`, url: "https://feeds.example.test/lf/posts/2", text: "tim mua xe", textNormalized: "tim mua xe", firstSeenAt: new Date(now - 1000) },
      ])
      .returning({ id: schema.post.id });
    carPost = car!.id;
    otherPost = other!.id;
    await handle.db.insert(schema.enrichment).values([
      {
        postId: carPost,
        intent: "sell",
        priceVnd: 680_000_000,
        engine: "rule",
        displayTitle: "Hyundai Santafe 2019 · 62.000 km",
        attributes: { make: "Hyundai", model: "Santafe", year: 2019, odo_km: 62000, region: "hcm" },
        dealPct: -8.4,
      },
      { postId: otherPost, intent: "other", priceVnd: 900_000_000, engine: "rule", attributes: { make: "Kia" } },
    ]);
    const [w] = await handle.db.insert(schema.watch).values({ userId, name: `lf-w-${RUN}` }).returning({ id: schema.watch.id });
    await handle.db.insert(schema.match).values({ postId: carPost, watchId: w!.id, score: 1, matchedTerms: ["x"] });
  });

  afterAll(async () => {
    await handle.db.delete(schema.match).where(eq(schema.match.postId, carPost));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, [carPost, otherPost]));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("row carries ListingFields", async () => {
    const row = (await feed("")).posts.find((p) => p.id === carPost)!;
    expect(row.displayTitle).toBe("Hyundai Santafe 2019 · 62.000 km");
    expect(row.thumbUrl).toBe(`/api/media/${carPost}/thumb`);
    expect(row.hasPhone).toBe(true);
    expect(row.dealPct as number).toBeCloseTo(-8.4, 5);
    expect(row.region).toBe("hcm");
    expect(row.attributes).toMatchObject({ make: "Hyundai", year: 2019 });
    expect(row.saved).toBe(false);
    expect(row.alsoIn).toEqual([]);
    expect((await feed("")).posts.find((p) => p.id === otherPost)!.thumbUrl).toBeNull();
  });

  test("filters", async () => {
    expect(ids(await feed("make=hyundai&priceMax=700000000&hideOther=1"))).toEqual([carPost]);
    expect(ids(await feed("make=hyundai&priceMax=600000000"))).toEqual([]);
    expect(ids(await feed("priceMin=700000000"))).toEqual([otherPost]);
    expect(ids(await feed("region=hcm"))).toEqual([carPost]);
    expect(ids(await feed("hideOther=1"))).toEqual([carPost]);
    expect(ids(await feed("matched=1"))).toEqual([carPost]);
    expect(ids(await feed("matched=1", otherEmail))).toEqual([]);
    expect(ids(await feed("saved=1"))).toEqual([]);
    const bad = await createApp(handle).request("/api/posts?matched=2", { headers: { "X-Dev-User": email } });
    expect(bad.status).toBe(400);
  });
});
