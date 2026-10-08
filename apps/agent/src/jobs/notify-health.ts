import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { enqueueOpsNotification, loadOpsUserId } from "./notify";

const logger = createLogger({ service: "agent" });

const NOTIFY_HEALTH_QUEUE = "notify_health";
const NOTIFY_HEALTH_CRON = "*/10 * * * *";
const WINDOW_MS = 60 * 60_000;

async function fetchConfigValue<T>(handle: DbHandle, key: string, fallback: T): Promise<T> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return (row?.value as T | undefined) ?? fallback;
}

/** Failure-rate ops alert over the last 60 min. */
export async function runNotifyHealthCheck(handle: DbHandle, now: Date): Promise<boolean> {
  const failureRatePct = await fetchConfigValue(handle, "notify.ops.failureRatePct", 10);
  const minSamples = await fetchConfigValue(handle, "notify.ops.minSamples", 10);

  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const rows = await handle.db
    .select({ status: schema.notification.status })
    .from(schema.notification)
    .where(
      and(
        inArray(schema.notification.status, ["sent", "failed"]),
        eq(schema.notification.channel, "telegram"),
        or(gte(schema.notification.sentAt, windowStart), gte(schema.notification.failedAt, windowStart)),
      ),
    );

  const sent = rows.filter((r) => r.status === "sent").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const total = sent + failed;
  if (total < minSamples) return false;

  const failureRate = (failed / total) * 100;
  if (failureRate <= failureRatePct) return false;

  const opsUserId = await loadOpsUserId(handle);
  if (!opsUserId) return false;

  const status = await enqueueOpsNotification(
    handle,
    opsUserId,
    { kind: "notify_failure_rate", text: `notify failure rate ${failureRate.toFixed(1)}% over last 60min (${failed}/${total})`, dedupeKey: "notify_failure_rate", ttlSec: 3_600 },
    now,
  );
  return status === "pending";
}

export async function registerNotifyHealthJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(NOTIFY_HEALTH_QUEUE);
  await boss.schedule(NOTIFY_HEALTH_QUEUE, NOTIFY_HEALTH_CRON, {});
  await boss.work(NOTIFY_HEALTH_QUEUE, async () => {
    const fired = await runNotifyHealthCheck(handle, new Date());
    if (fired) logger.info("notify_health: failure rate alert fired");
  });
}
