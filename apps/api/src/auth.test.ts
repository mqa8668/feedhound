import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "./index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// In CI (or whenever TEST_DATABASE_URL is explicitly set) a DB test that can't
// reach its database is a failure, not a skip — otherwise CI can go green
// while silently running zero DB tests.
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
    console.warn(`auth.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    // Guard: confirm we are actually talking to a "*_test" database before
    // any write happens, never trusting the URL string alone. Never skipped.
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
  throw new Error("auth.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("auth.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("apiKeyAuth (integration)", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let scopedKey: string;
  let unscopedKey: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "auth-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `auth-test-${crypto.randomUUID()}@example.com` })
      .returning({ id: schema.user.id });
    userId = user!.id;

    scopedKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    unscopedKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;

    await handle.db.insert(schema.apiKey).values([
      {
        userId,
        name: "scoped",
        prefix: scopedKey.slice(0, 8),
        hash: await sha256Hex(scopedKey),
        scopes: ["ingest"],
      },
      {
        userId,
        name: "unscoped",
        prefix: unscopedKey.slice(0, 8),
        hash: await sha256Hex(unscopedKey),
        scopes: ["other"],
      },
    ]);
  });

  afterAll(async () => {
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("valid key with required scope -> 200", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/ingest/_ping", {
      headers: { Authorization: `Bearer ${scopedKey}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("valid key without required scope -> 403", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/ingest/_ping", {
      headers: { Authorization: `Bearer ${unscopedKey}` },
    });
    expect(res.status).toBe(403);
  });

  test("no key -> 401", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/ingest/_ping");
    expect(res.status).toBe(401);
  });
});
