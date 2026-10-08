// Source pause / resume / parser alerts are decided from the
// visit ledger (`POST /api/visits`), not from `POST /api/health`. Platform
// neutral: only outcomes, reasons and the 022 counters are consulted.
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import { insertOpsAlert, type DbExec } from "../routes/health";

export type InsertOpsAlertFn = (handle: DbExec, teamId: string, text: string) => Promise<void>;

/** A source is paused after a second `blocked` visit within this window. */
export const BLOCK_PAIR_WINDOW_MS = 1_800_000;
/** A health-paused source is probed at most once per this interval. */
export const PROBE_INTERVAL_SEC = 7200;

const ALERT_CLAIM_INTERVAL_MS = 60 * 60 * 1000;

export interface VisitOutcomeInput {
  id: string;
  sourceId: string;
  outcome: string;
  reason: string | null;
  mode: string;
  finishedAt: Date;
}

export type HealthAction = "paused" | "resumed" | "alert_parser";

export async function applyVisitOutcome(
  handle: DbHandle,
  v: VisitOutcomeInput,
  opts: { alert?: InsertOpsAlertFn; now?: Date } = {},
): Promise<{ actions: HealthAction[] }> {
  const alertFn = opts.alert ?? insertOpsAlert;
  const now = opts.now ?? new Date();
  const actions: HealthAction[] = [];
  if (v.outcome === "skipped") return { actions };

  const [source] = await handle.db.select().from(schema.source).where(eq(schema.source.id, v.sourceId)).limit(1);
  if (!source) return { actions };

  const reason = v.reason ?? v.outcome;
  const ok = v.outcome === "ok";

  // Ordering: a newer non-skipped visit (finished_at later) already decided the
  // source state; an out-of-order older visit must not overwrite it or resume it.
  const [latest] = await handle.db
    .select({ id: schema.visit.id, outcome: schema.visit.outcome })
    .from(schema.visit)
    .where(
      and(
        eq(schema.visit.sourceId, v.sourceId),
        ne(schema.visit.id, v.id),
        isNotNull(schema.visit.outcome),
        ne(schema.visit.outcome, "skipped"),
        gt(schema.visit.finishedAt, v.finishedAt),
      ),
    )
    .orderBy(desc(schema.visit.finishedAt))
    .limit(1);
  const stale = latest !== undefined;

  // Block pair: this visit's IMMEDIATE non-skipped neighbour of the same
  // source (by finished_at, just before or just after) must be a blocked visit
  // within the window. Intervening visits break the pair.
  // `mustBeNewest`: the neighbour must also be the source's newest visit.
  async function pairedBlock(mustBeNewest: boolean): Promise<boolean> {
    const base = and(
      eq(schema.visit.sourceId, v.sourceId),
      ne(schema.visit.id, v.id),
      isNotNull(schema.visit.outcome),
      ne(schema.visit.outcome, "skipped"),
    );
    const cols = { id: schema.visit.id, outcome: schema.visit.outcome, finishedAt: schema.visit.finishedAt };
    const [before] = mustBeNewest
      ? []
      : await handle.db.select(cols).from(schema.visit).where(and(base, lte(schema.visit.finishedAt, v.finishedAt))).orderBy(desc(schema.visit.finishedAt)).limit(1);
    const [after] = await handle.db.select(cols).from(schema.visit).where(and(base, gt(schema.visit.finishedAt, v.finishedAt))).orderBy(asc(schema.visit.finishedAt)).limit(1);
    const pairs = (n: typeof before): boolean =>
      n !== undefined &&
      n.outcome === "blocked" &&
      n.finishedAt !== null &&
      Math.abs(n.finishedAt.getTime() - v.finishedAt.getTime()) <= BLOCK_PAIR_WINDOW_MS &&
      (!mustBeNewest || n.id === latest?.id);
    return pairs(before) || pairs(after);
  }

  async function pause(): Promise<void> {
    const done = await handle.db.transaction(async (tx) => {
      const paused = await tx
        .update(schema.source)
        .set({ status: "paused_by_health", health: { ok: false, reason, pausedAt: now.toISOString() }, lastHealthAt: now })
        .where(and(eq(schema.source.id, v.sourceId), eq(schema.source.status, "active")))
        .returning({ id: schema.source.id });
      if (paused.length === 0) return false;
      await alertFn({ db: tx }, source!.teamId, `source "${source!.name}" paused: ${reason} [visit ${v.id}]`);
      return true;
    });
    if (done) actions.push("paused");
  }

  if (stale) {
    // Only exception: this blocked visit pairs with a newer blocked visit that arrived first.
    if (v.outcome === "blocked" && (await pairedBlock(true))) await pause();
    return { actions };
  }

  const [prev] = await handle.db
    .select({
      outcome: schema.visit.outcome,
      finishedAt: schema.visit.finishedAt,
    })
    .from(schema.visit)
    .where(
      and(
        eq(schema.visit.sourceId, v.sourceId),
        ne(schema.visit.id, v.id),
        isNotNull(schema.visit.outcome),
        ne(schema.visit.outcome, "skipped"),
        lte(schema.visit.finishedAt, v.finishedAt),
      ),
    )
    .orderBy(desc(schema.visit.finishedAt))
    .limit(1);

  // A retried POST must not wipe pausedAt of an already health-paused source.
  const existingPausedAt = (source.health as { pausedAt?: string } | null)?.pausedAt;
  const keepPausedAt = !ok && source.status === "paused_by_health" && existingPausedAt !== undefined;
  await handle.db
    .update(schema.source)
    .set({
      health: ok ? { ok: true } : keepPausedAt ? { ok: false, reason, pausedAt: existingPausedAt } : { ok: false, reason },
      lastHealthAt: now,
    })
    .where(eq(schema.source.id, v.sourceId));

  // Claims the hourly alert slot with one conditional UPDATE (concurrent-safe).
  async function claimHourly(): Promise<boolean> {
    const cutoff = new Date(now.getTime() - ALERT_CLAIM_INTERVAL_MS);
    const claimed = await handle.db
      .update(schema.source)
      .set({ healthAlertAt: now })
      .where(and(eq(schema.source.id, v.sourceId), or(isNull(schema.source.healthAlertAt), lt(schema.source.healthAlertAt, cutoff))))
      .returning({ id: schema.source.id });
    return claimed.length > 0;
  }

  let shouldPause = false;
  if (v.outcome === "blocked") shouldPause = await pairedBlock(false);
  if (shouldPause) await pause();

  if (ok) {
    const resumed = await handle.db.transaction(async (tx) => {
      const r = await tx
        .update(schema.source)
        .set({ status: "active" })
        .where(and(eq(schema.source.id, v.sourceId), eq(schema.source.status, "paused_by_health")))
        .returning({ id: schema.source.id });
      if (r.length === 0) return false;
      await alertFn({ db: tx }, source.teamId, `source "${source.name}" resumed after ok ${v.mode} visit [visit ${v.id}]`);
      return true;
    });
    if (resumed) actions.push("resumed");

  }

  if (v.outcome === "no_slots" && prev?.outcome === "no_slots") {
    if (await claimHourly()) {
      actions.push("alert_parser");
      await alertFn(handle, source.teamId, `source "${source.name}": parser broken? 2 consecutive visits found no posts`);
    }
  }

  return { actions };
}
