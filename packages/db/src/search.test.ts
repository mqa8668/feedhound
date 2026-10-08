import { searchParamsSchema, type SearchParams } from "@feedhound/core/search-query";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { corpusPosts } from "../../../tests/fixtures/corpus-posts";
import { createDb, schema, type DbHandle } from "./index";
import { searchPosts, type SearchHit, type SearchResult } from "./search";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("search.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);

// Corpus search against the migrated test DB.
describe.skipIf(!canRun)("searchPosts", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let team: string;
  let team2: string;
  let src: string;
  let src2: string;
  let bulkSrc: string;
  const ids: Record<string, string> = {};

  const params = (p: Partial<SearchParams>): SearchParams => searchParamsSchema.parse(p);
  async function run(p: Partial<SearchParams>, t = team): Promise<SearchHit[]> {
    const r = await searchPosts(handle, params(p), t);
    if (!r.ok) throw new Error(r.error);
    return r.page.items;
  }
  const texts = (hits: SearchHit[]): string[] => hits.map((h) => h.title ?? "");

  async function mkPost(sourceId: string, key: string, text: string): Promise<string> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `${key}-${RUN}`,
        url: `https://feeds.example.test/g/posts/${key}-${RUN}`,
        title: key,
        text,
        textNormalized: text.toLowerCase(),
      })
      .returning({ id: schema.post.id });
    return p!.id;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL!);
    const teams = await handle.db
      .insert(schema.team)
      .values([{ name: `s1-${RUN}` }, { name: `s2-${RUN}` }])
      .returning({ id: schema.team.id });
    team = teams[0]!.id;
    team2 = teams[1]!.id;
    const mkSrc = async (teamId: string, name: string): Promise<string> => {
      const [s] = await handle.db
        .insert(schema.source)
        .values({ teamId, kind: "web", platformId: `s-${name}-${RUN}`, name, url: `https://feeds.example.test/s-${name}-${RUN}` })
        .returning({ id: schema.source.id });
      return s!.id;
    };
    src = await mkSrc(team, "main");
    bulkSrc = await mkSrc(team, "bulk");
    src2 = await mkSrc(team2, "other");
    ids.a = await mkPost(src, "A", "IP 15 FULLBOX");
    ids.b = await mkPost(src, "B", "ip15 full box");
    ids.c = await mkPost(src, "C", "iphone 15 fullbox seal");
    ids.d = await mkPost(src, "D", "ip 14 fullbox");
    ids.e = await mkPost(src, "E", "Bán IPHONE 15 pro máy đẹp");
    ids.f = await mkPost(src, "F", "zzmarker <script>alert(1)</script> & co");
    ids.g = await mkPost(src2, "G", "ip15 fullbox other team");
    const [phones] = await handle.db.insert(schema.category).values({ slug: `ph${RUN}`, name: "Phones", path: `ph${RUN}` }).returning({ id: schema.category.id });
    const [iph] = await handle.db
      .insert(schema.category)
      .values({ slug: `ip${RUN}`, name: "iPhone", path: `ph${RUN}.ip${RUN}`, parentId: phones!.id })
      .returning({ id: schema.category.id });
    const [lap] = await handle.db.insert(schema.category).values({ slug: `lp${RUN}`, name: "Laptops", path: `lp${RUN}` }).returning({ id: schema.category.id });
    ids.phones = phones!.id;
    ids.iph = iph!.id;
    ids.p1 = await mkPost(src, "P1", "catq sell iphone in range");
    ids.p2 = await mkPost(src, "P2", "catq sell phone out of range");
    ids.p3 = await mkPost(src, "P3", "catq buy iphone in range");
    ids.p4 = await mkPost(src, "P4", "catq laptop sell in range");
    ids.p5 = await mkPost(src, "P5", "catq not enriched");
    await handle.db.insert(schema.enrichment).values([
      { postId: ids.p1!, intent: "sell", priceVnd: 15_000_000, categoryId: iph!.id, sentiment: "pos", intentTags: ["sell", "review"] },
      { postId: ids.p2!, intent: "sell", priceVnd: 25_000_000, categoryId: phones!.id },
      { postId: ids.p3!, intent: "buy", priceVnd: 15_000_000, categoryId: iph!.id },
      { postId: ids.p4!, intent: "sell", priceVnd: 15_000_000, categoryId: lap!.id },
    ]);
    // bulk
    const rows = corpusPosts(3000, 42, [bulkSrc], RUN);
    for (let i = 0; i < rows.length; i += 500) await handle.db.insert(schema.post).values(rows.slice(i, i + 500));
  });

  afterAll(async () => {
    // bulk rows must not linger: other suites scan `post` (backfill tests have a 5 s budget)
    const own = [src, bulkSrc, src2];
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, handle.db.select({ id: schema.post.id }).from(schema.post).where(inArray(schema.post.sourceId, own))));
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, own));
    await handle.close();
  });

  test("Ip15 fullbox matches spaced and compact spellings, excludes others", async () => {
    const hits = await run({ q: "ip15 fullbox", sourceIds: [src] });
    expect(texts(hits).sort()).toEqual(["A", "B"]);
    const noSeal = await run({ q: "iphone fullbox -seal", sourceIds: [src] });
    expect(texts(noSeal)).not.toContain("C");
    const withSeal = await run({ q: "iphone fullbox", sourceIds: [src] });
    expect(texts(withSeal)).toContain("C");
  });

  test("A short two-word query stays a phrase; short prefixes do not leak", async () => {
    await mkPost(src, "O1", "Bán ô tô cũ giá rẻ");
    await mkPost(src, "O2", "toàn bộ phụ kiện");
    await mkPost(src, "O3", "Toyota Vios 2016");
    await mkPost(src, "O4", "iPhone ở Hà Nội to đẹp");
    await mkPost(src, "O5", "ip15pm fullbox rẻ");
    expect(texts(await run({ q: "ô tô", sourceIds: [src] }))).toEqual(["O1"]);
    expect(texts(await run({ q: "ip15", sourceIds: [src] }))).toContain("O5");
  });

  test("Accent-insensitive match, snippet marks, html escaped", async () => {
    for (const q of ["iphone 15 pro may dep", "iPhone 15 Pro máy đẹp"]) {
      const hits = await run({ q });
      const hit = hits.find((h) => h.id === ids.e);
      expect(hit).toBeDefined();
      expect(hit!.snippet).toContain("<mark>");
    }
    const [esc] = await run({ q: "zzmarker" });
    expect(esc!.snippet).not.toContain("<script>");
    expect(esc!.snippet).toContain("&lt;script&gt;");
    expect(esc!.snippet).toContain("<mark>");
    // trigram-only hit: first 200 chars, escaped, no raw tags
    const [tri] = await run({ q: "arkerscr" });
    expect(tri?.id).toBe(ids.f);
    expect(tri!.snippet).not.toContain("<script>");
  });

  test("Paging to exhaustion equals one unpaged query; changed filter -> cursor_params_mismatch", async () => {
    const base: Partial<SearchParams> = { q: "iphone", sourceIds: [bulkSrc] };
    const all: string[] = [];
    let cursor: string | undefined;
    let first: SearchResult | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const r = await searchPosts(handle, params({ ...base, limit: 25, cursor }), team);
      if (!r.ok) throw new Error(r.error);
      first ??= r;
      all.push(...r.page.items.map((h) => h.id));
      cursor = r.page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(300);
    const one = await searchPosts(handle, params({ ...base, limit: 100 }), team, undefined);
    expect(one.ok && one.page.total).toBe(all.length);
    expect(first!.ok && first!.page.total).toBe(all.length);
    // newest sort + price-free paging also stable
    const ids2: string[] = [];
    let c2: string | undefined;
    for (let guard = 0; guard < 400; guard++) {
      const r = await searchPosts(handle, params({ sourceIds: [bulkSrc], sort: "newest", limit: 100, cursor: c2 }), team);
      if (!r.ok) throw new Error(r.error);
      ids2.push(...r.page.items.map((h) => h.id));
      c2 = r.page.nextCursor ?? undefined;
      if (!c2) break;
    }
    expect(ids2.length).toBe(3000);
    expect(new Set(ids2).size).toBe(3000);
    // mismatch
    const [firstPage] = [await searchPosts(handle, params({ ...base, limit: 25 }), team)];
    const cur = firstPage!.ok ? firstPage!.page.nextCursor! : "";
    const bad = await searchPosts(handle, params({ ...base, intents: ["sell"], limit: 25, cursor: cur }), team);
    expect(bad).toEqual({ ok: false, error: "cursor_params_mismatch" });
    const junk = await searchPosts(handle, params({ ...base, cursor: "not-a-cursor" }), team);
    expect(junk).toEqual({ ok: false, error: "invalid_cursor" });
  }, 60_000);

  test("Category subtree + price + intent; unenriched absent", async () => {
    const hits = await run({ q: "catq", categoryIds: [ids.phones!], priceMin: 10_000_000, priceMax: 20_000_000, intents: ["sell"] });
    expect(texts(hits)).toEqual(["P1"]);
    expect(hits[0]!.enrichment).toMatchObject({ sentiment: "pos", intentTags: ["sell", "review"] });
    const sub = await run({ q: "catq", categoryIds: [ids.phones!] });
    expect(texts(sub).sort()).toEqual(["P1", "P2", "P3"]);
    const none = await run({ q: "catq", sort: "price_asc" });
    expect(texts(none)).not.toContain("P5");
    expect(none.map((h) => h.enrichment?.priceVnd)).toEqual([15_000_000, 15_000_000, 15_000_000, 25_000_000]);
  });

  test("Short digit-only terms do not probe phone digits; the full number matches", async () => {
    const id = await mkPost(src, "PH", "lien he 0912345678 gap ngay");
    const prefix = await run({ q: "09123", sourceIds: [src] });
    expect(prefix.map((h) => h.id)).not.toContain(id);
    const full = await run({ q: "0912345678", sourceIds: [src] });
    expect(full.map((h) => h.id)).toContain(id);
  });

  test("db: team scoping", async () => {
    expect(texts(await run({ q: "ip15 fullbox" }))).not.toContain("G");
    expect(texts(await run({ q: "ip15 fullbox" }, team2))).toEqual(["G"]);
  });
});
