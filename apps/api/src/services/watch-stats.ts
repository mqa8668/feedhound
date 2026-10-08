// Per-watch card stats (`GET /api/watches?stats=1`) and the `app.tz` day helpers shared with watch preview.

import type { NotifierKind } from "@feedhound/core/notifiers";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { desc, eq, inArray, or } from "drizzle-orm";

const DEFAULT_TZ = "Asia/Ho_Chi_Minh";
const STATS_DAYS = 7;
const DAY_MS = 86_400_000;

export interface WatchStats {
  today: number;
  last7d: number;
  /** One entry per `app.tz` day, oldest first, last entry = today. */
  daily: number[];
  lastHitAt: string | null;
  bestDeal: { postId: string; title: string | null; priceVnd: number; dealPct: number } | null;
  /** Kinds of the enabled notifiers in `notifierIds`; with `routesFallback`, of all the owner's enabled notifiers. */
  routes: NotifierKind[];
  /** No notifier picked, so matches go to all of the owner's enabled notifiers. */
  routesFallback: boolean;
}

/** `app.tz`; falls back to Asia/Ho_Chi_Minh. */
export async function loadAppTz(handle: DbHandle): Promise<string> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "app.tz"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "string" && row.value.length > 0 ? row.value : DEFAULT_TZ;
}

/** Whole-day number of `date`'s calendar day in `tz` (days since 1970-01-01 of the local date). */
export function localDayNumber(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(get("year"), get("month") - 1, get("day")) / DAY_MS);
}

/** Day number of a `YYYY-MM-DD` string. */
function dayNumberOfIso(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

/**
 * Index into a `days`-long, oldest-first daily array for `at`, relative to `now`. Anything older than the first day
 * clamps into index 0 (so a window that starts mid-day still sums to its total); future timestamps clamp to the last.
 */
export function dailyIndex(at: Date, now: Date, tz: string, days: number): number {
  const diff = localDayNumber(now, tz) - localDayNumber(at, tz);
  return Math.min(days - 1, Math.max(0, days - 1 - diff));
}

interface DayCountRow {
  watch_id: string;
  d: string;
  n: number;
}
interface LastHitRow {
  watch_id: string;
  last: Date;
}
interface DealRow {
  watch_id: string;
  post_id: string;
  title: string | null;
  price_vnd: number;
  deal_pct: number;
}

/** Stats for each given watch, keyed by watch id. `now` is injectable for tests. */
export async function loadWatchStats(
  handle: DbHandle,
  watches: { id: string; userId: string; notifierIds: string[] }[],
  now: Date = new Date(),
): Promise<Map<string, WatchStats>> {
  const out = new Map<string, WatchStats>();
  if (watches.length === 0) return out;
  const tz = await loadAppTz(handle);
  const ids = watches.map((w) => w.id);
  const nowIso = now.toISOString();
  const today = localDayNumber(now, tz);

  const dayRows = await handle.sql<DayCountRow[]>`
    select watch_id, (created_at at time zone ${tz})::date::text as d, count(*)::int as n
    from match
    where watch_id = any(${ids}::uuid[])
      and (created_at at time zone ${tz})::date >= ((${nowIso}::timestamptz at time zone ${tz})::date - ${STATS_DAYS - 1}::int)
    group by watch_id, d`;
  const lastRows = await handle.sql<LastHitRow[]>`
    select watch_id, max(created_at) as last from match where watch_id = any(${ids}::uuid[]) group by watch_id`;
  const dealRows = await handle.sql<DealRow[]>`
    select distinct on (m.watch_id) m.watch_id, p.id as post_id, p.title, e.price_vnd, e.deal_pct
    from match m
    join post p on p.id = m.post_id
    join lateral (select * from enrichment x where x.post_id = m.post_id order by x.revision desc limit 1) e on true
    where m.watch_id = any(${ids}::uuid[])
      and e.deal_pct is not null and e.deal_pct < 0 and e.price_vnd is not null
      and (m.created_at at time zone ${tz})::date >= ((${nowIso}::timestamptz at time zone ${tz})::date - ${STATS_DAYS - 1}::int)
    order by m.watch_id, e.deal_pct asc, m.created_at desc`;

  // One query covers the picked ids and, for watches with none picked, every notifier of their owners.
  const notifierIds = [...new Set(watches.flatMap((w) => w.notifierIds))];
  const fallbackOwners = [...new Set(watches.filter((w) => w.notifierIds.length === 0).map((w) => w.userId))];
  const notifiers =
    notifierIds.length === 0 && fallbackOwners.length === 0
      ? []
      : await handle.db
          .select({ id: schema.notifier.id, userId: schema.notifier.userId, kind: schema.notifier.kind, enabled: schema.notifier.enabled })
          .from(schema.notifier)
          .where(or(notifierIds.length > 0 ? inArray(schema.notifier.id, notifierIds) : undefined, fallbackOwners.length > 0 ? inArray(schema.notifier.userId, fallbackOwners) : undefined));
  const notifierById = new Map(notifiers.map((n) => [n.id, n]));

  for (const w of watches) {
    const daily = new Array<number>(STATS_DAYS).fill(0);
    for (const r of dayRows) {
      if (r.watch_id !== w.id) continue;
      const idx = STATS_DAYS - 1 - (today - dayNumberOfIso(r.d));
      if (idx >= 0 && idx < STATS_DAYS) daily[idx] = (daily[idx] ?? 0) + r.n;
    }
    const last = lastRows.find((r) => r.watch_id === w.id)?.last;
    const deal = dealRows.find((r) => r.watch_id === w.id);
    const routes: NotifierKind[] = [];
    const routesFallback = w.notifierIds.length === 0;
    const candidates = routesFallback ? notifiers.filter((n) => n.userId === w.userId) : w.notifierIds.map((nid) => notifierById.get(nid));
    for (const n of candidates) {
      const kind = n?.kind as NotifierKind | undefined;
      if (n?.enabled && kind && !routes.includes(kind)) routes.push(kind);
    }
    out.set(w.id, {
      today: daily[STATS_DAYS - 1] ?? 0,
      last7d: daily.reduce((a, b) => a + b, 0),
      daily,
      lastHitAt: last ? new Date(last).toISOString() : null,
      bestDeal: deal ? { postId: deal.post_id, title: deal.title, priceVnd: Number(deal.price_vnd), dealPct: deal.deal_pct } : null,
      routes,
      routesFallback,
    });
  }
  return out;
}
