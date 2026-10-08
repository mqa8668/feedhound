import { createLogger } from "@feedhound/core/logger";
import { authorKey } from "@feedhound/core/normalize";
import { priceStats } from "@feedhound/core/price-stats";
import { meanStd, zscoreFromStats } from "@feedhound/core/trending";
import { postTrendTerms, TREND_EXTRACTOR_VERSION, trendKey, trendLift } from "@feedhound/core/trend-entities";
import { schema, type DbHandle } from "@feedhound/db";
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";

const logger = createLogger({ service: "agent" });

/**
 * Hourly analytics rollup. Writes `metric_rollup` rows (metric volume | price | authors)
 * and `trend_term` rows (hist | 1h | 24h), all keyed by team. Every write is delete-then-insert in one
 * transaction per (team, bucket, ts) / (team, window, ts), so re-running an hour yields the same rows.
 */
export const ROLLUP_QUEUE = "rollup";
// Offset of 5 min means the newest hour appears ~hh:05; the trending API freshness window (3 h) is sized for this.
export const ROLLUP_CRON = "5 * * * *";

export const rollupPayloadSchema = z.object({
  hourTs: z.string().datetime().optional(),
  force: z.boolean().optional(),
});
export type RollupPayload = z.infer<typeof rollupPayloadSchema>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ANALYTICS_METRICS = ["volume", "price", "authors"] as const;
const BASELINE_HOURS = 168;
const INSERT_CHUNK = 2000;

export interface RollupOptions {
  hourTs: Date;
  now?: Date;
  /** Restrict the run to these teams (default: every team with a source). */
  teamIds?: string[];
}

export interface RollupConfig {
  tz: string;
  hourRetentionDays: number;
  trendRetentionDays: number;
  histRetentionDays: number;
  minCount: number;
  minZ: number;
  minLift: number;
  maxTermsPerPost: number;
}

export function floorToHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

async function configValue(handle: DbHandle, key: string): Promise<unknown> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return row?.value;
}

async function loadConfig(handle: DbHandle): Promise<RollupConfig> {
  const num = async (key: string, fallback: number): Promise<number> => {
    const v = await configValue(handle, key);
    return typeof v === "number" ? v : fallback;
  };
  const tz = await configValue(handle, "app.tz");
  return {
    tz: typeof tz === "string" ? tz : "Asia/Ho_Chi_Minh",
    hourRetentionDays: await num("analytics.retentionDays.hour", 90),
    trendRetentionDays: await num("analytics.retentionDays.trend", 90),
    histRetentionDays: await num("retention.trendTermHistDays", 90),
    minCount: await num("analytics.trend.minCount", 5),
    minZ: await num("analytics.trend.minZ", 3),
    minLift: await num("analytics.trend.minLift", 1.5),
    maxTermsPerPost: await num("analytics.trend.maxTermsPerPost", 5),
  };
}

interface PostRow {
  id: string;
  sourceId: string;
  fingerprint: string | null;
  authorId: string | null;
  authorName: string | null;
  firstSeenAt: Date;
  text: string;
  intent: string | null;
  categoryId: string | null;
  itemId: string | null;
  priceVnd: number | null;
  enriched: boolean;
  matched: boolean;
  notified: boolean;
  attributes: Record<string, unknown> | null;
  itemName: string | null;
  trendTerms: string[] | null;
}

