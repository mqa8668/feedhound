import { searchParamsSchema, type SearchParams } from "@feedhound/core/search-query";
import { sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { createDb, schema } from "../src/index";
import { buildSearchPredicate, searchPosts } from "../src/search";
import { generateCorpus } from "./generate";

// Runs only with BENCH=1 (not part of the default gate):
//   BENCH=1 bun packages/db/bench/corpus-bench.ts [--posts 500000] [--seed 42] [--keep]
// 40-query set x 20 runs after 3 warm-up passes; p95 per class must stay < 300 ms; EXPLAIN must show no seq scan on post.

const BUDGET_MS = 300;
const WARMUPS = 3;
const RUNS = 20;

if (process.env.BENCH !== "1") {
  console.error("corpus-bench: set BENCH=1 to run (heavy, not in the default gate)");
  process.exit(0);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = process.env.BENCH_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.replace(/^\//, "").endsWith("_test")) throw new Error("corpus-bench: BENCH_DATABASE_URL / TEST_DATABASE_URL must point at a *_test database");
const handle = createDb(url);
const posts = Number(arg("posts") ?? 500_000);
const seed = Number(arg("seed") ?? 42);

const gen = await generateCorpus(handle, { posts, seed });
const teamId = gen.teamId;
const cats = await handle.db.select({ id: schema.category.id }).from(schema.category).where(sql`${schema.category.slug} LIKE ${`%-${gen.tag}-${teamId.slice(0, 6)}`}`);
const cat = cats[0]!.id;
const p = (x: Partial<SearchParams>): SearchParams => searchParamsSchema.parse(x);

interface Q {
  cls: string;
  params: SearchParams;
}
const words = ["iphone", "samsung", "macbook", "laptop", "fullbox", "react", "honda", "ipad"];
const queries: Q[] = [];
for (const w of words) queries.push({ cls: "single-token", params: p({ q: w }) });
for (const w of words) queries.push({ cls: "multi-token", params: p({ q: `${w} 15 pro` }) });
for (const w of words.slice(0, 4)) queries.push({ cls: "phrase+exclude", params: p({ q: `"${w} 15" -seal` }) });
for (const w of words.slice(0, 4)) queries.push({ cls: "trigram", params: p({ q: w.slice(1, 6) }) });
for (const w of words.slice(0, 6)) queries.push({ cls: "filtered", params: p({ q: w, categoryIds: [cat], priceMin: 1_000_000, priceMax: 30_000_000, intents: ["sell"] }) });
for (const w of words.slice(0, 4)) queries.push({ cls: "newest/price", params: p({ q: w, sort: w.length % 2 ? "price_asc" : "newest" }) });
for (let i = 0; i < 6; i++) queries.push({ cls: "author/date", params: p({ author: `Author ${i * 7}`, from: new Date(Date.now() - 30 * 86400_000).toISOString() }) });
if (queries.length !== 40) throw new Error(`expected 40 queries, got ${queries.length}`);

const samples = new Map<string, number[]>();
for (let pass = 0; pass < WARMUPS + RUNS; pass++) {
  for (const q of queries) {
    const t0 = performance.now();
    const r = await searchPosts(handle, q.params, teamId);
    const ms = performance.now() - t0;
    if (!r.ok) throw new Error(r.error);
    if (pass >= WARMUPS) (samples.get(q.cls) ?? samples.set(q.cls, []).get(q.cls)!).push(ms);
  }
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
}

const lines: string[] = [`# Corpus search bench`, ``, `posts=${posts} seed=${seed} runs=${RUNS} warmups=${WARMUPS} budget p95 < ${BUDGET_MS} ms`, ``, `| class | n | p95 ms | verdict |`, `|---|---|---|---|`];
let fail = false;
for (const [cls, xs] of samples) {
  const v = p95(xs);
  const ok = v < BUDGET_MS;
  if (!ok) fail = true;
  lines.push(`| ${cls} | ${xs.length} | ${v.toFixed(1)} | ${ok ? "ok" : "FAIL"} |`);
}

lines.push(``, `## EXPLAIN (representative per class; "Seq Scan on post" is a failure)`, ``);
const seen = new Set<string>();
for (const q of queries) {
  if (seen.has(q.cls)) continue;
  seen.add(q.cls);
  const pred = buildSearchPredicate(q.params, teamId);
  const rows = await handle.db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN SELECT p.id FROM post p LEFT JOIN enrichment e ON e.post_id = p.id WHERE ${pred} ORDER BY p.effective_at DESC, p.id DESC LIMIT 26`);
  const plan = Array.from(rows).map((r) => r["QUERY PLAN"]).join("\n");
  const seq = /Seq Scan on post\b/.test(plan);
  if (seq) fail = true;
  lines.push(`- ${q.cls}: ${seq ? "SEQ SCAN on post" : "no seq scan on post"}`);
}
lines.push(``, fail ? "VERDICT: FAIL" : "VERDICT: PASS");
writeFileSync(new URL("./report.md", import.meta.url).pathname, `${lines.join("\n")}\n`);
console.log(lines.slice(-12).join("\n"));

if (!process.argv.includes("--keep")) {
  await handle.db.execute(sql`DELETE FROM match WHERE watch_id IN (SELECT w.id FROM watch w JOIN "user" u ON u.id = w.user_id WHERE u.team_id = ${teamId}::uuid)`);
  await handle.db.execute(sql`DELETE FROM enrichment WHERE post_id IN (SELECT p.id FROM post p JOIN source s ON s.id = p.source_id WHERE s.team_id = ${teamId}::uuid)`);
  await handle.db.execute(sql`DELETE FROM post WHERE source_id IN (SELECT id FROM source WHERE team_id = ${teamId}::uuid)`);
}
await handle.close();
process.exit(fail ? 1 : 0);
