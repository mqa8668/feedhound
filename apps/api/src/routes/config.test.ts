import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
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
    console.warn(`config.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("config.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("config.test.ts: skipped — TEST_DATABASE_URL is unset");
}

const KEY = "schedule.dailyCapPerSource";

describe.skipIf(!canRun)("config routes", () => {
  let handle: DbHandle;
  let teamId: string;
  let hunterEmail: string;
  let operatorEmail: string;
  let originalNodeEnv: string | undefined;
  let originalDevBypass: string | undefined;
  let originalVersionRows: (typeof schema.config.$inferSelect)[];

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    originalDevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.DEV_AUTH_BYPASS = "1"; // the bypass requires this explicit opt-in, not just NODE_ENV
    handle = createDb(TEST_DATABASE_URL);

    // Shared-DB hygiene: Config is append-only and shared —
    // snapshot the current rows for KEY so we can prove we only ever add,
    // never delete, and restore the pre-test current value at the end.
    originalVersionRows = await handle.db.select().from(schema.config).where(eq(schema.config.key, KEY)).orderBy(desc(schema.config.version));

    const [team] = await handle.db.insert(schema.team).values({ name: "config-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    hunterEmail = `config-hunter-${crypto.randomUUID()}@example.com`;
    operatorEmail = `config-op-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId, email: hunterEmail, role: "hunter" });
    await handle.db.insert(schema.user).values({ teamId, email: operatorEmail, role: "operator" });
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DEV_AUTH_BYPASS = originalDevBypass;
    // Restore the current value to what it was before this suite ran, by
    // appending one more version equal to the original current value
    // (append-only: never delete/rewrite rows another suite may read).
    const original = originalVersionRows[0];
    if (original) {
      const [latest] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, KEY)).orderBy(desc(schema.config.version)).limit(1);
      if (latest && latest.version !== original.version) {
        await handle.db.insert(schema.config).values({ key: KEY, version: latest.version + 1, value: original.value, updatedBy: "config.test.ts cleanup" });
      }
    }
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("hunter session gets 403 on PUT /api/config/:key", async () => {
    const app = createApp(handle);
    const [current] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, KEY)).orderBy(desc(schema.config.version)).limit(1);
    const res = await app.request(`/api/config/${KEY}`, {
      method: "PUT",
      headers: { "X-Dev-User": hunterEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ value: 30, baseVersion: current?.version ?? 0 }),
    });
    expect(res.status).toBe(403);
  });

  test("PUT with correct baseVersion creates version n+1; stale baseVersion -> 409; invalid value -> 400 and no row", async () => {
    const app = createApp(handle);
    const [before] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, KEY)).orderBy(desc(schema.config.version)).limit(1);
    const currentVersion = before?.version ?? 0;

    const okRes = await app.request(`/api/config/${KEY}`, {
      method: "PUT",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ value: 25, baseVersion: currentVersion }),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { version: number };
    expect(okBody.version).toBe(currentVersion + 1);

    const versionsRes = await app.request(`/api/config/${KEY}/versions`, { headers: { "X-Dev-User": operatorEmail } });
    const versionsBody = (await versionsRes.json()) as { versions: { version: number }[] };
    expect(versionsBody.versions[0]?.version).toBe(currentVersion + 1);

    const staleRes = await app.request(`/api/config/${KEY}`, {
      method: "PUT",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ value: 40, baseVersion: currentVersion }),
    });
    expect(staleRes.status).toBe(409);

    const rowCountBeforeInvalid = (await handle.db.select().from(schema.config).where(eq(schema.config.key, KEY))).length;
    const invalidRes = await app.request(`/api/config/${KEY}`, {
      method: "PUT",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "not-a-number", baseVersion: currentVersion + 1 }),
    });
    expect(invalidRes.status).toBe(400);
    const rowCountAfterInvalid = (await handle.db.select().from(schema.config).where(eq(schema.config.key, KEY))).length;
    expect(rowCountAfterInvalid).toBe(rowCountBeforeInvalid);
  });

  test("PUT internal key -> 403 internal_key and no row; registry-invalid value -> 400 with issues", async () => {
    const app = createApp(handle);
    const internalKey = "bot.telegram.updateOffset";
    const countRows = async (k: string) => (await handle.db.select().from(schema.config).where(eq(schema.config.key, k))).length;
    const [cur] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, internalKey)).orderBy(desc(schema.config.version)).limit(1);
    const before = await countRows(internalKey);
    const res = await app.request(`/api/config/${internalKey}`, {
      method: "PUT",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ value: 99, baseVersion: cur?.version ?? 0 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("internal_key");
    expect(await countRows(internalKey)).toBe(before);

    const bad = await app.request("/api/config/notify.quietHoursStart", {
      method: "PUT",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "25:00", baseVersion: 0 }),
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string; issues?: unknown[] };
    expect(badBody.error).toBe("validation");
    expect(badBody.issues?.length).toBeGreaterThan(0);
  });

  test("GET /api/config and /versions expose updatedByLabel (seed, migration, operator email)", async () => {
    const app = createApp(handle);
    const key2 = "search.recencyWeight";
    const rows = await handle.db.select().from(schema.config).where(eq(schema.config.key, key2)).orderBy(desc(schema.config.version));
    const base = rows[0]?.version ?? 0;
    const original = rows[0]?.value ?? 0.5;
    const [op] = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, operatorEmail));
    await handle.db.insert(schema.config).values([
      { key: key2, version: base + 1, value: 0.6, updatedBy: "seed" },
      { key: key2, version: base + 2, value: 0.7, updatedBy: "migration:0031" },
      { key: key2, version: base + 3, value: 0.8, updatedBy: op!.id },
    ]);
    try {
      const v = (await (await app.request(`/api/config/${key2}/versions`, { headers: { "X-Dev-User": operatorEmail } })).json()) as {
        versions: { version: number; value: unknown; updatedBy: string; updatedByLabel: string }[];
      };
      const label = (n: number) => v.versions.find((r) => r.version === n)?.updatedByLabel;
      expect(label(base + 1)).toBe("seed");
      expect(label(base + 2)).toBe("migration");
      expect(label(base + 3)).toBe(operatorEmail);
      expect(v.versions.find((r) => r.version === base + 3)?.updatedBy).toBe(op!.id);

      const list = (await (await app.request("/api/config", { headers: { "X-Dev-User": operatorEmail } })).json()) as {
        config: { key: string; version: number; value: unknown; updatedBy: string; updatedAt: string; updatedByLabel: string }[];
      };
      const cur = list.config.find((r) => r.key === key2);
      expect(cur).toMatchObject({ version: base + 3, value: 0.8, updatedByLabel: operatorEmail });
    } finally {
      await handle.db.insert(schema.config).values({ key: key2, version: base + 4, value: original, updatedBy: "config.test.ts cleanup" });
    }
  });
});