/** Posts of one team first seen in [from, to), joined to enrichment, with match/notify flags. */
async function loadPosts(handle: DbHandle, teamId: string, from: Date, to: Date, withText: boolean): Promise<PostRow[]> {
  const rows = await handle.sql<
    {
      id: string;
      source_id: string;
      fingerprint: string | null;
      author_id: string | null;
      author_name: string | null;
      first_seen_at_ms: number;
      text: string;
      intent: string | null;
      category_id: string | null;
      item_id: string | null;
      price_vnd: number | null;
      enriched: boolean;
      matched: boolean;
      notified: boolean;
      attributes: Record<string, unknown> | null;
      item_name: string | null;
      trend_terms: string[] | null;
    }[]
  >`
    select p.id, p.source_id, p.fingerprint, p.author_id, p.author_name, (extract(epoch from p.first_seen_at) * 1000)::float8 as first_seen_at_ms,
           ${withText ? handle.sql`p.text` : handle.sql`''`} as text,
           e.intent, e.category_id, e.item_id, e.price_vnd, (e.post_id is not null) as enriched,
           exists (select 1 from match m where m.post_id = p.id) as matched,
           exists (select 1 from match m join notification n on n.match_id = m.id
                   where m.post_id = p.id and n.status in ('sent', 'merged')) as notified,
           ${withText ? handle.sql`e.attributes` : handle.sql`null::jsonb`} as attributes,
           ${withText ? handle.sql`ci.name` : handle.sql`null::text`} as item_name,
           ${withText ? handle.sql`e.trend_terms` : handle.sql`null::text[]`} as trend_terms
    from post p
    join source s on s.id = p.source_id
    left join enrichment e on e.post_id = p.id
    left join catalog_item ci on ci.id = e.item_id
    where s.team_id = ${teamId} and p.first_seen_at >= ${from.toISOString()}::timestamptz
      and p.first_seen_at < ${to.toISOString()}::timestamptz
    order by p.first_seen_at, p.id`;
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    fingerprint: r.fingerprint,
    authorId: r.author_id,
    authorName: r.author_name,
    firstSeenAt: new Date(r.first_seen_at_ms),
    text: r.text,
    intent: r.intent,
    categoryId: r.category_id,
    itemId: r.item_id,
    priceVnd: r.price_vnd,
    enriched: r.enriched,
    matched: r.matched,
    notified: r.notified,
    attributes: r.attributes,
    itemName: r.item_name,
    trendTerms: r.trend_terms,
  }));
}

interface RollupRow {
  dims: Record<string, string>;
  counts: Record<string, number | string>;
}

interface VolumeAcc {
  dims: Record<string, string>;
  posts: number;
  keys: Set<string>;
  sell: number;
  buy: number;
  other: number;
  enriched: number;
  matched: number;
  notified: number;
}

/** Volume rows for a set of posts of one team. */
function volumeRows(teamId: string, posts: readonly PostRow[]): RollupRow[] {
  const acc = new Map<string, VolumeAcc>();
  for (const p of posts) {
    const intent = p.intent === "sell" || p.intent === "buy" ? p.intent : "other";
    const c = p.categoryId;
    const sets: Record<string, string>[] = [
      {},
      { sourceId: p.sourceId },
      { intent },
      ...(c ? [{ categoryId: c }, { sourceId: p.sourceId, categoryId: c }, { categoryId: c, intent }] : []),
    ];
    for (const extra of sets) {
      const dims = { metric: "volume", teamId, ...extra };
      const key = JSON.stringify(Object.entries(dims).sort());
      let a = acc.get(key);
      if (!a) {
        a = { dims, posts: 0, keys: new Set(), sell: 0, buy: 0, other: 0, enriched: 0, matched: 0, notified: 0 };
        acc.set(key, a);
      }
      a.posts++;
      a.keys.add(p.fingerprint ?? p.id);
      a[intent]++;
      if (p.enriched) a.enriched++;
      if (p.matched) a.matched++;
      if (p.notified) a.notified++;
    }
  }
  return [...acc.values()].map((a) => ({
    dims: a.dims,
    counts: {
      posts: a.posts,
      unique: a.keys.size,
      sell: a.sell,
      buy: a.buy,
      other: a.other,
      enriched: a.enriched,
      matched: a.matched,
      notified: a.notified,
    },
  }));
}

function priceRows(teamId: string, posts: readonly PostRow[]): RollupRow[] {
  const byItem = new Map<string, number[]>();
  for (const p of posts) {
    if (p.intent !== "sell" || !p.itemId || !(p.priceVnd !== null && p.priceVnd > 0)) continue;
    const list = byItem.get(p.itemId) ?? [];
    list.push(p.priceVnd);
    byItem.set(p.itemId, list);
  }
  const rows: RollupRow[] = [];
  for (const [itemId, prices] of byItem) {
    const s = priceStats(prices);
    if (s) rows.push({ dims: { metric: "price", teamId, itemId }, counts: { n: s.n, nRaw: s.nRaw, median: s.median, p25: s.p25, p75: s.p75 } });
  }
  return rows;
}

