import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

const logger = createLogger({ service: "agent" });

/**
 * Ops alerts: checks a fixed set of rules every 5 min and
 * inserts a `Notification` (channel `ops`) per triggered rule, deduped so a rule
 * fires at most once per `DEDUPE_WINDOW_MS` (6 h).
 *
 * The concrete signals (pg-boss queue size, LLM spend, source silence, disk free)
 * are not yet wired to real sources — specs 001-003 own that instrumentation — so
 * each check is injected as an async function. Callers not ready to supply a check
 * simply omit it and that rule is skipped.
 */

export interface LlmBudget {
  spendUsd: number;
  budgetUsd: number;
}

/**
 * Mutable state carried across invocations so `queue_backlog` can require a
 * sustained backlog (>500 for 10 min) rather than firing on a single sample.
 * Not persisted to the DB (no schema change in this fix round — a durable
 * `ops_alert_state` table would be the real fix, see 008 report); callers that
 * want persistence across process restarts must pass the same object back in.
 * The module keeps a process-lifetime default so `registerOpsAlertsJob` works
 * without callers wiring this up explicitly.
 */
export interface OpsAlertsState {
  queueBacklogFirstSeenAt?: Date;
}

const defaultState: OpsAlertsState = {};

export interface OpsAlertsOptions {
  handle: DbHandle;
  /** userId that owns the inserted `Notification` rows (schema requires a userId). */
  opsUserId: string;
  now?: Date;
  countPendingJobs?: () => Promise<number>;
  getLlmBudget?: () => Promise<LlmBudget | undefined>;
  isSourceSilent?: () => Promise<boolean>;
  isDiskLow?: () => Promise<boolean>;
  /** Defaults to a process-lifetime singleton; pass explicitly in tests to isolate. */
  state?: OpsAlertsState;
}

interface RuleCheck {
  name: string;
  triggered: boolean;
  message: string;
}

const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
const QUEUE_BACKLOG_THRESHOLD = 500;
const QUEUE_BACKLOG_SUSTAIN_MS = 10 * 60 * 1000;
const LLM_BUDGET_FRACTION = 0.8;

interface NotificationPayload {
  rule?: string;
  message?: string;
  at?: string;
}

/** Runs all injected rule checks and returns the names of rules that fired a new Notification. */
/**
 * Inserts one `ops` notification for `rule` unless one with the same rule was created within `windowMs`.
 * Single statement (INSERT ... SELECT ... WHERE NOT EXISTS) so the dedupe check and the insert are atomic
 * within one round trip, narrowing (not eliminating -- a real fix needs a unique index, see module doc
 * comment) the race window between two concurrent runs. Returns true when a row was inserted.
 */
export async function insertOpsAlertOnce(
  handle: DbHandle,
  opsUserId: string,
  rule: string,
  message: string,
  now: Date,
  windowMs: number,
): Promise<boolean> {
  const windowStart = new Date(now.getTime() - windowMs).toISOString();
  const payload: NotificationPayload = { rule, message, at: now.toISOString() };
  const inserted = await handle.sql<{ id: string }[]>`
    insert into notification (user_id, channel, status, payload)
    select ${opsUserId}, 'ops', 'pending', ${JSON.stringify(payload)}::jsonb
    where not exists (
      select 1 from notification
      where channel = 'ops'
        and payload ->> 'rule' = ${rule}
        and (payload ->> 'at')::timestamptz > ${windowStart}::timestamptz
    )
    returning id
  `;
  return inserted.length > 0;
}

export async function runOpsAlerts(opts: OpsAlertsOptions): Promise<string[]> {
  const now = opts.now ?? new Date();
  const state = opts.state ?? defaultState;
  const checks: RuleCheck[] = [];

  if (opts.countPendingJobs) {
    const pending = await opts.countPendingJobs();
    if (pending > QUEUE_BACKLOG_THRESHOLD) {
      if (!state.queueBacklogFirstSeenAt) {
        state.queueBacklogFirstSeenAt = now;
      }
      const sustainedMs = now.getTime() - state.queueBacklogFirstSeenAt.getTime();
      checks.push({
        name: "queue_backlog",
        triggered: sustainedMs >= QUEUE_BACKLOG_SUSTAIN_MS,
        message: `pg-boss pending=${pending} sustained_ms=${sustainedMs}`,
      });
    } else {
      state.queueBacklogFirstSeenAt = undefined;
    }
  }
  if (opts.getLlmBudget) {
    const budget = await opts.getLlmBudget();
    if (budget && budget.budgetUsd > 0) {
      const fraction = budget.spendUsd / budget.budgetUsd;
      checks.push({
        name: "llm_budget",
        triggered: fraction >= LLM_BUDGET_FRACTION,
        message: `spendUsd=${budget.spendUsd} budgetUsd=${budget.budgetUsd}`,
      });
    }
  }
  if (opts.isSourceSilent) {
    checks.push({ name: "source_silent", triggered: await opts.isSourceSilent(), message: "a source went silent" });
  }
  if (opts.isDiskLow) {
    checks.push({ name: "disk_low", triggered: await opts.isDiskLow(), message: "server disk free < 10%" });
  }

  const triggered = checks.filter((c) => c.triggered);
  if (triggered.length === 0) return [];

  const fired: string[] = [];
  for (const rule of triggered) {
    if (await insertOpsAlertOnce(opts.handle, opts.opsUserId, rule.name, rule.message, now, DEDUPE_WINDOW_MS)) fired.push(rule.name);
  }

  return fired;
}

