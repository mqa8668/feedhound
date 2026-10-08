import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";
import { assertNotProdDbFromDev } from "./prod-guard";

export * as schema from "./schema/index";
export {
  clearNoEnabledNotifierMarkers,
  MARKER_CLEAR_MAX_AGE_HOURS,
  MARKER_CLEAR_LIMIT,
  type ClearMarkersResult,
} from "./queries/notifications";

export { enqueueOpsNotification, fetchOpsChatId, type OpsAlertInput } from "./queries/ops-notifications";
export {
  buildSearchPredicate,
  DEFAULT_SEARCH_CONFIG,
  searchPosts,
  type SearchConfig,
  type SearchHit,
  type SearchOptions,
  type SearchPage,
  type SearchResult,
} from "./search";
export { loadPiiSalt, resolveAuthorRef } from "./pii";
export { buildDealPeerQuery, loadCatalogueAttrs, loadDealComparables, loadDealPeers, type DealComparable, type DealPeerQuery, type SqlRunner } from "./deal";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

/** Creates a new Postgres connection + Drizzle client. Callers own its lifecycle. */
export function createDb(databaseUrl?: string): DbHandle {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  assertNotProdDbFromDev(url);
  const sql = postgres(url);
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end(),
  };
}

let defaultHandle: DbHandle | undefined;

function getDefaultHandle(): DbHandle {
  if (!defaultHandle) defaultHandle = createDb();
  return defaultHandle;
}

/** Default `db` client, backed by `process.env.DATABASE_URL`, connected lazily on first use. */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getDefaultHandle().db as object, prop, receiver);
  },
});
