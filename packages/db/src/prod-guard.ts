const PROD_DB_NAME = "feedhound";
/** Compose service hostname of the production Postgres (only reachable inside the compose network). */
const COMPOSE_PG_HOST = "postgres";

/**
 * Refuses a non-production process pointed at the production database (incident 2026-10-05:
 * a local `bun run dev` agent consumed production jobs). Production containers are identified
 * by NODE_ENV=production or by reaching Postgres via the compose hostname `postgres`
 * (agent/bot compose services do not set NODE_ENV). Override: ALLOW_PROD_DB=1.
 */
export function assertNotProdDbFromDev(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.NODE_ENV === "production" || env.ALLOW_PROD_DB === "1") return;
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return;
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (name !== PROD_DB_NAME || parsed.hostname === COMPOSE_PG_HOST) return;
  throw new Error(
    `Refusing to start: DATABASE_URL targets the production database "${PROD_DB_NAME}" ` +
      `(host ${parsed.hostname}) from a non-production process. Use "feedhound_dev" locally, ` +
      `or set ALLOW_PROD_DB=1 to override.`,
  );
}
