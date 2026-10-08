import { METRICS_CONTENT_TYPE, SLO_TARGETS, type MetricsRegistry } from "@feedhound/core/metrics";
import type { DbHandle } from "@feedhound/db";
import { Hono } from "hono";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";
import { computePostsByCapture24h, computeSlo } from "../services/slo";

/**
 * Route pattern of the handler that answered: the first non-middleware, non-wildcard match
 * (later matches never ran, so the last entry can be a `:param` sibling). `unmatched` if none.
 */
export function routePattern(matched: readonly { method: string; path: string }[]): string {
  return matched.find((r) => r.method !== "ALL" && !r.path.includes("*"))?.path ?? "unmatched";
}

/**
 * `GET /metrics`: Prometheus text for the api process. Unauthenticated;
 * outside `/api/` so the Cloudflare tunnel never routes it. Registers the DB-derived
 * collection SLO gauges (rolling 24 h, computed at scrape time) on `registry`.
 */
export function metricsRoute(handle: DbHandle, registry: MetricsRegistry): Hono {
  const app = new Hono();
  const coverage = registry.gauge("source_coverage_ratio", "Share of expected visits that were ok/complete (24 h)", ["source", "kind"]);
  const sinceOk = registry.gauge("source_seconds_since_ok_visit", "Seconds since the last ok visit", ["source"]);
  const visits = registry.gauge("source_visits", "Visits started in the last 24 h by outcome", ["source", "outcome"]);
  const ingested = registry.gauge("posts_ingested", "Posts first seen in the last 24 h by capture method", ["capture"]);

  registry.collector("slo", async () => {
    const now = new Date();
    const [sources, byCapture] = await Promise.all([computeSlo(handle, { now }), computePostsByCapture24h(handle, { now })]);
    for (const s of sources) {
      const source = s.sourceId;
      if (s.coverageOkRatio !== null) coverage.set({ source, kind: "ok" }, s.coverageOkRatio);
      if (s.coverageCompleteRatio !== null) coverage.set({ source, kind: "complete" }, s.coverageCompleteRatio);
      if (s.secondsSinceOkVisit !== null) sinceOk.set({ source }, s.secondsSinceOkVisit);
      for (const [outcome, n] of Object.entries(s.visits24h)) visits.set({ source, outcome }, n);
    }
    for (const [name, n] of Object.entries(byCapture)) ingested.set({ capture: name }, n);
  });

  app.get("/metrics", async (c) => c.body(await registry.render(), 200, { "Content-Type": METRICS_CONTENT_TYPE }));
  return app;
}

/** `GET /api/ops/slo`: per-source SLO figures for the session's team; any role. */
export function opsSloRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();
  app.get("/api/ops/slo", cfAccessAuth(handle), requireSession(), async (c) => {
    const now = new Date();
    const sources = await computeSlo(handle, { now, teamId: c.get("session").teamId });
    return c.json({ targets: SLO_TARGETS, generatedAt: now.toISOString(), sources });
  });
  return app;
}
