import { createDb, schema, type DbHandle } from "@feedhound/db";
import { and, desc, eq, gt } from "drizzle-orm";
import { afterAll, describe, expect, test } from "bun:test";
import { METRICS_CONTENT_TYPE } from "@feedhound/core/metrics";
import { createBotApp, createBotMetrics, runPollLoop } from "./index";
import type { TelegramApiClient, TelegramUpdate } from "./telegram-api";

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
    console.warn(`bot index.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("bot index.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("bot index.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("createBotApp /healthz /readyz", () => {
  const handles: DbHandle[] = [];
  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close()));
  });

  test("/healthz is always 200 { ok: true } even when the DB is down", async () => {
    const down = createDb("postgres://x@127.0.0.1:1/feedhound_test");
    handles.push(down);
    const app = createBotApp(down);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("/readyz is 503 with checks.db = fail within 1.5s when the DB is down", async () => {
    const down = createDb("postgres://x@127.0.0.1:1/feedhound_test");
    handles.push(down);
    const app = createBotApp(down);
    const start = Date.now();
    const res = await app.request("/readyz");
    const elapsed = Date.now() - start;
    expect(res.status).toBe(503);
    expect(elapsed).toBeLessThan(1_500);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, string> };
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe("fail");
  });

  test("/readyz is 200 with every check ok against a reachable DB", async () => {
    const handle = createDb(TEST_DATABASE_URL);
    handles.push(handle);
    const app = createBotApp(handle);
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ db: "ok", accepting: "ok" });
  });
});

describe.skipIf(!canRun)("bot /metrics", () => {
  test("serves poll liveness and error counter; /healthz and /readyz unchanged", async () => {
    const handle = createDb(TEST_DATABASE_URL);
    try {
      const m = createBotMetrics();
      const t = new Date("2026-10-03T00:00:00Z");
      m.pollOk(t);
      m.pollError();
      m.pollError();
      const app = createBotApp(handle, m.registry);
      const res = await app.request("/metrics");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);
      const body = await res.text();
      expect(body).toContain(`bot_poll_last_ok_timestamp_seconds ${t.getTime() / 1000}`);
      expect(body).toContain("bot_poll_errors_total 2");
      expect((await app.request("/healthz")).status).toBe(200);
      expect((await app.request("/readyz")).status).toBe(200);
      // Without a registry there is no /metrics route.
      expect((await createBotApp(handle).request("/metrics")).status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe.skipIf(!canRun)("bot runPollLoop offset persistence", () => {
  const KEY = "bot.telegram.updateOffset";
  const metrics = { pollOk: () => undefined, pollError: () => undefined };
  const noop = async (): Promise<void> => undefined;

  function fakeApi(batches: TelegramUpdate[][]): TelegramApiClient {
    return {
      getUpdates: async () => batches.shift() ?? [],
      setMyCommands: noop,
      answerCallbackQuery: noop,
      editMessageReplyMarkup: noop,
      sendMessage: noop,
    };
  }

  async function state(handle: DbHandle): Promise<{ n: number; max: number; value: unknown }> {
    const rows = await handle.db.select().from(schema.config).where(eq(schema.config.key, KEY)).orderBy(desc(schema.config.version));
    return { n: rows.length, max: rows[0]?.version ?? 0, value: rows[0]?.value };
  }

  test("empty polls write no config rows; one update writes exactly one row (offset = update_id + 1)", async () => {
    const handle = createDb(TEST_DATABASE_URL);
    const before = await state(handle);
    try {
      await runPollLoop(handle, () => undefined, metrics, { api: fakeApi([]), maxCycles: 100 });
      expect((await state(handle)).n).toBe(before.n);

      await runPollLoop(handle, () => undefined, metrics, { api: fakeApi([[{ update_id: 500 }]]), maxCycles: 100 });
      const after = await state(handle);
      expect(after.n).toBe(before.n + 1);
      expect(after.max).toBe(before.max + 1);
      expect(after.value).toBe(501);
    } finally {
      // config is append-only: remove only the rows this test added.
      await handle.db.delete(schema.config).where(and(eq(schema.config.key, KEY), gt(schema.config.version, before.max)));
      await handle.close();
    }
  });
});
