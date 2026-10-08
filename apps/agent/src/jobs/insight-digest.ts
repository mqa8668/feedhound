import { escapeHtml } from "@feedhound/bot/format";
import { createLogger } from "@feedhound/core/logger";
import { validTz } from "@feedhound/core/tz";
import { telegramNotifierConfigSchema, type TelegramNotifierConfig } from "@feedhound/core/notifiers";
import { searchParamsSchema } from "@feedhound/core/search-query";
import { buildSearchPredicate, schema, type DbHandle } from "@feedhound/db";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { RateLimiter } from "../lib/rate-limit";
import type { NotifierMap } from "./notify";
import { fetchAppTz } from "./notify";
import { loadInsightsConfig, localParts, shiftDate, type InsightsConfig } from "./topic-rollup";

const logger = createLogger({ service: "agent" });

const INSIGHT_DIGEST_QUEUE = "insight_digest";
const INSIGHT_DIGEST_CRON = "20 * * * *";
const MAX_TEXT = 4000;
const SNIPPET_MAX = 120;

export function truncateText(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function snippet(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_MAX ? flat : `${flat.slice(0, SNIPPET_MAX - 1)}…`;
}

/** The user's first enabled telegram notifier with a valid chat id (delivery target). */
export async function findTelegramTarget(handle: DbHandle, userId: string): Promise<TelegramNotifierConfig | undefined> {
  const rows = await handle.db
    .select({ config: schema.notifier.config })
    .from(schema.notifier)
    .where(and(eq(schema.notifier.userId, userId), eq(schema.notifier.kind, "telegram"), eq(schema.notifier.enabled, true)))
    .orderBy(asc(schema.notifier.id));
  for (const r of rows) {
    const parsed = telegramNotifierConfigSchema.safeParse(r.config);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** Initial `delivery` for a new insight row: `pending` only when Telegram can actually be used. */
export async function initialDelivery(handle: DbHandle, notifiers: NotifierMap, userId: string, allowed = true): Promise<"pending" | "inbox"> {
  if (!allowed || !notifiers.telegram) return "inbox";
  return (await findTelegramTarget(handle, userId)) ? "pending" : "inbox";
}

/**
 * Sends every `pending` insight once (one attempt per row per run). Failures are retried on the next
 * run of either insight job until `deliveryMaxAttempts`, then `failed`. Never writes a `notification` row.
 */
export async function deliverPendingInsights(
  handle: DbHandle,
  deps: { notifiers: NotifierMap; rateLimiter: RateLimiter; maxAttempts: number },
): Promise<number> {
  const candidates = await handle.db
    .select({ id: schema.insight.id })
    .from(schema.insight)
    .where(eq(schema.insight.delivery, "pending"))
    .orderBy(asc(schema.insight.createdAt))
    .limit(200);
  let sent = 0;
  for (const { id } of candidates) {
    // Row lock held across the send: the topic_rollup and insight_digest jobs can overlap, and a row another
    // run is delivering is skipped (SKIP LOCKED); a row it already finished no longer matches `pending`.
    const ok = await handle.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.insight)
        .where(and(eq(schema.insight.id, id), eq(schema.insight.delivery, "pending")))
        .for("update", { skipLocked: true });
      if (!row) return false;
      const notifier = deps.notifiers.telegram;
      const target = notifier ? await findTelegramTarget(handle, row.userId) : undefined;
      if (!notifier || !target) {
        await tx.update(schema.insight).set({ delivery: "inbox" }).where(eq(schema.insight.id, row.id));
        return false;
      }
      await deps.rateLimiter.acquire(target.chatId);
      const html = fitHtml(row.text);
      let result: Awaited<ReturnType<typeof notifier.send>>;
      try {
        result = await notifier.send(target, { kind: "digest", html, dedupeKey: row.dedupeKey });
      } catch (err) {
        result = { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        await tx.update(schema.insight).set({ delivery: "sent", deliveredAt: new Date(), deliveryError: null }).where(eq(schema.insight.id, row.id));
        return true;
      }
      if (result.retryAfterSec !== undefined) deps.rateLimiter.pause(target.chatId, result.retryAfterSec * 1_000);
      const attempts = row.attempts + 1;
      const failed = !result.retryable || attempts >= deps.maxAttempts;
      await tx
        .update(schema.insight)
        .set({ attempts, deliveryError: result.error, delivery: failed ? "failed" : "pending" })
        .where(eq(schema.insight.id, row.id));
      return false;
    });
    if (ok) sent++;
  }
  return sent;
}

/** Escaped HTML of `text` that fits Telegram's 4096-char limit (escaping can expand text up to 5x). */
export function fitHtml(text: string): string {
  let html = escapeHtml(text);
  let max = Math.min(text.length, 3000);
  while (html.length > 4096 && max > 1) {
    max -= Math.max(1, Math.ceil((html.length - 4096) / 5));
    html = escapeHtml(truncateText(text, Math.max(max, 1)));
  }
  return html;
}

interface TopicDayRow {
  topicId: string;
  name: string;
  posts: number;
  neg: number;
  pos: number;
  mean: number;
}

/** Absolute link when PUBLIC_HOSTNAME is set, relative otherwise. */
export function corpusLink(id: string, hostname: string | undefined = process.env.PUBLIC_HOSTNAME): string {
  const h = (hostname ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return h ? `https://${h}/corpus/${id}` : `/corpus/${id}`;
}

export interface InsightDigestOptions {
  now: Date;
  notifiers: NotifierMap;
  rateLimiter: RateLimiter;
  tz?: string;
  cfg?: InsightsConfig;
}

/** Daily digest. Returns the number of digest rows created and messages sent. */
export async function runInsightDigest(handle: DbHandle, opts: InsightDigestOptions): Promise<{ created: number; sent: number }> {
  const cfg = opts.cfg ?? (await loadInsightsConfig(handle));
  const tz = validTz(opts.tz ?? (await fetchAppTz(handle)));
  const local = localParts(opts.now, tz);
  let created = 0;
  if (local.hour >= cfg.digestHourLocal) created = await buildDigests(handle, opts, cfg, tz, shiftDate(local.date, -1), local.hour);
  const sent = await deliverPendingInsights(handle, { notifiers: opts.notifiers, rateLimiter: opts.rateLimiter, maxAttempts: cfg.deliveryMaxAttempts });
  return { created, sent };
}

async function buildDigests(handle: DbHandle, opts: InsightDigestOptions, cfg: InsightsConfig, tz: string, day: string, hour: number): Promise<number> {
  const topics = await handle.db.select().from(schema.topic).where(eq(schema.topic.enabled, true)).orderBy(asc(schema.topic.createdAt));
  const byUser = new Map<string, (typeof topics)[number][]>();
  for (const t of topics) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);
  const dayStart = sql`((${day}::date)::timestamp AT TIME ZONE ${tz})`;
  const dayEnd = sql`(((${day}::date + 1))::timestamp AT TIME ZONE ${tz})`;
  const baseStart = sql`(((${day}::date - ${cfg.baselineDays}::int))::timestamp AT TIME ZONE ${tz})`;
  let created = 0;

  for (const [userId, userTopics] of byUser) {
    const ids = sql.join(userTopics.map((t) => sql`${t.id}::uuid`), sql`, `);
    const vol = await handle.db.execute<{ topic_id: string; posts: number; neg: number; pos: number }>(sql`
      SELECT topic_id, posts, neg, pos FROM topic_volume WHERE bucket = 'day' AND ts = ${dayStart} AND topic_id IN (${ids})`);
    const base = await handle.db.execute<{ topic_id: string; total: number }>(sql`
      SELECT topic_id, sum(posts)::int AS total FROM topic_volume
      WHERE bucket = 'day' AND ts >= ${baseStart} AND ts < ${dayStart} AND topic_id IN (${ids}) GROUP BY topic_id`);
    const volBy = new Map([...vol].map((r) => [r.topic_id, r]));
    const baseBy = new Map([...base].map((r) => [r.topic_id, r.total]));
    const rows: TopicDayRow[] = userTopics.map((t) => ({
      topicId: t.id,
      name: t.name,
      posts: volBy.get(t.id)?.posts ?? 0,
      neg: volBy.get(t.id)?.neg ?? 0,
      pos: volBy.get(t.id)?.pos ?? 0,
      mean: (baseBy.get(t.id) ?? 0) / cfg.baselineDays,
    }));
    if (rows.every((r) => r.posts === 0)) {
      // An empty day still produces a digest, so "nothing happened" is distinguishable from "broken".
      const [total] = await handle.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM post p WHERE p.effective_at >= ${dayStart} AND p.effective_at < ${dayEnd}
          AND p.source_id IN (SELECT s.id FROM source s WHERE s.team_id = ${userTopics[0]!.teamId}::uuid)`);
      // The day's volume rows are only final once the wide re-roll at evalHourLocal has run. Until then a collected day
      // with no topic hits may just be an unfinished rollup: skip, the next hourly run writes the real digest.
      if ((total?.n ?? 0) > 0 && hour <= cfg.evalHourLocal) continue;
      const zeroInserted = await handle.db
        .insert(schema.insight)
        .values({
          teamId: userTopics[0]!.teamId,
          userId,
          kind: "digest",
          day,
          dedupeKey: `digest:${userId}:${day}`,
          payload: { day, topics: [], spikes: [], notable: [], zero: true },
          text: `Daily digest ${day}\n\nNo new posts for ${userTopics.length} topics yesterday. The system collected ${total?.n ?? 0} posts.`,
          delivery: await initialDelivery(handle, opts.notifiers, userId),
        })
        .onConflictDoNothing()
        .returning({ id: schema.insight.id });
      created += zeroInserted.length;
      continue;
    }
    const top = rows.filter((r) => r.posts > 0).sort((a, b) => b.posts - a.posts || a.name.localeCompare(b.name)).slice(0, cfg.digestTopTopics);

    const spikes = await handle.db
      .select({ topicId: schema.insight.topicId, payload: schema.insight.payload })
      .from(schema.insight)
      .where(and(eq(schema.insight.userId, userId), eq(schema.insight.kind, "spike"), sql`${schema.insight.day} = ${day}::date`));
    const spikeLines = spikes.map((s) => {
      const p = s.payload as { topicName?: string; explain?: string };
      return `${p.topicName ?? "?"}: ${p.explain ?? ""}`;
    });

    const notable = await notablePosts(handle, userTopics, { dayStart, dayEnd, max: cfg.digestNotableMax }, cfg);

    const lines: string[] = [`Daily digest ${day}`, "", "Top topics"];
    top.forEach((r, i) => {
      const delta = r.posts - r.mean;
      lines.push(`${i + 1}. ${r.name}: ${r.posts} posts (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} vs 7-day avg ${r.mean.toFixed(1)}), neg ${r.neg} / pos ${r.pos}`);
    });
    if (spikeLines.length > 0) lines.push("", "Spikes", ...spikeLines.map((l) => `- ${l}`));
    if (notable.length > 0) lines.push("", "Notable posts", ...notable.map((n) => `- ${n.line} ${corpusLink(n.id)}`));
    const text = truncateText(lines.join("\n"));

    const delivery = await initialDelivery(handle, opts.notifiers, userId);
    const inserted = await handle.db
      .insert(schema.insight)
      .values({
        teamId: userTopics[0]!.teamId,
        userId,
        kind: "digest",
        day,
        dedupeKey: `digest:${userId}:${day}`,
        payload: { day, topics: top, spikes: spikeLines, notable },
        text,
        delivery,
      })
      .onConflictDoNothing()
      .returning({ id: schema.insight.id });
    created += inserted.length;
  }
  return created;
}

async function notablePosts(
  handle: DbHandle,
  topics: (typeof schema.topic.$inferSelect)[],
  w: { dayStart: SQL; dayEnd: SQL; max: number },
  cfg: InsightsConfig,
): Promise<{ id: string; line: string }[]> {
  if (w.max === 0) return [];
  const preds = topics.map((t) => buildSearchPredicate(searchParamsSchema.parse(t.params), t.teamId, { trgmMinLen: cfg.trgmMinLen }));
  const anyPred = sql.join(preds.map((p) => sql`(${p})`), sql` OR `);
  const matched = sql.join(preds.map((p) => sql`(CASE WHEN (${p}) THEN 1 ELSE 0 END)`), sql` + `);
  const rows = await handle.db.execute<{ id: string; title: string | null; text: string }>(sql`
    SELECT p.id, p.title, p.text
    FROM post p LEFT JOIN enrichment e ON e.post_id = p.id
    WHERE p.effective_at >= ${w.dayStart} AND p.effective_at < ${w.dayEnd} AND (${anyPred})
    ORDER BY coalesce(('complain' = ANY(e.intent_tags)) OR e.sentiment = 'neg', false) DESC, (${matched}) DESC, p.effective_at DESC, p.id DESC
    LIMIT ${w.max}`);
  return [...rows].map((r) => ({ id: r.id, line: snippet(r.title && r.title.trim() !== "" ? r.title : r.text) }));
}

export async function registerInsightDigestJob(boss: PgBoss, handle: DbHandle, notifiers: NotifierMap, rateLimiter: RateLimiter): Promise<void> {
  await boss.createQueue(INSIGHT_DIGEST_QUEUE);
  await boss.schedule(INSIGHT_DIGEST_QUEUE, INSIGHT_DIGEST_CRON, null, { singletonKey: INSIGHT_DIGEST_QUEUE });
  await boss.work(INSIGHT_DIGEST_QUEUE, { batchSize: 1 }, async () => {
    const r = await runInsightDigest(handle, { now: new Date(), notifiers, rateLimiter });
    if (r.created > 0 || r.sent > 0) logger.info(r, "insight_digest done");
  });
}
