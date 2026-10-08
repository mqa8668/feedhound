import type { DbHandle } from "../index";

// `clearNoEnabledNotifierMarkers` re-arms matches whose "no
// enabled notifier" marker (`notification.status = 'suppressed', last_error = 'no
// enabled notifier'`) was written while the user had no enabled notifier. Bounded so
// re-enabling a notifier after a long outage cannot flood-reenqueue every historical
// match — the CR-1 sweeper would otherwise drip-feed all of them at the per-chat rate
// limit for hours/days. Only markers for matches seen within the last
// `MARKER_CLEAR_MAX_AGE_HOURS` are cleared, and at most `MARKER_CLEAR_LIMIT` rows per
// call (most recent matches first). Shared by `PATCH /api/notifiers/:id` (re-enable)
// and `/link` (candidate gains a notifier) so both call sites share one bound.
export const MARKER_CLEAR_MAX_AGE_HOURS = 24;
export const MARKER_CLEAR_LIMIT = 200;

/**
 * The 24 h / 200-row bound (see comment above) is correct, but a
 * marker it leaves behind was previously dropped with no signal — a user re-enabling a
 * notifier after a multi-day outage lost every alert older than 24 h and neither the API
 * response nor the bot's `/link` reply said so. `droppedOutsideBound` counts markers for
 * this user that this bound can *never* clear (i.e. older than `cutoff` — markers still
 * inside the age window but past the row `LIMIT` remain eligible and will be cleared by a
 * later call, so they are not counted as dropped).
 *
 * Delete + count now run in one transaction (previously two separate
 * statements) — outside a transaction, two concurrent callers for the same user each saw
 * the other's uncommitted delete, so the reported count was unstable and, worse, was an
 * unbounded `COUNT(*)` with no age filter that never went down even as markers aged out
 * for good, so the same "N not restored" was reported forever.
 */
export interface ClearMarkersResult {
  cleared: number;
  droppedOutsideBound: number;
}

export async function clearNoEnabledNotifierMarkers(handle: DbHandle, userId: string, now: Date): Promise<ClearMarkersResult> {
  const cutoff = new Date(now.getTime() - MARKER_CLEAR_MAX_AGE_HOURS * 60 * 60_000);
  return handle.sql.begin(async (tx) => {
    const cleared = await tx<{ id: string }[]>`
      delete from notification
      where id in (
        select n.id
        from notification n
        join match m on m.id = n.match_id
        where n.user_id = ${userId}
          and n.status = 'suppressed'
          and n.last_error = 'no enabled notifier'
          and m.created_at >= ${cutoff.toISOString()}
        order by m.created_at desc
        limit ${MARKER_CLEAR_LIMIT}
      )
      returning id
    `;
    const [remaining] = await tx<{ count: string }[]>`
      select count(*)::text as count
      from notification n
      join match m on m.id = n.match_id
      where n.user_id = ${userId}
        and n.status = 'suppressed'
        and n.last_error = 'no enabled notifier'
        and m.created_at < ${cutoff.toISOString()}
    `;
    return { cleared: cleared.length, droppedOutsideBound: Number(remaining?.count ?? "0") };
  });
}
