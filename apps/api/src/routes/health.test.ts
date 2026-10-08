import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { createApp } from "../index";
import { insertOpsAlert } from "./health";

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

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    console.warn(`health.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("health.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("health.test.ts: skipped — TEST_DATABASE_URL is unset");
}

// `/api/health` bodies are tiny; anything over 64 KB is
// rejected before it reaches zod/handler logic.
describe.skipIf(!canRun)("POST /api/health body limit", () => {
  let handle: DbHandle;
  let teamId: string;
  let key: string;
  let sourceId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);

    const [team] = await handle.db.insert(schema.team).values({ name: "health-body-limit-team" }).returning({ id: schema.team.id });
    teamId = team!.id;

    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `health-body-limit-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });

    key = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const [apiKeyRow] = await handle.db
      .insert(schema.apiKey)
      .values({
        userId: user!.id,
        name: "health-body-limit",
        prefix: key.slice(0, 8),
        hash: await sha256Hex(key),
        scopes: ["ingest"],
      })
      .returning({ id: schema.apiKey.id });

    const [source] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: "g-body-limit",
        name: "Body limit group",
        url: "https://feeds.example.test/g-body-limit",
        assignedKeyId: apiKeyRow!.id,
      })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    const users = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, teamId));
    for (const u of users) await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, u.id));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("rejects a body over 64 KB with 413", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/health", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, ok: true, visitId: "a".repeat(70 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  test("accepts a normal-sized body", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/health", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, ok: true, visitId: "v1" }),
    });
    expect(res.status).toBe(200);
  });

  // /api/health only stamps last_health_at.
  test("ok=false leaves status and health untouched, stamps last_health_at, creates no notification", async () => {
    const app = createApp(handle);
    await handle.db.update(schema.source).set({ status: "active", health: { ok: true }, lastHealthAt: null }).where(eq(schema.source.id, sourceId));
    const before = await handle.db.select({ id: schema.notification.id }).from(schema.notification);

    const res = await app.request("/api/health", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, ok: false, reason: "x", visitId: "v-ac8" }),
    });
    expect(res.status).toBe(200);
    const [after] = await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId));
    expect(after?.status).toBe("active");
    expect(after?.health).toEqual({ ok: true });
    expect(after?.lastHealthAt).not.toBeNull();
    const afterNotes = await handle.db.select({ id: schema.notification.id }).from(schema.notification);
    expect(afterNotes.length).toBe(before.length);
  });
});

describe.skipIf(!canRun)("insertOpsAlert", () => {
  let handle: DbHandle;
  let teamId: string;
  let operatorId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `ops-alert-team-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [op] = await handle.db.insert(schema.user).values({ teamId, email: `ops-alert-${crypto.randomUUID()}@example.com`, role: "operator" }).returning({ id: schema.user.id });
    operatorId = op!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, operatorId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("with notify.ops.chatId unset the row is born skipped with payload.ops kind and dedupeKey", async () => {
    const [latest] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, "notify.ops.chatId")).orderBy(desc(schema.config.version)).limit(1);
    await handle.db.insert(schema.config).values({ key: "notify.ops.chatId", version: (latest?.version ?? 0) + 1, value: "", updatedBy: "test-health-unset" });
    try {
      await insertOpsAlert(handle, teamId, "source X paused");
      const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.userId, operatorId));
      expect(row?.status).toBe("skipped");
      expect(row?.payload.ops).toEqual({ kind: "source_health", text: "source X paused", dedupeKey: `source_health:${teamId}:source X paused` });
    } finally {
      await handle.db.delete(schema.config).where(eq(schema.config.updatedBy, "test-health-unset"));
    }
  });
});
