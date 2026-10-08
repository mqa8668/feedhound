import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { Hono } from "hono";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";

const logger = createLogger({ service: "api" });

const queueParamSchema = z.string().regex(/^[a-z_]{1,64}$/);
const bodySchema = z.object({ limit: z.number().int().min(1).max(1000).optional() }).optional();
const DEFAULT_LIMIT = 100;

/**
 * `POST /api/ops/dlq/:queue/retry`: re-queues up to `limit` jobs
 * from `<queue>_dlq` back onto `<queue>`, then completes them on the DLQ.
 *
 * At-least-once, not exactly-once: a crash between `boss.send` and
 * `boss.complete` can re-send the same job on the next retry call (the job
 * stays in `<queue>_dlq` and is picked up again). This is accepted per the
 * design notes: enrich/match/notify are idempotent via
 * `singletonKey` and status guards, so a duplicate send is a no-op there.
 */
export function opsDlqRoute(handle: DbHandle, boss?: PgBoss): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  app.post("/api/ops/dlq/:queue/retry", apiKeyAuth(["ops"], handle), async (c) => {
    const queueParsed = queueParamSchema.safeParse(c.req.param("queue"));
    if (!queueParsed.success || queueParsed.data.endsWith("_dlq")) {
      return c.json({ error: "validation", message: "invalid queue name" }, 400);
    }
    const queue = queueParsed.data;

    // only a genuinely empty body means "use defaults" — malformed
    // JSON must be a 400, not silently fall back to `DEFAULT_LIMIT`.
    const rawBody = await c.req.text();
    let limit = DEFAULT_LIMIT;
    if (rawBody.trim().length > 0) {
      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "validation", message: "invalid JSON body" }, 400);
      }
      const bodyParsed = bodySchema.safeParse(json);
      if (!bodyParsed.success) return c.json({ error: "validation", issues: bodyParsed.error.issues }, 400);
      limit = bodyParsed.data?.limit ?? DEFAULT_LIMIT;
    }

    if (!boss) return c.json({ error: "queue_unavailable" }, 503);

    const dlqName = `${queue}_dlq`;
    const target = await boss.getQueue(queue);
    if (!target || target.deadLetter !== dlqName) return c.json({ error: "unknown_queue" }, 404);

    const jobs = await boss.fetch<object>(dlqName, { batchSize: limit });
    let retried = 0;
    let deduped = 0;
    if (jobs.length > 0) {
      // `boss.fetch()` doesn't return `singletonKey`; read it from
      // `pgboss.job` so re-sending doesn't drop the queue's dedup key.
      const singletonKeyRows = await handle.sql<{ id: string; singleton_key: string | null }[]>`
        select id, singleton_key from pgboss.job where name = ${dlqName} and id = any(${jobs.map((j) => j.id)})
      `;
      const singletonKeyById = new Map(singletonKeyRows.map((row) => [row.id, row.singleton_key]));
      // only complete the ids whose `boss.send`
      // actually succeeded — if `boss.send` throws on job k, jobs 1..k-1 must
      // still be completed on the DLQ (they were re-sent) while k stays in
      // the DLQ for the next retry call.
      const sentIds: string[] = [];
      try {
        for (const job of jobs) {
          const singletonKey = singletonKeyById.get(job.id) ?? undefined;
          const result = await boss.send(queue, job.data, singletonKey ? { singletonKey } : {});
          sentIds.push(job.id);
          // `boss.send` returns `null` when the singleton dedupe
          // key already has a job queued — that's a no-op, not a retry.
          if (result === null) deduped++;
          else retried++;
        }
      } finally {
        if (sentIds.length > 0) await boss.complete(dlqName, sentIds);
      }
    }

    // `getQueue().queuedCount` is a periodically-refreshed cache
    // (`pgboss.queue`, pg-boss's own monitor) and would under-report right
    // after this call's own `fetch`/`complete`; count `pgboss.job` directly
    // for an accurate `remaining`.
    const [remainingRow] = await handle.sql<{ count: string }[]>`
      select count(*) from pgboss.job where name = ${dlqName} and state in ('created', 'retry')
    `;
    const remaining = Number(remainingRow?.count ?? 0);
    const apiKey = c.get("apiKey");
    logger.info({ queue, retried, deduped, keyId: apiKey.id }, "dlq retry");
    return c.json({ queue, retried, deduped, remaining }, 200);
  });

  return app;
}
