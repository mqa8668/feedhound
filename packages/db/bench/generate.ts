import { sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/index";

// Seeded bulk generator for the corpus bench. Usage:
//   bun packages/db/bench/generate.ts --posts 500000 --seed 42 [--db <url>]
// Generates in SQL (generate_series + setseed) so 500 k rows take a minute, not an hour. Idempotent per `tag`.

export interface GenerateOptions {
  posts: number;
  seed: number;
  sources?: number;
  days?: number;
  enrichedPct?: number;
  matches?: number;
  tag?: string;
}

export interface GeneratedCorpus {
  teamId: string;
  tag: string;
}

const VOCAB = [
  "iphone", "15", "14", "pro", "max", "samsung", "galaxy", "macbook", "air", "laptop", "dell", "thinkpad", "ban", "can", "mua", "gia", "re", "fullbox", "seal", "like", "new", "cu",
  "may", "dep", "ipad", "tuyen", "dung", "react", "senior", "remote", "xe", "may", "honda", "vision", "sh", "ha", "noi", "hcm", "ship", "cod", "bao", "hanh", "12", "thang",
];

/** Creates one team + `sources` sources and `posts` posts (+ enrichment, + matches against one watch). */
export async function generateCorpus(handle: DbHandle, opts: GenerateOptions): Promise<GeneratedCorpus> {
  const { posts, seed } = opts;
  const sources = opts.sources ?? 20;
  const days = opts.days ?? 180;
  const enrichedPct = opts.enrichedPct ?? 90;
  const matches = opts.matches ?? Math.min(100_000, Math.floor(posts / 5));
  const tag = opts.tag ?? `bench${seed}`;

  const [team] = await handle.db.insert(schema.team).values({ name: `bench-corpus-${tag}-${Date.now()}` }).returning({ id: schema.team.id });
  const teamId = team!.id;
  const srcRows = await handle.db
    .insert(schema.source)
    .values(
      Array.from({ length: sources }, (_, i) => ({
        teamId,
        kind: "web" as const,
        platformId: `${tag}-src-${i}-${teamId.slice(0, 6)}`,
        name: `Bench group ${i}`,
        url: `https://feeds.example.test/${tag}-${i}-${teamId.slice(0, 6)}`,
      })),
    )
    .returning({ id: schema.source.id });
  const sourceIds = srcRows.map((s) => s.id);

  const cats: { id: string }[] = [];
  const catSlugs = ["phones", "laptops", "motorbikes", "jobs"];
  for (const slug of catSlugs) {
    const [c] = await handle.db
      .insert(schema.category)
      .values({ slug: `${slug}-${tag}-${teamId.slice(0, 6)}`, name: slug, path: `${slug}_${tag}_${teamId.slice(0, 6)}` })
      .returning({ id: schema.category.id });
    cats.push(c!);
  }
  const catIds = cats.map((c) => c.id);

  const vocabLiteral = sql.raw(`ARRAY[${VOCAB.map((w) => `'${w}'`).join(",")}]`);
  const srcLiteral = sql.raw(`ARRAY[${sourceIds.map((s) => `'${s}'::uuid`).join(",")}]`);
  const catLiteral = sql.raw(`ARRAY[${catIds.map((s) => `'${s}'::uuid`).join(",")}]`);
  const tagLit = sql.raw(`'${tag}-${teamId.slice(0, 6)}'`);

  await handle.db.execute(sql`SELECT setseed(${seed / 1000.0}::float8)`);
  await handle.db.execute(sql`
    INSERT INTO post (source_id, platform_post_id, url, title, text, text_normalized, author_name, author_id, posted_at, first_seen_at, enrich_state, match_state)
    SELECT src, 'b-' || ${tagLit} || '-' || g, 'https://feeds.example.test/bench/posts/' || g, 'b' || g, txt, txt,
      'Author ' || (g % 400), 'author-' || (g % 400), ts, ts, 'done', 'done'
    FROM (
      SELECT g, (${srcLiteral})[1 + (g % ${sources})] AS src,
        now() - (random() * ${days} * interval '1 day') AS ts,
        (SELECT string_agg((${vocabLiteral})[1 + floor(random() * ${VOCAB.length})::int], ' ') FROM generate_series(1, 5 + (g % 6))) AS txt
      FROM generate_series(1, ${posts}) g
    ) t`);
  await handle.db.execute(sql`
    INSERT INTO enrichment (post_id, intent, price_vnd, category_id, confidence)
    SELECT p.id, (ARRAY['sell','sell','buy','other'])[1 + floor(random() * 4)::int], round((100000 + random() * 49900000)::numeric),
      (${catLiteral})[1 + floor(random() * ${catIds.length})::int], random()
    FROM post p WHERE p.platform_post_id LIKE 'b-' || ${tagLit} || '-%' AND random() < ${enrichedPct / 100}`);

  if (matches > 0) {
    const [u] = await handle.db.insert(schema.user).values({ teamId, email: `bench-${tag}-${teamId.slice(0, 6)}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const [w] = await handle.db.insert(schema.watch).values({ userId: u!.id, name: "bench", includeAll: ["iphone"] }).returning({ id: schema.watch.id });
    await handle.db.execute(sql`
      INSERT INTO match (post_id, watch_id, score)
      SELECT id, ${w!.id}::uuid, random() FROM post WHERE platform_post_id LIKE 'b-' || ${tagLit} || '-%' ORDER BY id LIMIT ${matches}`);
  }
  await handle.db.execute(sql`ANALYZE post`);
  await handle.db.execute(sql`ANALYZE enrichment`);
  return { teamId, tag };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const url = arg("db") ?? process.env.BENCH_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.replace(/^\//, "").endsWith("_test")) throw new Error("generate: pass --db / BENCH_DATABASE_URL / TEST_DATABASE_URL pointing at a *_test database");
  const handle = createDb(url);
  try {
    const out = await generateCorpus(handle, { posts: Number(arg("posts") ?? 500_000), seed: Number(arg("seed") ?? 42) });
    console.log(JSON.stringify(out));
  } finally {
    await handle.close();
  }
}
