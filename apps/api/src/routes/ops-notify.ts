import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { Hono } from "hono";
import { z } from "zod";
import { apiKeyAuth } from "../middleware/api-key";

const bodySchema = z.object({
  rule: z.string().min(1),
  message: z.string().min(1),
});

/**
 * POST /api/ops/notify — the stable entry point infra scripts use to raise an
 * ops Notification without a direct DB connection. Requires
 * an ApiKey with scope `ops` (e.g. `.env` key `OPS_API_KEY`, used by
 * `infra/backup.sh`).
 */
export function opsNotifyRoute(handle: DbHandle): Hono {
  const app = new Hono();

  app.post("/api/ops/notify", apiKeyAuth(["ops"], handle), async (c) => {
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);

    const apiKeyCtx = c.get("apiKey");
    await handle.db.insert(schema.notification).values({
      userId: apiKeyCtx.userId,
      channel: "ops",
      status: "pending",
      payload: { rule: parsed.data.rule, message: parsed.data.message, at: new Date().toISOString() },
    });

    return c.json({ ok: true }, 201);
  });

  return app;
}
