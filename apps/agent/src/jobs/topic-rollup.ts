import { createLogger } from "@feedhound/core/logger";
import { validTz } from "@feedhound/core/tz";
import { detectSpike } from "@feedhound/core/topic";
import { searchParamsSchema } from "@feedhound/core/search-query";
import { buildSearchPredicate, schema, type DbHandle } from "@feedhound/db";
import { desc, eq, inArray, and, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { RateLimiter } from "../lib/rate-limit";
import { deliverPendingInsights, initialDelivery, truncateText } from "./insight-digest";
import { fetchAppTz, type NotifierMap } from "./notify";

const logger = createLogger({ service: "agent" });

const TOPIC_ROLLUP_QUEUE = "topic_rollup";
const TOPIC_ROLLUP_CRON = "5 * * * *";
const DEFAULT_WINDOW_DAYS = 2;
const HOUR_MS = 3_600_000;

export interface InsightsConfig {
  topicsMax: number;
  minVolume: number;
  ratioMin: number;
  zMin: number;
  baselineDays: number;
  evalHourLocal: number;
  digestHourLocal: number;
  digestTopTopics: number;
  digestNotableMax: number;
  hourRetentionDays: number;
  deliveryMaxAttempts: number;
  trgmMinLen: number;
}

const DEFAULTS: Record<keyof InsightsConfig, [string, number]> = {
  topicsMax: ["insights.topicsMax", 20],
  minVolume: ["insights.spike.minVolume", 10],
  ratioMin: ["insights.spike.ratioMin", 3],
  zMin: ["insights.spike.zMin", 3],
  baselineDays: ["insights.spike.baselineDays", 7],
  evalHourLocal: ["insights.spike.evalHourLocal", 6],
  digestHourLocal: ["insights.digest.hourLocal", 8],
  digestTopTopics: ["insights.digest.topTopics", 5],
  digestNotableMax: ["insights.digest.notableMax", 5],
  hourRetentionDays: ["insights.hourRetentionDays", 30],
  deliveryMaxAttempts: ["insights.deliveryMaxAttempts", 3],
  trgmMinLen: ["search.trgmMinLen", 3],
};

/** Latest Config values for the `insights.*` keys, falling back to the built-in defaults. */
export async function loadInsightsConfig(handle: DbHandle): Promise<InsightsConfig> {
  const keys = Object.values(DEFAULTS).map(([k]) => k);
  const rows = await handle.db
    .select({ key: schema.config.key, value: schema.config.value })
    .from(schema.config)
    .where(inArray(schema.config.key, keys))
    .orderBy(desc(schema.config.version));
  const latest = new Map<string, unknown>();
  for (const r of rows) if (!latest.has(r.key)) latest.set(r.key, r.value);
  const out = {} as Record<keyof InsightsConfig, number>;
  for (const [name, [key, fallback]] of Object.entries(DEFAULTS) as [keyof InsightsConfig, [string, number]][]) {
    const v = latest.get(key);
    out[name] = typeof v === "number" ? v : fallback;
  }
  return out;
}

/** Local calendar date (`YYYY-MM-DD`) and hour of `now` in `tz`. */
export function localParts(now: Date, tz: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** `date` (`YYYY-MM-DD`) shifted by `days` calendar days. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface TopicRollupOptions {
  now: Date;
  /** Roll up one topic only (promote-time backfill); spike evaluation is skipped for such runs. */
  topicId?: string;
  backfillDays?: number;
  notifiers: NotifierMap;
  rateLimiter: RateLimiter;
  tz?: string;
  cfg?: InsightsConfig;
}

type TopicRow = typeof schema.topic.$inferSelect;

async function rollupTopic(handle: DbHandle, t: TopicRow, from: Date, tz: string, cfg: InsightsConfig): Promise<void> {
  const pred = buildSearchPredicate(searchParamsSchema.parse(t.params), t.teamId, { trgmMinLen: cfg.trgmMinLen });
  const cutoff = sql`(date_trunc('day', ${from.toISOString()}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
  // delete + re-insert in one transaction so counts that dropped (deleted / re-attributed posts) are corrected
  await handle.db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM topic_volume WHERE topic_id = ${t.id}::uuid AND ts >= ${cutoff}`);
    await tx.execute(sql`
      INSERT INTO topic_volume (topic_id, bucket, ts, posts, neg, neu, pos)
      SELECT ${t.id}::uuid, b.bucket, b.ts, count(*)::int,
        (count(*) FILTER (WHERE e.sentiment = 'neg'))::int, (count(*) FILTER (WHERE e.sentiment = 'neu'))::int, (count(*) FILTER (WHERE e.sentiment = 'pos'))::int
      FROM post p LEFT JOIN enrichment e ON e.post_id = p.id,
        LATERAL (VALUES
          ('hour', date_trunc('hour', p.effective_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
          ('day', date_trunc('day', p.effective_at AT TIME ZONE ${tz}) AT TIME ZONE ${tz})
        ) AS b(bucket, ts)
      WHERE ${pred} AND p.effective_at >= ${cutoff}
      GROUP BY b.bucket, b.ts
      ON CONFLICT (topic_id, bucket, ts) DO UPDATE SET posts = EXCLUDED.posts, neg = EXCLUDED.neg, neu = EXCLUDED.neu, pos = EXCLUDED.pos`);
  });
}

