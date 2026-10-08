import { createLogger } from "@feedhound/core/logger";
import { postTrendTerms, trendKey } from "@feedhound/core/trend-entities";
import { TrendCurateOutput } from "@feedhound/llm";
import type { Budget } from "@feedhound/llm/budget";
import type { LlmClient } from "@feedhound/llm/client";
import { getPrompt, type TrendCuratePromptInput } from "@feedhound/llm/registry";
import type { DbHandle } from "@feedhound/db";
import type { PgBoss } from "pg-boss";
import { isLlmQuotaBlocked, isQuotaFailure, tripLlmQuotaBreaker } from "./enrich";

const logger = createLogger({ service: "agent" });

/**
 * Hourly, bounded LLM curation of the newest 24 h trend snapshot. One cheap-model call per team
 * merges spelling variants and drops generic keys; verdicts are cached per key in `trend_term_alias`.
 */
export const TREND_CURATE_QUEUE = "trend_curate";
export const TREND_CURATE_CRON = "20 * * * *";

export interface TrendCurateConfig {
  enabled: boolean;
  maxCandidates: number;
  dailyTokenCap: number;
  modelCheap: string;
  modelStrong: string;
  tz: string;
}

export interface RunTrendCurateOptions {
  now: Date;
  config: TrendCurateConfig;
  llmClient: LlmClient | undefined;
  budget: Pick<Budget, "isExhausted" | "recordUsage"> | undefined;
  teamIds?: string[];
}

type Outcome = "ok" | "invalid" | "error" | "disabled" | "budget" | "quota" | "cap";

async function recordRun(handle: DbHandle, teamId: string, candidates: number | null, tokens: number, outcome: Outcome): Promise<void> {
  await handle.sql`insert into trend_curate_run (team_id, candidates, tokens, outcome) values (${teamId}, ${candidates}, ${tokens}, ${outcome})`;
}

async function tokensToday(handle: DbHandle, teamId: string, now: Date, tz: string): Promise<number> {
  const [row] = await handle.sql<{ n: number }[]>`
    select coalesce(sum(tokens), 0)::int as n from trend_curate_run
    where team_id = ${teamId}
      and ran_at >= (date_trunc('day', ${now.toISOString()}::timestamptz at time zone ${tz}) at time zone ${tz})`;
  return row?.n ?? 0;
}

/** Un-curated keys of the newest 24 h snapshot (category null), strongest lift first. */
async function loadCandidates(handle: DbHandle, teamId: string, limit: number): Promise<TrendCuratePromptInput["terms"]> {
  const rows = await handle.sql<{ term: string; display: string | null; count: number }[]>`
    select t.term, t.display, t.count from trend_term t
    where t.team_id = ${teamId} and t."window" = '24h' and t.category_id is null and t.extractor >= 2
      and t.ts = (select max(ts) from trend_term where team_id = ${teamId} and "window" = '24h' and category_id is null)
      and not exists (select 1 from trend_term_alias a where a.team_id = t.team_id and a.term_key = t.term)
    order by t.lift desc nulls last, t.count desc, t.term
    limit ${limit}::int`;
  return rows.map((r) => ({ key: r.term, display: r.display ?? r.term, count: r.count }));
}

interface AliasWrite {
  key: string;
  kind: "merge" | "drop" | "keep";
  canonicalKey: string | null;
  canonicalDisplay: string | null;
}

const foldTokens = (text: string): string[] =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "");

/** A canonical must come from its inputs: it equals an input key, or shares >= 1 token with an input display. */
function derivable(canonical: string, inputs: readonly { key: string; display: string }[]): boolean {
  const ck = trendKey(canonical);
  const ct = new Set(foldTokens(canonical));
  return inputs.some((i) => i.key === ck || foldTokens(i.display).some((t) => ct.has(t)));
}

/**
 * Rule 8 + review: unknown keys are ignored. A canonical is skipped (with its group) when it fails sanitising (incl. the
 * person-name filter and the snapshot's author names), is not derivable from its input displays (bounds prompt injection),
 * is dropped in this run, is already dropped/merged (here or in an earlier run), or is itself merged away by another group.
 */
function planAliases(
  output: { merge: { canonical: string; keys: string[] }[]; drop: string[] },
  terms: readonly { key: string; display: string }[],
  authorNames: readonly string[],
  blocked: ReadonlySet<string>,
): AliasWrite[] {
  const input = new Map(terms.map((t) => [t.key, t]));
  const dropped = new Set(output.drop.filter((k) => input.has(k)));
  const mergedAway = new Set<string>();
  for (const g of output.merge) for (const k of g.keys) if (input.has(k)) mergedAway.add(k);
  const writes = new Map<string, AliasWrite>();
  for (const group of output.merge) {
    const canonical = postTrendTerms({ text: "", attributes: null, itemName: null, llmTerms: [group.canonical], authorNames: [...authorNames], max: 1 })[0];
    if (!canonical) continue;
    const canonicalKey = trendKey(canonical);
    const members = group.keys.filter((k) => input.has(k) && !writes.has(k));
    if (members.length === 0 || !derivable(canonical, members.map((k) => input.get(k)!))) continue;
    if (dropped.has(canonicalKey) || blocked.has(canonicalKey) || (mergedAway.has(canonicalKey) && !group.keys.includes(canonicalKey))) continue;
    for (const key of members) {
      if (key === canonicalKey) continue;
      writes.set(key, { key, kind: "merge", canonicalKey, canonicalDisplay: canonical });
    }
    if (!writes.has(canonicalKey)) writes.set(canonicalKey, { key: canonicalKey, kind: "keep", canonicalKey: null, canonicalDisplay: null });
  }
  for (const key of dropped) if (writes.get(key)?.kind !== "merge") writes.set(key, { key, kind: "drop", canonicalKey: null, canonicalDisplay: null });
  for (const key of input.keys()) if (!writes.has(key)) writes.set(key, { key, kind: "keep", canonicalKey: null, canonicalDisplay: null });
  return [...writes.values()];
}

