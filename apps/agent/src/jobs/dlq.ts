import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { desc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { countDeadLetters } from "./ops-alerts";

const logger = createLogger({ service: "agent" });

const DLQ_MONITOR_QUEUE = "dlq_monitor";
const DLQ_MONITOR_CRON = "*/5 * * * *";
const MAX_TEXT_CHARS = 500;
const MAX_LAST_ERROR_CHARS = 200;

/**
 * Every queue registered on `boss` gets a dead-letter
 * queue `<name>_dlq`. Uses `updateQueue` (not `createQueue` options) so
 * queues already existing at boot (and queues first `createQueue`d by the
 * api process, e.g. `match`/`enrich` via `apps/api/src/services/corpus.ts`)
 * are covered without clobbering `policy: "stately"` on
 * `notify_ops_flush` (`updateQueue`'s `UpdateQueueOptions` never touches
 * `policy`).
 */
export async function applyDeadLetters(boss: PgBoss): Promise<void> {
  const queues = await boss.getQueues();
  for (const queue of queues) {
    // pg-boss's own internal maintenance queue(s) (e.g.
    // `__pgboss__send-it`) are not app queues and must never get a
    // dead-letter queue wired onto them.
    if (queue.name.startsWith("__pgboss__")) continue;
    if (queue.name.endsWith("_dlq")) continue;
    const expected = `${queue.name}_dlq`;
    if (queue.deadLetter === expected) continue;
    await boss.createQueue(expected).catch(() => {
      // already exists — fine, updateQueue below still wires it up.
    });
    await boss.updateQueue(queue.name, { deadLetter: expected });
  }
}

async function fetchConfigNumber(handle: DbHandle, key: string, fallback: number): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "number" ? row.value : fallback;
}

interface OldestNewest {
  oldestCreatedOn: Date | undefined;
  lastErrorMessage: string | undefined;
}

/** Two single-row SQL reads on `pgboss.job` for the alert text. */
async function fetchOldestAndLastError(handle: DbHandle, queue: string): Promise<OldestNewest> {
  const [oldest] = await handle.sql<{ created_on: Date }[]>`
    select created_on from pgboss.job
    where name = ${`${queue}_dlq`} and state in ('created', 'retry')
    order by created_on asc
    limit 1
  `;
  const [newestFailed] = await handle.sql<{ message: string | null }[]>`
    select output ->> 'message' as message from pgboss.job
    where name = ${queue} and state = 'failed'
    order by created_on desc
    limit 1
  `;
  return {
    oldestCreatedOn: oldest?.created_on,
    lastErrorMessage: newestFailed?.message ?? undefined,
  };
}

/** Builds the plain-text ops alert body for one non-empty DLQ. */
async function buildAlertText(handle: DbHandle, queue: string, count: number): Promise<string> {
  const { oldestCreatedOn, lastErrorMessage } = await fetchOldestAndLastError(handle, queue);
  const oldest = oldestCreatedOn ? new Date(oldestCreatedOn).toISOString() : "n/a";
  const lastError = lastErrorMessage ? lastErrorMessage.slice(0, MAX_LAST_ERROR_CHARS) : "n/a";
  const text = `DLQ ${queue}: ${count} job(s) failed after all retries. Oldest: ${oldest}. Last error: ${lastError}. Retry: POST /api/ops/dlq/${queue}/retry`;
  return text.slice(0, MAX_TEXT_CHARS);
}

export interface DlqMonitorDeps {
  boss: PgBoss;
  handle: DbHandle;
  send: (kind: string, text: string, dedupeKey: string, ttlSec: number) => Promise<void>;
}

/**
 * Per non-empty DLQ, sends one `notify_ops` job
 * (`kind: "dlq"`, `dedupeKey: "dlq:<queue>"`) so `enqueueOpsNotification`'s
 * existing dedupe window caps this at one ops Notification per
 * queue per `ops.dlqAlertIntervalSec`.
 */
export async function runDlqMonitor(deps: DlqMonitorDeps): Promise<void> {
  const ttlSec = await fetchConfigNumber(deps.handle, "ops.dlqAlertIntervalSec", 3600);
  const deadLetters = await countDeadLetters(deps.boss);
  for (const { queue, count } of deadLetters) {
    const text = await buildAlertText(deps.handle, queue, count);
    await deps.send("dlq", text, `dlq:${queue}`, ttlSec);
  }
}

/**
 * `dlq_monitor` cron. `sendJob` defaults to
 * `boss.send("notify_ops", ...)`, injectable for tests that wire `send`
 * straight to `enqueueOpsNotification` (injected `now`).
 */
export function registerDlqMonitorJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  return (async () => {
    await boss.createQueue(DLQ_MONITOR_QUEUE);
    await boss.schedule(DLQ_MONITOR_QUEUE, DLQ_MONITOR_CRON, {});
    await boss.work(DLQ_MONITOR_QUEUE, async () => {
      await runDlqMonitor({
        boss,
        handle,
        send: async (kind, text, dedupeKey, ttlSec) => {
          await boss.send("notify_ops", { kind, text, dedupeKey, ttlSec });
        },
      });
      logger.info("dlq_monitor run");
    });
  })();
}
