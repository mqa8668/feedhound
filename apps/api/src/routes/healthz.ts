import { isShuttingDown } from "@feedhound/core/shutdown";
import { runReadiness } from "@feedhound/core/health";
import { appVersion } from "@feedhound/core/version";
import type { DbHandle } from "@feedhound/db";
import { Hono } from "hono";
import type { PgBoss } from "pg-boss";

async function checkDb(handle: DbHandle): Promise<boolean> {
  try {
    await handle.sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** `queue` check: `select 1 from pgboss.job limit 1` — an empty table is ok, a missing schema (pg-boss never started) is not. */
async function checkQueue(handle: DbHandle): Promise<boolean> {
  try {
    await handle.sql`select 1 from pgboss.job limit 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * `/healthz` (liveness) + `/readyz` (readiness) for the api process. `boss` is a set-if-started flag: `createApp` only ever receives a
 * `PgBoss` whose `.start()` has already resolved (see `apps/api/src/index.ts`
 * `createBoss`), so its mere presence is the "started" flag expected.
 */
export function healthzRoute(service: string, handle: DbHandle, boss?: PgBoss): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, service, version: appVersion() }));

  app.get("/readyz", async (c) => {
    const result = await runReadiness({
      db: () => checkDb(handle),
      boss: () => boss !== undefined,
      queue: () => checkQueue(handle),
      accepting: () => !isShuttingDown(),
    });
    return c.json({ ok: result.ok, service, version: appVersion(), checks: result.checks }, result.ok ? 200 : 503);
  });

  return app;
}
