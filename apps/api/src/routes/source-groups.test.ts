import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { runSourceClassify } from "../../../agent/src/jobs/source-classify";
import { createApp, type ApiApp } from "../index";
import { sourceGroupsRoute } from "./source-groups";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);
if (!canRun) console.warn("source-groups.test.ts: skipped — TEST_DATABASE_URL is unset");

const RUN = crypto.randomUUID().slice(0, 8);

interface LeafDto {
  id: string;
  topic: { key: string; categoryId: string | null; method: string; share: number | null };
  region: { key: string; label: string; method: string };
  sampleN: number;
  override: { topicCategoryId: string | null; region: string | null };
  relevance7d: { posts: number };
}
interface TreeDto {
  rollup: { sources: number };
  platforms: { key: string; rollup: { sources: number }; topics: { key: string; rollup: { sources: number }; regions: { key: string; rollup: { sources: number }; sources: LeafDto[] }[] }[] }[];
}

describe.skipIf(!canRun)("source-groups API", () => {
  let handle: DbHandle;
  let app: ApiApp;
  let teamA: string;
  let teamB: string;
  let cats: { root: string; cars: string; phones: string };
  let srcA: string;
  let srcB: string;
  const email = { op: `sg-op-${RUN}@example.com`, hunter: `sg-hunter-${RUN}@example.com`, other: `sg-other-${RUN}@example.com` };
  const sources: string[] = [];

  const call = (method: string, path: string, who: string, body?: unknown) =>
    app.request(path, { method, headers: { "X-Dev-User": who, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const tree = async (who: string): Promise<TreeDto> => (await call("GET", "/api/source-groups/tree", who)).json() as Promise<TreeDto>;
  const leafOf = (t: TreeDto, id: string): LeafDto | undefined =>
    t.platforms.flatMap((p) => p.topics.flatMap((tp) => tp.regions.flatMap((r) => r.sources))).find((l) => l.id === id);

  async function seedSource(teamId: string, key: string): Promise<string> {
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `${key}-${RUN}`, name: `sg ${key}`, url: `https://feeds.example.test/${key}-${RUN}` })
      .returning({ id: schema.source.id });
    sources.push(s!.id);
    return s!.id;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    const teams = await handle.db.insert(schema.team).values([{ name: `sg-a-${RUN}` }, { name: `sg-b-${RUN}` }]).returning({ id: schema.team.id });
    teamA = teams[0]!.id;
    teamB = teams[1]!.id;
    await handle.db.insert(schema.user).values([
      { teamId: teamA, email: email.op, role: "operator" },
      { teamId: teamA, email: email.hunter, role: "hunter" },
      { teamId: teamB, email: email.other, role: "operator" },
    ]);
    const regionDef = { key: "region", label: "Region", kind: "enum", keyAttr: false, values: ["hcm", "ha_noi"], aliases: [{ value: "hcm", label: "TP.HCM", match: ["hcm"] }] };
    const [root] = await handle.db
      .insert(schema.category)
      .values({ slug: `sg${RUN}`, name: `sg${RUN}`, path: `sg${RUN}`, attributeSchema: [regionDef] })
      .returning({ id: schema.category.id });
    const [cars] = await handle.db.insert(schema.category).values({ slug: `sgcars${RUN}`, name: "Cars", path: `sg${RUN}.cars`, parentId: root!.id }).returning({ id: schema.category.id });
    const [phones] = await handle.db.insert(schema.category).values({ slug: `sgph${RUN}`, name: "Phones", path: `sg${RUN}.phones`, parentId: root!.id }).returning({ id: schema.category.id });
    cats = { root: root!.id, cars: cars!.id, phones: phones!.id };
    srcA = await seedSource(teamA, "a");
    srcB = await seedSource(teamB, "b");
    for (let i = 0; i < 22; i++) {
      const [p] = await handle.db
        .insert(schema.post)
        .values({ sourceId: srcA, platformPostId: `sg-${RUN}-${i}`, url: `https://feeds.example.test/g/posts/sg-${RUN}-${i}`, firstSeenAt: new Date() })
        .returning({ id: schema.post.id });
      await handle.db.insert(schema.enrichment).values({ postId: p!.id, categoryId: cats.cars, attributes: { region: "hcm" }, engine: "rule" });
    }
    app = createApp(handle);
  });

  afterAll(async () => {
    if (!handle) return;
    const posts = await handle.db.select({ id: schema.post.id }).from(schema.post).where(inArray(schema.post.sourceId, sources));
    const postIds = posts.map((p) => p.id);
    if (postIds.length) {
      await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, postIds));
      await handle.db.delete(schema.post).where(inArray(schema.post.id, postIds));
    }
    await handle.db.delete(schema.sourceGroup).where(inArray(schema.sourceGroup.sourceId, sources));
    await handle.db.delete(schema.source).where(inArray(schema.source.id, sources));
    await handle.db.delete(schema.user).where(inArray(schema.user.email, Object.values(email)));
    await handle.db.delete(schema.category).where(inArray(schema.category.id, [cats.cars, cats.phones, cats.root]));
    await handle.db.delete(schema.team).where(inArray(schema.team.id, [teamA, teamB]));
    await handle.close();
  });

  describe("wiring (real job -> real app)", () => {
    test("Classify then tree puts the source under web / cars / hcm", async () => {
      await runSourceClassify(handle, { now: new Date(), teamId: teamA });
      const t = await tree(email.op);
      const pf = t.platforms.find((p) => p.key === "web")!;
      const topic = pf.topics.find((x) => x.key === cats.cars)!;
      const region = topic.regions.find((r) => r.key === "hcm")!;
      const leaf = region.sources.find((l) => l.id === srcA)!;
      expect(leaf.topic.method).toBe("auto");
      expect(leaf.region.method).toBe("auto");
      expect(leaf.region.label).toBe("TP.HCM");
      expect(leaf.sampleN).toBe(22);
      expect(leaf.relevance7d.posts).toBe(22);
      expect(region.rollup.sources).toBeGreaterThanOrEqual(1);
      expect(topic.rollup.sources).toBeGreaterThanOrEqual(region.rollup.sources);
      expect(pf.rollup.sources).toBeGreaterThanOrEqual(topic.rollup.sources);
      expect(t.rollup.sources).toBe(1); // team A has exactly one source
    });
  });

  test("Override wins, survives a rerun, DELETE restores auto", async () => {
    const res = await call("PUT", `/api/source-groups/${srcA}/override`, email.op, { topicCategoryId: cats.phones });
    expect(res.status).toBe(200);
    const leaf = (await res.json()) as LeafDto;
    expect([leaf.topic.key, leaf.topic.method, leaf.region.key, leaf.region.method]).toEqual([cats.phones, "override", "hcm", "auto"]);
    await runSourceClassify(handle, { now: new Date(Date.now() + 1000), teamId: teamA });
    const after = leafOf(await tree(email.op), srcA)!;
    expect([after.topic.key, after.topic.method, after.override.topicCategoryId]).toEqual([cats.phones, "override", cats.phones]);
    const [row] = await handle.db.select().from(schema.sourceGroup).where(inArray(schema.sourceGroup.sourceId, [srcA]));
    expect(row!.autoTopicCategoryId).toBe(cats.cars);
    // absent key unchanged, null clears
    const region = await call("PUT", `/api/source-groups/${srcA}/override`, email.op, { region: "ha_noi" });
    expect(((await region.json()) as LeafDto).region.method).toBe("override");
    const cleared = await call("PUT", `/api/source-groups/${srcA}/override`, email.op, { region: null });
    const clearedLeaf = (await cleared.json()) as LeafDto;
    expect([clearedLeaf.region.method, clearedLeaf.topic.method]).toEqual(["auto", "override"]);
    expect((await call("DELETE", `/api/source-groups/${srcA}/override`, email.op)).status).toBe(204);
    const restored = leafOf(await tree(email.op), srcA)!;
    expect([restored.topic.key, restored.topic.method]).toEqual([cats.cars, "auto"]);
  });

  test("Roles, validation, team scoping", async () => {
    const put = (who: string, id: string, body: unknown) => call("PUT", `/api/source-groups/${id}/override`, who, body);
    expect((await put(email.hunter, srcA, { region: "hcm" })).status).toBe(403);
    expect((await call("DELETE", `/api/source-groups/${srcA}/override`, email.hunter)).status).toBe(403);
    expect((await call("POST", "/api/source-groups/reclassify", email.hunter)).status).toBe(403);
    expect((await call("GET", "/api/source-groups/tree", email.hunter)).status).toBe(200);

    const badCat = await put(email.op, srcA, { topicCategoryId: crypto.randomUUID() });
    expect(badCat.status).toBe(422);
    expect(((await badCat.json()) as { field: string }).field).toBe("topicCategoryId");
    const badRegion = await put(email.op, srcA, { region: "atlantis" });
    expect(badRegion.status).toBe(422);
    expect(((await badRegion.json()) as { field: string }).field).toBe("region");
    expect((await put(email.op, srcB, { region: "hcm" })).status).toBe(404);
    expect((await call("DELETE", `/api/source-groups/${srcB}/override`, email.op)).status).toBe(404);

    const t = await tree(email.op);
    expect(leafOf(t, srcB)).toBeUndefined();
    expect(leafOf(await tree(email.other), srcA)).toBeUndefined();
  });

  test("reclassify enqueues a singleton job (202); 503 without a queue", async () => {
    const sent: { name: string; data: object; opts?: Record<string, unknown> }[] = [];
    const withBoss = sourceGroupsRoute(handle, { send: async (name, data, opts) => (sent.push({ name, data, opts }), "job-1") });
    const res = await withBoss.request("/api/source-groups/reclassify", { method: "POST", headers: { "X-Dev-User": email.op } });
    expect(res.status).toBe(202);
    expect(sent[0]!.name).toBe("source_classify");
    expect(typeof sent[0]!.opts?.singletonKey).toBe("string");
    expect((await call("POST", "/api/source-groups/reclassify", email.op)).status).toBe(503);
  });

  test("10 reclassify POSTs against a real default-policy queue leave exactly 1 queued job", async () => {
    const boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();
    try {
      const queue = `source_classify`;
      await boss.createQueue(queue);
      await boss.deleteAllJobs(queue);
      const route = sourceGroupsRoute(handle, boss);
      for (let i = 0; i < 10; i++) {
        const res = await route.request("/api/source-groups/reclassify", { method: "POST", headers: { "X-Dev-User": email.op } });
        expect(res.status).toBe(202);
      }
      // queuedCount is a cached monitoring stat (pg-boss 12); count the real job rows instead.
      const rows = await boss.getDb().executeSql("select count(*)::int as n from pgboss.job where name = $1 and state = 'created'", [queue]);
      expect((rows.rows[0] as { n: number }).n).toBe(1);
      await boss.deleteAllJobs(queue);
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  test("A failed health result older than 12 h is stale, a fresh one is down", async () => {
    const setHealth = (hoursAgo: number) =>
      handle.db.update(schema.source).set({ health: { ok: false, reason: "blocked" }, lastHealthAt: new Date(Date.now() - hoursAgo * 3_600_000) }).where(eq(schema.source.id, srcA));
    await setHealth(20);
    expect((leafOf(await tree(email.op), srcA) as { health?: string } | undefined)?.health).toBe("stale");
    await setHealth(1);
    expect((leafOf(await tree(email.op), srcA) as { health?: string } | undefined)?.health).toBe("down");
    await handle.db.update(schema.source).set({ health: {}, lastHealthAt: null }).where(eq(schema.source.id, srcA));
  });

  test("tree response carries minPosts and the taxonomy regionOptions", async () => {
    const t = (await (await call("GET", "/api/source-groups/tree", email.op)).json()) as { minPosts: number; regionOptions: string[] };
    expect(typeof t.minPosts).toBe("number");
    expect(Array.isArray(t.regionOptions)).toBe(true);
  });
});
