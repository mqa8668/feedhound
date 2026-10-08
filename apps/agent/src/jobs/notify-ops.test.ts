import { createDb, schema, type DbHandle } from "@feedhound/db";
import { createTelegramNotifier } from "@feedhound/bot/notifiers";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { and, desc, eq, inArray } from "drizzle-orm";
import { RateLimiter } from "../lib/rate-limit";
import { enqueueOpsNotification, flushPendingOpsNotifications, type NotifierMap, type NotifyRunDeps } from "./notify";
import { runNotifyHealthCheck } from "./notify-health";
import { TelegramMock } from "../../../../tests/helpers/telegram-mock";

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
    console.warn(`notify-ops.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("notify-ops.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("notify-ops.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("notify_ops / notify_health (ops part)", () => {
  let handle: DbHandle;
  let mock: TelegramMock;
  let notifiers: NotifierMap;
  let teamId: string;
  let operatorId: string;
  let opsNotifierChatId: number;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    mock = new TelegramMock();
    notifiers = { telegram: createTelegramNotifier({ botToken: "test", apiBase: mock.baseUrl }) };
    const [team] = await handle.db.insert(schema.team).values({ name: `notify-ops-test-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [operator] = await handle.db.insert(schema.user).values({ teamId, email: `ops-${crypto.randomUUID()}@example.com`, role: "operator" }).returning({ id: schema.user.id });
    operatorId = operator!.id;
    opsNotifierChatId = Math.floor(Math.random() * 1_000_000_000);
    await handle.db.insert(schema.notifier).values({ userId: operatorId, kind: "telegram", config: { chatId: opsNotifierChatId, mode: "instant" }, enabled: true });

    const [latest] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, "notify.ops.chatId")).orderBy(desc(schema.config.version)).limit(1);
    await handle.db.insert(schema.config).values({ key: "notify.ops.chatId", version: (latest?.version ?? 0) + 1, value: opsNotifierChatId, updatedBy: "test" });
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, operatorId));
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.userId, operatorId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, operatorId));
    await handle.db.delete(schema.config).where(and(eq(schema.config.updatedBy, "test"), eq(schema.config.key, "notify.ops.chatId")));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
    await mock.close();
  });

  afterEach(() => {
    mock.calls.length = 0;
    mock.resetScripts();
  });

  function deps(now?: Date): NotifyRunDeps {
    return { handle, notifiers, rateLimiter: new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100_000, globalPerSec: 100_000 }), now };
  }

  test("enqueueOpsNotification dedupes by dedupeKey within ttlSec, sends once", async () => {
    const now = new Date();
    const status1 = await enqueueOpsNotification(handle, operatorId, { kind: "source_silent", text: "source X silent", dedupeKey: "dedupe-test-1", ttlSec: 3_600 }, now);
    expect(status1).toBe("pending");
    await flushPendingOpsNotifications(deps(now), { userId: operatorId });
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    // A second alert with the same dedupeKey, before ttl expires, is skipped (no new send).
    const status2 = await enqueueOpsNotification(handle, operatorId, { kind: "source_silent", text: "source X silent again", dedupeKey: "dedupe-test-1", ttlSec: 3_600 }, new Date(now.getTime() + 1_000));
    expect(status2).toBe("skipped");
    await flushPendingOpsNotifications(deps(now), { userId: operatorId });
    expect(mock.callsFor("sendMessage")).toHaveLength(1); // still just the one send
  });

  // dedupe must also cover an outstanding (`pending`/`sending`)
  // row, not just a `sent` one within `ttlSec` — two enqueue calls with the same
  // dedupeKey before the first has been flushed (e.g. two `notify_health` ticks 10 min
  // apart, before the periodic ops flush ran) must not both become `pending` and fire
  // side by side once flushed.
  test("A second enqueue with the same dedupeKey before the first is flushed is skipped, not duplicated", async () => {
    const dedupeKey = `dedupe-pending-${crypto.randomUUID()}`;
    const now = new Date();

    const status1 = await enqueueOpsNotification(handle, operatorId, { kind: "notify_failure_rate", text: "rate high", dedupeKey, ttlSec: 3_600 }, now);
    expect(status1).toBe("pending");

    // A second trigger for the same key arrives before anything flushed the first row.
    const status2 = await enqueueOpsNotification(handle, operatorId, { kind: "notify_failure_rate", text: "rate high again", dedupeKey, ttlSec: 3_600 }, new Date(now.getTime() + 1_000));
    expect(status2).toBe("skipped");

    const rows = await handle.db
      .select()
      .from(schema.notification)
      .where(and(eq(schema.notification.channel, "ops"), eq(schema.notification.userId, operatorId)));
    const matching = rows.filter((r) => r.payload.ops?.dedupeKey === dedupeKey);
    expect(matching).toHaveLength(2); // one pending (audit) + one skipped (audit)
    expect(matching.filter((r) => r.status === "pending")).toHaveLength(1);

    await flushPendingOpsNotifications(deps(now), { userId: operatorId });
    expect(mock.callsFor("sendMessage")).toHaveLength(1); // exactly one send, not two

    await handle.db.delete(schema.notification).where(inArray(schema.notification.id, matching.map((r) => r.id)));
  });

  // ops part: >10% failed over the last hour with >=10 samples -> exactly one ops alert
  // across two runs within 1h (dedupe via notify_failure_rate key).
  test("notify_health fires once for a sustained failure rate, deduped on a second run", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `hu-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const now = new Date();
    const rows = Array.from({ length: 10 }, (_, i) => ({
      userId,
      channel: "telegram",
      status: i < 3 ? "sent" : "failed",
      sentAt: i < 3 ? now : null,
      failedAt: i < 3 ? null : now,
      payload: {},
    }));
    await handle.db.insert(schema.notification).values(rows);

    // Pin the ops recipient (shared resolver: config email, then SEED_OPERATOR_EMAIL) to this file's operator.
    const [op] = await handle.db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, operatorId));
    const prevSeedEmail = process.env.SEED_OPERATOR_EMAIL;
    process.env.SEED_OPERATOR_EMAIL = op!.email;
    try {
      const fired1 = await runNotifyHealthCheck(handle, now);
      expect(fired1).toBe(true);
      // Dedupe checks for a `sent` ops row, so flush the one just enqueued
      // before the second, otherwise-triggering, run.
      await flushPendingOpsNotifications(deps(now), { userId: operatorId, dedupeKeyPrefix: "notify_failure_rate" });
      const fired2 = await runNotifyHealthCheck(handle, new Date(now.getTime() + 60_000));
      expect(fired2).toBe(false); // deduped

      // The second run still inserts a `skipped` audit row ("insert ... skip"),
      // so assert on the actual Telegram send count, not the notification row count.
      const opsRows = await handle.db
        .select()
        .from(schema.notification)
        .where(and(eq(schema.notification.channel, "ops"), eq(schema.notification.userId, operatorId)));
      const failureRateRows = opsRows.filter((r) => r.payload.ops?.dedupeKey === "notify_failure_rate");
      expect(failureRateRows.filter((r) => r.status === "sent")).toHaveLength(1);
      expect(mock.callsFor("sendMessage")).toHaveLength(1);
    } finally {
      if (prevSeedEmail === undefined) delete process.env.SEED_OPERATOR_EMAIL;
      else process.env.SEED_OPERATOR_EMAIL = prevSeedEmail;
      // The operator's `sent` notify_failure_rate row would otherwise survive and
      // dedupe the next run's first fire (1h window), failing it.
      await handle.sql`delete from notification where channel = 'ops' and payload -> 'ops' ->> 'dedupeKey' = 'notify_failure_rate'`;
      await handle.db.delete(schema.notification).where(inArray(schema.notification.userId, [userId]));
      await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    }
  });

  // a retryable failure on an ops row must go through the same
  // `notify.retry.delaysSec` ladder as an alert row (rules 5-7 apply), not fail
  // permanently on the first transient error; the finalize update must also be guarded by
  // `status = 'sending'` so a concurrent reclaim cannot clobber it.
  test("A retryable ops send failure goes through the retry ladder instead of failing outright", async () => {
    const now = new Date();
    const dedupeKey = `dedupe-retry-${crypto.randomUUID()}`;
    await enqueueOpsNotification(handle, operatorId, { kind: "queue_backlog", text: "backlog high", dedupeKey, ttlSec: 3_600 }, now);

    mock.script("sendMessage", { status: 500 });
    await flushPendingOpsNotifications(deps(now), { userId: operatorId });
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    const opsRows = await handle.db.select().from(schema.notification).where(and(eq(schema.notification.channel, "ops"), eq(schema.notification.userId, operatorId)));
    const row = opsRows.find((r) => r.payload.ops?.dedupeKey === dedupeKey);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row!.nextAttemptAt!.getTime() - now.getTime()).toBe(5_000);

    // Retry once due: succeeds.
    mock.calls.length = 0;
    mock.resetScripts();
    mock.script("sendMessage", { status: 200 });
    await flushPendingOpsNotifications(deps(row!.nextAttemptAt!), { userId: operatorId });
    expect(mock.callsFor("sendMessage")).toHaveLength(1);
    const [after] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, row!.id)).limit(1);
    expect(after?.status).toBe("sent");

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, row!.id));
  });

  async function insertPending(payload: schema.NotificationPayload, createdAt?: Date): Promise<string> {
    const [row] = await handle.db.insert(schema.notification).values({ userId: operatorId, channel: "ops", status: "pending", payload, ...(createdAt ? { createdAt } : {}) }).returning({ id: schema.notification.id });
    return row!.id;
  }
  async function statusOf(id: string): Promise<{ status: string; lastError: string | null }> {
    const [r] = await handle.db.select({ status: schema.notification.status, lastError: schema.notification.lastError }).from(schema.notification).where(eq(schema.notification.id, id)).limit(1);
    return r!;
  }

  test("chat unset settles every pending ops row as skipped, nothing sent", async () => {
    const [latest] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, "notify.ops.chatId")).orderBy(desc(schema.config.version)).limit(1);
    await handle.db.insert(schema.config).values({ key: "notify.ops.chatId", version: (latest?.version ?? 0) + 1, value: "", updatedBy: "test-unset" });
    try {
      const ids = [
        await insertPending({ ops: { kind: "dlq", text: "a", dedupeKey: "k1" } }),
        await insertPending({ ops: { text: "no kind" } }),
        await insertPending({ rule: "legacy_rule", message: "legacy msg" }),
      ];
      await flushPendingOpsNotifications(deps(new Date()), { userId: operatorId });
      for (const id of ids) expect(await statusOf(id)).toEqual({ status: "skipped", lastError: "notify.ops.chatId unset" });
      expect(mock.callsFor("sendMessage")).toHaveLength(0);
      await handle.db.delete(schema.notification).where(inArray(schema.notification.id, ids));
    } finally {
      await handle.db.delete(schema.config).where(eq(schema.config.updatedBy, "test-unset"));
    }
  });

  test("chat set: 25h-old pending row is stale-skipped, legacy row is sent as kind=rule text=message, no hostname", async () => {
    const now = new Date();
    const oldId = await insertPending({ ops: { kind: "dlq", text: "old" } }, new Date(now.getTime() - 25 * 3_600_000));
    const legacyId = await insertPending({ rule: "legacy_rule", message: "legacy msg" });
    const weirdId = await insertPending({ at: "x" });
    await flushPendingOpsNotifications(deps(now), { userId: operatorId });
    expect(await statusOf(oldId)).toEqual({ status: "skipped", lastError: "stale" });
    expect(await statusOf(legacyId)).toMatchObject({ status: "sent" });
    expect(await statusOf(weirdId)).toEqual({ status: "skipped", lastError: "unsupported ops payload" });
    const sends = mock.callsFor("sendMessage");
    expect(sends).toHaveLength(1);
    const text = String((sends[0] as { body?: { text?: string } }).body?.text ?? "");
    expect(text).toMatch(/^<b>\[ops\] legacy_rule<\/b>\nlegacy msg\n<i>\d{4}-/);
    expect(text).not.toContain(hostname());
    await handle.db.delete(schema.notification).where(inArray(schema.notification.id, [oldId, legacyId, weirdId]));
  });
});
