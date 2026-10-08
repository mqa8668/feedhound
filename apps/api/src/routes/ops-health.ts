import { deriveSilenceConfig, isWithinActiveHours, SILENCE_CONFIG_KEYS, silenceGap } from "@feedhound/core/silence";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { authenticateApiKey } from "../middleware/api-key";
import { resolveSession, type Role, type Session } from "../middleware/cf-access";

interface QueueRow {
  name: string;
  pending: number;
  failed: number;
}

async function fetchQueueStats(handle: DbHandle): Promise<QueueRow[] | null> {
  try {
    const rows = await handle.sql<{ name: string; pending: string; failed: string }[]>`
      select name,
        count(*) filter (where state in ('created', 'retry', 'active')) as pending,
        count(*) filter (where state = 'failed') as failed
      from pgboss.job
      group by name
    `;
    return rows.map((r) => ({ name: r.name, pending: Number(r.pending), failed: Number(r.failed) }));
  } catch (err) {
    // pg-boss schema may not exist yet in a fresh/test DB (42P01): a legitimately empty answer.
    // Any other failure returns null, which the route never caches.
    return (err as { code?: string }).code === "42P01" ? [] : null;
  }
}

/**
 * Session first (dashboard); otherwise an `ops`-scope Bearer key acts as that key owner's
 * session (debt D6, plan 2026-10-05 ruling 3). Used on this GET only; never widens other routes.
 */
function sessionOrOpsKey(handle: DbHandle) {
  return createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    const session = await resolveSession(c.req.raw.headers, handle);
    if (session === "not_provisioned") return c.json({ error: "not_provisioned" }, 403);
    if (session) {
      c.set("session", session);
      return next();
    }
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return c.json({ error: "unauthenticated" }, 401);
    const token = header.slice("Bearer ".length).trim();
    const result = await authenticateApiKey(token, ["ops"], handle);
    if (!result.ok) return c.json({ error: result.message }, result.status);
    const [owner] = await handle.db
      .select({ id: schema.user.id, teamId: schema.user.teamId, email: schema.user.email, role: schema.user.role })
      .from(schema.user)
      .where(eq(schema.user.id, result.context.userId))
      .limit(1);
    if (!owner) return c.json({ error: "invalid api key" }, 401);
    c.set("session", { userId: owner.id, teamId: owner.teamId, email: owner.email, role: owner.role as Role });
    return next();
  });
}

/** Per-team response cache lifetime. */
export const OPS_HEALTH_CACHE_TTL_MS = 10_000;

/** `GET /api/ops/health` (any session, or an `ops`-scope api key). Auth runs on every request; only the result is cached, per team. 10 s per-team cache, never for `db: "down"`. */
export function opsHealthRoute(
  handle: DbHandle,
  opts?: { cacheTtlMs?: number; now?: () => number },
): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();
  const ttlMs = opts?.cacheTtlMs ?? OPS_HEALTH_CACHE_TTL_MS;
  const clock = opts?.now ?? Date.now;
  const cache = new Map<string, { at: number; body: unknown }>();

  app.get("/api/ops/health", sessionOrOpsKey(handle), async (c) => {
    const session = c.get("session");
    const hit = cache.get(session.teamId);
    if (hit && clock() - hit.at < ttlMs) return c.json(hit.body);

    let db: "ok" | "down" = "ok";
    try {
      await handle.sql`select 1`;
    } catch {
      db = "down";
    }

    const sourceRows = await handle.db
      .select()
      .from(schema.source)
      .where(eq(schema.source.teamId, session.teamId));

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const postsLastHourRows =
      sourceRows.length === 0
        ? []
        : await handle.db
            .select({ sourceId: schema.post.sourceId, count: sql<string>`count(*)` })
            .from(schema.post)
            .where(
              and(
                inArray(
                  schema.post.sourceId,
                  sourceRows.map((s) => s.id),
                ),
                gte(schema.post.firstSeenAt, since),
              ),
            )
            .groupBy(schema.post.sourceId);
    const postsLastHourBySource = new Map(postsLastHourRows.map((r) => [r.sourceId, Number(r.count)]));

    const health = (raw: unknown): { ok?: boolean; reason?: string | null } =>
      typeof raw === "object" && raw !== null ? (raw as { ok?: boolean; reason?: string | null }) : {};

    const sources = sourceRows.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      lastVisitAt: s.lastIngestAt ?? s.lastHealthAt ?? null,
      lastError: health(s.health).reason ?? null,
      postsLastHour: postsLastHourBySource.get(s.id) ?? 0,
    }));

    const queueStats = await fetchQueueStats(handle);
    const queues = queueStats ?? [];

    // Push-source silence, computed at read time from the visit ledger.
    const nowDate = new Date();
    const rawCfg: Partial<Record<(typeof SILENCE_CONFIG_KEYS)[number], unknown>> = {};
    for (const key of SILENCE_CONFIG_KEYS) {
      const [row] = await handle.db
        .select({ value: schema.config.value })
        .from(schema.config)
        .where(eq(schema.config.key, key))
        .orderBy(desc(schema.config.version))
        .limit(1);
      if (row?.value !== undefined && row.value !== null) rawCfg[key] = row.value;
    }
    const silenceCfg = deriveSilenceConfig(rawCfg);
    const intervalSec = silenceCfg.fallbackIntervalSec;
    // Web sources are server-polled, so only push sources are part of the silence signal.
    const pushRows = sourceRows.filter((s) => s.kind !== "web");
    const watched = pushRows.filter((s) => s.status === "active" || s.status === "paused_by_health");
    let lastVisitAt: Date | null = null;
    if (pushRows.length > 0) {
      const [lv] = await handle.sql<{ last: Date | null }[]>`
        select max(coalesce(finished_at, started_at)) as last from visit where source_id = any(${pushRows.map((s) => s.id)}::uuid[])
      `;
      lastVisitAt = lv?.last ? new Date(lv.last) : null;
    }
    const earliestCreated = watched.reduce<Date | null>((min, s) => (!min || s.createdAt < min ? s.createdAt : min), null);
    const reference = lastVisitAt ?? earliestCreated;
    const gap = reference ? silenceGap(reference, nowDate, intervalSec, silenceCfg) : null;
    const thresholdSec = silenceGap(nowDate, nowDate, intervalSec, silenceCfg).thresholdSec;
    const silent =
      watched.length > 0 && gap !== null && isWithinActiveHours(nowDate, silenceCfg.tz, silenceCfg.activeHours) && gap.gapSec >= thresholdSec;

    const body = {
      db,
      ingest: { lastVisitAt: lastVisitAt ? lastVisitAt.toISOString() : null, silent, thresholdSec },
      sources,
      queues,
    };
    if (db === "ok" && queueStats !== null) cache.set(session.teamId, { at: clock(), body });
    return c.json(body);
  });

  return app;
}
