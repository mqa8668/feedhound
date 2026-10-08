import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, asc, eq, inArray } from "drizzle-orm";

const HOUR_MS = 60 * 60 * 1000;

export interface SourceSlo {
  sourceId: string;
  name: string;
  status: string;
  coverageOkRatio: number | null;
  coverageCompleteRatio: number | null;
  secondsSinceOkVisit: number | null;
  visits24h: Record<string, number>; // DB outcome values + "in_flight"
}

export interface SloOptions {
  now: Date;
  teamId?: string;
  sourceIds?: string[];
}

/**
 * Per-source collection SLO figures over the 24 h window ending at `now`.
 * Reads existing tables only (metric_rollup coverage rows, visit, post); writes nothing.
 */
export async function computeSlo(handle: DbHandle, opts: SloOptions): Promise<SourceSlo[]> {
  const { now } = opts;
  const conds = [];
  if (opts.teamId !== undefined) conds.push(eq(schema.source.teamId, opts.teamId));
  if (opts.sourceIds !== undefined) {
    if (opts.sourceIds.length === 0) return [];
    conds.push(inArray(schema.source.id, opts.sourceIds));
  }
  const sources = await handle.db
    .select({
      id: schema.source.id,
      name: schema.source.name,
      status: schema.source.status,
      lastOkVisitAt: schema.source.lastOkVisitAt,
    })
    .from(schema.source)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(schema.source.name), asc(schema.source.id));
  if (sources.length === 0) return [];

  const ids = sources.map((s) => s.id);
  const since = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
  const hourStart = new Date(now);
  hourStart.setUTCMinutes(0, 0, 0);
  const coverageFrom = new Date(hourStart.getTime() - 23 * HOUR_MS).toISOString();

  const { coverageRows, visitRows } = await handle.sql.begin(async (tx) => {
    await tx`set local statement_timeout = '5s'`;
    const coverageRows = await tx<{ source_id: string; expected: string; ok: string; complete: string }[]>`
      select dims->>'sourceId' as source_id,
        sum((counts->>'visits_expected')::numeric) as expected,
        sum((counts->>'visits_ok')::numeric) as ok,
        sum((counts->>'visits_complete')::numeric) as complete
      from metric_rollup
      where bucket = 'hour'
        and dims->>'metric' = 'coverage'
        and ts >= ${coverageFrom}::timestamptz
        and dims->>'sourceId' = any(${ids})
      group by dims->>'sourceId'
    `;
    const visitRows = await tx<{ source_id: string; outcome: string | null; n: string }[]>`
      select source_id, outcome, count(*) as n
      from visit
      where started_at > ${since}::timestamptz
        and source_id = any(${ids})
      group by source_id, outcome
    `;
    return { coverageRows, visitRows };
  });

  const ratio = (num: string, den: string): number | null => {
    const d = Number(den);
    return d > 0 ? Math.min(1, Number(num) / d) : null;
  };
  const coverage = new Map(coverageRows.map((r) => [r.source_id, r]));

  return sources.map((s) => {
    const cov = coverage.get(s.id);
    const visits24h: Record<string, number> = {};
    for (const v of visitRows) {
      if (v.source_id !== s.id) continue;
      visits24h[v.outcome ?? "in_flight"] = Number(v.n);
    }
    return {
      sourceId: s.id,
      name: s.name,
      status: s.status,
      coverageOkRatio: cov ? ratio(cov.ok, cov.expected) : null,
      coverageCompleteRatio: cov ? ratio(cov.complete, cov.expected) : null,
      secondsSinceOkVisit: s.lastOkVisitAt ? Math.round((now.getTime() - s.lastOkVisitAt.getTime()) / 1000) : null,
      visits24h,
    };
  });
}

/** Posts first seen in the 24 h window grouped by capture method; null capture counts as `unknown`. */
export async function computePostsByCapture24h(
  handle: DbHandle,
  opts: { now: Date; sourceIds?: string[] },
): Promise<Record<string, number>> {
  const since = new Date(opts.now.getTime() - 24 * HOUR_MS).toISOString();
  const ids = opts.sourceIds;
  if (ids !== undefined && ids.length === 0) return {};
  const rows = await handle.sql.begin(async (tx) => {
    await tx`set local statement_timeout = '5s'`;
    return ids !== undefined
      ? tx<{ capture: string; n: string }[]>`
          select coalesce(capture, 'unknown') as capture, count(*) as n
          from post
          where first_seen_at > ${since}::timestamptz and source_id = any(${ids})
          group by 1
        `
      : tx<{ capture: string; n: string }[]>`
          select coalesce(capture, 'unknown') as capture, count(*) as n
          from post
          where first_seen_at > ${since}::timestamptz
          group by 1
        `;
  });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.capture] = Number(r.n);
  return out;
}
