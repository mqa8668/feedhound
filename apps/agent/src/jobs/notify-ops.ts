import { z } from "zod";
import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import type { PgBoss } from "pg-boss";
import { enqueueOpsNotification, flushPendingOpsNotifications, loadOpsUserId, type NotifierMap, type NotifyRunDeps } from "./notify";
import type { RateLimiter } from "../lib/rate-limit";

const logger = createLogger({ service: "agent" });

const NOTIFY_OPS_QUEUE = "notify_ops";
// `flushPendingOpsNotifications` otherwise only runs when a `notify_ops` job
// arrives (worker below). `notify_health` and the 403 `notifier_blocked` path in
// `notify.ts` both insert a `pending` ops row directly (via `enqueueOpsNotification`,
// not through this queue), so without a periodic drain those rows can sit unsent until
// an unrelated ops event happens to enqueue a `notify_ops` job. A short, self-contained
// cron here (registered alongside the `notify_ops` worker, no other file needs to know
// about it) guarantees every pending ops row is flushed within a minute regardless of
// how it was enqueued — including a `POST /api/notifications/:id/retry` on an ops row,
// which only resets `status = 'pending'` and has no other trigger of its own.
const NOTIFY_OPS_FLUSH_QUEUE = "notify_ops_flush";
const NOTIFY_OPS_FLUSH_CRON = "*/1 * * * *";

export const notifyOpsJobSchema = z.object({
  kind: z.enum(["source_silent", "source_paused", "llm_budget", "queue_backlog", "notify_failure_rate", "notifier_blocked", "dlq"]),
  text: z.string(),
  dedupeKey: z.string(),
  ttlSec: z.number().int().positive(),
});
export type NotifyOpsJobPayload = z.infer<typeof notifyOpsJobSchema>;

/**
 * `notify_ops` worker: 001/002/008 send jobs here instead
 * of inserting a `Notification` row directly. Enqueues (dedupe + skip logic)
 * then immediately flushes any pending ops row so ops alerts don't wait for
 * the next `notify_digest` tick.
 */
export async function registerNotifyOpsJob(boss: PgBoss, handle: DbHandle, notifiers: NotifierMap, rateLimiter: RateLimiter): Promise<void> {
  await boss.createQueue(NOTIFY_OPS_QUEUE);
  await boss.work(NOTIFY_OPS_QUEUE, async ([job]) => {
    const payload = notifyOpsJobSchema.parse(job?.data);
    const opsUserId = await loadOpsUserId(handle);
    if (!opsUserId) {
      logger.warn("notify_ops: no operator user found, skipping");
      return;
    }
    const now = new Date();
    const status = await enqueueOpsNotification(handle, opsUserId, payload, now);
    logger.info({ ...payload, status }, "notify_ops enqueued");
    const deps: NotifyRunDeps = { handle, notifiers, rateLimiter, now };
    await flushPendingOpsNotifications(deps);
  });

  // `policy: "stately"` (pg-boss: at most one job per state, queued or
  // active) stops the every-minute cron from stacking a second flush job on top of one
  // still draining a backlog, and stops an unbounded queue of identical flush jobs from
  // building up past the queue's job expiry while one run is in progress.
  await boss.createQueue(NOTIFY_OPS_FLUSH_QUEUE, { policy: "stately" });
  await boss.schedule(NOTIFY_OPS_FLUSH_QUEUE, NOTIFY_OPS_FLUSH_CRON, {});
  await boss.work(NOTIFY_OPS_FLUSH_QUEUE, async () => {
    await flushPendingOpsNotifications({ handle, notifiers, rateLimiter, now: new Date() });
  });
}
