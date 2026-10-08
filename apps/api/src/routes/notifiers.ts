import { createLogger } from "@feedhound/core/logger";
import { telegramNotifierConfigSchema } from "@feedhound/core/notifiers";
import type { DbHandle } from "@feedhound/db";
import { clearNoEnabledNotifierMarkers, schema } from "@feedhound/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";
import { resolveTargetUserId, resolveWatchActor } from "./watches";

const logger = createLogger({ service: "api" });

const patchBodySchema = z.object({
  enabled: z.boolean().optional(),
  config: z.object({ mode: z.enum(["instant", "digest"]).optional(), digestEveryMin: z.number().int().min(1).max(1440).optional() }).optional(),
});

/** `/api/notifiers`: own rows only; `chatId` is immutable via PATCH. */
export function notifiersRoute(handle: DbHandle): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  // Also reachable with a dashboard session; `?userId=` (operator, same team) lists a teammate's rows.
  app.get("/api/notifiers", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["notifications:read"]);
    if (actor instanceof Response) return actor;
    const targetUserId = await resolveTargetUserId(handle, actor, c.req.query("userId"));
    if (targetUserId instanceof Response) return targetUserId;
    const rows = await handle.db.select().from(schema.notifier).where(eq(schema.notifier.userId, targetUserId));
    // Teammates' rows never expose `config` (chat ids, tokens): only what a watch picker needs.
    if (targetUserId !== actor.userId) {
      return c.json({ notifiers: rows.map((r) => ({ id: r.id, userId: r.userId, kind: r.kind, enabled: r.enabled })) });
    }
    return c.json({ notifiers: rows });
  });

  app.patch("/api/notifiers/:id", apiKeyAuth(["notifications:write"], handle), async (c) => {
    const apiKey = c.get("apiKey");
    const [existing] = await handle.db
      .select()
      .from(schema.notifier)
      .where(and(eq(schema.notifier.id, c.req.param("id")), eq(schema.notifier.userId, apiKey.userId)))
      .limit(1);
    if (!existing) return c.json({ error: "not found" }, 404);

    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = patchBodySchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: "invalid body", field: issue?.path.join(".") || undefined, reason: issue?.message }, 422);
    }
    const { enabled, config: configPatch } = parsed.data;

    const setValues: Partial<typeof schema.notifier.$inferInsert> = {};
    if (enabled !== undefined) setValues.enabled = enabled;
    // `notify.ts`'s `markNoTarget("no enabled notifier")` marker (matchId
    // set, notifierId null, status `suppressed`) is permanent — once written it makes the
    // CR-1 sweeper's `not exists` check skip that match forever, even after the user
    // re-enables the notifier that made it fire. Re-enabling clears any such marker for this
    // user so the next sweeper tick (their `notifyEnqueuedAt` is already stale) re-arms the
    // match for a fresh `notify` run.
    const reEnabling = enabled === true && existing.enabled === false;
    if (configPatch) {
      // `chatId` is immutable — merge the patch onto the existing config and re-validate,
      // never let the caller replace `chatId`.
      const currentParsed = telegramNotifierConfigSchema.safeParse(existing.config);
      const merged = {
        chatId: currentParsed.success ? currentParsed.data.chatId : (existing.config as { chatId?: number }).chatId,
        mode: configPatch.mode ?? (currentParsed.success ? currentParsed.data.mode : "instant"),
        digestEveryMin: configPatch.digestEveryMin ?? (currentParsed.success ? currentParsed.data.digestEveryMin : undefined),
      };
      const revalidated = telegramNotifierConfigSchema.safeParse(merged);
      if (!revalidated.success) return c.json({ error: "invalid body", field: "config", reason: "invalid notifier config" }, 422);
      setValues.config = revalidated.data;
    }

    const [row] = await handle.db
      .update(schema.notifier)
      .set(setValues)
      .where(and(eq(schema.notifier.id, existing.id), eq(schema.notifier.userId, apiKey.userId)))
      .returning();

    let droppedMarkersOutsideBound = 0;
    if (reEnabling) {
      // Bounded by age + count (see `clearNoEnabledNotifierMarkers`) so
      // re-enabling after a long outage cannot flood-reenqueue weeks of historical matches.
      const result = await clearNoEnabledNotifierMarkers(handle, apiKey.userId, new Date());
      droppedMarkersOutsideBound = result.droppedOutsideBound;
      // Markers left behind by the age/count bound were previously dropped
      // silently. Log and surface the count so a user re-enabling after a long outage
      // knows some historical alerts were not restored.
      if (droppedMarkersOutsideBound > 0) {
        logger.warn(
          { userId: apiKey.userId, cleared: result.cleared, droppedMarkersOutsideBound },
          "clearNoEnabledNotifierMarkers: some markers left outside the age/count bound",
        );
      }
    }

    // Always include `droppedMarkersOutsideBound` (default 0) instead of only
    // on the re-enable branch — a varying response shape forces every caller to branch on
    // whether the field exists at all before reading it.
    return c.json({ ...row, droppedMarkersOutsideBound });
  });

  return app;
}