function authorRows(teamId: string, posts: readonly PostRow[]): RollupRow[] {
  interface Acc {
    dims: Record<string, string>;
    posts: number;
    sell: number;
    name: string;
    newest: number;
  }
  const acc = new Map<string, Acc>();
  const bump = (dims: Record<string, string>, p: PostRow): void => {
    const key = JSON.stringify(Object.entries(dims).sort());
    let a = acc.get(key);
    if (!a) {
      a = { dims, posts: 0, sell: 0, name: "", newest: -Infinity };
      acc.set(key, a);
    }
    a.posts++;
    if (p.intent === "sell") a.sell++;
    const t = p.firstSeenAt.getTime();
    if (t >= a.newest) {
      a.newest = t;
      a.name = p.authorName ?? "";
    }
  };
  for (const p of posts) {
    const k = authorKey({ authorId: p.authorId, authorName: p.authorName });
    if (!k) continue;
    bump({ metric: "authors", teamId, authorKey: k }, p);
    if (p.categoryId) bump({ metric: "authors", teamId, authorKey: k, categoryId: p.categoryId }, p);
  }
  return [...acc.values()].map((a) => ({ dims: a.dims, counts: { posts: a.posts, sell: a.sell, name: a.name } }));
}

/** Serialises delete-then-insert of one (team, bucket, ts) between overlapping runs; released at commit. */
async function lockKey(tx: Pick<DbHandle["db"], "execute">, key: string): Promise<void> {
  await tx.execute(dsql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

async function writeRollup(handle: DbHandle, teamId: string, bucket: "hour" | "day", ts: Date, rows: readonly RollupRow[]): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await lockKey(tx, `${teamId}:${bucket}:${ts.toISOString()}`);
    await tx
      .delete(schema.metricRollup)
      .where(
        and(
          eq(schema.metricRollup.bucket, bucket),
          eq(schema.metricRollup.ts, ts),
          dsql`${schema.metricRollup.dims}->>'teamId' = ${teamId}`,
          dsql`${schema.metricRollup.dims}->>'metric' in (${dsql.join(
            ANALYTICS_METRICS.map((m) => dsql`${m}`),
            dsql`, `,
          )})`,
        ),
      );
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(schema.metricRollup).values(rows.slice(i, i + INSERT_CHUNK).map((r) => ({ bucket, ts, dims: r.dims, counts: r.counts })));
    }
  });
}

type TermKey = string; // `${categoryId ?? ""}\u0000${trendKey}`
const termKey = (categoryId: string | null, term: string): TermKey => `${categoryId ?? ""}\u0000${term}`;
const splitKey = (k: TermKey): { categoryId: string | null; term: string } => {
  const i = k.indexOf("\u0000");
  return { categoryId: i === 0 ? null : k.slice(0, i), term: k.slice(i + 1) };
};

interface AliasVerdict {
  kind: string;
  canonicalKey: string | null;
  canonicalDisplay: string | null;
}

/** Curation verdicts of one team (`trend_term_alias`), by term key. */
async function loadAliases(handle: DbHandle, teamId: string): Promise<Map<string, AliasVerdict>> {
  const rows = await handle.sql<{ term_key: string; kind: string; canonical_key: string | null; canonical_display: string | null }[]>`
    select term_key, kind, canonical_key, canonical_display from trend_term_alias where team_id = ${teamId}`;
  return new Map(rows.map((r) => [r.term_key, { kind: r.kind, canonicalKey: r.canonical_key, canonicalDisplay: r.canonical_display }]));
}

interface HourTerms {
  counts: Map<TermKey, number>;
  /** trendKey -> most frequent display this hour (tie -> smallest). */
  displays: Map<string, string>;
}