const OPS_ALERTS_QUEUE = "ops_alerts";
const OPS_ALERTS_CRON = "*/5 * * * *";

/**
 * Real `queue_backlog` signal: sums `readyCount`
 * (jobs ready to run now, i.e. `queuedCount` minus not-yet-due deferred
 * jobs — the true backlog, per pg-boss's own doc comment on `QueueResult`)
 * across every registered queue via `PgBoss#getQueues()`. The other three
 * checks (`llm_budget`, `source_silent`, `disk_low`) stay injected stubs:
 * they depend on signals specs 001-003 do not expose to the agent yet.
 */
export async function countPendingJobs(boss: PgBoss): Promise<number> {
  const queues = await boss.getQueues();
  return queues.filter((q) => !q.name.endsWith("_dlq")).reduce((total, q) => total + q.readyCount, 0);
}

/**
 * 016: origin queues (name not ending in `_dlq`) whose own `<name>_dlq` holds
 * at least one job — the signal `dlq_monitor` (`apps/agent/src/jobs/dlq.ts`)
 * alerts on.
 */
export async function countDeadLetters(boss: PgBoss): Promise<{ queue: string; count: number }[]> {
  const queues = await boss.getQueues();
  const names = new Set(queues.map((q) => q.name));
  const out: { queue: string; count: number }[] = [];
  for (const q of queues) {
    if (q.name.endsWith("_dlq")) continue;
    const dlqName = `${q.name}_dlq`;
    if (!names.has(dlqName)) continue;
    // `getQueues()`'s `queuedCount` is a periodically-refreshed cache on
    // `pgboss.queue` (pg-boss's own monitor, default every 60s) and would
    // under-report a just-dead-lettered job for up to that long.
    // `getQueueStats` computes fresh whenever the queue has no capture yet
    // (a brand-new DLQ) and otherwise serves the same cache, so this stays
    // cheap in steady state while being accurate right after a dead-letter.
    const stats = await boss.getQueueStats(dlqName).catch(() => []);
    const count = stats[0]?.queuedCount ?? 0;
    if (count > 0) out.push({ queue: q.name, count });
  }
  return out;
}

/**
 * Resolves the `Notification.userId` for ops-channel rows: the
 * operator whose email is Config `notify.ops.recipientEmail` (falling back to
 * `SEED_OPERATOR_EMAIL`, the seeded operator); when neither names an existing operator, the
 * OLDEST operator (deterministic — creating a newer operator never re-routes ops alerts).
 */
export async function resolveOpsUserId(handle: DbHandle): Promise<string | undefined> {
  const [cfg] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "notify.ops.recipientEmail"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  const configured = typeof cfg?.value === "string" ? cfg.value.trim() : "";
  for (const email of [configured, process.env.SEED_OPERATOR_EMAIL?.trim() ?? ""]) {
    if (!email) continue;
    const [named] = await handle.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(and(eq(schema.user.email, email), eq(schema.user.role, "operator")))
      .limit(1);
    if (named) return named.id;
  }
  const [oldest] = await handle.db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.role, "operator"))
    .orderBy(asc(schema.user.createdAt), asc(schema.user.id))
    .limit(1);
  return oldest?.id;
}

/**
 * Registers the `ops_alerts` cron job (every 5 min) on `boss`. `queue_backlog` is wired to the real pg-boss queue sizes via
 * `countPendingJobs`; the other three checks (LLM spend, source silence,
 * disk free) are not wired here since specs 001-003 do not yet expose those
 * signals to the agent — the job runs and dedupes correctly but those rules
 * fire only once a caller supplies the check functions.
 */
export async function registerOpsAlertsJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(OPS_ALERTS_QUEUE);
  await boss.schedule(OPS_ALERTS_QUEUE, OPS_ALERTS_CRON, {});
  await boss.work(OPS_ALERTS_QUEUE, async () => {
    const opsUserId = await resolveOpsUserId(handle);
    if (!opsUserId) {
      logger.warn("ops_alerts: no operator user found, skipping run");
      return;
    }
    const fired = await runOpsAlerts({
      handle,
      opsUserId,
      now: new Date(),
      countPendingJobs: () => countPendingJobs(boss),
    });
    logger.info({ fired }, "ops_alerts run");
  });
}
