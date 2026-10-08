import { createRegistry, METRICS_CONTENT_TYPE, type MetricsRegistry } from "@feedhound/core/metrics";
import type { DbHandle } from "@feedhound/db";
import { Hono } from "hono";
import { lastRollupErrors, lastRollupSuccessMs } from "./jobs/rollup";
import { countStranded, STALE_AFTER_SEC } from "./jobs/reconcile";

export interface AgentMetricsDeps {
  handle: DbHandle;
  /** `getUsageToday` resolving `undefined` means no LLM/budget exists: no `llm_*` samples are emitted. */
  budget?: { getUsageToday(): Promise<{ prompt: number; completion: number; total: number; calls: number } | undefined> };
}

/** Agent-side `/metrics` series: pg-boss queue depth, LLM tokens today, notification outcomes (24 h). */
export function createAgentMetrics(deps: AgentMetricsDeps): MetricsRegistry {
  const registry = createRegistry();
  const jobs = registry.gauge("pgboss_jobs", "pg-boss jobs by queue and state (DLQ = queue *_dlq)", ["queue", "state"]);
  const tokens = registry.gauge("llm_tokens_today", "LLM tokens used today", ["kind"]);
  const calls = registry.gauge("llm_calls_today", "LLM calls made today", []);
  const notifications = registry.gauge("notifications", "Notification rows created in the last 24 h by status", ["status"]);

  registry.collector("pgboss", async () => {
    const rows = await deps.handle.sql<{ name: string; state: string; n: string }[]>`
      select name, state::text as state, count(*) as n
      from pgboss.job
      where state in ('created', 'retry', 'active', 'failed')
      group by name, state
    `;
    for (const r of rows) jobs.set({ queue: r.name, state: r.state }, Number(r.n));
  });

  const pending = registry.gauge("posts_pending_pipeline", "Posts stuck pending in a pipeline stage longer than 10 min", ["kind"]);
  const failed = registry.gauge("posts_failed_pipeline", "Posts whose pipeline stage ended failed", ["kind"]);
  registry.collector("pipeline", async () => {
    const stranded = await countStranded(deps.handle, new Date(), STALE_AFTER_SEC);
    pending.set({ kind: "enrich" }, stranded.enrich);
    pending.set({ kind: "match" }, stranded.match);
    const [row] = await deps.handle.sql<{ enrich: number; match: number }[]>`
      select count(*) filter (where enrich_state = 'failed')::int as enrich, count(*) filter (where match_state = 'failed')::int as match
      from post where enrich_state = 'failed' or match_state = 'failed'
    `;
    failed.set({ kind: "enrich" }, row?.enrich ?? 0);
    failed.set({ kind: "match" }, row?.match ?? 0);
  });

  // NOTE: the lag gauge is absent until the first error-free run; alert on `absent(analytics_rollup_lag_seconds)` as well as its value.
  // Seconds since the last rollup run that completed without team errors; absent before the first.
  const rollupLag = registry.gauge("analytics_rollup_lag_seconds", "Seconds since the last successful analytics rollup run", []);
  const rollupErrors = registry.gauge("analytics_rollup_errors", "Teams that failed in the last analytics rollup run", []);
  registry.collector("analytics", async () => {
    const at = lastRollupSuccessMs();
    if (at !== null) rollupLag.set(undefined, Math.max(0, (Date.now() - at) / 1000));
    rollupErrors.set(undefined, lastRollupErrors());
  });

  registry.collector("notifications", async () => {
    const rows = await deps.handle.sql<{ status: string; n: string }[]>`
      select status, count(*) as n
      from notification
      where created_at > now() - interval '24 hours'
      group by status
    `;
    for (const r of rows) notifications.set({ status: r.status }, Number(r.n));
  });

  const budget = deps.budget;
  if (budget) {
    registry.collector("llm", async () => {
      const u = await budget.getUsageToday();
      if (!u) return;
      tokens.set({ kind: "prompt" }, u.prompt);
      tokens.set({ kind: "completion" }, u.completion);
      tokens.set({ kind: "total" }, u.total);
      calls.set(undefined, u.calls);
    });
  }

  return registry;
}

export function agentMetricsApp(registry: MetricsRegistry): Hono {
  const app = new Hono();
  app.get("/metrics", async (c) => c.body(await registry.render(), 200, { "Content-Type": METRICS_CONTENT_TYPE }));
  return app;
}
