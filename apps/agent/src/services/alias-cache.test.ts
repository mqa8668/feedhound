import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AliasCache } from "./alias-cache";

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

if (TEST_DATABASE_URL && !isTestDbUrl(TEST_DATABASE_URL)) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  let reachable = true;
  try {
    await probe.sql`select 1`;
  } catch (err) {
    reachable = false;
    if (MUST_RUN) {
      await probe.close();
      throw err;
    }
    console.warn(`alias-cache.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) {
      await probe.close();
      throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    }
    canRun = true;
  }
  await probe.close();
} else if (MUST_RUN) {
  throw new Error("alias-cache.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("alias-cache.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("AliasCache (no-restart classify)", () => {
  let handle: DbHandle;
  let categoryId: string;
  let itemId: string;
  let cache: AliasCache;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [cat] = await handle.db
      .insert(schema.category)
      .values({ slug: `alias-cache-test-${crypto.randomUUID()}`, name: "Alias Cache Test", path: `alias_cache_test_${Date.now()}` })
      .returning({ id: schema.category.id });
    categoryId = cat!.id;
    const [item] = await handle.db
      .insert(schema.catalogItem)
      .values({ categoryId, name: "Alias Cache Item" })
      .returning({ id: schema.catalogItem.id });
    itemId = item!.id;
    cache = new AliasCache({ handle, refreshSec: 3600 });
    await cache.start();
  });

  afterAll(async () => {
    await cache.stop();
    await handle.db.delete(schema.catalogItem).where(eq(schema.catalogItem.id, itemId));
    await handle.db.delete(schema.category).where(eq(schema.category.id, categoryId));
    await handle.close();
  });

  test("reloads on NOTIFY catalogue_changed after an alias is added", async () => {
    await handle.db.update(schema.catalogItem).set({ aliases: ["freshalias123"] }).where(eq(schema.catalogItem.id, itemId));
    await handle.sql.notify("catalogue_changed", "1");

    await new Promise((resolve) => setTimeout(resolve, 300));

    const dict = cache.get();
    const hasAlias = (dict.entries as { alias: string }[]).some((e) => e.alias === "freshalias123");
    expect(hasAlias).toBe(true);
  });
});
