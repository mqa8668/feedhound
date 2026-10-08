import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { eq, inArray, type SQL } from "drizzle-orm";
import type { Session } from "../middleware/cf-access";

/**
 * Watches whose matches the session may read: a hunter
 * sees only own watches; an operator sees every watch on the team. Expressed
 * on `watch.userId` so a foreign/other-team `?watch=` id yields an empty list
 * instead of a leak. Moved from dashboard-matches.ts.
 */
export function readableWatches(handle: DbHandle, session: Session): SQL {
  if (session.role === "operator") {
    const teamUserIds = handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, session.teamId));
    return inArray(schema.watch.userId, teamUserIds);
  }
  return eq(schema.watch.userId, session.userId);
}

/** Ids of every source owned by the team. */
export async function teamSourceIds(handle: DbHandle, teamId: string): Promise<string[]> {
  const rows = await handle.db.select({ id: schema.source.id }).from(schema.source).where(eq(schema.source.teamId, teamId));
  return rows.map((r) => r.id);
}