async function evaluateSpike(handle: DbHandle, t: TopicRow, day: string, tz: string, cfg: InsightsConfig, opts: TopicRollupOptions): Promise<boolean> {
  const first = shiftDate(day, -cfg.baselineDays);
  const rows = await handle.db.execute<{ d: string; posts: number }>(sql`
    SELECT (ts AT TIME ZONE ${tz})::date::text AS d, posts FROM topic_volume
    WHERE topic_id = ${t.id}::uuid AND bucket = 'day'
      AND ts >= ((${first}::date)::timestamp AT TIME ZONE ${tz}) AND ts < (((${day}::date + 1))::timestamp AT TIME ZONE ${tz})`);
  const byDay = new Map([...rows].map((r) => [r.d, r.posts]));
  const baseline = Array.from({ length: cfg.baselineDays }, (_, i) => byDay.get(shiftDate(first, i)) ?? 0);
  const verdict = detectSpike(byDay.get(day) ?? 0, baseline, { minVolume: cfg.minVolume, ratioMin: cfg.ratioMin, zMin: cfg.zMin });
  if (!verdict.spike) return false;
  const delivery = await initialDelivery(handle, opts.notifiers, t.userId, t.alertsEnabled);
  const text = truncateText(`Spike: "${t.name}" on ${day} - ${verdict.explain}`);
  const inserted = await handle.db
    .insert(schema.insight)
    .values({
      teamId: t.teamId,
      userId: t.userId,
      kind: "spike",
      topicId: t.id,
      day,
      dedupeKey: `spike:${t.id}:${day}`,
      payload: { topicId: t.id, topicName: t.name, day, count: verdict.count, mean: verdict.mean, sd: verdict.sd, ratio: verdict.ratio, z: verdict.z, explain: verdict.explain },
      text,
      delivery,
    })
    .onConflictDoNothing()
    .returning({ id: schema.insight.id });
  return inserted.length > 0;
}

/** Hourly: upserts hour/day volume buckets, evaluates daily spikes, then sends pending insights. */
export async function runTopicRollup(handle: DbHandle, opts: TopicRollupOptions): Promise<{ topics: number; spikes: number; sent: number }> {
  const cfg = opts.cfg ?? (await loadInsightsConfig(handle));
  const tz = validTz(opts.tz ?? (await fetchAppTz(handle)));
  const topics = await handle.db
    .select()
    .from(schema.topic)
    .where(and(eq(schema.topic.enabled, true), opts.topicId ? eq(schema.topic.id, opts.topicId) : undefined));
  const local = localParts(opts.now, tz);
  const dayMs = 24 * HOUR_MS;
  // Daily wide re-roll (just before spike evaluation) so late enrich@4 sentiment backfill (up to 7 days old) reaches topic_volume.
  const wide = local.hour === cfg.evalHourLocal ? cfg.baselineDays + 1 : 0;
  const base = opts.backfillDays ?? Math.max(DEFAULT_WINDOW_DAYS, wide);
  // A topic created recently may have lost its promote-time backfill (best-effort queue send): re-backfill it hourly.
  const newTopicMs = (cfg.baselineDays + 1) * dayMs;
  for (const t of topics) {
    const isNew = opts.now.getTime() - t.createdAt.getTime() < newTopicMs;
    const days = isNew ? Math.max(base, cfg.baselineDays + 1) : base;
    await rollupTopic(handle, t, new Date(opts.now.getTime() - days * dayMs), tz, cfg);
  }
  await handle.db.execute(sql`DELETE FROM topic_volume WHERE bucket = 'hour' AND ts < ${new Date(opts.now.getTime() - cfg.hourRetentionDays * 24 * HOUR_MS).toISOString()}::timestamptz`);

  let spikes = 0;
  if (!opts.topicId && local.hour >= cfg.evalHourLocal) {
    const day = shiftDate(local.date, -1);
    for (const t of topics) if (await evaluateSpike(handle, t, day, tz, cfg, opts)) spikes++;
  }
  const sent = await deliverPendingInsights(handle, { notifiers: opts.notifiers, rateLimiter: opts.rateLimiter, maxAttempts: cfg.deliveryMaxAttempts });
  return { topics: topics.length, spikes, sent };
}

const jobDataSchema = z.object({ topicId: z.string().uuid().optional(), backfillDays: z.number().int().min(1).max(60).optional() }).nullish();

export async function registerTopicRollupJob(boss: PgBoss, handle: DbHandle, notifiers: NotifierMap, rateLimiter: RateLimiter): Promise<void> {
  await boss.createQueue(TOPIC_ROLLUP_QUEUE);
  await boss.schedule(TOPIC_ROLLUP_QUEUE, TOPIC_ROLLUP_CRON, null, { singletonKey: TOPIC_ROLLUP_QUEUE });
  await boss.work(TOPIC_ROLLUP_QUEUE, { batchSize: 1 }, async ([job]) => {
    const data = jobDataSchema.parse(job?.data) ?? {};
    const r = await runTopicRollup(handle, {
      now: new Date(),
      notifiers,
      rateLimiter,
      ...(data.topicId ? { topicId: data.topicId } : {}),
      ...(data.backfillDays ? { backfillDays: data.backfillDays } : {}),
    });
    logger.info(r, "topic_rollup done");
  });
}
