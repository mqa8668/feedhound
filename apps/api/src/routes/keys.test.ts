import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
    console.warn(`keys.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("keys.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("keys.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("keys routes", () => {
  let handle: DbHandle;
  let teamId: string;
  let hunterEmail: string;
  let operatorEmail: string;
  let operatorId: string;
  let originalNodeEnv: string | undefined;
  let originalDevBypass: string | undefined;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    originalDevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.DEV_AUTH_BYPASS = "1"; // the bypass requires this explicit opt-in, not just NODE_ENV
    handle = createDb(TEST_DATABASE_URL);

    const [team] = await handle.db.insert(schema.team).values({ name: "keys-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    hunterEmail = `keys-hunter-${crypto.randomUUID()}@example.com`;
    operatorEmail = `keys-op-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId, email: hunterEmail, role: "hunter" });
    const [operator] = await handle.db.insert(schema.user).values({ teamId, email: operatorEmail, role: "operator" }).returning({ id: schema.user.id });
    operatorId = operator!.id;
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DEV_AUTH_BYPASS = originalDevBypass;
    const users = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, teamId));
    for (const u of users) await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, u.id));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("hunter session gets 403 on POST /api/keys", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/keys", {
      method: "POST",
      headers: { "X-Dev-User": hunterEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "k", userId: operatorId, scopes: ["ingest"] }),
    });
    expect(res.status).toBe(403);
  });

  test("operator mints a key that starts hk_, never leaks in GET, authenticates, then 401s after revoke", async () => {
    const app = createApp(handle);

    const createRes = await app.request("/api/keys", {
      method: "POST",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dashboard-key", userId: operatorId, scopes: ["ingest"] }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; key: string; prefix: string };
    expect(created.key.startsWith("hk_")).toBe(true);

    const listRes = await app.request("/api/keys", { headers: { "X-Dev-User": operatorEmail } });
    const listBody = (await listRes.json()) as { keys: Record<string, unknown>[] };
    expect(listBody.keys.every((k) => !("key" in k))).toBe(true);
    expect(listBody.keys.some((k) => k.id === created.id)).toBe(true);

    const pingRes = await app.request("/api/ingest/_ping", { headers: { Authorization: `Bearer ${created.key}` } });
    expect(pingRes.status).toBe(200);

    const deleteRes = await app.request(`/api/keys/${created.id}`, { method: "DELETE", headers: { "X-Dev-User": operatorEmail } });
    expect(deleteRes.status).toBe(204);

    const pingAfterRevoke = await app.request("/api/ingest/_ping", { headers: { Authorization: `Bearer ${created.key}` } });
    expect(pingAfterRevoke.status).toBe(401);
  });
});
