import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
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
    console.warn(`ops-dlq.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("ops-dlq.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("ops-dlq.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("POST /api/ops/dlq/:queue/retry", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  // Queue names are validated against `/^[a-z_]{1,64}$/` -
  // letters and underscores only, no digits.
  const queueSuffix = suffix.replace(/[0-9]/g, "q");
  const QUEUE = `tzero_retry_${queueSuffix}`;
  const DLQ_QUEUE = `${QUEUE}_dlq`;

  let handle: DbHandle;
  let boss: PgBoss;
  let teamId: string;
  let userId: string;
  let opsKeyToken: string;
  let noScopeKeyToken: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();
    await boss.createQueue(QUEUE);
    await boss.createQueue(DLQ_QUEUE);
    await boss.updateQueue(QUEUE, { deadLetter: DLQ_QUEUE });

    const [team] = await handle.db.insert(schema.team).values({ name: `ops-dlq-test-${suffix}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `ops-dlq-${suffix}@example.com`, role: "operator" }).returning({ id: schema.user.id });
    userId = user!.id;

    opsKeyToken = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: user!.id,
      name: "ops",
      prefix: opsKeyToken.slice(0, 8),
      hash: await sha256Hex(opsKeyToken),
      scopes: ["ops"],
    });

    noScopeKeyToken = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: user!.id,
      name: "no-scope",
      prefix: noScopeKeyToken.slice(0, 8),
      hash: await sha256Hex(noScopeKeyToken),
      scopes: ["ingest"],
    });

    for (let i = 0; i < 3; i++) {
      await boss.send(QUEUE, { i });
    }
    // Move the 3 jobs straight into the DLQ (mirrors what a failed retry
    // ladder does): fetch off `QUEUE`, insert into `DLQ_QUEUE`, complete on `QUEUE`.
    const jobs = await boss.fetch<object>(QUEUE, { batchSize: 10 });
    for (const job of jobs) {
      await boss.send(DLQ_QUEUE, job.data);
    }
    await boss.complete(
      QUEUE,
      jobs.map((j) => j.id),
    );
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await handle.sql`delete from pgboss.job where name in (${QUEUE}, ${DLQ_QUEUE})`;
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("200 retries `limit` jobs and reports remaining", async () => {
    const app = createApp(handle, boss);
    const res = await app.request(`/api/ops/dlq/${QUEUE}/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${opsKeyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ limit: 2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queue: string; retried: number; deduped: number; remaining: number };
    expect(body).toEqual({ queue: QUEUE, retried: 2, deduped: 0, remaining: 1 });

    const requeued = await handle.sql<{ count: string }[]>`select count(*) from pgboss.job where name = ${QUEUE} and state in ('created', 'retry')`;
    expect(Number(requeued[0]!.count)).toBe(2);
  });

  test("401 without an api key", async () => {
    const app = createApp(handle, boss);
    const res = await app.request(`/api/ops/dlq/${QUEUE}/retry`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("403 with a key lacking the ops scope", async () => {
    const app = createApp(handle, boss);
    const res = await app.request(`/api/ops/dlq/${QUEUE}/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${noScopeKeyToken}` },
    });
    expect(res.status).toBe(403);
  });

  test("404 for an unknown queue", async () => {
    const app = createApp(handle, boss);
    const res = await app.request("/api/ops/dlq/nope/retry", {
      method: "POST",
      headers: { authorization: `Bearer ${opsKeyToken}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("503 when the api has no boss", async () => {
    const app = createApp(handle, undefined);
    const res = await app.request(`/api/ops/dlq/${QUEUE}/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${opsKeyToken}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(503);
  });

  test("400 for a bad queue name", async () => {
    const app = createApp(handle, boss);
    const res = await app.request("/api/ops/dlq/Not-Valid!/retry", {
      method: "POST",
      headers: { authorization: `Bearer ${opsKeyToken}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  test("400 for malformed JSON body (not silently defaulted)", async () => {
    const app = createApp(handle, boss);
    const res = await app.request(`/api/ops/dlq/${QUEUE}/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${opsKeyToken}`, "content-type": "application/json" },
      body: '{"limit": 2',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation");
  });
});
