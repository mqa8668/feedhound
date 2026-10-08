import { resolveSchema } from "@feedhound/core/attributes";
import { createDb, loadCatalogueAttrs, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../index";

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

if (TEST_DATABASE_URL && !isTestDbUrl(TEST_DATABASE_URL)) throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  try {
    await probe.sql`select 1`;
    canRun = true;
  } catch (err) {
    if (MUST_RUN) throw err;
  } finally {
    await probe.close();
  }
} else if (MUST_RUN) {
  throw new Error("deal-decision.test.ts: TEST_DATABASE_URL is required (CI is set)");
}

const PHONE = "0912345678";
const AUTHOR = "Nguyen Van Kinhdoanh";

// Post decision and compare.
describe.skipIf(!canRun)("deal decision API", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const DAY = 86_400_000;
  const at = Date.now() - DAY;
  let handle: DbHandle;
  let emailA: string;
  let emailB: string;
  let srcA: string;
  let srcB: string;
  let catId: string;
  let carsId: string | null = null;
  let carsCreated = false;
  const created: string[] = [];
  const ids: Record<string, string> = {};

  async function mkPost(
    key: string,
    src: string,
    opts: { daysAgo: number; title: string; text?: string; authorId?: string; authorName?: string; attributes: Record<string, string | number>; price: number; dealPct?: number; dealN?: number; dealMedian?: number },
  ): Promise<string> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({
        sourceId: src,
        platformPostId: `${key}-${RUN}`,
        url: `https://feeds.example.test/${key}-${RUN}`,
        title: opts.title,
        text: opts.text ?? opts.title,
        textNormalized: (opts.text ?? opts.title).toLowerCase(),
        postedAt: new Date(at - opts.daysAgo * DAY),
        authorId: opts.authorId ?? null,
        authorName: opts.authorName ?? null,
      })
      .returning({ id: schema.post.id });
    created.push(p!.id);
    await handle.db.insert(schema.enrichment).values({
      postId: p!.id,
      intent: "sell",
      priceVnd: opts.price,
      priceQualifier: "exact",
      priceConfidence: 0.9,
      categoryId: catId,
      attributes: opts.attributes,
      dealPct: opts.dealPct ?? null,
      dealN: opts.dealN ?? null,
      dealMedianVnd: opts.dealMedian ?? null,
    });
    return p!.id;
  }

  const get = async (email: string, path: string): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
    const res = await createApp(handle).request(path, { headers: { "X-Dev-User": email } });
    const text = await res.text();
    return { status: res.status, text, json: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [ta, tb] = await handle.db
      .insert(schema.team)
      .values([{ name: `dd-a-${RUN}` }, { name: `dd-b-${RUN}` }])
      .returning({ id: schema.team.id });
    emailA = `dd-a-${RUN}@example.com`;
    emailB = `dd-b-${RUN}@example.com`;
    const [ua, ub] = await handle.db
      .insert(schema.user)
      .values([
        { teamId: ta!.id, email: emailA, role: "hunter" },
        { teamId: tb!.id, email: emailB, role: "hunter" },
      ])
      .returning({ id: schema.user.id });
    const [sa, sb] = await handle.db
      .insert(schema.source)
      .values([
        { teamId: ta!.id, kind: "web", platformId: `dd-a-${RUN}`, name: "Nhóm A", url: `https://feeds.example.test/dd-a-${RUN}` },
        { teamId: tb!.id, kind: "web", platformId: `dd-b-${RUN}`, name: "Nhóm B", url: `https://feeds.example.test/dd-b-${RUN}` },
      ])
      .returning({ id: schema.source.id });
    srcA = sa!.id;
    srcB = sb!.id;

    const [cars] = await handle.db.select({ id: schema.category.id }).from(schema.category).where(eq(schema.category.slug, "cars")).limit(1);
    if (cars) carsId = cars.id;
    else {
      const [row] = await handle.db.insert(schema.category).values({ slug: "cars", name: "Cars", path: "cars" }).returning({ id: schema.category.id });
      carsId = row!.id;
      carsCreated = true;
    }
    // a shared test DB may already carry the seeded `cars` schema: neutralise its key attributes so only `year` is a peer key
    const known = await loadCatalogueAttrs(handle);
    const inherited = resolveSchema(carsId, known.tree, known.schemas).map((d) => ({ ...d, keyAttr: false, keyOptional: undefined }));
    const [carsRow] = await handle.db.select({ path: schema.category.path }).from(schema.category).where(eq(schema.category.id, carsId));
    const [cat] = await handle.db
      .insert(schema.category)
      .values({
        slug: `kia${RUN}`,
        name: "Kia",
        parentId: carsId,
        path: `${carsRow!.path}.kia${RUN}`,
        attributeSchema: [
          ...inherited.filter((d) => d.key !== "year" && d.key !== "odo_km"),
          { key: "year", label: "Year", kind: "number", unit: "year", min: 1990, max: 2030, keyAttr: true, tolerance: 1 },
          { key: "odo_km", label: "ODO", kind: "number", unit: "km", min: 0, max: 1_000_000, keyAttr: false },
        ],
      })
      .returning({ id: schema.category.id });
    catId = cat!.id;

    // subject: Kia Morning 2012 at 185tr, 13 peers (median 203tr)
    ids.subject = await mkPost("subject", srcA, {
      daysAgo: 0,
      title: "Kia Morning 2012 lh " + PHONE,
      text: `Kia Morning 2012 lh ${PHONE}`,
      authorId: `ext-${RUN}`,
      authorName: AUTHOR,
      attributes: { year: 2012, odo_km: 90_000 },
      price: 185e6,
      dealPct: -9.2,
      dealN: 13,
      dealMedian: 203e6,
    });
    ids.other = await mkPost("other", srcA, { daysAgo: 20, title: "Kia Morning khac", authorId: `ext-${RUN}`, authorName: AUTHOR, attributes: { year: 2010 }, price: 150e6 });
    for (let i = 0; i < 13; i++) {
      await mkPost(`peer${i}`, srcA, {
        daysAgo: 1 + i,
        title: i === 0 ? "Kia Morning 2012 lh 0988 777 666" : `Kia Morning peer ${i}`,
        attributes: { year: 2011 + (i % 3), odo_km: 40_000 + i * 10_000 },
        price: (196 + i) * 1e6,
      });
    }
    // thin: year 2005 with only 3 peers
    ids.thin = await mkPost("thin", srcA, { daysAgo: 0, title: "Kia Morning 2005", attributes: { year: 2005 }, price: 90e6 });
    for (let i = 0; i < 3; i++) await mkPost(`thinpeer${i}`, srcA, { daysAgo: 1 + i, title: `Kia 2005 peer ${i}`, attributes: { year: 2005 }, price: (90 + i) * 1e6 });
    ids.foreign = await mkPost("foreign", srcB, { daysAgo: 0, title: "Kia Morning 2012", attributes: { year: 2012 }, price: 190e6 });

    ids.foreignPeer = await mkPost("foreignpeer", srcB, { daysAgo: 2, title: "Kia Morning 2012 team B", attributes: { year: 2012 }, price: 100e6 });
    ids.nameA = await mkPost("namea", srcA, { daysAgo: 0, title: "Kia Morning 2008", authorName: "Trần Thị Hằng", attributes: { year: 2008 }, price: 120e6 });
    ids.nameB = await mkPost("nameb", srcA, { daysAgo: 3, title: "Kia Morning 2008 b", authorName: "  TRẦN  thị hằng ", attributes: { year: 2008 }, price: 121e6 });

    const [w] = await handle.db.insert(schema.watch).values({ userId: ua!.id, name: "Morning duoi 200tr", priceMax: 200e6, intents: ["sell"] }).returning({ id: schema.watch.id });
    await handle.db.insert(schema.match).values({ postId: ids.subject!, watchId: w!.id, score: 0.9, matchedTerms: [] });
    void ub;
  });

  afterAll(async () => {
    await handle.db.delete(schema.match).where(inArray(schema.match.postId, created));
    await handle.db.delete(schema.enrichment).where(inArray(schema.enrichment.postId, created));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, created));
    await handle.db.delete(schema.category).where(eq(schema.category.id, catId));
    if (carsCreated && carsId) await handle.db.delete(schema.category).where(eq(schema.category.id, carsId));
    await handle.close();
  });

  test("Verdict, comparables, distribution, fit and pseudonymous seller", async () => {
    const r = await get(emailA, `/api/posts/${ids.subject}/decision`);
    expect(r.status).toBe(200);
    const j = r.json as {
      capabilities: Record<string, boolean>;
      verdict: { text: string; n: number; medianVnd: number };
      comparables: { year: number | null; odoKm: number | null; deltaPct: number; title: string }[];
      distribution: { n: number; p50: number } | null;
      percentile: number | null;
      fit: { watchName: string; items: { label: string; status: string }[] }[];
      seller: { label: string; sellPosts90: number };
      specs: { key: string; value: string }[];
    };
    expect(j.verdict.text).toStartWith("9% cheaper");
    expect(j.verdict.text).toContain("13 comparable cars");
    expect(j.verdict).toMatchObject({ n: 13, medianVnd: 203e6 });
    expect(j.capabilities).toEqual({ listing: false, dealV2: false, risk: false, seller: false });
    expect(j.comparables).toHaveLength(10);
    // Closest year first, then closest odometer
    expect(j.comparables[0]!.year).toBe(2012);
    const yearGaps = j.comparables.map((c) => Math.abs((c.year ?? 0) - 2012));
    expect(yearGaps).toEqual([...yearGaps].sort((a, b) => a - b));
    expect(j.comparables[0]!.deltaPct).toBeGreaterThan(0);
    expect(j.distribution?.n).toBe(13);
    expect(j.percentile).toBe(0);
    expect(j.fit.map((f) => ({ watchName: f.watchName, items: f.items }))).toEqual([{ watchName: "Morning duoi 200tr", items: [{ label: "Price ≤ 200M", status: "ok" }, { label: "Listing type: selling", status: "ok" }] }]);
    expect(j.seller.label).toMatch(/^Member #[0-9a-f]{8}$/);
    expect(j.seller.sellPosts90).toBe(2);
    expect(j.specs.map((s) => s.key)).toEqual(["year", "odo_km"]);
    expect(r.text).not.toContain(PHONE);
    expect(r.text).not.toContain("0988");
    expect(r.text).not.toContain(AUTHOR);
  });

  test("review: another team's comparable never appears in the decision", async () => {
    const r = await get(emailA, `/api/posts/${ids.subject}/decision`);
    const j = r.json as { comparables: { postId: string }[]; distribution: { n: number } | null };
    expect(j.comparables.map((c) => c.postId)).not.toContain(ids.foreignPeer!);
    expect(j.distribution?.n).toBe(13); // team B's year-2012 peer is not counted
    const b = await get(emailB, `/api/posts/${ids.foreign}/decision`);
    expect(b.status).toBe(200);
    expect((b.json as { comparables: { postId: string }[] }).comparables.map((c) => c.postId)).toEqual([ids.foreignPeer!]);
  });

  test("review: sellPosts90 matches name-only authors on the pseudonym key (case/whitespace insensitive)", async () => {
    const r = await get(emailA, `/api/posts/${ids.nameA}/decision`);
    expect((r.json as { seller: { sellPosts90: number } }).seller.sellPosts90).toBe(2);
  });

  test("Thin data gives no distribution and the not-enough text; another team's post is 404", async () => {
    const thin = (await get(emailA, `/api/posts/${ids.thin}/decision`)).json as { verdict: { text: string }; distribution: unknown };
    expect(thin.distribution).toBeNull();
    expect(thin.verdict.text).toStartWith("Not enough comparable listings to judge the price");
    expect((await get(emailB, `/api/posts/${ids.subject}/decision`)).status).toBe(404);
    expect((await get(emailA, `/api/posts/${ids.foreign}/decision`)).status).toBe(404);
    expect((await get(emailA, "/api/posts/not-a-uuid/decision")).status).toBe(400);
  });

  test("Compare returns items in ids order, pseudonymous sellers, 400/404 guards", async () => {
    const order = [ids.thin!, ids.subject!, ids.other!];
    const r = await get(emailA, `/api/compare?ids=${order.join(",")}`);
    expect(r.status).toBe(200);
    const j = r.json as { items: { postId: string; sellerLabel: string | null; matched: boolean; dealPct: number | null }[] };
    expect(j.items.map((i) => i.postId)).toEqual(order);
    expect(j.items[1]!.sellerLabel).toMatch(/^Member #[0-9a-f]{8}$/);
    expect(j.items[1]).toMatchObject({ matched: true, dealPct: -9.2 });
    expect(j.items[0]!.matched).toBe(false);
    expect(r.text).not.toContain(PHONE);
    expect(r.text).not.toContain(AUTHOR);
    expect((await get(emailA, `/api/compare?ids=${ids.thin}`)).status).toBe(400);
    const five = [...order, ids.subject!, ids.foreign!, ids.thin!].join(",");
    expect((await get(emailA, `/api/compare?ids=${five}`)).status).toBe(400);
    expect((await get(emailA, `/api/compare?ids=${ids.thin},nope`)).status).toBe(400);
    expect((await get(emailA, `/api/compare?ids=${ids.thin},${ids.thin}`)).status).toBe(400);
    expect((await get(emailA, `/api/compare?ids=${ids.thin},${ids.foreign}`)).status).toBe(404);
  });
});
