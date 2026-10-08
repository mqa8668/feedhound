import { formatVndCompact } from "@feedhound/core/listing";
import { maskPii } from "@feedhound/core/pii";
import { searchParamsSchema } from "@feedhound/core/search-query";
import { buildSearchPredicate, schema, type DbHandle } from "@feedhound/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";
import { readConfigNumbers } from "./deal-decision";

/** Constants (no config). */
const NEW_LOW_LOOKBACK_DAYS = 30;
const NEW_LOWS_MAX = 5;
const MIN_MEDIAN_N = 3;
const MIN_PRIOR_FOR_LOW = 3;
const DAY_MS = 86_400_000;
const MEDIAN_CHANGE_MIN_PCT = 3;
const NO_CHANGES = "No significant changes since yesterday.";

const querySchema = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) });

/** Local calendar date (`YYYY-MM-DD`) of `at` in `tz`. */
function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validTz(tz: string | null): string {
  if (tz === null) return "Asia/Ho_Chi_Minh";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Ho_Chi_Minh";
  }
}

/**
 * `GET /api/insights/overview?days=` -- per-topic volume sparkline, weekly median asking price,
 * yesterday delta and new lows, plus a deterministic list of what changed. Topics are team-visible.
 * Prices counted are sell posts with an exact, non-suspect price.
 */
