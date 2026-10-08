import { createDb, schema, type DbHandle } from "../index";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { clearNoEnabledNotifierMarkers } from "./notifications";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

function isTestDbUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/^\//, "").endsWith("_test");
  } catch {
    return false;
  }
}
if (TEST_DATABASE_URL && !isTestDbUrl(TEST_DATABASE_URL)) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  let reachable = true;
  try {
    await probe.sql`select 1`;
  } catch (err) {
    reachable = false;
    if (MUST_RUN) {
      await probe.close();
      throw err;
    }
    console.warn(`notifications.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) {
      await probe.close();
      throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    }
    canRun = true;
  }
  await probe.close();
} else if (MUST_RUN) {
  throw new Error("notifications.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("notifications.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("clearNoEnabledNotifierMarkers", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `t-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, userId));
    await handle.db.delete(schema.match).where(inArray(schema.match.watchId, handle.db.select({ id: schema.watch.id }).from(schema.watch).where(eq(schema.watch.userId, userId))));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, handle.db.select({ id: schema.source.id }).from(schema.source).where(eq(schema.source.teamId, teamId))));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  async function makeMarker(matchCreatedAt: Date): Promise<string> {
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `nq-src-${crypto.randomUUID()}`, name: "s", url: `https://feeds.example.test/nq-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    const [post] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: `https://x/${crypto.randomUUID()}`, text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `nq-watch-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, createdAt: matchCreatedAt }).returning({ id: schema.match.id });
    const [marker] = await handle.db
      .insert(schema.notification)
      .values({ matchId: match!.id, notifierId: null, userId, channel: "none", status: "suppressed", lastError: "no enabled notifier", payload: {} })
      .returning({ id: schema.notification.id });
    return marker!.id;
  }

  // A marker left outside the age/count bound was previously dropped with no
  // signal at all — `droppedOutsideBound` must report it so a caller (API response, bot
  // `/link` reply) can tell the user some alerts were not restored.
  test("reports droppedOutsideBound for markers the age bound leaves uncleared", async () => {
    const recentId = await makeMarker(new Date(Date.now() - 60 * 60_000)); // 1h ago: cleared
    const oldId = await makeMarker(new Date(Date.now() - 30 * 24 * 60 * 60_000)); // 30d ago: left behind

    const result = await clearNoEnabledNotifierMarkers(handle, userId, new Date());
    expect(result.cleared).toBe(1);
    expect(result.droppedOutsideBound).toBe(1);

    const [recentAfter] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, recentId));
    expect(recentAfter).toBeUndefined();
    const [oldAfter] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, oldId));
    expect(oldAfter).toBeDefined();

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, oldId));
  });
});

