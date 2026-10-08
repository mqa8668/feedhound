import { matchPost } from "@feedhound/core/matcher";
import { normalizeText } from "@feedhound/core/normalize";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";
import { WatchIndex } from "./watch-index";

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
    console.warn(`watch-index.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("watch-index.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("watch-index.test.ts: skipped — TEST_DATABASE_URL is unset");
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!canRun)("WatchIndex", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "watch-index-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `watch-index-test-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.config).where(and(inArray(schema.config.updatedBy, ["test", "test-cleanup"]), eq(schema.config.key, "match.maxWatches")));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("PATCH-driven watch_changed NOTIFY reloads the index within 1s (version bump, new/removed watch visible)", async () => {
    const index = new WatchIndex({ handle, reloadDebounceMs: 50 });
    await index.start();
    try {
      const startVersion = index.version;

      const [watch] = await handle.db
        .insert(schema.watch)
        .values({ userId, name: "watch-index-ac8", enabled: true, include: ["placeholder-term"] })
        .returning({ id: schema.watch.id });
      const watchId = watch!.id;

      // Trigger fires on INSERT too — wait for the index to pick this row up first.
      await waitUntil(() => index.get().some((w) => w.id === watchId), 1000);

      await handle.db.update(schema.watch).set({ include: ["zzwatchidx"] }).where(eq(schema.watch.id, watchId));

      const versionBeforePatch = index.version;
      await waitUntil(() => index.version > versionBeforePatch, 1000);
      expect(index.version).toBeGreaterThan(startVersion);

      const compiled = index.get().find((w) => w.id === watchId);
      expect(compiled).toBeDefined();
      const post = { id: "p1", sourceId: "s1", textNormalized: normalizeText("ban zzwatchidx gia tot").nfc };
      const results = matchPost({ post }, index.get(), new Date());
      expect(results.some((r) => r.watchId === watchId)).toBe(true);

      await handle.db.update(schema.watch).set({ enabled: false }).where(eq(schema.watch.id, watchId));
      await waitUntil(() => !index.get().some((w) => w.id === watchId), 1000);
      expect(index.get().some((w) => w.id === watchId)).toBe(false);
    } finally {
      await index.stop();
    }
  }, 10_000);

  // Regression: `match.maxWatches` must actually be
  // read from the Config table, not silently stay pinned to the hardcoded
  // module default forever.
  test("GetForTeam returns only the team's enabled watches", async () => {
    const [watch] = await handle.db
      .insert(schema.watch)
      .values({ userId, name: "watch-index-team", enabled: true, include: ["team-scope-term"] })
      .returning({ id: schema.watch.id });
    const index = new WatchIndex({ handle });
    await index.reload();
    expect(index.getForTeam(teamId).some((w) => w.id === watch!.id)).toBe(true);
    expect(index.getForTeam(crypto.randomUUID())).toEqual([]);
    expect(index.get().some((w) => w.id === watch!.id)).toBe(true);
  });

  test("Start() honours the live match.maxWatches Config value when not overridden explicitly", async () => {
    const [existing] = await handle.db
      .select({ version: schema.config.version, value: schema.config.value })
      .from(schema.config)
      .where(eq(schema.config.key, "match.maxWatches"))
      .orderBy(desc(schema.config.version))
      .limit(1);
    const nextVersion = (existing?.version ?? 0) + 1;
    await handle.db.insert(schema.config).values({
      key: "match.maxWatches",
      version: nextVersion,
      value: 1,
      updatedBy: "test",
    });

    try {
      await handle.db.insert(schema.watch).values([
        { userId, name: "finding6-a", enabled: true, include: ["placeholder-a"] },
        { userId, name: "finding6-b", enabled: true, include: ["placeholder-b"] },
      ]);

      // No `maxWatches` override passed: must load the Config value (1) at start(),
      // not the hardcoded default (1000), so only one of the two enabled watches loads.
      const index = new WatchIndex({ handle });
      await index.start();
      try {
        expect(index.get().length).toBe(1);
      } finally {
        await index.stop();
      }
    } finally {
      // Config is append-only (packages/db/src/schema/config.ts): don't delete
      // the row this test just wrote, append a row that restores the previous
      // value instead. Otherwise `match.maxWatches` stays pinned at 1 in the
      // shared feedhound_test DB forever, silently starving every WatchIndex test
      // (and any other suite's WatchIndex) that runs afterwards, in this
      // process or a later one.
      await handle.db.insert(schema.config).values({
        key: "match.maxWatches",
        version: nextVersion + 1,
        value: existing?.value ?? 1000,
        updatedBy: "test-cleanup",
      });
    }
  }, 10_000);

  test("reload() with ~1000 watches completes in < 2s (reload timing)", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      userId,
      name: `bulk-${i}`,
      enabled: true,
      include: ["iphone"],
    }));
    await handle.db.insert(schema.watch).values(rows);

    const index = new WatchIndex({ handle, maxWatches: 1000 });
    const start = performance.now();
    await index.reload();
    const ms = performance.now() - start;

    expect(index.get().length).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThan(2000);
  }, 10_000);
});
