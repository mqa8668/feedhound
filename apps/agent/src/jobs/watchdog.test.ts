import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import { insertOpsAlert, runCoverageRollup, runWatchdog, type WatchdogConfig } from "./watchdog";

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
    console.warn(`watchdog.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("watchdog.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("watchdog.test.ts: skipped — TEST_DATABASE_URL is unset");
}

// Fixed UTC instant that is 12:00 in Asia/Ho_Chi_Minh (UTC+7) -> inside 07:00-23:00,
// and 02:00 in Asia/Ho_Chi_Minh -> outside 07:00-23:00 (used by shifting -10h).
const NOON_VN = new Date("2026-01-15T05:00:00.000Z");
const NIGHT_VN = new Date("2026-01-15T19:00:00.000Z"); // 02:00 next day in VN
// 09:00-10:00 in Asia/Ho_Chi_Minh -> a UTC-hour bucket fully inside 07:00-23:00.
const H = new Date("2026-01-15T02:00:00.000Z");

const CONFIG: WatchdogConfig = {
  tz: "Asia/Ho_Chi_Minh",
  activeHours: { start: "07:00", end: "23:00" },
  gapMultiplier: 1.5,
  gapGraceSec: 5 * 60,
  fallbackIntervalSec: 4800,
  visitEveryMaxSec: 2700,
  activeWindowSec: 57600,
};

// Interval 3600s (60 min): threshold = 3600 * 1.5 + 300 = 5700s = 95 min.
const INTERVAL_SEC = 3600;

describe.skipIf(!canRun)("runWatchdog / runCoverageRollup (integration, fake clock)", () => {
  let handle: DbHandle;
  let teamId: string;
  let operatorUserId: string;
  const runSourceIds: string[] = [];

  async function makeSource(overrides: Partial<typeof schema.source.$inferInsert>): Promise<string> {
    const [row] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "push",
        platformId: `wd-${crypto.randomUUID()}`,
        name: "Watchdog test source",
        url: `https://example.com/wd-${crypto.randomUUID()}`,
        ...overrides,
      })
      .returning({ id: schema.source.id });
    runSourceIds.push(row!.id);
    return row!.id;
  }

  async function opsAlertCount(): Promise<number> {
    const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.userId, operatorUserId));
    return rows.length;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `watchdog-test-team-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [operator] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `watchdog-test-${crypto.randomUUID()}@example.com`, role: "operator" })
      .returning({ id: schema.user.id });
    operatorUserId = operator!.id;
  });

  afterAll(async () => {
    if (runSourceIds.length > 0) {
      await handle.sql`delete from metric_rollup where dims->>'sourceId' = any(${runSourceIds})`;
    }
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, operatorUserId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("95 min gap on a 60 min interval -> exactly one alert; 94 min -> none", async () => {
    const lastOkVisitAt = new Date(NOON_VN.getTime() - 95 * 60_000);
    const sourceId = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt });

    const before = await opsAlertCount();
    const result = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [sourceId] });
    expect(result.alerted).toBe(1);
    expect(await opsAlertCount()).toBe(before + 1);

    const [refreshed] = await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId));
    expect(refreshed?.watchdogAlertAt?.getTime()).toBe(NOON_VN.getTime());

    const sourceId94 = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt: new Date(NOON_VN.getTime() - 94 * 60_000) });
    const before94 = await opsAlertCount();
    const result94 = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [sourceId94] });
    expect(result94.alerted).toBe(0);
    expect(await opsAlertCount()).toBe(before94);
  });

  test("Already-alerted source with no new ok visit -> no further alert on the next run", async () => {
    const lastOkVisitAt = new Date(NOON_VN.getTime() - 95 * 60_000);
    const sourceId = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt });

    const first = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [sourceId] });
    expect(first.alerted).toBe(1);

    const before = await opsAlertCount();
    const second = await runWatchdog({ handle, now: new Date(NOON_VN.getTime() + 60_000), config: CONFIG, sourceIds: [sourceId] });
    expect(second.alerted).toBe(0);
    expect(await opsAlertCount()).toBe(before);
  });

  test("Recovery clears the gap and alerts once; a new 95 min gap afterwards alerts again", async () => {
    const lastOkVisitAt = new Date(NOON_VN.getTime() - 95 * 60_000);
    const sourceId = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt });

    const alertRun = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [sourceId] });
    expect(alertRun.alerted).toBe(1);

    const recoveredAt = new Date(NOON_VN.getTime() + 5 * 60_000);
    await handle.db.update(schema.source).set({ lastOkVisitAt: recoveredAt }).where(eq(schema.source.id, sourceId));

    const before = await opsAlertCount();
    const recoveryRun = await runWatchdog({ handle, now: new Date(recoveredAt.getTime() + 60_000), config: CONFIG, sourceIds: [sourceId] });
    expect(recoveryRun.recovered).toBe(1);
    expect(await opsAlertCount()).toBe(before + 1);

    const [afterRecovery] = await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId));
    expect(afterRecovery?.watchdogAlertAt).toBeNull();

    // A fresh 95-minute gap after the recovery alerts once again.
    const now2 = new Date(recoveredAt.getTime() + 95 * 60_000 + 60_000);
    const before2 = await opsAlertCount();
    const secondGapRun = await runWatchdog({ handle, now: now2, config: CONFIG, sourceIds: [sourceId] });
    expect(secondGapRun.alerted).toBe(1);
    expect(await opsAlertCount()).toBe(before2 + 1);
  });

  test("watchdog half: paused_by_health source silent 95 min is alerted with 'paused_by_health' in the text; a user-paused source with the same silence is not alerted", async () => {
    const lastOkVisitAt = new Date(NOON_VN.getTime() - 95 * 60_000);
    const healthSourceId = await makeSource({
      expectedIntervalSec: INTERVAL_SEC,
      lastOkVisitAt,
      status: "paused_by_health",
      health: { ok: false, reason: "http_403" },
    });
    const pausedSourceId = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt, status: "paused" });

    const beforeIds = new Set(
      (await handle.db.select({ id: schema.notification.id }).from(schema.notification).where(eq(schema.notification.userId, operatorUserId))).map((r) => r.id),
    );
    const result = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [healthSourceId, pausedSourceId] });
    expect(result.alerted).toBe(1);
    expect(result.checked).toBe(1); // only the paused_by_health source is scanned

    const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.userId, operatorUserId));
    const newRows = rows.filter((r) => !beforeIds.has(r.id)); // heap order is unspecified; diff by id
    expect(newRows.length).toBe(1);
    const text = JSON.stringify((newRows[0]?.payload as { ops?: { text?: string } } | null)?.ops?.text ?? "");
    expect(text).toContain("paused_by_health");
  });

  test("silent source outside active hours -> not checked, no alert", async () => {
    const sourceId = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt: new Date(NIGHT_VN.getTime() - 95 * 60_000) });
    const before = await opsAlertCount();
    const result = await runWatchdog({ handle, now: NIGHT_VN, config: CONFIG, sourceIds: [sourceId] });
    expect(result.checked).toBe(0);
    expect(result.alerted).toBe(0);
    expect(await opsAlertCount()).toBe(before);
  });

  test("web source silent past threshold is skipped when webEnabled=false, alerts when true; push alerts in both", async () => {
    const lastOkVisitAt = new Date(NOON_VN.getTime() - 95 * 60_000);
    const webId = await makeSource({ kind: "web", expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt });

    const before = await opsAlertCount();
    const off = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [webId], webEnabled: false });
    expect(off.checked).toBe(0);
    expect(off.alerted).toBe(0);
    expect(await opsAlertCount()).toBe(before);

    const pushId = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt });
    const offPush = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [pushId], webEnabled: false });
    expect(offPush.alerted).toBe(1);

    const on = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [webId], webEnabled: true });
    expect(on.checked).toBe(1);
    expect(on.alerted).toBe(1);
    expect(await opsAlertCount()).toBe(before + 2);

    const push2 = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt });
    expect((await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [push2], webEnabled: true })).alerted).toBe(1);
  });

  test("Coverage rollup for a full active hour with 2 ok visits, 1 error visit, 3 posts -> one metric_rollup row; re-running is idempotent", async () => {
    const sourceId = await makeSource({ expectedIntervalSec: 1800 });

    async function insertVisit(startedAt: Date, outcome: string): Promise<void> {
      await handle.db.insert(schema.visit).values({ id: crypto.randomUUID(), sourceId, startedAt, finishedAt: startedAt, outcome });
    }
    await insertVisit(new Date(H.getTime() + 5 * 60_000), "ok");
    await insertVisit(new Date(H.getTime() + 35 * 60_000), "ok");
    await insertVisit(new Date(H.getTime() + 45 * 60_000), "error");

    async function insertPost(platformPostId: string, firstSeenAt: Date): Promise<void> {
      await handle.db.insert(schema.post).values({ sourceId, platformPostId, url: `https://example.com/p/${platformPostId}`, firstSeenAt, lastSeenAt: firstSeenAt });
    }
    await insertPost("cov-p1", new Date(H.getTime() + 10 * 60_000));
    await insertPost("cov-p2", new Date(H.getTime() + 20 * 60_000));
    await insertPost("cov-p3", new Date(H.getTime() + 30 * 60_000));

    const now = new Date(H.getTime() + 61 * 60_000);
    const result = await runCoverageRollup({ handle, now, config: CONFIG, sourceIds: [sourceId] });
    expect(result.rows).toBeGreaterThanOrEqual(1);

    const rows = await handle.db
      .select()
      .from(schema.metricRollup)
      .where(and(eq(schema.metricRollup.bucket, "hour"), eq(schema.metricRollup.ts, H), sql`${schema.metricRollup.dims}->>'sourceId' = ${sourceId}`));
    expect(rows.length).toBe(1);
    expect(rows[0]?.counts).toEqual({ visits_expected: 2, visits_ok: 2, visits_complete: 0, posts_new: 3 });

    await runCoverageRollup({ handle, now, config: CONFIG, sourceIds: [sourceId] });
    const rowsAfter = await handle.db
      .select()
      .from(schema.metricRollup)
      .where(and(eq(schema.metricRollup.bucket, "hour"), eq(schema.metricRollup.ts, H), sql`${schema.metricRollup.dims}->>'sourceId' = ${sourceId}`));
    expect(rowsAfter.length).toBe(1);
    expect(rowsAfter[0]?.counts).toEqual({ visits_expected: 2, visits_ok: 2, visits_complete: 0, posts_new: 3 });

    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, sourceId));
  });

  test("code-review parity: a source with no expectedIntervalSec uses fallbackIntervalSec", async () => {
    const sourceId = await makeSource({ lastOkVisitAt: new Date(NOON_VN.getTime() - CONFIG.fallbackIntervalSec * 1.5 * 1000 - CONFIG.gapGraceSec * 1000 - 1000) });
    const result = await runWatchdog({ handle, now: NOON_VN, config: CONFIG, sourceIds: [sourceId] });
    expect(result.alerted).toBe(1);
  });

  test("A failing notification write for one source doesn't lose its slot and doesn't abort the rest of the run", async () => {
    const lastOkVisitAt = new Date(NOON_VN.getTime() - 95 * 60_000);
    const failingSourceId = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt, name: "watchdog-fails-write" });
    const okSourceId = await makeSource({ expectedIntervalSec: INTERVAL_SEC, lastOkVisitAt, name: "watchdog-succeeds" });

    const before = await opsAlertCount();
    const result = await runWatchdog({
      handle,
      now: NOON_VN,
      config: CONFIG,
      sourceIds: [failingSourceId, okSourceId],
      insertOpsAlert: async (h, teamId, text) => {
        if (text.includes(failingSourceId)) throw new Error("injected write failure");
        return insertOpsAlert(h, teamId, text);
      },
    });

    // Only the healthy source's alert lands; the failing source is skipped
    // (not counted, not aborting the loop).
    expect(result.alerted).toBe(1);
    expect(await opsAlertCount()).toBe(before + 1);

    const [failingRefreshed] = await handle.db.select().from(schema.source).where(eq(schema.source.id, failingSourceId));
    // The claim + notification write share a transaction: the failed write
    // rolled the claim back too, so the slot is still open (not consumed).
    expect(failingRefreshed?.watchdogAlertAt).toBeNull();

    const [okRefreshed] = await handle.db.select().from(schema.source).where(eq(schema.source.id, okSourceId));
    expect(okRefreshed?.watchdogAlertAt?.getTime()).toBe(NOON_VN.getTime());
  });

  test("With notify.ops.chatId unset insertOpsAlert writes a skipped row with payload.ops kind and dedupeKey", async () => {
    const [latest] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, "notify.ops.chatId")).orderBy(desc(schema.config.version)).limit(1);
    await handle.db.insert(schema.config).values({ key: "notify.ops.chatId", version: (latest?.version ?? 0) + 1, value: "", updatedBy: "test-wd-unset" });
    try {
      const text = `unset-chat-${crypto.randomUUID()}`;
      await insertOpsAlert(handle, teamId, text);
      const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.userId, operatorUserId));
      const row = rows.find((r) => r.payload.ops?.text === text);
      expect(row?.status).toBe("skipped");
      expect(row?.payload.ops).toEqual({ kind: "watchdog", text, dedupeKey: `watchdog:${teamId}:${text}` });
    } finally {
      await handle.db.delete(schema.config).where(eq(schema.config.updatedBy, "test-wd-unset"));
    }
  });
});