// Migration 0018: 0017's `DEFAULT now()` backfilled every pre-existing row's
// `created_at` to the migration instant rather than its true insert time, which would have
// made `?since=` near that instant return the whole table's history once. Since `match` is
// always created before the notification derived from it, an unconditional
// `least(created_at, ..., match.created_at)` would wrongly floor *every* row (even ones
// whose `created_at` is already accurate) down to its match's timestamp — 0018 instead only
// touches rows sharing an exact duplicate `created_at` (the bulk-backfill signature; an
// organic insert essentially never collides with another row's timestamp to the
// microsecond). This exercises that same CTE-gated statement directly: a group of rows
// sharing one bogus timestamp gets corrected, while a row with its own distinct (already
// accurate) `created_at` is left untouched even though its match is, as normal, earlier.
describe.skipIf(!canRun)("migration 0018: created_at backfill floor", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `t-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, userId));
    await handle.db.delete(schema.match).where(inArray(schema.match.watchId, handle.db.select({ id: schema.watch.id }).from(schema.watch).where(eq(schema.watch.userId, userId))));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, handle.db.select({ id: schema.source.id }).from(schema.source).where(eq(schema.source.teamId, teamId))));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  // Same statement as migrations/0018_notification_created_at_index.sql (match-joined half).
  async function runBackfillFloor(): Promise<void> {
    await handle.sql`
      WITH backfilled_timestamps AS (
        SELECT "created_at"
        FROM "notification"
        GROUP BY "created_at"
        HAVING count(*) > 1
      )
      UPDATE "notification" n
      SET "created_at" = LEAST(
        n."created_at",
        COALESCE(n."sent_at", n."created_at"),
        COALESCE(n."failed_at", n."created_at"),
        COALESCE(n."sending_at", n."created_at"),
        COALESCE(m."created_at", n."created_at")
      )
      FROM "match" m
      WHERE m."id" = n."match_id"
        AND n."created_at" IN (SELECT "created_at" FROM backfilled_timestamps)
    `;
  }

  test("corrects rows sharing the bulk-backfill duplicate timestamp signature", async () => {
    const bogusCreatedAt = new Date(); // stands in for "the instant 0017 ran", shared by both rows below

    const base = Date.now() - 400 * 24 * 60 * 60_000; // ~400 days ago, unique per test run
    const matchAt1 = new Date(base);
    const sentAt1 = new Date(base + 5 * 60_000); // after matchAt1, as normal — not the floor here
    const [source1] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `nq-mig-1-${crypto.randomUUID()}`, name: "s", url: `https://feeds.example.test/nq-mig-1-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    const [post1] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source1!.id, platformPostId: crypto.randomUUID(), url: `https://x/${crypto.randomUUID()}`, text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });
    const [watch1] = await handle.db.insert(schema.watch).values({ userId, name: `nq-mig-1-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [match1] = await handle.db.insert(schema.match).values({ postId: post1!.id, watchId: watch1!.id, score: 1, createdAt: matchAt1 }).returning({ id: schema.match.id });
    const [row1] = await handle.db
      .insert(schema.notification)
      .values({ matchId: match1!.id, notifierId: null, userId, channel: "telegram", status: "sent", sentAt: sentAt1, createdAt: bogusCreatedAt, payload: {} })
      .returning({ id: schema.notification.id });

    // A second row sharing the exact same bogus timestamp — this duplication is what marks
    // both as backfill candidates.
    const matchAt2 = new Date(base + 2 * 24 * 60 * 60_000);
    const [source2] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `nq-mig-2-${crypto.randomUUID()}`, name: "s", url: `https://feeds.example.test/nq-mig-2-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    const [post2] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source2!.id, platformPostId: crypto.randomUUID(), url: `https://x/${crypto.randomUUID()}`, text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });
    const [watch2] = await handle.db.insert(schema.watch).values({ userId, name: `nq-mig-2-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [match2] = await handle.db.insert(schema.match).values({ postId: post2!.id, watchId: watch2!.id, score: 1, createdAt: matchAt2 }).returning({ id: schema.match.id });
    const [row2] = await handle.db
      .insert(schema.notification)
      .values({ matchId: match2!.id, notifierId: null, userId, channel: "telegram", status: "pending", createdAt: bogusCreatedAt, payload: {} })
      .returning({ id: schema.notification.id });

    // An unrelated row with its own distinct, already-accurate `created_at` — its match is,
    // as normal, earlier than it, but it must NOT be floored down to the match since it
    // doesn't share the duplicate-timestamp signature.
    const trueCreatedAt3 = new Date(base + 3 * 24 * 60 * 60_000);
    const matchAt3 = new Date(base);
    const [source3] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `nq-mig-3-${crypto.randomUUID()}`, name: "s", url: `https://feeds.example.test/nq-mig-3-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    const [post3] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source3!.id, platformPostId: crypto.randomUUID(), url: `https://x/${crypto.randomUUID()}`, text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });
    const [watch3] = await handle.db.insert(schema.watch).values({ userId, name: `nq-mig-3-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [match3] = await handle.db.insert(schema.match).values({ postId: post3!.id, watchId: watch3!.id, score: 1, createdAt: matchAt3 }).returning({ id: schema.match.id });
    const [row3] = await handle.db
      .insert(schema.notification)
      .values({ matchId: match3!.id, notifierId: null, userId, channel: "telegram", status: "pending", createdAt: trueCreatedAt3, payload: {} })
      .returning({ id: schema.notification.id });

    await runBackfillFloor();

    const [after1] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, row1!.id));
    // A match always precedes the notification derived from it, so `match.created_at` is
    // the earliest available timestamp here (earlier than `sentAt1` too) — the floor.
    expect(after1?.createdAt.getTime()).toBe(matchAt1.getTime());
    expect(after1?.createdAt.getTime()).toBeLessThan(bogusCreatedAt.getTime());

    const [after2] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, row2!.id));
    expect(after2?.createdAt.getTime()).toBe(matchAt2.getTime()); // no own event timestamps -> floored to its match

    const [after3] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, row3!.id));
    expect(after3?.createdAt.getTime()).toBe(trueCreatedAt3.getTime()); // untouched: not part of the duplicate signature

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, row1!.id));
    await handle.db.delete(schema.notification).where(eq(schema.notification.id, row2!.id));
    await handle.db.delete(schema.notification).where(eq(schema.notification.id, row3!.id));
  });
});

// Migration 0019: 0018's `GROUP BY created_at HAVING count(*) > 1` heuristic
// treats *every* duplicated timestamp as a backfill candidate. But Postgres `now()` is
// `transaction_timestamp()`, so a legitimate multi-row transaction (e.g. `notify.ts`'s
// fan-out, `enrich.ts`, `ops-alerts.ts`) also produces rows sharing one microsecond-precision
// `created_at` — 0018 would wrongly floor those too, moving them behind a keyset cursor.
// 0019 fixes this by identifying and touching only the single *earliest* duplicate instant
// (the unique signature of 0017's one-time `DEFAULT now()` backfill, which necessarily
// precedes every application-driven write). This exercises that corrected statement.
describe.skipIf(!canRun)("migration 0019: single backfill-instant floor", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `t-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, userId));
    await handle.db.delete(schema.match).where(inArray(schema.match.watchId, handle.db.select({ id: schema.watch.id }).from(schema.watch).where(eq(schema.watch.userId, userId))));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, handle.db.select({ id: schema.source.id }).from(schema.source).where(eq(schema.source.teamId, teamId))));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  // Same statement shape as migrations/0019_notification_backfill_instant_fix.sql
  // (match-joined half), minus the temp table (a plain scalar subquery is equivalent for a
  // single test run and avoids a second connection concern).
  async function runSingleInstantFloor(): Promise<void> {
    await handle.sql`
      UPDATE "notification" n
      SET "created_at" = LEAST(
        n."created_at",
        COALESCE(n."sent_at", n."created_at"),
        COALESCE(n."failed_at", n."created_at"),
        COALESCE(n."sending_at", n."created_at"),
        COALESCE(m."created_at", n."created_at")
      )
      FROM "match" m
      WHERE m."id" = n."match_id"
        AND n."created_at" = (
          SELECT "created_at" FROM "notification"
          GROUP BY "created_at"
          HAVING count(*) > 1
          ORDER BY "created_at" ASC
          LIMIT 1
        )
    `;
  }

  async function makeRow(createdAt: Date, matchAt: Date): Promise<string> {
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `nq-0019-${crypto.randomUUID()}`, name: "s", url: `https://feeds.example.test/nq-0019-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    const [post] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: `https://x/${crypto.randomUUID()}`, text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `nq-0019-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, createdAt: matchAt }).returning({ id: schema.match.id });
    const [row] = await handle.db
      .insert(schema.notification)
      .values({ matchId: match!.id, notifierId: null, userId, channel: "telegram", status: "pending", createdAt, payload: {} })
      .returning({ id: schema.notification.id });
    return row!.id;
  }

  test("floors only the earliest duplicate instant, leaving a later legit fan-out transaction's duplicate untouched", async () => {
    const base = Date.now() - 500 * 24 * 60 * 60_000; // ~500 days ago, unique per test run

    // The true backfill instant: earliest duplicate timestamp, shared by two rows.
    const backfillInstant = new Date(base);
    const backfillMatchAt1 = new Date(base - 10 * 24 * 60 * 60_000);
    const backfillMatchAt2 = new Date(base - 5 * 24 * 60 * 60_000);
    const backfillRow1 = await makeRow(backfillInstant, backfillMatchAt1);
    const backfillRow2 = await makeRow(backfillInstant, backfillMatchAt2);

    // A later, legitimate same-transaction fan-out: two different matches whose
    // notifications were inserted together, so they too share one microsecond-precision
    // timestamp -- but this is not the earliest duplicate group, so it must be left alone.
    const fanoutInstant = new Date(base + 100 * 24 * 60 * 60_000);
    const fanoutMatchAt1 = new Date(base + 99 * 24 * 60 * 60_000);
    const fanoutMatchAt2 = new Date(base + 98 * 24 * 60 * 60_000);
    const fanoutRow1 = await makeRow(fanoutInstant, fanoutMatchAt1);
    const fanoutRow2 = await makeRow(fanoutInstant, fanoutMatchAt2);

    await runSingleInstantFloor();

    const [after1] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, backfillRow1));
    expect(after1?.createdAt.getTime()).toBe(backfillMatchAt1.getTime());
    const [after2] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, backfillRow2));
    expect(after2?.createdAt.getTime()).toBe(backfillMatchAt2.getTime());

    const [fanoutAfter1] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, fanoutRow1));
    expect(fanoutAfter1?.createdAt.getTime()).toBe(fanoutInstant.getTime()); // untouched
    const [fanoutAfter2] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, fanoutRow2));
    expect(fanoutAfter2?.createdAt.getTime()).toBe(fanoutInstant.getTime()); // untouched

    await handle.db.delete(schema.notification).where(inArray(schema.notification.id, [backfillRow1, backfillRow2, fanoutRow1, fanoutRow2]));
  });
});

