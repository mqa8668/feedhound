import { createDb, schema, type DbHandle } from "@feedhound/db";
import { METRICS_CONTENT_TYPE } from "@feedhound/core/metrics";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../index";
import { computePostsByCapture24h, computeSlo } from "./slo";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  let reachable = true;
  try {
    await probe.sql`select 1`;
  } catch (err) {
    reachable = false;
    if (MUST_RUN) {
      await probe.close();
      throw err;
    }
    console.warn(`slo.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) {
      await probe.close();
      throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    }
    canRun = true;
  }
  await probe.close();
} else if (MUST_RUN) {
  throw new Error("slo.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("slo.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("computeSlo + /metrics SLO gauges", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const now = new Date();
  const HOUR = 3_600_000;
  const hourStart = new Date(now);
  hourStart.setUTCMinutes(0, 0, 0);

  let handle: DbHandle;
  let teamId: string;
  let S: string;
  let T: string;

  async function makeSource(name: string, lastOkVisitAt?: Date): Promise<string> {
    const [row] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `slo-${name}-${suffix}`, name: `slo-${name}-${suffix}`, url: `https://example.com/${name}-${suffix}`, lastOkVisitAt })
      .returning({ id: schema.source.id });
    return row!.id;
  }

  async function rollup(sourceId: string, ts: Date, counts: Record<string, number>): Promise<void> {
    await handle.db.insert(schema.metricRollup).values({ bucket: "hour", ts, dims: { metric: "coverage", sourceId }, counts });
  }

  async function visit(sourceId: string, startedAt: Date, v: Partial<typeof schema.visit.$inferInsert>): Promise<void> {
    await handle.db.insert(schema.visit).values({ id: crypto.randomUUID(), sourceId, startedAt, ...v });
  }

  async function post(sourceId: string, id: string, fingerprint: string | null, capture: string | null): Promise<string> {
    const [row] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: id, url: `https://example.com/p/${id}`, fingerprint, capture })
      .returning({ id: schema.post.id });
    return row!.id;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `slo-test-${suffix}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    S = await makeSource("s", new Date(now.getTime() - 600_000));
    T = await makeSource("t");
  });

  afterAll(async () => {
    await handle.sql`delete from metric_rollup where dims->>'sourceId' = any(${[S, T]})`;
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, [S, T]));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId)); // visit cascades
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Coverage ratios, seconds since ok visit, nulls, /metrics samples", async () => {
    await rollup(S, hourStart, { visits_expected: 6, visits_ok: 5, visits_complete: 5 });
    await rollup(S, new Date(hourStart.getTime() - HOUR), { visits_expected: 4, visits_ok: 4, visits_complete: 3 });
    await rollup(S, new Date(now.getTime() - 30 * HOUR), { visits_expected: 100, visits_ok: 0, visits_complete: 0 });

    const [s, t] = await computeSlo(handle, { now, sourceIds: [S, T] }).then((r) => [r.find((x) => x.sourceId === S)!, r.find((x) => x.sourceId === T)!]);
    expect(s!.coverageOkRatio).toBeCloseTo(0.9, 10);
    expect(s!.coverageCompleteRatio).toBeCloseTo(0.8, 10);
    expect(s!.secondsSinceOkVisit).toBe(600);
    expect(t!.coverageOkRatio).toBeNull();
    expect(t!.coverageCompleteRatio).toBeNull();
    expect(t!.secondsSinceOkVisit).toBeNull();

    const res = await createApp(handle).request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toMatch(new RegExp(`source_coverage_ratio\\{kind="ok",source="${S}"\\} 0\\.9\\d*`));
    expect(body).not.toContain(`source_coverage_ratio{kind="ok",source="${T}"}`);
    expect(body).not.toContain(`source_coverage_ratio{kind="complete",source="${T}"}`);
  });

  test("Visit outcomes and posts by capture", async () => {
    await visit(S, new Date(now.getTime() - HOUR), { outcome: "ok" });
    await visit(S, new Date(now.getTime() - 2 * HOUR), { outcome: "ok" });
    await visit(S, new Date(now.getTime() - 3 * HOUR), { outcome: "no_slots" });
    await visit(S, new Date(now.getTime() - 4 * HOUR), { outcome: null });
    await visit(S, new Date(now.getTime() - 25 * HOUR), { outcome: "ok" });

    const [s] = await computeSlo(handle, { now, sourceIds: [S] });
    expect(s!.visits24h).toEqual({ ok: 2, no_slots: 1, in_flight: 1 });

    await post(S, `cap-a1-${suffix}`, null, "api");
    await post(S, `cap-a2-${suffix}`, null, "api");
    await post(S, `cap-p1-${suffix}`, null, "push");
    await post(S, `cap-u1-${suffix}`, null, null);
    expect(await computePostsByCapture24h(handle, { now, sourceIds: [S] })).toEqual({ api: 2, push: 1, unknown: 1 });
  });
});
