// Seeds one team with 90 d x 30 sources of hour rows, day rows, and 8 d of hist terms.
// Test databases only: bun scripts/seed-analytics.ts   (uses TEST_DATABASE_URL; creates its own team).
import { createDb, type DbHandle } from "../packages/db/src/index";

export interface SeededAnalytics {
  teamId: string;
  userId: string;
  email: string;
  sourceIds: string[];
  itemId: string;
  categoryId: string;
}

export async function seedAnalytics(handle: DbHandle): Promise<SeededAnalytics> {
  const { sql } = handle;
  const tag = crypto.randomUUID().slice(0, 8);
  const [team] = await sql<{ id: string }[]>`insert into team (name) values (${`perf-${tag}`}) returning id`;
  const email = `perf-${tag}@example.com`;
  const [user] = await sql<{ id: string }[]>`insert into "user" (team_id, email, role) values (${team!.id}::uuid, ${email}, 'operator') returning id`;
  const [cat] = await sql<{ id: string }[]>`insert into category (slug, name, path) values (${`perf-${tag}`}, 'Perf', ${`perf_${tag}`}::ltree) returning id`;
  const [item] = await sql<{ id: string }[]>`insert into catalog_item (category_id, name) values (${cat!.id}::uuid, 'Perf item') returning id`;
  const sourceIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const [s] = await sql<{ id: string }[]>`
      insert into source (team_id, kind, platform_id, name, url) values (${team!.id}::uuid, 'web', ${`perf-${tag}-${i}`}, ${`Perf source ${i}`}, 'https://example.com')
      returning id`;
    sourceIds.push(s!.id);
  }
  const t = team!.id;
  const counts = sql`jsonb_build_object('posts', 20, 'unique', 18, 'sell', 10, 'buy', 5, 'other', 5, 'enriched', 15, 'matched', 4, 'notified', 2)`;
  await sql`
    insert into metric_rollup (bucket, ts, dims, counts)
    select 'hour', h, jsonb_build_object('metric', 'volume', 'teamId', ${t}::text) || coalesce(extra, '{}'::jsonb), ${counts}
    from generate_series(date_trunc('hour', now()) - interval '90 days', date_trunc('hour', now()), interval '1 hour') h
    cross join (select null::jsonb as extra union all select jsonb_build_object('sourceId', id::text) from source where team_id = ${t}::uuid) e`;
  await sql`
    insert into metric_rollup (bucket, ts, dims, counts)
    select 'day', d, jsonb_build_object('metric', 'volume', 'teamId', ${t}::text) || coalesce(extra, '{}'::jsonb), ${counts}
    from generate_series(date_trunc('day', now()) - interval '365 days', date_trunc('day', now()), interval '1 day') d
    cross join (select null::jsonb as extra union all select jsonb_build_object('sourceId', id::text) from source where team_id = ${t}::uuid) e`;
  await sql`
    insert into metric_rollup (bucket, ts, dims, counts)
    select 'day', d, jsonb_build_object('metric', 'price', 'teamId', ${t}::text, 'itemId', ${item!.id}::text),
           jsonb_build_object('n', 5, 'nRaw', 6, 'median', 10000000 + (extract(day from d)::int * 10000), 'p25', 9000000, 'p75', 11000000)
    from generate_series(date_trunc('day', now()) - interval '365 days', date_trunc('day', now()), interval '1 day') d`;
  await sql`
    insert into metric_rollup (bucket, ts, dims, counts)
    select 'day', d, jsonb_build_object('metric', 'authors', 'teamId', ${t}::text, 'authorKey', 'id:' || a),
           jsonb_build_object('posts', 1 + (a % 7), 'sell', a % 3, 'name', 'Author ' || a)
    from generate_series(date_trunc('day', now()) - interval '30 days', date_trunc('day', now()), interval '1 day') d
    cross join generate_series(1, 200) a`;
  await sql`
    insert into trend_term (team_id, "window", ts, term, count)
    select ${t}::uuid, 'hist', h, 'term ' || n, 2 + (n % 9)
    from generate_series(date_trunc('hour', now()) - interval '8 days', date_trunc('hour', now()), interval '1 hour') h
    cross join generate_series(1, 300) n`;
  for (const window of ["1h", "24h"]) {
    await sql`
      insert into trend_term (team_id, "window", ts, term, count, baseline, zscore)
      select ${t}::uuid, ${window}, date_trunc('hour', now()), 'term ' || n, 10 + (n % 9), 1, 3 + (n % 20)
      from generate_series(1, 30) n`;
  }
  return { teamId: t, userId: user!.id, email, sourceIds, itemId: item!.id, categoryId: cat!.id };
}

if (import.meta.main) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test")) {
    console.error("refusing: TEST_DATABASE_URL must be set and end in _test");
    process.exit(2);
  }
  const handle = createDb(url);
  try {
    const seeded = await seedAnalytics(handle);
    console.log(JSON.stringify({ teamId: seeded.teamId, email: seeded.email, itemId: seeded.itemId }));
  } finally {
    await handle.close();
  }
}