export function insightsOverviewRoute(handle: DbHandle, now: () => Date = () => new Date()): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/insights/overview", cfAccessAuth(handle), requireSession(), async (c) => {
    const { teamId } = c.get("session");
    const q = querySchema.safeParse({ days: c.req.query("days") || undefined });
    if (!q.success) return c.json({ error: "validation", message: "days must be an integer 7-90", issues: q.error.issues }, 400);
    const { days } = q.data;

    const [tzRow] = await handle.db.select({ value: schema.config.value }).from(schema.config).where(eq(schema.config.key, "app.tz")).orderBy(desc(schema.config.version)).limit(1);
    const tz = validTz(typeof tzRow?.value === "string" ? tzRow.value : null);
    const cfg = await readConfigNumbers(handle, { "insights.spike.minVolume": 10, "search.trgmMinLen": 3 });
    const at = now();
    const today = localDate(at, tz);
    const dayList = Array.from({ length: days }, (_, i) => shiftDate(today, i - (days - 1)));
    const windowStart = new Date(at.getTime() - Math.max(days, NEW_LOW_LOOKBACK_DAYS + 1) * DAY_MS);
    const cutoff = new Date(at.getTime() - DAY_MS);

    const topics = await handle.db.select().from(schema.topic).where(eq(schema.topic.teamId, teamId)).orderBy(schema.topic.name);

    // volume series from the rollup's day rows; a missing day is 0.
    const volRows = topics.length
      ? await handle.db.execute<{ topic_id: string; d: string; posts: number }>(sql`
          SELECT topic_id, (ts AT TIME ZONE ${tz})::date::text AS d, posts FROM topic_volume
          WHERE bucket = 'day' AND topic_id IN (${sql.join(topics.map((t) => sql`${t.id}::uuid`), sql`, `)})
            AND ts >= ((${dayList[0]}::date)::timestamp AT TIME ZONE ${tz})`)
      : [];
    const volBy = new Map<string, Map<string, number>>();
    for (const r of volRows) volBy.set(r.topic_id, (volBy.get(r.topic_id) ?? new Map()).set(r.d, r.posts));

    const out: {
      id: string;
      name: string;
      series: { day: string; posts: number }[];
      weekly: { week: string; medianVnd: number | null; n: number }[];
      yesterday: { posts: number; prevPosts: number };
      median7d: number | null;
      medianPrev7d: number | null;
      newLows: { postId: string; title: string; url: string; priceVnd: number; prevMinVnd: number }[];
    }[] = [];
    const changes: string[] = [];

    for (const t of topics) {
      const byDay = volBy.get(t.id) ?? new Map<string, number>();
      const series = dayList.map((day) => ({ day, posts: byDay.get(day) ?? 0 }));
      const yesterday = { posts: byDay.get(shiftDate(today, -1)) ?? 0, prevPosts: byDay.get(shiftDate(today, -2)) ?? 0 };

      const params = searchParamsSchema.safeParse(t.params);
      let weekly: { week: string; medianVnd: number | null; n: number }[] = [];
      let median7d: number | null = null;
      let medianPrev7d: number | null = null;
      let newLows: { postId: string; title: string; url: string; priceVnd: number; prevMinVnd: number }[] = [];
      if (params.success) {
        // Medians and the prior minimum are computed in SQL so a busy topic never loads its whole priced history.
        const pred = buildSearchPredicate(params.data, teamId, { trgmMinLen: cfg["search.trgmMinLen"] });
        const iso = (d: Date): string => d.toISOString();
        const base = sql`${pred} AND e.intent = 'sell' AND e.price_vnd IS NOT NULL AND NOT e.price_suspect AND e.price_qualifier = 'exact'
          AND p.effective_at >= ${iso(windowStart)}::timestamptz AND p.effective_at <= ${iso(at)}::timestamptz`;
        const daysStart = new Date(at.getTime() - days * DAY_MS);
        const weekRows = await handle.db.execute<{ week: string; n: number; med: string | number | null }>(sql`
          SELECT date_trunc('week', p.effective_at AT TIME ZONE ${tz})::date::text AS week, count(*)::int AS n,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY e.price_vnd) AS med
          FROM post p LEFT JOIN enrichment e ON e.post_id = p.id
          WHERE ${base} AND p.effective_at >= ${iso(daysStart)}::timestamptz
          GROUP BY 1 ORDER BY 1`);
        weekly = [...weekRows].map((r) => ({ week: r.week, medianVnd: r.n >= MIN_MEDIAN_N && r.med !== null ? Number(r.med) : null, n: r.n }));

        const t7 = iso(new Date(at.getTime() - 7 * DAY_MS));
        const t14 = iso(new Date(at.getTime() - 14 * DAY_MS));
        const lookbackStart = iso(new Date(cutoff.getTime() - NEW_LOW_LOOKBACK_DAYS * DAY_MS));
        const [agg] = await handle.db.execute<{ n7: number; med7: string | number | null; nprev: number; medprev: string | number | null; nprior: number; minprior: string | number | null }>(sql`
          SELECT count(*) FILTER (WHERE p.effective_at > ${t7}::timestamptz)::int AS n7,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY e.price_vnd) FILTER (WHERE p.effective_at > ${t7}::timestamptz) AS med7,
                 count(*) FILTER (WHERE p.effective_at > ${t14}::timestamptz AND p.effective_at <= ${t7}::timestamptz)::int AS nprev,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY e.price_vnd) FILTER (WHERE p.effective_at > ${t14}::timestamptz AND p.effective_at <= ${t7}::timestamptz) AS medprev,
                 count(*) FILTER (WHERE p.first_seen_at < ${iso(cutoff)}::timestamptz AND p.effective_at >= ${lookbackStart}::timestamptz)::int AS nprior,
                 min(e.price_vnd) FILTER (WHERE p.first_seen_at < ${iso(cutoff)}::timestamptz AND p.effective_at >= ${lookbackStart}::timestamptz) AS minprior
          FROM post p LEFT JOIN enrichment e ON e.post_id = p.id
          WHERE ${base} AND p.effective_at >= ${lookbackStart}::timestamptz`);
        if (agg) {
          median7d = agg.n7 >= MIN_MEDIAN_N && agg.med7 !== null ? Number(agg.med7) : null;
          medianPrev7d = agg.nprev >= MIN_MEDIAN_N && agg.medprev !== null ? Number(agg.medprev) : null;
          const prevMin = agg.nprior >= MIN_PRIOR_FOR_LOW && agg.minprior !== null ? Number(agg.minprior) : null;
          if (prevMin !== null) {
            // "first seen in the last 24 h" (first_seen_at), so an old listing the crawler just found still counts; capped.
            const lows = await handle.db.execute<{ id: string; title: string | null; display_title: string | null; url: string; price: string | number }>(sql`
              SELECT p.id, p.title, e.display_title, p.url, e.price_vnd AS price
              FROM post p LEFT JOIN enrichment e ON e.post_id = p.id
              WHERE ${base} AND p.first_seen_at >= ${iso(cutoff)}::timestamptz AND p.first_seen_at <= ${iso(at)}::timestamptz AND e.price_vnd < ${prevMin}
              ORDER BY e.price_vnd ASC, p.effective_at DESC LIMIT ${NEW_LOWS_MAX}`);
            newLows = [...lows].map((r) => ({ postId: r.id, title: maskPii(r.display_title ?? r.title ?? ""), url: r.url, priceVnd: Number(r.price), prevMinVnd: prevMin }));
          }
        }
      }

      const d = yesterday.posts - yesterday.prevPosts;
      if (d !== 0) changes.push(`${t.name}: ${yesterday.posts} posts yesterday (${d > 0 ? "+" : ""}${d} vs the day before)`);
      if (median7d !== null && medianPrev7d !== null && medianPrev7d > 0) {
        const x = Math.round(((median7d - medianPrev7d) / medianPrev7d) * 100);
        if (Math.abs(x) >= MEDIAN_CHANGE_MIN_PCT) {
          changes.push(`${t.name}: 7-day median price ${x < 0 ? "↓" : "↑"}${Math.abs(x)}% (${formatVndCompact(medianPrev7d)} → ${formatVndCompact(median7d)})`);
        }
      }
      for (const l of newLows) changes.push(`${t.name}: new low price ${formatVndCompact(l.priceVnd)} (previous low ${formatVndCompact(l.prevMinVnd)})`);

      out.push({ id: t.id, name: t.name, series, weekly, yesterday, median7d, medianPrev7d, newLows });
    }

    const [vol] = await handle.db
      .select({
        posts7d: sql<number>`count(*) filter (where ${schema.post.effectiveAt} >= ${new Date(at.getTime() - 7 * DAY_MS).toISOString()}::timestamptz)::int`,
        lastPostAt: sql<string | null>`max(${schema.post.effectiveAt})`,
      })
      .from(schema.post)
      .where(and(sql`${schema.post.effectiveAt} >= ${new Date(at.getTime() - 90 * DAY_MS).toISOString()}::timestamptz`, inArray(schema.post.sourceId, handle.db.select({ id: schema.source.id }).from(schema.source).where(and(eq(schema.source.teamId, teamId))))));
    const posts7d = vol?.posts7d ?? 0;

    return c.json({
      days,
      volume: {
        posts7d,
        perDay: Math.round((posts7d / 7) * 10) / 10,
        lastPostAt: vol?.lastPostAt ? new Date(vol.lastPostAt).toISOString() : null,
        spikeMinVolume: cfg["insights.spike.minVolume"],
      },
      changes: changes.length > 0 ? changes : [NO_CHANGES],
      topics: out,
    });
  });

  return app;
}
