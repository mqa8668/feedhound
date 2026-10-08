import { searchParamsSchema } from "@feedhound/core/search-query";
import { searchParamsToTopic } from "@feedhound/core/topic";
import { schema, type DbHandle } from "@feedhound/db";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";

const TOPIC_ROLLUP_QUEUE = "topic_rollup";
const DAY_MS = 86_400_000;
const MAX_RANGE_MS = { hour: 7 * DAY_MS, day: 400 * DAY_MS } as const;

export interface TopicsBoss {
  send(name: string, data: object, options?: { retryLimit?: number; singletonKey?: string }): Promise<string | null>;
}

const createSchema = z.object({ savedSearchId: z.string().uuid(), name: z.string().min(1).max(60).optional() });
const patchSchema = z.object({ name: z.string().min(1).max(60).optional(), enabled: z.boolean().optional(), alertsEnabled: z.boolean().optional() });
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO date" });
const seriesSchema = z.object({ bucket: z.enum(["hour", "day"]).default("day"), from: isoDate.optional(), to: isoDate.optional() });

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 4; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function configNumber(handle: DbHandle, key: string, fallback: number): Promise<number> {
  const [row] = await handle.db.select({ value: schema.config.value }).from(schema.config).where(eq(schema.config.key, key)).orderBy(desc(schema.config.version)).limit(1);
  return typeof row?.value === "number" ? row.value : fallback;
}

/**
 * `/api/topics`. Team-visible. List/series by team; PATCH/DELETE by the creator or an
 * operator of the team (else 403 `not_owner`); another team's id is 404. Limits, unique names and delivery stay per creator.
 */
