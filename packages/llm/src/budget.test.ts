import { createDb, type DbHandle } from "@feedhound/db";
import { afterAll, describe, expect, test } from "bun:test";
import { createBudget } from "./budget";

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
let handle: DbHandle | undefined;
if (TEST_DATABASE_URL) {
  handle = createDb(TEST_DATABASE_URL);
  let reachable = true;
  try {
    await handle.sql`select 1`;
  } catch (err) {
    reachable = false;
    if (MUST_RUN) {
      await handle.close();
      throw err;
    }
    console.warn(`budget.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    const rows = await handle.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) {
      await handle.close();
      throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    }
    canRun = true;
  }
} else if (MUST_RUN) {
  throw new Error("budget.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("budget.test.ts: skipped — TEST_DATABASE_URL is unset");
}

// Fixed fake-clock date so every run's bucket lands on the same "day" row
// and cleanup only ever touches rows this file created.
const FAKE_NOW = new Date("2027-03-15T10:00:00.000Z");

describe.skipIf(!canRun)("budget: concurrent recordUsage", () => {
  afterAll(async () => {
    if (!handle) return;
    await handle.sql`delete from metric_rollup where bucket = 'day' and dims = '{"metric":"llm_tokens"}'::jsonb and ts = '2027-03-15T00:00:00.000Z'::timestamptz`;
    await handle.close();
  });

  test("two concurrent first-calls-of-the-day both land in the same row (no undercount)", async () => {
    const h = handle!;
    await h.sql`delete from metric_rollup where bucket = 'day' and dims = '{"metric":"llm_tokens"}'::jsonb and ts = '2027-03-15T00:00:00.000Z'::timestamptz`;

    const budget = createBudget({ handle: h, tz: "UTC", dailyTokenBudget: 1_000_000, budgetAlertPct: 80, now: () => FAKE_NOW });

    // Simulate two workers racing the first `recordUsage` call after
    // midnight -- before the fix, `SELECT ... FOR UPDATE` locked nothing
    // for a non-existent row, so both inserted a separate row and only one
    // was ever read back by `getUsageToday()`'s no-ORDER-BY `limit(1)`.
    await Promise.all([
      budget.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
      budget.recordUsage({ promptTokens: 200, completionTokens: 25, totalTokens: 225 }),
    ]);

    const usage = await budget.getUsageToday();
    expect(usage.total).toBe(375);
    expect(usage.calls).toBe(2);
    expect(usage.prompt).toBe(300);
    expect(usage.completion).toBe(75);

    const rows = await h.sql`select count(*)::int as n from metric_rollup where bucket = 'day' and dims = '{"metric":"llm_tokens"}'::jsonb and ts = '2027-03-15T00:00:00.000Z'::timestamptz`;
    expect(rows[0]?.n).toBe(1);
  });

  test("isExhausted trips once the atomic total reaches the budget", async () => {
    const h = handle!;
    await h.sql`delete from metric_rollup where bucket = 'day' and dims = '{"metric":"llm_tokens"}'::jsonb and ts = '2027-03-15T00:00:00.000Z'::timestamptz`;

    const budget = createBudget({ handle: h, tz: "UTC", dailyTokenBudget: 100, budgetAlertPct: 80, now: () => FAKE_NOW });
    await Promise.all([
      budget.recordUsage({ promptTokens: 40, completionTokens: 10, totalTokens: 50 }),
      budget.recordUsage({ promptTokens: 40, completionTokens: 10, totalTokens: 50 }),
    ]);

    expect(await budget.isExhausted()).toBe(true);
  });
});
