import { createDb, type DbHandle } from "@feedhound/db";
import { afterAll, describe, expect, test } from "bun:test";
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
    console.warn(`healthz.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("healthz.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("healthz.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("GET /healthz, /readyz", () => {
  const handles: DbHandle[] = [];
  let boss: PgBoss;

  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
    await Promise.all(handles.map((h) => h.close()));
  });

  test("/healthz is always 200 { ok: true } even when the DB is down", async () => {
    const down = createDb("postgres://x@127.0.0.1:1/feedhound_test");
    handles.push(down);
    const app = createApp(down, undefined);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("/healthz reports APP_VERSION", async () => {
    const down = createDb("postgres://x@127.0.0.1:1/feedhound_test");
    handles.push(down);
    const prev = process.env.APP_VERSION;
    process.env.APP_VERSION = "v9.9.9";
    try {
      const res = await createApp(down, undefined).request("/healthz");
      expect(((await res.json()) as { version: string }).version).toBe("v9.9.9");
    } finally {
      if (prev === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = prev;
    }
  });

  test("/readyz is 503 with checks.db = fail within 1.5s when the DB is down", async () => {
    const down = createDb("postgres://x@127.0.0.1:1/feedhound_test");
    handles.push(down);
    const app = createApp(down, undefined);
    const start = Date.now();
    const res = await app.request("/readyz");
    const elapsed = Date.now() - start;
    expect(res.status).toBe(503);
    expect(elapsed).toBeLessThan(1_500);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, string> };
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("fail");
  });

  test("/readyz is 200 with every check ok against a reachable DB and a started boss", async () => {
    const handle = createDb(TEST_DATABASE_URL);
    handles.push(handle);
    boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();
    const app = createApp(handle, boss);
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ db: "ok", boss: "ok", queue: "ok", accepting: "ok" });
  });
});