async function curateTeam(handle: DbHandle, teamId: string, opts: RunTrendCurateOptions): Promise<void> {
  const { config, llmClient, budget, now } = opts;
  if (!config.enabled || !llmClient || !budget || config.modelCheap === "") return recordRun(handle, teamId, null, 0, "disabled");
  if (await budget.isExhausted()) return recordRun(handle, teamId, null, 0, "budget");
  if (isLlmQuotaBlocked(now)) return recordRun(handle, teamId, null, 0, "quota");
  if ((await tokensToday(handle, teamId, now, config.tz)) >= config.dailyTokenCap) return recordRun(handle, teamId, null, 0, "cap");

  const terms = await loadCandidates(handle, teamId, config.maxCandidates);
  if (terms.length === 0) return;

  const prompt = getPrompt<TrendCuratePromptInput>("trend-curate").render({ terms });
  let model = config.modelCheap;
  let result = await llmClient.complete({ model, prompt, schema: TrendCurateOutput });
  let tokens = 0;
  const account = async (usage: { totalTokens: number } | undefined): Promise<void> => {
    if (!usage) return;
    tokens += usage.totalTokens;
    await budget.recordUsage({ promptTokens: 0, completionTokens: 0, ...usage });
  };
  await account(result.usage);
  if (!result.ok && isQuotaFailure(result) && config.modelStrong !== "") {
    model = config.modelStrong;
    result = await llmClient.complete({ model, prompt, schema: TrendCurateOutput });
    await account(result.usage);
  }
  if (!result.ok) {
    if (isQuotaFailure(result)) tripLlmQuotaBreaker(now);
    logger.info({ teamId, reason: result.reason, status: result.status, raw: result.raw?.slice(0, 200) }, "trend_curate: LLM call failed");
    return recordRun(handle, teamId, terms.length, tokens, result.reason === "schema" ? "invalid" : isQuotaFailure(result) ? "quota" : "error");
  }

  const authors = await handle.sql<{ n: string }[]>`
    select distinct p.author_name as n from post p join source s on s.id = p.source_id
    where s.team_id = ${teamId} and p.author_name is not null and p.first_seen_at >= ${new Date(now.getTime() - 24 * 3_600_000).toISOString()}::timestamptz
    limit 5000`;
  const existing = await handle.sql<{ term_key: string }[]>`select term_key from trend_term_alias where team_id = ${teamId} and kind in ('merge', 'drop')`;
  const writes = planAliases(result.data, terms, authors.map((a) => a.n), new Set(existing.map((e) => e.term_key)));
  await handle.sql.begin(async (tx) => {
    for (const w of writes) {
      await tx`insert into trend_term_alias (team_id, term_key, kind, canonical_key, canonical_display, model)
        values (${teamId}, ${w.key}, ${w.kind}, ${w.canonicalKey}, ${w.canonicalDisplay}, ${model})
        on conflict (team_id, term_key) do nothing`;
    }
    await tx`insert into trend_curate_run (team_id, candidates, tokens, outcome) values (${teamId}, ${terms.length}, ${tokens}, 'ok')`;
  });
}

/** One pass over every team with a source; a failing team never stops the others. */
export async function runTrendCurate(handle: DbHandle, opts: RunTrendCurateOptions): Promise<{ teams: number; errors: number }> {
  const teams = opts.teamIds
    ? await handle.sql<{ team_id: string }[]>`select distinct team_id from source where team_id in ${handle.sql(opts.teamIds)} order by team_id`
    : await handle.sql<{ team_id: string }[]>`select distinct team_id from source order by team_id`;
  let errors = 0;
  for (const { team_id: teamId } of teams) {
    try {
      await curateTeam(handle, teamId, opts);
    } catch (err) {
      errors++;
      logger.error({ teamId, err: String(err) }, "trend_curate team failed");
    }
  }
  return { teams: teams.length, errors };
}

export interface RegisterTrendCurateOptions {
  boss: PgBoss;
  handle: DbHandle;
  llmClient: LlmClient | undefined;
  budget: () => Budget | undefined;
  fetchConfig: () => Promise<TrendCurateConfig>;
}

export async function registerTrendCurateJob(options: RegisterTrendCurateOptions): Promise<void> {
  const { boss, handle } = options;
  await boss.createQueue(TREND_CURATE_QUEUE);
  await boss.schedule(TREND_CURATE_QUEUE, TREND_CURATE_CRON, null, { singletonKey: TREND_CURATE_QUEUE });
  await boss.work(TREND_CURATE_QUEUE, async () => {
    const r = await runTrendCurate(handle, { now: new Date(), config: await options.fetchConfig(), llmClient: options.llmClient, budget: options.budget() });
    if (r.errors > 0) throw new Error(`trend_curate failed for ${r.errors} team(s)`);
  });
}
