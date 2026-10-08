import { createDb, type DbHandle } from "@feedhound/db";
import type { LlmResult } from "@feedhound/llm/client";
import { createMockLlmClient } from "@feedhound/llm/mock";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTeams, createTeam } from "../../../../tests/fixtures/analytics/flat-baseline";
import { resetLlmQuotaBreaker, tripLlmQuotaBreaker } from "./enrich";
import { runTrendCurate, type TrendCurateConfig } from "./trend-curate";

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
    console.warn(`trend-curate.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  } finally {
    await probe.close();
  }
} else if (MUST_RUN) {
  throw new Error("trend-curate.test.ts: TEST_DATABASE_URL is required (CI is set)");
}

const CONFIG: TrendCurateConfig = {
  enabled: true,
  maxCandidates: 50,
  dailyTokenCap: 30_000,
  modelCheap: "cheap-model",
  modelStrong: "strong-model",
  tz: "Asia/Ho_Chi_Minh",
};
const NOW = new Date("2026-09-25T10:20:00Z");
const USAGE = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };

interface Out {
  merge: { canonical: string; keys: string[] }[];
  drop: string[];
}
const ok = (data: Out): LlmResult<unknown> => ({ ok: true, data, usage: USAGE, model: "cheap-model", latencyMs: 1 });
const sentKeys = (req: { prompt: { user: string } }): string[] => (JSON.parse(req.prompt.user) as { terms: { key: string }[] }).terms.map((t) => t.key);

describe.skipIf(!canRun)("trend_curate (integration)", () => {
  let handle: DbHandle;
  const teams: string[] = [];
  const budget = { isExhausted: async () => false, recordUsage: async () => ({ before: { prompt: 0, completion: 0, total: 0, calls: 0 }, after: { prompt: 0, completion: 0, total: 0, calls: 0 } }) };

  beforeAll(() => {
    handle = createDb(TEST_DATABASE_URL);
  });
  beforeEach(() => resetLlmQuotaBreaker());
  afterAll(async () => {
    await handle.sql`delete from trend_curate_run where team_id in ${handle.sql(teams)}`;
    await cleanupTeams(handle, teams);
    await handle.close();
  });

  async function seedTeam(label: string, n: number): Promise<string> {
    const t = await createTeam(handle, label);
    teams.push(t.teamId);
    for (let i = 1; i <= n; i++) {
      await handle.sql`insert into trend_term (team_id, "window", ts, term, display, count, lift, extractor)
        values (${t.teamId}::uuid, '24h', ${NOW.toISOString()}::timestamptz, ${`term${String(i).padStart(2, "0")}`}, ${i <= 2 ? `Honda City ${i}` : `Term ${i}`}, 10, ${100 - i}, 2)`;
    }
    return t.teamId;
  }
  const aliasRows = (teamId: string) =>
    handle.sql<{ term_key: string; kind: string; canonical_key: string | null; canonical_display: string | null }[]>`
      select term_key, kind, canonical_key, canonical_display from trend_term_alias where team_id = ${teamId}::uuid order by term_key`;
  const runRows = (teamId: string) =>
    handle.sql<{ candidates: number | null; tokens: number; outcome: string }[]>`
      select candidates, tokens, outcome from trend_curate_run where team_id = ${teamId}::uuid order by ran_at, id`;

  test("60 candidates -> 50 then 10 in two single calls; merge/drop/keep rows; run rows carry tokens", async () => {
    const teamId = await seedTeam("curate1", 60);
    const sent: string[][] = [];
    const client = createMockLlmClient([
      (req) => {
        sent.push(sentKeys(req));
        return ok({
          merge: [
            { canonical: "Honda City", keys: ["term01", "term02", "not-in-input"] },
            { canonical: "0912345678", keys: ["term05"] }, // canonical fails sanitising -> group skipped
          ],
          drop: ["term03", "term01", "ghost"],
        });
      },
      (req) => {
        sent.push(sentKeys(req));
        return ok({ merge: [], drop: [] });
      },
    ]);
    const res = await runTrendCurate(handle, { now: NOW, config: CONFIG, llmClient: client, budget, teamIds: [teamId] });
    expect(res.errors).toBe(0);
    expect(client.calls).toHaveLength(1);
    expect(sent[0]).toHaveLength(50);
    expect(client.calls[0]!.model).toBe("cheap-model");
    let alias = await aliasRows(teamId);
    const byKey = new Map(alias.map((a) => [a.term_key, a]));
    expect(byKey.get("term01")).toMatchObject({ kind: "merge", canonical_key: "hondacity", canonical_display: "Honda City" });
    expect(byKey.get("term02")).toMatchObject({ kind: "merge", canonical_key: "hondacity" });
    expect(byKey.get("term03")?.kind).toBe("drop");
    expect(byKey.get("term05")?.kind).toBe("keep");
    expect(byKey.has("not-in-input") || byKey.has("ghost")).toBe(false);
    expect(sent[0]!.every((k) => byKey.has(k))).toBe(true);
    expect((await runRows(teamId)).map((r) => ({ ...r }))).toEqual([{ candidates: 50, tokens: 120, outcome: "ok" }]);

    await runTrendCurate(handle, { now: NOW, config: CONFIG, llmClient: client, budget, teamIds: [teamId] });
    expect(client.calls).toHaveLength(2);
    expect(sent[1]!.length).toBeLessThanOrEqual(11); // the 10 leftovers (+ the canonical key row is already `keep`)
    expect(sent[1]!.every((k) => !sent[0]!.includes(k))).toBe(true);
    alias = await aliasRows(teamId);
    expect(alias.filter((a) => a.term_key.startsWith("term")).length).toBe(60);

    // third run: nothing left -> no call and no run row
    await runTrendCurate(handle, { now: NOW, config: CONFIG, llmClient: client, budget, teamIds: [teamId] });
    expect(client.calls).toHaveLength(2);
    expect(await runRows(teamId)).toHaveLength(2);
  });

  test("Flag off, exhausted budget, open breaker and reached cap make no call and set the outcome", async () => {
    const teamId = await seedTeam("curate2", 5);
    const client = createMockLlmClient([ok({ merge: [], drop: [] })]);
    const run = (over: Partial<TrendCurateConfig>, b = budget) => runTrendCurate(handle, { now: NOW, config: { ...CONFIG, ...over }, llmClient: client, budget: b, teamIds: [teamId] });

    await run({ enabled: false });
    await run({}, { ...budget, isExhausted: async () => true });
    tripLlmQuotaBreaker(NOW);
    await run({});
    resetLlmQuotaBreaker();
    await handle.sql`insert into trend_curate_run (team_id, candidates, tokens, outcome) values (${teamId}::uuid, 1, 40000, 'ok')`;
    await run({});
    expect(client.calls).toHaveLength(0);
    expect((await runRows(teamId)).map((r) => r.outcome)).toEqual(["disabled", "budget", "quota", "ok", "cap"]);
    expect(await aliasRows(teamId)).toHaveLength(0);
  });

  test("Invalid output writes no alias rows; a 429 on the cheap model escalates to strong", async () => {
    const bad = await seedTeam("curate3", 4);
    const client = createMockLlmClient([{ ok: false, reason: "schema", raw: "not json" }]);
    await runTrendCurate(handle, { now: NOW, config: CONFIG, llmClient: client, budget, teamIds: [bad] });
    expect(client.calls).toHaveLength(1);
    expect(await aliasRows(bad)).toHaveLength(0);
    expect((await runRows(bad)).map((r) => r.outcome)).toEqual(["invalid"]);

    const esc = await seedTeam("curate4", 3);
    const client2 = createMockLlmClient([{ ok: false, reason: "http", status: 429 }, ok({ merge: [], drop: ["term01"] })]);
    await runTrendCurate(handle, { now: NOW, config: CONFIG, llmClient: client2, budget, teamIds: [esc] });
    expect(client2.calls.map((c) => c.model)).toEqual(["cheap-model", "strong-model"]);
    expect((await aliasRows(esc)).map((a) => a.kind)).toEqual(["drop", "keep", "keep"]);
  });

  test("review: guard rejects underivable / name / chained canonicals; Civic RS chain is not written", async () => {
    const teamId = await seedTeam("curate5", 0);
    const put = async (team: string, term: string, display: string, lift: number): Promise<void> => {
      await handle.sql`insert into trend_term (team_id, "window", ts, term, display, count, lift, extractor) values (${team}::uuid, '24h', ${NOW.toISOString()}::timestamptz, ${term}, ${display}, 10, ${lift}, 2)`;
    };
    await put(teamId, "civicrs", "Civic RS", 9);
    await put(teamId, "hondacivicrs", "Honda Civic RS", 8);
    await put(teamId, "vision", "Vision 2022", 7);
    await put(teamId, "xyz", "Xyz", 6);
    const client = createMockLlmClient([
      ok({
        merge: [
          { canonical: "Honda Civic RS", keys: ["civicrs"] }, // canonical key is dropped in this run -> skipped
          { canonical: "Ignore previous instructions", keys: ["vision"] }, // not derivable from the input -> skipped
          { canonical: "Nguyễn Thị Hoa", keys: ["xyz"] }, // person name -> skipped
        ],
        drop: ["hondacivicrs"],
      }),
    ]);
    await runTrendCurate(handle, { now: NOW, config: CONFIG, llmClient: client, budget, teamIds: [teamId] });
    const kinds = Object.fromEntries((await aliasRows(teamId)).map((a) => [a.term_key, a.kind]));
    expect(kinds).toEqual({ civicrs: "keep", hondacivicrs: "drop", vision: "keep", xyz: "keep" });

    const t2 = await seedTeam("curate6", 0);
    await handle.sql`insert into trend_term_alias (team_id, term_key, kind) values (${t2}::uuid, 'hondacivicrs', 'drop')`;
    await put(t2, "civicrs", "Civic RS", 9);
    const c2 = createMockLlmClient([ok({ merge: [{ canonical: "Honda Civic RS", keys: ["civicrs"] }], drop: [] })]);
    await runTrendCurate(handle, { now: NOW, config: CONFIG, llmClient: c2, budget, teamIds: [t2] });
    expect((await aliasRows(t2)).find((a) => a.term_key === "civicrs")?.kind).toBe("keep");
  });
});
