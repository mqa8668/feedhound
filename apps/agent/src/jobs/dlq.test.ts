import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { enqueueOpsNotification } from "./notify";
import { applyDeadLetters, runDlqMonitor } from "./dlq";

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
    console.warn(`dlq.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("dlq.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("dlq.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("dlq (integration)", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const FAIL_QUEUE = `t016_fail_${suffix}`;
  const DLQ_QUEUE = `${FAIL_QUEUE}_dlq`;

  let handle: DbHandle;
  let boss: PgBoss;
  let teamId: string;
  let opsUserId: string;
  let opsChatId: number;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();

    const [team] = await handle.db.insert(schema.team).values({ name: `dlq-test-${suffix}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [operator] = await handle.db.insert(schema.user).values({ teamId, email: `dlq-test-${suffix}@example.com`, role: "operator" }).returning({ id: schema.user.id });
    opsUserId = operator!.id;

    // The dedupe relies on `enqueueOpsNotification` treating repeat calls
    // within the ttl window as duplicates, which only happens once
    // `notify.ops.chatId` is set (unset -> every row is inserted "skipped",
    // never deduped). Restored in afterAll (shared-DB hygiene).
    opsChatId = Math.floor(Math.random() * 1_000_000_000);
    const [latest] = await handle.db
      .select({ version: schema.config.version })
      .from(schema.config)
      .where(eq(schema.config.key, "notify.ops.chatId"))
      .orderBy(desc(schema.config.version))
      .limit(1);
    await handle.db.insert(schema.config).values({ key: "notify.ops.chatId", version: (latest?.version ?? 0) + 1, value: opsChatId, updatedBy: "test" });

    await boss.createQueue(FAIL_QUEUE, { retryLimit: 1, retryDelay: 0, expireInSeconds: 5 });
    await boss.work(FAIL_QUEUE, async () => {
      throw new Error("t016 always fails");
    });
  });

  afterAll(async () => {
    try {
      // Delete the queues themselves (not just their jobs): a leftover queue
      // keeps a stale cached queued_count that later makes every
      // `countDeadLetters` run see a non-empty DLQ.
      await boss.deleteQueue(FAIL_QUEUE).catch(() => undefined);
      await boss.deleteQueue(DLQ_QUEUE).catch(() => undefined);
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
    await handle.sql`delete from pgboss.job where name in (${FAIL_QUEUE}, ${DLQ_QUEUE})`;
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, opsUserId));
    await handle.db.delete(schema.config).where(and(eq(schema.config.updatedBy, "test"), eq(schema.config.key, "notify.ops.chatId")));
    await handle.db.delete(schema.user).where(eq(schema.user.id, opsUserId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test(
    "ApplyDeadLetters wires every non-_dlq queue's deadLetter, and a failing job lands in <queue>_dlq with identical data",
    async () => {
      await applyDeadLetters(boss);
      const queues = await boss.getQueues();
      for (const q of queues) {
        // pg-boss's own `__pgboss__*` queues exist on a freshly created DB and are skipped by applyDeadLetters.
        if (q.name.endsWith("_dlq") || q.name.startsWith("__pgboss__")) continue;
        expect(q.deadLetter).toBe(`${q.name}_dlq`);
      }

      await boss.send(FAIL_QUEUE, { hello: "world" });

      let dlqRows: { data: unknown }[] = [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        dlqRows = await handle.sql<{ data: unknown }[]>`select data from pgboss.job where name = ${DLQ_QUEUE} and state = 'created'`;
        if (dlqRows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      expect(dlqRows.length).toBe(1);
      expect(dlqRows[0]!.data).toEqual({ hello: "world" });
    },
    20_000,
  );

  test("dlq_monitor raises at most one ops Notification per queue per interval", async () => {
    const dedupeKey = `dlq:${FAIL_QUEUE}`;
    let now = new Date("2026-01-01T00:00:00.000Z");
    const send = async (kind: string, text: string, key: string, ttlSec: number) => {
      // Only alert on this test's own queue; other DLQs in the shared DB are not ours.
      if (key !== dedupeKey) return;
      await enqueueOpsNotification(handle, opsUserId, { kind, text, dedupeKey: key, ttlSec }, now);
    };

    await runDlqMonitor({ boss, handle, send }); // t0 -> new "pending" alert
    // Simulates the notify_ops_flush cron, which in production
    // sends this row well within the 30 min gap below, turning it "sent".
    // enqueueOpsNotification's own dedupe is exercised elsewhere (004); this
    // test only exercises dlq_monitor's one-call-per-non-empty-DLQ behaviour.
    await handle.sql`
      update notification set status = 'sent', sent_at = ${now.toISOString()}
      where user_id = ${opsUserId} and channel = 'ops' and payload -> 'ops' ->> 'dedupeKey' = ${dedupeKey} and status = 'pending'
    `;

    now = new Date(now.getTime() + 30 * 60_000);
    await runDlqMonitor({ boss, handle, send }); // t0+30min: within the 60min ttl -> deduped ("skipped")

    now = new Date(now.getTime() + 31 * 60_000);
    await runDlqMonitor({ boss, handle, send }); // t0+61min: outside the ttl -> new alert

    const rows = await handle.sql<{ status: string; text: string }[]>`
      select status, payload -> 'ops' ->> 'text' as text from notification
      where channel = 'ops' and payload -> 'ops' ->> 'dedupeKey' = ${dedupeKey}
    `;
    const alerts = rows.filter((r) => r.status !== "skipped");
    expect(alerts.length).toBe(2);
    for (const row of alerts) {
      expect(row.text).toContain(FAIL_QUEUE);
      expect(row.text).toContain("Retry: POST /api/ops/dlq/");
    }

    // Clean up now, not just in `afterAll`: a "pending" row left behind here
    // is picked up by any *other* test file's `flushPendingOpsNotifications`
    // call (a global scan, not scoped to `opsUserId`) if `bun test` runs
    // files concurrently, inflating that test's send count.
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, opsUserId));
  });
});
