import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { applyVisitOutcome } from "./source-health";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  try {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    canRun = true;
  } catch (err) {
    if (MUST_RUN) throw err;
  } finally {
    await probe.close();
  }
} else if (MUST_RUN) {
  throw new Error("source-health.test.ts: TEST_DATABASE_URL is required (CI is set)");
}

const T0 = new Date("2026-10-03T08:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

describe.skipIf(!canRun)("applyVisitOutcome", () => {
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let alerts: string[];
  const capture = async (_h: unknown, _t: string, text: string): Promise<void> => void alerts.push(text);

  async function status(): Promise<typeof schema.source.$inferSelect> {
    const [s] = await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId));
    return s!;
  }

  /** Inserts the visit row (as `POST /api/visits` does) then applies the outcome. */
  async function report(over: {
    id?: string;
    outcome: string;
    reason?: string | null;
    mode?: string;
    at: Date;
  }) {
    const id = over.id ?? crypto.randomUUID();
    await handle.db
      .insert(schema.visit)
      .values({
        id,
        sourceId,
        startedAt: over.at,
        finishedAt: over.at,
        outcome: over.outcome,
        mode: over.mode ?? "normal",
        reason: over.reason ?? null,
      })
      .onConflictDoNothing();
    return applyVisitOutcome(
      handle,
      { id, sourceId, outcome: over.outcome, reason: over.reason ?? null, mode: over.mode ?? "normal", finishedAt: over.at },
      { alert: capture, now: over.at },
    );
  }

  async function reset(statusValue: "active" | "paused" | "paused_by_health" = "active"): Promise<void> {
    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, sourceId));
    await handle.db
      .update(schema.source)
      .set({ status: statusValue, health: { ok: null }, healthAlertAt: null, lastHealthAt: null })
      .where(eq(schema.source.id, sourceId));
    alerts = [];
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `source-health-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [src] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `sh-${crypto.randomUUID()}`, name: "Health group", url: "https://feeds.example.test/sh" })
      .returning({ id: schema.source.id });
    sourceId = src!.id;
  });

  beforeEach(async () => {
    await reset();
  });

  afterAll(async () => {
    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("A blocked visit needs a 2nd within 30 min; replay adds no alert", async () => {
    const first = await report({ outcome: "blocked", reason: "blocked:dialog", at: min(0) });
    expect(first.actions).toEqual([]);
    const s1 = await status();
    expect(s1.status).toBe("active");
    expect(s1.health).toMatchObject({ ok: false, reason: "blocked:dialog" });
    expect(alerts).toHaveLength(0);

    const id2 = crypto.randomUUID();
    const second = await report({ id: id2, outcome: "blocked", reason: "blocked:dialog", at: min(10) });
    expect(second.actions).toEqual(["paused"]);
    expect((await status()).status).toBe("paused_by_health");
    expect(alerts).toHaveLength(1);

    const replay = await report({ id: id2, outcome: "blocked", reason: "blocked:dialog", at: min(10) });
    expect(replay.actions).toEqual([]);
    expect(alerts).toHaveLength(1);
  });

  test("A 2nd blocked visit 31 min later does not pause", async () => {
    await report({ outcome: "blocked", reason: "blocked:login_form", at: min(0) });
    await report({ outcome: "blocked", reason: "blocked:login_form", at: min(31) });
    expect((await status()).status).toBe("active");
    expect(alerts).toHaveLength(0);
  });

  test("round1: blocked pair pauses regardless of arrival order", async () => {
    await report({ outcome: "blocked", reason: "blocked:dialog", at: min(10) });
    expect((await status()).status).toBe("active");
    const r = await report({ outcome: "blocked", reason: "blocked:dialog", at: min(0) });
    expect(r.actions).toEqual(["paused"]);
    expect((await status()).status).toBe("paused_by_health");
    expect(alerts).toHaveLength(1);
  });

  test("round2: an intervening ok visit breaks the pair", async () => {
    await report({ outcome: "blocked", reason: "blocked:dialog", at: min(0) });
    await report({ outcome: "ok", at: min(10) });
    const r = await report({ outcome: "blocked", reason: "blocked:dialog", at: min(25) });
    expect(r.actions).toEqual([]);
    expect((await status()).status).toBe("active");
  });

  test("round2: a late blocked visit whose neighbour is not the newest visit does not pause", async () => {
    await report({ outcome: "blocked", reason: "blocked:dialog", at: min(-5) });
    await report({ outcome: "ok", at: min(10) });
    await report({ outcome: "no_slots", at: min(20) });
    const r = await report({ outcome: "blocked", reason: "blocked:dialog", at: min(0) });
    expect(r.actions).toEqual([]);
    expect((await status()).status).toBe("active");
  });

  test("round1: alert failure rolls back the status change; retry re-applies both", async () => {
    const failing = async (): Promise<void> => {
      throw new Error("alert insert failed");
    };
    await report({ outcome: "blocked", reason: "blocked:wall", at: min(-5) });
    const id = crypto.randomUUID();
    await handle.db.insert(schema.visit).values({ id, sourceId, startedAt: min(0), finishedAt: min(0), outcome: "blocked", mode: "normal", reason: "blocked:wall" });
    const input = { id, sourceId, outcome: "blocked", reason: "blocked:wall", mode: "normal", finishedAt: min(0) };
    await expect(applyVisitOutcome(handle, input, { alert: failing, now: min(0) })).rejects.toThrow("alert insert failed");
    expect((await status()).status).toBe("active");
    const r = await applyVisitOutcome(handle, input, { alert: capture, now: min(0) });
    expect(r.actions).toEqual(["paused"]);
    expect((await status()).status).toBe("paused_by_health");
    expect(alerts).toHaveLength(1);
  });

  test("An ok probe resumes a health-paused source once; replay adds none", async () => {
    await reset("paused_by_health");
    const id = crypto.randomUUID();
    const r = await report({ id, outcome: "ok", mode: "probe", at: min(0) });
    expect(r.actions).toEqual(["resumed"]);
    expect((await status()).status).toBe("active");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("resumed");
    expect((await report({ id, outcome: "ok", mode: "probe", at: min(0) })).actions).toEqual([]);
    expect(alerts).toHaveLength(1);
  });

  test("Two consecutive no_slots -> one parser alert, status unchanged; no_slots, ok, no_slots -> none", async () => {
    await report({ outcome: "no_slots", at: min(0) });
    const r = await report({ outcome: "no_slots", at: min(20) });
    expect(r.actions).toEqual(["alert_parser"]);
    expect(alerts).toHaveLength(1);
    expect((await status()).status).toBe("active");

    await reset();
    await report({ outcome: "no_slots", at: min(0) });
    await report({ outcome: "ok", at: min(20) });
    await report({ outcome: "no_slots", at: min(40) });
    expect(alerts).toHaveLength(0);
  });

  test("skipped visits are a no-op", async () => {
    const r = await report({ outcome: "skipped", at: min(0) });
    expect(r.actions).toEqual([]);
    expect((await status()).health).toMatchObject({ ok: null });
  });
});