export function topicsRoute(handle: DbHandle, boss?: TopicsBoss, now: () => Date = () => new Date()): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();
  const auth = [cfAccessAuth(handle), requireSession()] as const;
  const inTeam = (id: string, teamId: string) => and(eq(schema.topic.id, id), eq(schema.topic.teamId, teamId));
  const mayChange = (row: { userId: string }, s: Session): boolean => row.userId === s.userId || s.role === "operator";
  const validation = (message: string, issues?: unknown) => ({ error: "validation" as const, message, issues });
  const isUuid = (s: string): boolean => z.string().uuid().safeParse(s).success;

  app.get("/api/topics", ...auth, async (c) => {
    const { userId, teamId } = c.get("session");
    const rows = await handle.db.select().from(schema.topic).where(eq(schema.topic.teamId, teamId)).orderBy(schema.topic.name);
    const ids = rows.map((r) => r.id);
    const since = new Date(now().getTime() - 7 * DAY_MS).toISOString();
    const vol = ids.length
      ? await handle.db
          .select({ topicId: schema.topicVolume.topicId, n: sql<number>`coalesce(sum(${schema.topicVolume.posts}), 0)::int` })
          .from(schema.topicVolume)
          .where(and(inArray(schema.topicVolume.topicId, ids), eq(schema.topicVolume.bucket, "day"), sql`${schema.topicVolume.ts} >= ${since}::timestamptz`))
          .groupBy(schema.topicVolume.topicId)
      : [];
    const spikes = ids.length
      ? await handle.db
          .select({ topicId: schema.insight.topicId, day: sql<string>`max(${schema.insight.day})::text` })
          .from(schema.insight)
          .where(and(inArray(schema.insight.topicId, ids), eq(schema.insight.kind, "spike")))
          .groupBy(schema.insight.topicId)
      : [];
    const volBy = new Map(vol.map((v) => [v.topicId, v.n]));
    const spikeBy = new Map(spikes.map((s) => [s.topicId, s.day]));
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        savedSearchId: r.savedSearchId,
        params: r.params,
        enabled: r.enabled,
        alertsEnabled: r.alertsEnabled,
        mine: r.userId === userId,
        createdAt: r.createdAt.toISOString(),
        last7d: volBy.get(r.id) ?? 0,
        lastSpikeDay: spikeBy.get(r.id) ?? null,
      })),
    });
  });

  app.post("/api/topics", ...auth, async (c) => {
    const { userId, teamId } = c.get("session");
    const body = createSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json(validation("invalid body", body.error.issues), 400);
    const [saved] = await handle.db
      .select()
      .from(schema.savedSearch)
      .where(eq(schema.savedSearch.id, body.data.savedSearchId));
    // Any saved search of the caller's team may be promoted (the topic is owned by the caller).
    const [creator] = saved ? await handle.db.select({ teamId: schema.user.teamId }).from(schema.user).where(eq(schema.user.id, saved.userId)) : [];
    if (!saved || creator?.teamId !== teamId) return c.json({ error: "not_found" }, 404);
    const parsed = searchParamsSchema.safeParse(saved.query);
    if (!parsed.success) return c.json(validation("saved search params invalid", parsed.error.issues), 400);
    const { params, dropped } = searchParamsToTopic(parsed.data);
    const max = await configNumber(handle, "insights.topicsMax", 20);
    const baselineDays = await configNumber(handle, "insights.spike.baselineDays", 7);
    try {
      const id = await handle.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`topic:${userId}`}))`);
        const [n] = await tx.select({ n: count() }).from(schema.topic).where(eq(schema.topic.userId, userId));
        if ((n?.n ?? 0) >= max) return null;
        const [row] = await tx
          .insert(schema.topic)
          .values({ teamId, userId, savedSearchId: saved.id, name: body.data.name ?? saved.name, params })
          .returning({ id: schema.topic.id });
        return row!.id;
      });
      if (id === null) return c.json({ error: "limit_reached" }, 409);
      // best effort: the hourly cron fills the series even when the queue is unavailable
      await boss?.send(TOPIC_ROLLUP_QUEUE, { topicId: id, backfillDays: baselineDays + 1 }, { retryLimit: 2, singletonKey: `${TOPIC_ROLLUP_QUEUE}:${id}` }).catch(() => undefined);
      return c.json({ id, dropped }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "duplicate_name" }, 409);
      throw err;
    }
  });

  app.patch("/api/topics/:id", ...auth, async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const [existing] = await handle.db.select({ id: schema.topic.id, userId: schema.topic.userId }).from(schema.topic).where(inTeam(id, session.teamId));
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (!mayChange(existing, session)) return c.json({ error: "not_owner" }, 403);
    const body = patchSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json(validation("invalid body", body.error.issues), 400);
    try {
      const [row] = await handle.db
        .update(schema.topic)
        .set({
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
          ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
          ...(body.data.alertsEnabled !== undefined ? { alertsEnabled: body.data.alertsEnabled } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.topic.id, id))
        .returning();
      return c.json({ id: row!.id, name: row!.name, enabled: row!.enabled, alertsEnabled: row!.alertsEnabled });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "duplicate_name" }, 409);
      throw err;
    }
  });

  app.delete("/api/topics/:id", ...auth, async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const [existing] = await handle.db.select({ id: schema.topic.id, userId: schema.topic.userId }).from(schema.topic).where(inTeam(id, session.teamId));
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (!mayChange(existing, session)) return c.json({ error: "not_owner" }, 403);
    await handle.db.delete(schema.topic).where(eq(schema.topic.id, id));
    return c.body(null, 204);
  });

  app.get("/api/topics/:id/series", ...auth, async (c) => {
    const { teamId } = c.get("session");
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const [topic] = await handle.db.select({ id: schema.topic.id }).from(schema.topic).where(inTeam(id, teamId));
    if (!topic) return c.json({ error: "not_found" }, 404);
    const q = seriesSchema.safeParse(c.req.query());
    if (!q.success) return c.json(validation("invalid query", q.error.issues), 400);
    const { bucket } = q.data;
    const to = q.data.to ? new Date(q.data.to) : now();
    const from = q.data.from ? new Date(q.data.from) : new Date(to.getTime() - (bucket === "hour" ? 2 : 30) * DAY_MS);
    if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > MAX_RANGE_MS[bucket]) {
      return c.json(validation(`range must be positive and at most ${bucket === "hour" ? "7" : "400"} days`), 400);
    }
    const points = await handle.db
      .select()
      .from(schema.topicVolume)
      .where(
        and(
          eq(schema.topicVolume.topicId, id),
          eq(schema.topicVolume.bucket, bucket),
          sql`${schema.topicVolume.ts} >= ${from.toISOString()}::timestamptz`,
          sql`${schema.topicVolume.ts} < ${to.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(schema.topicVolume.ts);
    const spikes = await handle.db
      .select({ day: sql<string>`${schema.insight.day}::text`, payload: schema.insight.payload })
      .from(schema.insight)
      .where(and(eq(schema.insight.topicId, id), eq(schema.insight.kind, "spike")))
      .orderBy(schema.insight.day);
    return c.json({
      points: points.map((p) => ({ ts: p.ts.toISOString(), posts: p.posts, neg: p.neg, neu: p.neu, pos: p.pos })),
      spikes: spikes.map((s) => {
        const p = s.payload as { count?: number; mean?: number; ratio?: number; z?: number };
        return { day: s.day, count: p.count ?? 0, mean: p.mean ?? 0, ratio: p.ratio ?? 0, z: p.z ?? 0 };
      }),
    });
  });

  return app;
}
