import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, sql } from "drizzle-orm";
import type { LlmUsage } from "./client";

export interface UsageTotals {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
}

const ZERO_USAGE: UsageTotals = { prompt: 0, completion: 0, total: 0, calls: 0 };
const DIMS = { metric: "llm_tokens" };

export interface Budget {
  getUsageToday(): Promise<UsageTotals>;
  recordUsage(usage: LlmUsage): Promise<{ before: UsageTotals; after: UsageTotals }>;
  isExhausted(): Promise<boolean>;
  crossedAlertPct(before: UsageTotals, after: UsageTotals): boolean;
}

export interface CreateBudgetOptions {
  handle: DbHandle;
  /** Server timezone used to compute the "day" bucket boundary (resets at midnight server tz). */
  tz: string;
  dailyTokenBudget: number;
  budgetAlertPct: number;
  now?: () => Date;
}

/** `YYYY-MM-DD` for `date` in `tz`. */
function dayStartUtc(date: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

/** Daily LLM token budget backed by `MetricRollup` (bucket "day", dims `{metric:"llm_tokens"}`). */
export function createBudget(opts: CreateBudgetOptions): Budget {
  const now = opts.now ?? (() => new Date());

  function bucketTs(): Date {
    return dayStartUtc(now(), opts.tz);
  }

  async function fetchRow(ts: Date): Promise<{ id: string; counts: UsageTotals } | undefined> {
    const rows = await opts.handle.db
      .select({ id: schema.metricRollup.id, counts: schema.metricRollup.counts })
      .from(schema.metricRollup)
      .where(
        and(
          eq(schema.metricRollup.bucket, "day"),
          eq(schema.metricRollup.ts, ts),
          sql`${schema.metricRollup.dims} = ${JSON.stringify(DIMS)}::jsonb`,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return { id: row.id, counts: row.counts as UsageTotals };
  }

  return {
    async getUsageToday(): Promise<UsageTotals> {
      const row = await fetchRow(bucketTs());
      return row?.counts ?? ZERO_USAGE;
    },

    async recordUsage(usage: LlmUsage): Promise<{ before: UsageTotals; after: UsageTotals }> {
      const ts = bucketTs();
      // Atomic upsert against the `metric_rollup_bucket_ts_dims_key` unique
      // index (migration 0016). `SELECT ... FOR UPDATE` locks nothing when
      // the day's row does not exist yet, so two workers making the first
      // call after midnight could each insert their own row and the
      // no-ORDER-BY `limit(1)` read in `fetchRow` would then undercount the
      // day's total forever. A single `INSERT ... ON CONFLICT DO UPDATE`
      // that increments in the same statement is race-free regardless of
      // whether the row already exists.
      const before = await this.getUsageToday();
      const rows = await opts.handle.sql<{ counts: UsageTotals }[]>`
        insert into metric_rollup (bucket, ts, dims, counts)
        values ('day', ${ts.toISOString()}::timestamptz, ${JSON.stringify(DIMS)}::jsonb, jsonb_build_object(
          'prompt', ${usage.promptTokens}::int,
          'completion', ${usage.completionTokens}::int,
          'total', ${usage.totalTokens}::int,
          'calls', 1
        ))
        on conflict (bucket, ts, dims) do update set counts = jsonb_build_object(
          'prompt', coalesce((metric_rollup.counts->>'prompt')::int, 0) + ${usage.promptTokens}::int,
          'completion', coalesce((metric_rollup.counts->>'completion')::int, 0) + ${usage.completionTokens}::int,
          'total', coalesce((metric_rollup.counts->>'total')::int, 0) + ${usage.totalTokens}::int,
          'calls', coalesce((metric_rollup.counts->>'calls')::int, 0) + 1
        )
        returning counts
      `;
      const after = (rows[0]?.counts as UsageTotals | undefined) ?? ZERO_USAGE;
      return { before, after };
    },

    async isExhausted(): Promise<boolean> {
      const usage = await this.getUsageToday();
      return usage.total >= opts.dailyTokenBudget;
    },

    crossedAlertPct(before: UsageTotals, after: UsageTotals): boolean {
      if (opts.dailyTokenBudget <= 0) return false;
      const beforePct = (before.total / opts.dailyTokenBudget) * 100;
      const afterPct = (after.total / opts.dailyTokenBudget) * 100;
      return beforePct < opts.budgetAlertPct && afterPct >= opts.budgetAlertPct;
    },
  };
}