function mostFrequent(votes: ReadonlyMap<string, number>): string {
  let best = "";
  let bestN = -1;
  for (const [d, n] of votes) {
    if (n > bestN || (n === bestN && d < best)) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/** Per-category + all-category entity-term counts for one hour (every count). */
function termCounts(posts: readonly PostRow[], aliases: ReadonlyMap<string, AliasVerdict>, maxTerms: number): HourTerms {
  const counts = new Map<TermKey, number>();
  const displayVotes = new Map<string, Map<string, number>>();
  const authorNames = [...new Set(posts.map((p) => p.authorName).filter((n): n is string => n !== null && n !== ""))];
  for (const p of posts) {
    const terms = postTrendTerms({ text: p.text, attributes: p.attributes, itemName: p.itemName, llmTerms: p.trendTerms, authorNames, max: maxTerms });
    const seen = new Set<string>();
    for (const display of terms) {
      let key = trendKey(display);
      let shown = display;
      const verdict = aliases.get(key);
      if (verdict?.kind === "drop") continue;
      if (verdict?.kind === "merge" && verdict.canonicalKey) {
        key = verdict.canonicalKey;
        shown = verdict.canonicalDisplay ?? display;
        // One hop only; a canonical that was later dropped never resurfaces.
        if (aliases.get(key)?.kind === "drop") continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const votes = displayVotes.get(key) ?? new Map<string, number>();
      votes.set(shown, (votes.get(shown) ?? 0) + 1);
      displayVotes.set(key, votes);
      counts.set(termKey(null, key), (counts.get(termKey(null, key)) ?? 0) + 1);
      if (p.categoryId) counts.set(termKey(p.categoryId, key), (counts.get(termKey(p.categoryId, key)) ?? 0) + 1);
    }
  }
  return { counts, displays: new Map([...displayVotes].map(([k, votes]) => [k, mostFrequent(votes)])) };
}

interface TrendRow {
  term: string;
  categoryId: string | null;
  count: number;
  baseline: number | null;
  zscore: number | null;
  display: string | null;
  lift: number | null;
}

async function writeTerms(handle: DbHandle, teamId: string, window: "hist" | "1h" | "24h", ts: Date, rows: readonly TrendRow[]): Promise<void> {
  await handle.db.transaction(async (tx) => {
    await lockKey(tx, `${teamId}:terms:${window}:${ts.toISOString()}`);
    await tx
      .delete(schema.trendTerm)
      .where(and(eq(schema.trendTerm.teamId, teamId), eq(schema.trendTerm.window, window), eq(schema.trendTerm.ts, ts)));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(schema.trendTerm).values(rows.slice(i, i + INSERT_CHUNK).map((r) => ({ teamId, window, ts, extractor: TREND_EXTRACTOR_VERSION, ...r })));
    }
  });
}

interface HistTerm {
  byTs: Map<number, number>;
  displays: Map<string, number>;
}

/** Hourly raw counts per term key over [from, to), from persisted extractor-2 `hist` rows. */
async function loadHist(handle: DbHandle, teamId: string, from: Date, to: Date): Promise<Map<TermKey, HistTerm>> {
  const rows = await handle.sql<{ ts_ms: number; term: string; category_id: string | null; count: number; display: string | null }[]>`
    select (extract(epoch from ts) * 1000)::float8 as ts_ms, term, category_id, count, display from trend_term
    where team_id = ${teamId} and "window" = 'hist' and extractor = ${TREND_EXTRACTOR_VERSION}
      and ts >= ${from.toISOString()}::timestamptz and ts < ${to.toISOString()}::timestamptz`;
  const out = new Map<TermKey, HistTerm>();
  for (const r of rows) {
    const k = termKey(r.category_id, r.term);
    let m = out.get(k);
    if (!m) {
      m = { byTs: new Map(), displays: new Map() };
      out.set(k, m);
    }
    m.byTs.set(r.ts_ms, r.count);
    if (r.display) m.displays.set(r.display, (m.displays.get(r.display) ?? 0) + r.count);
  }
  return out;
}

function hourlySeries(byTs: Map<number, number> | undefined, startMs: number, hours: number): number[] {
  const series: number[] = [];
  for (let i = 0; i < hours; i++) {
    const t = startMs + i * HOUR_MS;
    series.push(byTs?.get(t) ?? 0);
  }
  return series;
}

/** Rules 6 + 8 for hour H. `current` = every term count of H (unfiltered). */
async function rollupTrending(handle: DbHandle, teamId: string, H: Date, current: HourTerms, cfg: RollupConfig): Promise<void> {
  const Hms = H.getTime();
  const hist = await loadHist(handle, teamId, new Date(Hms - (BASELINE_HOURS + 24) * HOUR_MS), new Date(Hms + HOUR_MS));

  const oneH: TrendRow[] = [];
  for (const [k, count] of current.counts) {
    if (count < cfg.minCount) continue;
    const { mu, sigma } = meanStd(hourlySeries(hist.get(k)?.byTs, Hms - BASELINE_HOURS * HOUR_MS, BASELINE_HOURS));
    const z = zscoreFromStats(count, mu, sigma);
    const sk = splitKey(k);
    if (z >= cfg.minZ) oneH.push({ ...sk, count, baseline: mu, zscore: z, display: current.displays.get(sk.term) ?? null, lift: trendLift(count, mu).lift });
  }
  await writeTerms(handle, teamId, "1h", H, oneH);

  const twentyFourH: TrendRow[] = [];
  for (const [k, h] of hist) {
    let count = 0;
    for (let i = 0; i < 24; i++) count += h.byTs.get(Hms - i * HOUR_MS) ?? 0;
    if (count < cfg.minCount) continue;
    const { mu, sigma } = meanStd(hourlySeries(h.byTs, Hms - (BASELINE_HOURS + 24) * HOUR_MS, BASELINE_HOURS));
    const baseline = 24 * mu;
    const z = zscoreFromStats(count, baseline, Math.sqrt(24) * sigma);
    const { lift, isNew } = trendLift(count, baseline);
    if (lift >= cfg.minLift || isNew) twentyFourH.push({ ...splitKey(k), count, baseline, zscore: z, display: mostFrequent(h.displays) || null, lift });
  }
  await writeTerms(handle, teamId, "24h", H, twentyFourH);
}

/** Rewrites the `hist` rows of [h, h+1h) from the posts (recomputed so late LLM terms and aliases count). */
async function rollupHist(
  handle: DbHandle,
  teamId: string,
  h: Date,
  posts: readonly PostRow[],
  aliases: ReadonlyMap<string, AliasVerdict>,
  cfg: RollupConfig,
): Promise<HourTerms> {
  const terms = termCounts(posts, aliases, cfg.maxTermsPerPost);
  const rows: TrendRow[] = [];
  for (const [k, count] of terms.counts) {
    const sk = splitKey(k);
    rows.push({ ...sk, count, baseline: null, zscore: null, display: terms.displays.get(sk.term) ?? null, lift: null });
  }
  await writeTerms(handle, teamId, "hist", h, rows);
  return terms;
}

const histRowsSignature = (rows: readonly TrendRow[]): string =>
  rows
    .map((r) => `${r.categoryId ?? ""}\u0000${r.term}\u0000${r.count}\u0000${r.display ?? ""}`)
    .sort()
    .join("\u0001");

/**
 * Recomputes the `hist` rows of `hours` consecutive hours from `from` with one posts query and one hist query,
 * writing only the hours whose rows changed (so a steady state costs no writes).
 */
async function rollupHistRange(
  handle: DbHandle,
  teamId: string,
  from: Date,
  hours: number,
  aliases: ReadonlyMap<string, AliasVerdict>,
  cfg: RollupConfig,
): Promise<void> {
  const to = new Date(from.getTime() + hours * HOUR_MS);
  const posts = await loadPosts(handle, teamId, from, to, true);
  const byHour = new Map<number, PostRow[]>();
  for (const p of posts) {
    const h = floorToHour(p.firstSeenAt).getTime();
    const list = byHour.get(h) ?? [];
    list.push(p);
    byHour.set(h, list);
  }
  const existing = await handle.sql<{ ts_ms: number; term: string; category_id: string | null; count: number; display: string | null; extractor: number }[]>`
    select (extract(epoch from ts) * 1000)::float8 as ts_ms, term, category_id, count, display, extractor from trend_term
    where team_id = ${teamId} and "window" = 'hist' and ts >= ${from.toISOString()}::timestamptz and ts < ${to.toISOString()}::timestamptz`;
  const oldRows = new Map<number, TrendRow[]>();
  const legacy = new Set<number>();
  for (const r of existing) {
    const list = oldRows.get(r.ts_ms) ?? [];
    list.push({ term: r.term, categoryId: r.category_id, count: r.count, baseline: null, zscore: null, display: r.display, lift: null });
    oldRows.set(r.ts_ms, list);
    if (r.extractor < TREND_EXTRACTOR_VERSION) legacy.add(r.ts_ms);
  }
  for (let i = 0; i < hours; i++) {
    const h = new Date(from.getTime() + i * HOUR_MS);
    const terms = termCounts(byHour.get(h.getTime()) ?? [], aliases, cfg.maxTermsPerPost);
    const rows: TrendRow[] = [];
    for (const [k, count] of terms.counts) {
      const sk = splitKey(k);
      rows.push({ ...sk, count, baseline: null, zscore: null, display: terms.displays.get(sk.term) ?? null, lift: null });
    }
    const before = oldRows.get(h.getTime()) ?? [];
    if (!legacy.has(h.getTime()) && histRowsSignature(before) === histRowsSignature(rows)) continue;
    await writeTerms(handle, teamId, "hist", h, rows);
  }
}

/** Hour rows + hist for [h, h+1h). Returns the unfiltered term counts. */
async function rollupHour(handle: DbHandle, teamId: string, h: Date, aliases: ReadonlyMap<string, AliasVerdict>, cfg: RollupConfig): Promise<HourTerms> {
  const posts = await loadPosts(handle, teamId, h, new Date(h.getTime() + HOUR_MS), true);
  await writeRollup(handle, teamId, "hour", h, volumeRows(teamId, posts));
  return rollupHist(handle, teamId, h, posts, aliases, cfg);
}

/**
 * A team without any extractor-2 hist row in the last 168 h still carries unigram-era rows.
 * Drop them and rebuild those 168 h oldest first (DB only; the rebuild is skipped when the team has no recent posts).
 */
async function rebuildLegacyHist(handle: DbHandle, teamId: string, H: Date, aliases: ReadonlyMap<string, AliasVerdict>, cfg: RollupConfig): Promise<void> {
  const from = new Date(H.getTime() - BASELINE_HOURS * HOUR_MS).toISOString();
  const [has] = await handle.sql<{ n: number }[]>`
    select count(*)::int as n from (select 1 from trend_term where team_id = ${teamId} and "window" = 'hist' and extractor = ${TREND_EXTRACTOR_VERSION}
      and ts >= ${from}::timestamptz limit 1) x`;
  if ((has?.n ?? 0) > 0) return;
  await handle.sql`delete from trend_term where team_id = ${teamId} and extractor < ${TREND_EXTRACTOR_VERSION}`;
  const [recent] = await handle.sql<{ n: number }[]>`
    select count(*)::int as n from (select 1 from post p join source s on s.id = p.source_id
      where s.team_id = ${teamId} and p.first_seen_at >= ${from}::timestamptz limit 1) x`;
  if ((recent?.n ?? 0) === 0) return;
  for (let i = BASELINE_HOURS; i >= 24; i -= 24) await rollupHistRange(handle, teamId, new Date(H.getTime() - i * HOUR_MS), 24, aliases, cfg);
}

/** Local-day bounds (in `tz`) of the day containing `at`, as UTC instants. */
async function dayBounds(handle: DbHandle, tz: string, at: Date): Promise<{ start: Date; end: Date }> {
  const [row] = await handle.sql<{ s: number; e: number }[]>`
    select (extract(epoch from date_trunc('day', ${at.toISOString()}::timestamptz at time zone ${tz}) at time zone ${tz}) * 1000)::float8 as s,
           (extract(epoch from (date_trunc('day', ${at.toISOString()}::timestamptz at time zone ${tz}) + interval '1 day') at time zone ${tz}) * 1000)::float8 as e`;
  if (!row) throw new Error("dayBounds: no row");
  return { start: new Date(row.s), end: new Date(row.e) };
}

async function rollupDay(handle: DbHandle, teamId: string, tz: string, at: Date): Promise<void> {
  const { start, end } = await dayBounds(handle, tz, at);
  const posts = await loadPosts(handle, teamId, start, end, false);
  await writeRollup(handle, teamId, "day", start, [...volumeRows(teamId, posts), ...priceRows(teamId, posts), ...authorRows(teamId, posts)]);
}

/** Only 007 rows; day rows and other metrics are never touched. */
async function purge(handle: DbHandle, cfg: RollupConfig, now: Date): Promise<void> {
  const cutoff = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
  await handle.sql`
    delete from metric_rollup
    where bucket = 'hour' and ts < ${cutoff(cfg.hourRetentionDays)}::timestamptz
      and dims->>'metric' in ${handle.sql([...ANALYTICS_METRICS])}`;
  await handle.sql`delete from trend_term where "window" = 'hist' and ts < ${cutoff(cfg.histRetentionDays)}::timestamptz`;
  await handle.sql`delete from trend_term where "window" in ('1h', '24h') and ts < ${cutoff(cfg.trendRetentionDays)}::timestamptz`;
}

let lastRollupAtMs: number | null = null;

/** Wall-clock ms of the last rollup run that finished with no team errors; null before the first. */
export function lastRollupSuccessMs(): number | null {
  return lastRollupAtMs;
}

let lastErrors = 0;

/** Teams that failed in the most recent rollup run. */
export function lastRollupErrors(): number {
  return lastErrors;
}

export async function runRollup(handle: DbHandle, opts: RollupOptions): Promise<{ teams: number; errors: number }> {
  const now = opts.now ?? new Date();
  const H = floorToHour(opts.hourTs);
  const prev = new Date(H.getTime() - HOUR_MS);
  const cfg = await loadConfig(handle);
  const teams = opts.teamIds
    ? await handle.sql<{ team_id: string }[]>`select distinct team_id from source where team_id in ${handle.sql(opts.teamIds)} order by team_id`
    : await handle.sql<{ team_id: string }[]>`select distinct team_id from source order by team_id`;
  let errors = 0;
  for (const { team_id: teamId } of teams) {
    try {
      const aliases = await loadAliases(handle, teamId);
      await rebuildLegacyHist(handle, teamId, H, aliases, cfg);
      // Late LLM terms / new aliases: re-count the whole trailing 24 h, not only the previous hour.
      await rollupHistRange(handle, teamId, new Date(H.getTime() - 24 * HOUR_MS), 23, aliases, cfg);
      await rollupHour(handle, teamId, prev, aliases, cfg);
      const current = await rollupHour(handle, teamId, H, aliases, cfg);
      const days = new Set<number>();
      for (const at of [prev, H]) days.add((await dayBounds(handle, cfg.tz, at)).start.getTime());
      for (const ms of days) await rollupDay(handle, teamId, cfg.tz, new Date(ms));
      await rollupTrending(handle, teamId, H, current, cfg);
    } catch (err) {
      errors++;
      logger.error({ teamId, hourTs: H.toISOString(), err: String(err) }, "rollup team failed");
    }
  }
  await purge(handle, cfg, now);
  lastErrors = errors;
  if (errors === 0) lastRollupAtMs = Date.now();
  logger.info({ hourTs: H.toISOString(), teams: teams.length, errors }, "rollup run");
  return { teams: teams.length, errors };
}

/** Enqueue a rollup for `hourTs`; the singleton key dedupes concurrent requests unless `force`. */
export async function enqueueRollup(boss: PgBoss, payload: RollupPayload): Promise<void> {
  const hourTs = payload.hourTs ? floorToHour(new Date(payload.hourTs)).toISOString() : undefined;
  await boss.send(ROLLUP_QUEUE, payload, hourTs && !payload.force ? { singletonKey: hourTs } : {});
}

async function fetchTz(handle: DbHandle): Promise<string> {
  const v = await configValue(handle, "app.tz");
  return typeof v === "string" ? v : "Asia/Ho_Chi_Minh";
}

/** One queue job: throws when any team failed so pg-boss retries (writes are idempotent and serialised). */
export async function processRollupJob(handle: DbHandle, data: unknown, teamIds?: string[]): Promise<void> {
  const payload = rollupPayloadSchema.parse(data ?? {});
  const hourTs = payload.hourTs ? new Date(payload.hourTs) : new Date(floorToHour(new Date()).getTime() - HOUR_MS);
  const res = await runRollup(handle, { hourTs, teamIds });
  if (res.errors > 0) throw new Error(`rollup failed for ${res.errors} team(s)`);
}

export async function registerRollup(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(ROLLUP_QUEUE);
  await boss.schedule(ROLLUP_QUEUE, ROLLUP_CRON, null, { tz: await fetchTz(handle) });
  await boss.work(ROLLUP_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await processRollupJob(handle, job.data);
    }
  });
}
