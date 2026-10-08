import { createDb, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedAnalytics, type SeededAnalytics } from "../../../../scripts/seed-analytics";
import { cleanupTeams } from "../../../../tests/fixtures/analytics/flat-baseline";
import { createApp } from "../index";

// API half: p95 < 300 ms per route over 50 calls. Runs only with PERF=1 against a *_test database.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const enabled = process.env.PERF === "1" && Boolean(TEST_DATABASE_URL) && new URL(TEST_DATABASE_URL ?? "http://x/").pathname.endsWith("_test");

describe.skipIf(!enabled)("analytics routes perf", () => {
  let handle: DbHandle;
  let seeded: SeededAnalytics;
  const prevBypass = process.env.DEV_AUTH_BYPASS;

  beforeAll(async () => {
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    seeded = await seedAnalytics(handle);
  }, 300_000);

  afterAll(async () => {
    if (prevBypass === undefined) delete process.env.DEV_AUTH_BYPASS;
    else process.env.DEV_AUTH_BYPASS = prevBypass;
    await handle.sql`delete from catalog_item where id = ${seeded.itemId}::uuid`;
    await cleanupTeams(handle, [seeded.teamId], [seeded.categoryId]);
    await handle.close();
  }, 300_000);

  test("p95 < 300 ms per route", async () => {
    const now = Date.now();
    const iso = (ms: number): string => new Date(ms).toISOString();
    const day = 86_400_000;
    const routes: Record<string, string> = {
      "volume hour/source 14d": `/api/analytics/volume?bucket=hour&groupBy=source&from=${iso(now - 14 * day)}&to=${iso(now)}`,
      "volume day/none 365d": `/api/analytics/volume?bucket=day&from=${iso(now - 365 * day)}&to=${iso(now)}`,
      price: `/api/analytics/price?itemId=${seeded.itemId}&from=${iso(now - 365 * day)}&to=${iso(now)}`,
      trending: `/api/analytics/trending?window=1h`,
      authors: `/api/analytics/authors?from=${iso(now - 7 * day)}&to=${iso(now)}`,
      funnel: `/api/analytics/funnel?from=${iso(now - 30 * day)}&to=${iso(now)}`,
    };
    const app = createApp(handle);
    for (const [name, path] of Object.entries(routes)) {
      const times: number[] = [];
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now();
        const res = await app.request(path, { headers: { "X-Dev-User": seeded.email } });
        times.push(performance.now() - t0);
        expect(res.status).toBe(200);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.floor(times.length * 0.95) - 1]!;
      console.log(`perf ${name}: p95=${p95.toFixed(1)}ms`);
      expect(p95).toBeLessThan(300);
    }
  }, 300_000);
});
