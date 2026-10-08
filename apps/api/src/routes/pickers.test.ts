import { createDb, schema, type DbHandle } from "@feedhound/db";
import { seedTaxonomyAndCatalogue } from "@feedhound/db/src/seed";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../index";

// API shape: GET /api/categories exposes resolved attribute schemas and price bounds.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
if ((process.env.CI || TEST_DATABASE_URL) && !TEST_DATABASE_URL) throw new Error("pickers.test.ts: TEST_DATABASE_URL is required (CI is set)");

interface CategoryOut {
  slug: string;
  attributeSchema: { key: string; kind: string; values?: string[] }[];
  priceBounds: { min: number; max: number } | null;
}

describe.skipIf(!TEST_DATABASE_URL)("GET /api/categories", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const email = `pickers-${RUN}@example.com`;
  let handle: DbHandle;
  let teamId: string;
  let prevNodeEnv: string | undefined;
  let prevBypass: string | undefined;

  beforeAll(async () => {
    prevNodeEnv = process.env.NODE_ENV;
    prevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where slug = 'cars' and attribute_schema <> '[]'::jsonb`;
    if (!seeded?.n) await seedTaxonomyAndCatalogue(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `pickers-${RUN}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    await handle.db.insert(schema.user).values({ teamId, email, role: "hunter" });
  }, 120_000);

  afterAll(async () => {
    process.env.NODE_ENV = prevNodeEnv;
    process.env.DEV_AUTH_BYPASS = prevBypass;
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("inherited price bounds and schemas", async () => {
    const res = await createApp(handle).request("/api/categories", { headers: { "X-Dev-User": email } });
    expect(res.status).toBe(200);
    const { categories } = (await res.json()) as { categories: CategoryOut[] };
    const by = (slug: string): CategoryOut => categories.find((c) => c.slug === slug)!;

    expect(by("iphone").priceBounds).toEqual({ min: 500_000, max: 80_000_000 });
    expect(by("iphone").attributeSchema.map((d) => d.key)).toEqual(["storage_gb", "battery_pct", "market"]);
    const chip = by("macbook").attributeSchema.find((d) => d.key === "chip");
    expect(chip?.kind).toBe("ordered");
    expect(chip?.values).toHaveLength(18);
    expect(by("macbook").priceBounds).toEqual({ min: 2_000_000, max: 150_000_000 });
    // cars: schema + bounds are inherited by sedan / suv
    expect(by("sedan").attributeSchema.map((d) => d.key)).toEqual(by("cars").attributeSchema.map((d) => d.key));
    expect(by("suv").priceBounds).toEqual({ min: 30_000_000, max: 5_000_000_000 });
    expect(by("electronics").priceBounds).toBeNull();
    expect(by("electronics").attributeSchema).toEqual([]);
  });
  test("GET /api/catalog-items?ids= returns only those items; bad ids -> 422", async () => {
    const headers = { "X-Dev-User": email };
    const all = (await (await createApp(handle).request("/api/catalog-items?limit=3", { headers })).json()) as { items: { id: string }[] };
    expect(all.items.length).toBeGreaterThan(1);
    const want = all.items[1]!.id;
    const res = await createApp(handle).request(`/api/catalog-items?ids=${want}`, { headers });
    expect(((await res.json()) as { items: { id: string }[] }).items.map((x) => x.id)).toEqual([want]);
    expect((await createApp(handle).request("/api/catalog-items?ids=nope", { headers })).status).toBe(422);
    const many = Array.from({ length: 101 }, () => crypto.randomUUID()).join(",");
    expect((await createApp(handle).request(`/api/catalog-items?ids=${many}`, { headers })).status).toBe(422);
  });
});
