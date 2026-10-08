import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type DbHandle } from "./index";
import { seedTaxonomyAndCatalogue as seed } from "./seed";

// DB half: the seed upserts attribute schemas, price bounds and catalogue items idempotently.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);
if (MUST_RUN && !TEST_DATABASE_URL) throw new Error("seed-attributes.test.ts: TEST_DATABASE_URL is required (CI is set)");
const dbDescribe = TEST_DATABASE_URL ? describe : describe.skip;

const ROOT_CONFIG = new URL("../../../config", import.meta.url).pathname;

interface Def {
  key: string;
  kind: string;
  values?: string[];
  max?: number;
}

async function load(h: DbHandle) {
  const q = async (slug: string) => {
    const [r] = await h.sql<{ attribute_schema: Def[]; price_min_vnd: string | null; price_max_vnd: string | null }[]>`
      select attribute_schema, price_min_vnd, price_max_vnd from category where slug = ${slug} limit 1`;
    if (!r) throw new Error(`no category ${slug}`);
    return { defs: r.attribute_schema, min: r.price_min_vnd === null ? null : Number(r.price_min_vnd), max: r.price_max_vnd === null ? null : Number(r.price_max_vnd) };
  };
  const counts = await h.sql<{ c: number; i: number }[]>`select (select count(*)::int from category) as c, (select count(*)::int from catalog_item) as i`;
  return { phones: await q("phones"), iphone: await q("iphone"), macbook: await q("macbook"), cars: await q("cars"), sedan: await q("sedan"), counts: counts[0] };
}

dbDescribe("seed attributes", () => {
  const dir = mkdtempSync(join(tmpdir(), "seed026-"));
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await seed(TEST_DATABASE_URL); // restore the real config for other test files
  }, 120_000);

  test("schemas, bounds and items are seeded; a re-seed with a changed max keeps row counts", async () => {
    await seed(TEST_DATABASE_URL);
    const h = createDb(TEST_DATABASE_URL);
    try {
      const a = await load(h);
      expect([a.phones.min, a.phones.max]).toEqual([500_000, 80_000_000]);
      expect(a.iphone.min).toBeNull(); // inherited from phones at read time
      expect(a.iphone.defs.map((d) => d.key)).toEqual(["storage_gb", "battery_pct", "market"]);
      expect(a.macbook.defs.find((d) => d.key === "chip")?.values?.length).toBe(18);
      expect([a.cars.min, a.cars.max]).toEqual([30_000_000, 5_000_000_000]);
      expect(a.sedan.defs).toEqual([]);
      const [air] = await h.sql<{ attributes: unknown; aliases: string[] }[]>`select attributes, aliases from catalog_item where name = 'MacBook Air'`;
      expect(air?.attributes).toEqual({ line: "air" });
      expect(air?.aliases).toContain("mba");

      cpSync(ROOT_CONFIG, dir, { recursive: true });
      const tax = readFileSync(join(dir, "taxonomy.yaml"), "utf8");
      const changed = tax.replace('"unit": "gb", "min": 4, "max": 256', '"unit": "gb", "min": 4, "max": 512');
      expect(changed).not.toBe(tax);
      writeFileSync(join(dir, "taxonomy.yaml"), changed);
      await seed(TEST_DATABASE_URL, dir);

      const b = await load(h);
      expect(b.macbook.defs.find((d) => d.key === "ram_gb")?.max).toBe(512);
      expect(b.counts).toEqual(a.counts);
    } finally {
      await h.close();
    }
  }, 120_000);

  test("an invalid schema fails the seed naming the node slug", async () => {
    const bad = join(dir, "bad");
    cpSync(ROOT_CONFIG, bad, { recursive: true });
    const tax = readFileSync(join(bad, "taxonomy.yaml"), "utf8");
    writeFileSync(join(bad, "taxonomy.yaml"), tax.replace('"kind": "ordered"', '"kind": "bogus"'));
    await expect(seed(TEST_DATABASE_URL, bad)).rejects.toThrow(/macbook/);
  }, 60_000);
});
