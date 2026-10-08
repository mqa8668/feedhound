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
    console.warn(`users.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("users.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("users.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("users routes", () => {
  let handle: DbHandle;
  let teamId: string;
  let hunterId: string;
  let operatorId: string;
  let hunterEmail: string;
  let operatorEmail: string;
  let originalNodeEnv: string | undefined;
  let originalDevBypass: string | undefined;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    originalDevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.DEV_AUTH_BYPASS = "1"; // the bypass requires this explicit opt-in, not just NODE_ENV
    handle = createDb(TEST_DATABASE_URL);

    const [team] = await handle.db.insert(schema.team).values({ name: "users-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    hunterEmail = `users-hunter-${crypto.randomUUID()}@example.com`;
    operatorEmail = `users-op-${crypto.randomUUID()}@example.com`;
    const [hunter] = await handle.db.insert(schema.user).values({ teamId, email: hunterEmail, role: "hunter" }).returning({ id: schema.user.id });
    hunterId = hunter!.id;
    const [operator] = await handle.db.insert(schema.user).values({ teamId, email: operatorEmail, role: "operator" }).returning({ id: schema.user.id });
    operatorId = operator!.id;
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DEV_AUTH_BYPASS = originalDevBypass;
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("hunter session gets 403 on GET/POST /api/members", async () => {
    const app = createApp(handle);
    const getRes = await app.request("/api/members", { headers: { "X-Dev-User": hunterEmail } });
    expect(getRes.status).toBe(403);

    const postRes = await app.request("/api/members", {
      method: "POST",
      headers: { "X-Dev-User": hunterEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", role: "hunter" }),
    });
    expect(postRes.status).toBe(403);
  });

  test("operator creates a user, lists it, hunter patches own telegramChatId, operator deletes it (not self)", async () => {
    const app = createApp(handle);
    const newEmail = `users-new-${crypto.randomUUID()}@example.com`;

    const createRes = await app.request("/api/members", {
      method: "POST",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail, role: "hunter" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; email: string };
    expect(created.email).toBe(newEmail.toLowerCase());

    const listRes = await app.request("/api/members", { headers: { "X-Dev-User": operatorEmail } });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { users: { id: string }[] };
    expect(listBody.users.some((u) => u.id === created.id)).toBe(true);

    // hunter may patch own telegramChatId
    const selfPatch = await app.request(`/api/members/${hunterId}`, {
      method: "PATCH",
      headers: { "X-Dev-User": hunterEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ telegramChatId: "123" }),
    });
    expect(selfPatch.status).toBe(200);

    // hunter may not patch role, even their own
    const roleEscalation = await app.request(`/api/members/${hunterId}`, {
      method: "PATCH",
      headers: { "X-Dev-User": hunterEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "operator" }),
    });
    expect(roleEscalation.status).toBe(403);

    // deleting self is refused
    const selfDelete = await app.request(`/api/members/${operatorId}`, { method: "DELETE", headers: { "X-Dev-User": operatorEmail } });
    expect(selfDelete.status).toBe(400);

    const deleteRes = await app.request(`/api/members/${created.id}`, { method: "DELETE", headers: { "X-Dev-User": operatorEmail } });
    expect(deleteRes.status).toBe(204);
  });

  // deleting a user with watches must require the
  // same ?confirm=true as DELETE /api/watches/:id (both cascade to `match`).
  test("deleting a user with a watch requires ?confirm=true", async () => {
    const app = createApp(handle);
    const newEmail = `users-watchowner-${crypto.randomUUID()}@example.com`;
    const createRes = await app.request("/api/members", {
      method: "POST",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail, role: "hunter" }),
    });
    const created = (await createRes.json()) as { id: string };

    const [watch] = await handle.db.insert(schema.watch).values({ userId: created.id, name: "w", include: ["iphone"] }).returning({ id: schema.watch.id });

    const noConfirm = await app.request(`/api/members/${created.id}`, { method: "DELETE", headers: { "X-Dev-User": operatorEmail } });
    expect(noConfirm.status).toBe(400);

    const withConfirm = await app.request(`/api/members/${created.id}?confirm=true`, { method: "DELETE", headers: { "X-Dev-User": operatorEmail } });
    expect(withConfirm.status).toBe(204);

    const remaining = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, watch!.id));
    expect(remaining).toHaveLength(0);
  });

  // Deleting the owner of an ingest key assigned to a source cascades the
  // key (`api_key.user_id onDelete: cascade`) and silently detaches it from the source
  // (`source.assigned_key_id onDelete: set null`) — must require `?confirm=true` like the
  // watch-owning case, and mark the source's health once the delete actually happens.
  test("deleting a user who owns a key assigned to a source requires ?confirm=true and marks source health", async () => {
    const app = createApp(handle);
    const newEmail = `users-keyowner-${crypto.randomUUID()}@example.com`;
    const createRes = await app.request("/api/members", {
      method: "POST",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail, role: "hunter" }),
    });
    const created = (await createRes.json()) as { id: string };

    const [apiKeyRow] = await handle.db
      .insert(schema.apiKey)
      .values({ userId: created.id, name: "k", prefix: "sk_test_", hash: "hash", scopes: ["ingest:write"] })
      .returning({ id: schema.apiKey.id });
    const [source] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: `users-keyowner-${crypto.randomUUID()}`,
        name: "s",
        url: "https://feeds.example.test/users-keyowner",
        assignedKeyId: apiKeyRow!.id,
      })
      .returning({ id: schema.source.id });

    try {
      const noConfirm = await app.request(`/api/members/${created.id}`, { method: "DELETE", headers: { "X-Dev-User": operatorEmail } });
      expect(noConfirm.status).toBe(400);
      const noConfirmBody = (await noConfirm.json()) as { reason: string };
      expect(noConfirmBody.reason).toContain("ingest key");

      const withConfirm = await app.request(`/api/members/${created.id}?confirm=true`, { method: "DELETE", headers: { "X-Dev-User": operatorEmail } });
      expect(withConfirm.status).toBe(204);

      const [sourceAfter] = await handle.db.select().from(schema.source).where(eq(schema.source.id, source!.id));
      expect(sourceAfter?.assignedKeyId).toBeNull();
      expect(sourceAfter?.health).toEqual({ ok: false, reason: "ingest key owner deleted" });
    } finally {
      await handle.db.delete(schema.source).where(eq(schema.source.id, source!.id));
    }
  });
});