// `droppedOutsideBound` must be bounded to markers the age cutoff can never
// clear -- a marker still inside the age window but past this call's row `LIMIT` remains
// eligible for a later call and must not be counted as permanently dropped.
describe.skipIf(!canRun)("clearNoEnabledNotifierMarkers droppedOutsideBound bound", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `t-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, userId));
    await handle.db.delete(schema.match).where(inArray(schema.match.watchId, handle.db.select({ id: schema.watch.id }).from(schema.watch).where(eq(schema.watch.userId, userId))));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, handle.db.select({ id: schema.source.id }).from(schema.source).where(eq(schema.source.teamId, teamId))));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  async function makeMarker(matchCreatedAt: Date): Promise<string> {
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `nq-bound-${crypto.randomUUID()}`, name: "s", url: `https://feeds.example.test/nq-bound-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    const [post] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: `https://x/${crypto.randomUUID()}`, text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `nq-bound-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, createdAt: matchCreatedAt }).returning({ id: schema.match.id });
    const [marker] = await handle.db
      .insert(schema.notification)
      .values({ matchId: match!.id, notifierId: null, userId, channel: "none", status: "suppressed", lastError: "no enabled notifier", payload: {} })
      .returning({ id: schema.notification.id });
    return marker!.id;
  }

  test("a marker inside the age window is never counted as dropped, even before it is actually cleared", async () => {
    // Directly exercises the bounded count in isolation (without running the clear
    // statement first) -- the pre-fix query had no age filter at all and would have
    // counted this in-window marker as "dropped" purely because it hadn't been deleted yet.
    const recentId = await makeMarker(new Date(Date.now() - 60 * 60_000)); // 1h ago: in window

    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    const [remaining] = await handle.sql<{ count: string }[]>`
      select count(*)::text as count
      from notification n
      join match m on m.id = n.match_id
      where n.user_id = ${userId}
        and n.status = 'suppressed'
        and n.last_error = 'no enabled notifier'
        and m.created_at < ${cutoff.toISOString()}
    `;
    expect(Number(remaining?.count ?? "0")).toBe(0);

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, recentId));
  });
});
