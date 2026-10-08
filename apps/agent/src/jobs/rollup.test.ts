import { createDb, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { seedAirpodsSpike } from "../../../../tests/fixtures/analytics/airpods-spike";
import { cleanupTeams, createTeam, HOUR_MS, insertPosts, seedFlatBaseline } from "../../../../tests/fixtures/analytics/flat-baseline";
import { ROLLUP_DAY_EXPECTED, ROLLUP_DAY_HOURS, ROLLUP_DAY_START, seedRollupDay } from "../../../../tests/fixtures/analytics/rollup-day";
import { processRollupJob, runRollup } from "./rollup";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

let canRun = false;
if (TEST_DATABASE_URL) {
  if (!new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
  }
  const probe = createDb(TEST_DATABASE_URL);
  try {
    await probe.sql`select 1`;
    canRun = true;
  } catch (err) {
    if (MUST_RUN) throw err;
    console.warn(`rollup.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  } finally {
    await probe.close();
  }
} else if (MUST_RUN) {
  throw new Error("rollup.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("rollup.test.ts: skipped — TEST_DATABASE_URL is unset");
}

type Json = Record<string, unknown>;

async function rollupRows(handle: DbHandle, teamId: string): Promise<{ bucket: string; ms: number; dims: Json; counts: Json }[]> {
  const rows = await handle.sql<{ bucket: string; ms: number; dims: string; counts: string }[]>`
    select bucket, (extract(epoch from ts) * 1000)::float8 as ms, dims::text as dims, counts::text as counts from metric_rollup
    where dims->>'teamId' = ${teamId} and dims->>'metric' in ('volume', 'price', 'authors')
    order by bucket, ts, dims::text`;
  return rows.map((r) => ({ bucket: r.bucket, ms: r.ms, dims: JSON.parse(r.dims) as Json, counts: JSON.parse(r.counts) as Json }));
}

async function trendRows(handle: DbHandle, teamId: string): Promise<Json[]> {
  return handle.sql<Json[]>`
    select "window", ts::text as ts, term, category_id, count, baseline, zscore from trend_term
    where team_id = ${teamId} order by "window", ts, term, coalesce(category_id::text, '')`;
}

const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

describe.skipIf(!canRun)("runRollup (integration)", () => {
  let handle: DbHandle;
  const teams: string[] = [];
  const categories: string[] = [];

  beforeAll(() => {
    handle = createDb(TEST_DATABASE_URL);
  });
  afterAll(async () => {
    await cleanupTeams(handle, teams, categories);
    await handle.close();
  });

  test("spike surfaces in 1h trending; re-run is identical; foreign metrics untouched", async () => {
    const t = await createTeam(handle, "spike");
    teams.push(t.teamId);
    const sourceId = t.sourceIds[0]!;
    const H = new Date("2026-08-20T10:00:00Z");
    const hours = await seedFlatBaseline(handle, sourceId, H);
    // each run also reprocesses the previous hour, so every second hour covers the whole baseline
    for (const h of hours.filter((_, i) => i % 2 === 1)) await runRollup(handle, { hourTs: h, now: H, teamIds: [t.teamId] });
    await seedAirpodsSpike(handle, sourceId, H);
    // The spike posts carry the LLM entity term "AirPods" (their text alone yields no entity term).
    await handle.sql`insert into enrichment (post_id, engine, trend_terms) select id, 'llm', array['AirPods'] from post where source_id = ${sourceId}::uuid and text = 'airpods'`;

    // foreign-metric rows inside the rolled-up range
    const foreign = [
      { bucket: "hour", ts: H, dims: { metric: "coverage", teamId: t.teamId, sourceId }, counts: { visits: 3 } },
      { bucket: "day", ts: new Date("2026-08-19T17:00:00Z"), dims: { metric: "llm_tokens", teamId: t.teamId }, counts: { total: 42 } },
    ];
    for (const r of foreign) {
      await handle.sql`insert into metric_rollup (bucket, ts, dims, counts) values (${r.bucket}, ${r.ts.toISOString()}::timestamptz, ${JSON.stringify(r.dims)}::jsonb, ${JSON.stringify(r.counts)}::jsonb)`;
    }
    const foreignSnapshot = async (): Promise<unknown> =>
      handle.sql`select bucket, ts::text, dims::text, counts::text from metric_rollup where dims->>'teamId' = ${t.teamId} and dims->>'metric' in ('coverage', 'llm_tokens') order by dims::text`;
    const foreignBefore = await foreignSnapshot();

    await runRollup(handle, { hourTs: H, now: H, teamIds: [t.teamId] });
    const spike = await handle.sql<{ count: number; zscore: number; team_id: string }[]>`
      select count, zscore, team_id from trend_term
      where team_id = ${t.teamId} and "window" = '1h' and ts = ${H.toISOString()}::timestamptz and term = 'airpods' and category_id is null`;
    expect(spike).toHaveLength(1);
    expect(spike[0]!.count).toBe(200);
    expect(spike[0]!.zscore).toBeGreaterThanOrEqual(3);
    const top = await handle.sql<{ term: string }[]>`
      select term from trend_term where team_id = ${t.teamId} and "window" = '1h' and ts = ${H.toISOString()}::timestamptz and category_id is null
      order by zscore desc limit 3`;
    expect(top.map((r) => r.term)).toContain("airpods");
    const bad = await handle.sql`select 1 from trend_term where team_id = ${t.teamId} and extractor <> 2`;
    expect(bad).toHaveLength(0);

    const first = hash([await rollupRows(handle, t.teamId), await trendRows(handle, t.teamId)]);
    await runRollup(handle, { hourTs: H, now: H, teamIds: [t.teamId] });
    expect(hash([await rollupRows(handle, t.teamId), await trendRows(handle, t.teamId)])).toBe(first);
    expect(await foreignSnapshot()).toEqual(foreignBefore);
  }, 300_000);

  test("Rollup-day fixture counts match expected JSON; T2 posts never counted in T", async () => {
    const f = await seedRollupDay(handle);
    teams.push(f.teamId, f.otherTeamId);
    categories.push(...f.categoryIds);
    for (const h of ROLLUP_DAY_HOURS) await runRollup(handle, { hourTs: h, now: ROLLUP_DAY_HOURS[2], teamIds: [f.teamId, f.otherTeamId] });

    const rows = await rollupRows(handle, f.teamId);
    const global = (bucket: string, ts: Date): Json | undefined =>
      rows.find((r) => r.bucket === bucket && r.ms === ts.getTime() && r.dims.metric === "volume" && Object.keys(r.dims).length === 2)?.counts;
    ROLLUP_DAY_HOURS.forEach((h, i) => expect(global("hour", h)).toEqual(ROLLUP_DAY_EXPECTED.hour[i]!));
    expect(global("day", ROLLUP_DAY_START)).toEqual(ROLLUP_DAY_EXPECTED.day);
    const author = rows.find((r) => r.bucket === "day" && r.dims.metric === "authors" && r.dims.authorKey === f.authorKey && !("categoryId" in r.dims));
    expect(author?.counts).toEqual(ROLLUP_DAY_EXPECTED.author);

    // 2 sources, 2 categories: per-source rows add up to the global count, and T2's source never appears
    const perSource = rows.filter((r) => r.bucket === "day" && r.dims.metric === "volume" && "sourceId" in r.dims && !("categoryId" in r.dims) && !("intent" in r.dims));
    expect(perSource.map((r) => r.dims.sourceId).sort()).toEqual([...f.sourceIds].sort());
    expect(perSource.reduce((n, r) => n + Number(r.counts.posts), 0)).toBe(10);
    const otherRows = await rollupRows(handle, f.otherTeamId);
    expect(otherRows.find((r) => r.bucket === "day" && r.dims.metric === "volume" && Object.keys(r.dims).length === 2)?.counts.posts).toBe(3);
  }, 120_000);

  test("Purge removes aged 007 rows only", async () => {
    const t = await createTeam(handle, "purge");
    teams.push(t.teamId);
    const now = new Date("2026-09-30T12:00:00Z");
    const aged = (days: number): string => new Date(now.getTime() - days * 24 * HOUR_MS).toISOString();
    const put = async (bucket: string, days: number, dims: Json): Promise<void> => {
      await handle.sql`insert into metric_rollup (bucket, ts, dims, counts) values (${bucket}, ${aged(days)}::timestamptz, ${JSON.stringify(dims)}::jsonb, ${JSON.stringify({ posts: 1 })}::jsonb)`;
    };
    await put("hour", 91, { metric: "volume", teamId: t.teamId });
    await put("hour", 91, { metric: "coverage", teamId: t.teamId });
    await put("day", 400, { metric: "volume", teamId: t.teamId });
    for (const window of ["hist", "1h"]) {
      await handle.sql`insert into trend_term (team_id, "window", ts, term, count) values (${t.teamId}, ${window}, ${aged(91)}::timestamptz, 'old', 9)`;
    }
    await runRollup(handle, { hourTs: new Date(now.getTime() - HOUR_MS), now, teamIds: [t.teamId] });
    const left = await handle.sql<{ bucket: string; metric: string }[]>`
      select bucket, dims->>'metric' as metric from metric_rollup where dims->>'teamId' = ${t.teamId} order by bucket, 2`;
    expect(left.map((r) => ({ ...r }))).toEqual([
      { bucket: "day", metric: "volume" },
      { bucket: "hour", metric: "coverage" },
    ]);
    const terms = await handle.sql`select 1 from trend_term where team_id = ${t.teamId} and term = 'old'`;
    expect(terms).toHaveLength(0);
  });

  test("1h/24h kept 7 d, hist kept 90 d", async () => {
    const t = await createTeam(handle, "retention035");
    teams.push(t.teamId);
    const now = new Date("2026-09-30T12:00:00Z");
    const aged = (days: number): string => new Date(now.getTime() - days * 24 * HOUR_MS).toISOString();
    const keys = ["analytics.retentionDays.trend", "retention.trendTermHistDays"];
    const values = [7, 90];
    const versions: number[] = [];
    for (const [i, key] of keys.entries()) {
      const [row] = await handle.sql<{ v: number }[]>`select coalesce(max(version), 0) + 1 as v from config where key = ${key}`;
      versions.push(row!.v);
      await handle.sql`insert into config (key, version, value, updated_by) values (${key}, ${row!.v}, ${JSON.stringify(values[i])}::jsonb, 'test:035')`;
    }
    try {
      const put = async (window: string, days: number, term: string): Promise<void> => {
        await handle.sql`insert into trend_term (team_id, "window", ts, term, count, extractor) values (${t.teamId}, ${window}, ${aged(days)}::timestamptz, ${term}, 9, 2)`;
      };
      await put("1h", 6, "h1-6d");
      await put("1h", 8, "h1-8d");
      await put("24h", 6, "h24-6d");
      await put("24h", 8, "h24-8d");
      await put("hist", 8, "hist-8d");
      await put("hist", 91, "hist-91d");
      await runRollup(handle, { hourTs: new Date(now.getTime() - HOUR_MS), now, teamIds: [t.teamId] });
      const left = await handle.sql<{ term: string }[]>`select term from trend_term where team_id = ${t.teamId} and term like '%-%d' order by term`;
      expect(left.map((r) => r.term)).toEqual(["h1-6d", "h24-6d", "hist-8d"]);
    } finally {
      for (const [i, key] of keys.entries()) await handle.sql`delete from config where key = ${key} and version = ${versions[i]!}`;
    }
  });

  test("review r1: one failing team does not stop the others; purge still runs", async () => {
    const bad = await createTeam(handle, "iso-bad");
    const good = await createTeam(handle, "iso-good");
    teams.push(bad.teamId, good.teamId);
    const H = new Date("2026-08-21T10:00:00Z");
    await seedAirpodsSpike(handle, bad.sourceIds[0]!, H);
    await seedAirpodsSpike(handle, good.sourceIds[0]!, H);
    const old = new Date(H.getTime() - 100 * 24 * HOUR_MS).toISOString();
    await handle.sql`insert into metric_rollup (bucket, ts, dims, counts) values ('hour', ${old}::timestamptz, ${JSON.stringify({ metric: "volume", teamId: good.teamId })}::jsonb, '{"posts":1}'::jsonb)`;
    await handle.sql.unsafe(`create or replace function iso_fail() returns trigger language plpgsql as $$ begin
      if new.dims->>'teamId' = '${bad.teamId}' then raise exception 'boom'; end if; return new; end $$`);
    await handle.sql.unsafe("create trigger iso_fail_trg before insert on metric_rollup for each row execute function iso_fail()");
    try {
      const res = await runRollup(handle, { hourTs: H, now: H, teamIds: [bad.teamId, good.teamId] });
      expect(res.errors).toBe(1);
      await expect(processRollupJob(handle, { hourTs: H.toISOString() }, [bad.teamId, good.teamId])).rejects.toThrow(/1 team/);
    } finally {
      await handle.sql.unsafe("drop trigger iso_fail_trg on metric_rollup");
      await handle.sql.unsafe("drop function iso_fail()");
    }
    expect((await rollupRows(handle, bad.teamId)).length).toBe(0);
    expect((await rollupRows(handle, good.teamId)).some((r) => r.bucket === "hour" && r.ms === H.getTime())).toBe(true);
    const aged = await handle.sql`select 1 from metric_rollup where ts = ${old}::timestamptz and dims->>'teamId' = ${good.teamId}`;
    expect(aged).toHaveLength(0);
  }, 120_000);

  test("review r1: concurrent runs on the same hour do not collide and leave correct rows", async () => {
    const t = await createTeam(handle, "conc");
    teams.push(t.teamId);
    const H = new Date("2026-08-22T10:00:00Z");
    await seedAirpodsSpike(handle, t.sourceIds[0]!, H);
    await runRollup(handle, { hourTs: H, now: H, teamIds: [t.teamId] });
    const hourRows = async (): Promise<Json[]> => (await rollupRows(handle, t.teamId)).filter((r) => r.bucket === "hour" && r.ms === H.getTime());
    const expected = hash(await hourRows());
    await Promise.all([1, 2, 3].map(() => runRollup(handle, { hourTs: H, now: H, teamIds: [t.teamId] })));
    const res = await Promise.all([runRollup(handle, { hourTs: H, now: H, teamIds: [t.teamId] }), runRollup(handle, { hourTs: new Date(H.getTime() + HOUR_MS), now: H, teamIds: [t.teamId] })]);
    expect(res.every((r) => r.errors === 0)).toBe(true);
    const rows = await rollupRows(handle, t.teamId);
    expect(rows.find((r) => r.bucket === "hour" && r.ms === H.getTime() && Object.keys(r.dims).length === 2)?.counts.posts).toBe(200);
    expect(hash(await hourRows())).toBe(expected);
  }, 120_000);

  /** Seeds `n` posts in the hour starting `hoursBefore` before H; returns their ids. */
  async function seedTermPosts(sourceId: string, H: Date, hoursBefore: number, n: number, text: string, terms: string[] | null): Promise<string[]> {
    const ids = await insertPosts(
      handle,
      Array.from({ length: n }, (_, i) => ({ sourceId, text, firstSeenAt: new Date(H.getTime() - hoursBefore * HOUR_MS + (i + 1) * 60_000) })),
    );
    if (terms) for (const id of ids) await handle.sql`insert into enrichment (post_id, engine, trend_terms) values (${id}::uuid, 'llm', ${terms}::text[])`;
    return ids;
  }

  test("New entity beats a steady generic word; snapshot has display + isNew; hist rows are extractor 2", async () => {
    const t = await createTeam(handle, "trend047a");
    teams.push(t.teamId);
    const sourceId = t.sourceIds[0]!;
    const H = new Date("2026-09-20T10:00:00Z");
    // "xe" ~4/h for the 7 days before the last 24 h (extractor-2 history, so no legacy rebuild).
    await handle.sql`
      insert into trend_term (team_id, "window", ts, term, count, display, extractor)
      select ${t.teamId}::uuid, 'hist', ${H.toISOString()}::timestamptz - g * interval '1 hour', 'xe', 4, 'xe', 2 from generate_series(25, 168) g`;
    for (let i = 1; i <= 12; i++) await seedTermPosts(sourceId, H, i, 1, "bán xe đẹp, xem xe chỉ 450tr", ["Honda City 2019", "xe"]);
    await runRollup(handle, { hourTs: H, now: H, teamIds: [t.teamId] });
    const snap = await handle.sql<{ term: string; display: string; count: number; lift: number; baseline: number; extractor: number }[]>`
      select term, display, count, lift, baseline, extractor from trend_term
      where team_id = ${t.teamId} and "window" = '24h' and ts = ${H.toISOString()}::timestamptz and category_id is null`;
    const city = snap.find((r) => r.term === "hondacity2019");
    expect(city).toMatchObject({ display: "Honda City 2019", count: 12, extractor: 2 });
    expect(city!.baseline).toBeLessThan(0.5);
    expect(snap.map((r) => r.term)).not.toContain("xe");
    expect(snap.every((r) => r.term.length > 2)).toBe(true);
    const old = await handle.sql`select 1 from trend_term where team_id = ${t.teamId} and extractor <> 2`;
    expect(old).toHaveLength(0);
  }, 120_000);

  test("Terms added after an hour was rolled up are counted next run; legacy hist rows are rebuilt", async () => {
    const t = await createTeam(handle, "trend047b");
    teams.push(t.teamId);
    const sourceId = t.sourceIds[0]!;
    const H = new Date("2026-09-21T10:00:00Z");
    const ids = await seedTermPosts(sourceId, H, 3, 5, "blah foo", null);
    await runRollup(handle, { hourTs: H, now: H, teamIds: [t.teamId] });
    const count = async (): Promise<number[]> =>
      (await handle.sql<{ count: number }[]>`select count from trend_term where team_id = ${t.teamId} and "window" = 'hist' and term = 'vision2022'`).map((r) => r.count);
    expect(await count()).toEqual([]);
    for (const id of ids) await handle.sql`insert into enrichment (post_id, engine, trend_terms) values (${id}::uuid, 'llm', array['Vision 2022'])`;
    const next = new Date(H.getTime() + HOUR_MS);
    await runRollup(handle, { hourTs: next, now: next, teamIds: [t.teamId] });
    expect(await count()).toEqual([5]);
    const snap = await handle.sql`select 1 from trend_term where team_id = ${t.teamId} and "window" = '24h' and ts = ${next.toISOString()}::timestamptz and term = 'vision2022'`;
    expect(snap).toHaveLength(1);

    const legacy = await createTeam(handle, "trend047c");
    teams.push(legacy.teamId);
    const src = legacy.sourceIds[0]!;
    for (const h of [3, 9, 50]) await handle.sql`insert into trend_term (team_id, "window", ts, term, count) values (${legacy.teamId}::uuid, 'hist', ${new Date(H.getTime() - h * HOUR_MS).toISOString()}::timestamptz, 'old', 9)`;
    for (const h of [160, 100, 30]) await seedTermPosts(src, H, h, 2, "blah foo", ["Vision 2022"]);
    await runRollup(handle, { hourTs: H, now: H, teamIds: [legacy.teamId] });
    const rows = await handle.sql<{ extractor: number; term: string; n: number }[]>`
      select extractor, term, count(*)::int as n from trend_term where team_id = ${legacy.teamId} and "window" = 'hist' group by 1, 2`;
    expect(rows.map((r) => ({ ...r }))).toEqual([{ extractor: 2, term: "vision2022", n: 3 }]);
  }, 120_000);

  test("Alias merge folds variants into one key, drop excludes the key", async () => {
    const t = await createTeam(handle, "trend047d");
    teams.push(t.teamId);
    const sourceId = t.sourceIds[0]!;
    const H = new Date("2026-09-22T10:00:00Z");
    await handle.sql`insert into trend_term_alias (team_id, term_key, kind, canonical_key, canonical_display) values
      (${t.teamId}::uuid, 'civicrs', 'merge', 'hondacivicrs', 'Honda Civic RS'), (${t.teamId}::uuid, 'xemay', 'drop', null, null)`;
    await seedTermPosts(sourceId, H, 2, 3, "p1", ["Civic RS"]);
    await seedTermPosts(sourceId, H, 2, 3, "p2", ["Honda Civic RS"]);
    await seedTermPosts(sourceId, H, 2, 2, "p3", ["Xemay"]);
    await runRollup(handle, { hourTs: H, now: H, teamIds: [t.teamId] });
    const rows = await handle.sql<{ term: string; display: string; count: number }[]>`
      select term, display, count from trend_term where team_id = ${t.teamId} and "window" = 'hist' and category_id is null order by term`;
    expect(rows.map((r) => ({ ...r }))).toEqual([{ term: "hondacivicrs", display: "Honda Civic RS", count: 6 }]);
  }, 120_000);
});
