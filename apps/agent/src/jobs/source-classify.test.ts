// RunSourceClassify against the test DB.
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { runSourceClassify } from "./source-classify";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);
if (!canRun) console.warn("source-classify.test.ts: skipped — TEST_DATABASE_URL is unset");

const RUN = crypto.randomUUID().slice(0, 8);

describe.skipIf(!canRun)("runSourceClassify", () => {
  let handle: DbHandle;
  let teamA: string;
  let teamB: string;
  let catIds: { root: string; cars: string; sedan: string; phones: string };
  const sources: string[] = [];

  async function seedPosts(sourceId: string, n: number, categoryId: string, region: string | null, tag: string) {
    for (let i = 0; i < n; i++) {
      const [p] = await handle.db
        .insert(schema.post)
        .values({ sourceId, platformPostId: `${tag}-${RUN}-${i}`, url: `https://feeds.example.test/g/posts/${tag}-${RUN}-${i}`, firstSeenAt: new Date() })
        .returning({ id: schema.post.id });
      await handle.db.insert(schema.enrichment).values({ postId: p!.id, categoryId, attributes: region ? { region } : {}, engine: "rule" });
    }
  }
  async function seedSource(teamId: string, key: string): Promise<string> {
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `${key}-${RUN}`, name: `src ${key}`, url: `https://feeds.example.test/${key}-${RUN}` })
      .returning({ id: schema.source.id });
    sources.push(s!.id);
    return s!.id;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const teams = await handle.db.insert(schema.team).values([{ name: `sc-a-${RUN}` }, { name: `sc-b-${RUN}` }]).returning({ id: schema.team.id });
    teamA = teams[0]!.id;
    teamB = teams[1]!.id;
    const ins = async (slug: string, path: string, parentId: string | null) => {
      const [c] = await handle.db.insert(schema.category).values({ slug, name: slug, path, parentId }).returning({ id: schema.category.id });
      return c!.id;
    };
    const root = await ins(`sc${RUN}`, `sc${RUN}`, null);
    const cars = await ins(`cars${RUN}`, `sc${RUN}.cars`, root);
    const sedan = await ins(`sedan${RUN}`, `sc${RUN}.cars.sedan`, cars);
    const phones = await ins(`phones${RUN}`, `sc${RUN}.phones`, root);
    catIds = { root, cars, sedan, phones };
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
    await handle.db.delete(schema.category).where(inArray(schema.category.id, Object.values(catIds)));
    await handle.db.delete(schema.team).where(inArray(schema.team.id, [teamA, teamB]));
    await handle.close();
  });

  test("One row per source incl. zero-post, idempotent, classified_at advances, other team untouched by scoping", async () => {
    const s1 = await seedSource(teamA, "s1");
    const s2 = await seedSource(teamA, "s2");
    const s3 = await seedSource(teamA, "s3");
    const sb = await seedSource(teamB, "sb");
    // S1: 22 posts in a depth-3 category (lifted to `cars`), all hcm.
    await seedPosts(s1, 22, catIds.sedan, "hcm", "s1");
    // S2: 5 posts only -> insufficient; source defaults must apply.
    await seedPosts(s2, 5, catIds.phones, null, "s2");
    await handle.db.update(schema.source).set({ defaults: { categoryId: catIds.phones, region: "ha_noi" } }).where(eq(schema.source.id, s2));
    await seedPosts(sb, 1, catIds.cars, null, "sb");

    // posts were first seen "now" (real clock), so the window must contain them: run at real now.
    await runSourceClassify(handle, { now: new Date(), teamId: teamA });
    const read = async () => {
      const rows = await handle.db.select().from(schema.sourceGroup).where(inArray(schema.sourceGroup.sourceId, sources));
      return new Map(rows.map((r) => [r.sourceId, r]));
    };
    const first = await read();
    expect([...first.keys()].filter((k) => k !== sb).sort()).toEqual([s1, s2, s3].sort());
    expect(first.has(sb)).toBe(false); // teamId scoped run

    const r1 = first.get(s1)!;
    expect([r1.autoTopicCategoryId, r1.autoTopicMethod, r1.autoTopicShare, r1.autoRegion, r1.autoRegionMethod, r1.sampleN]).toEqual([catIds.cars, "auto", 1, "hcm", "auto", 22]);
    const r2 = first.get(s2)!;
    expect([r2.autoTopicCategoryId, r2.autoTopicMethod, r2.autoRegion, r2.autoRegionMethod, r2.sampleN]).toEqual([catIds.phones, "default", "ha_noi", "default", 5]);
    const r3 = first.get(s3)!;
    expect([r3.autoTopicCategoryId, r3.autoTopicMethod, r3.autoRegion, r3.autoRegionMethod, r3.sampleN]).toEqual([null, "insufficient", null, "none", 0]);

    await runSourceClassify(handle, { now: new Date(Date.now() + 1000) });
    const second = await read();
    expect(second.has(sb)).toBe(true); // unscoped run covers the other team too
    expect(second.get(sb)!.sampleN).toBe(1);
    for (const id of [s1, s2, s3]) {
      const a = first.get(id)!;
      const b = second.get(id)!;
      expect({ ...b, classifiedAt: null }).toEqual({ ...a, classifiedAt: null });
      expect(b.classifiedAt!.getTime()).toBeGreaterThan(a.classifiedAt!.getTime());
    }
  });
});
