import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { runNotifyJob, sweepStuckNotifyClaims, type NotifyRunDeps } from "./notify";
import { RETENTION_QUEUE, registerRetentionJob, runRetention } from "./retention";
import { thumbPath } from "./thumbs";

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
    console.warn(`retention.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("retention.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("retention.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("runRetention (integration)", () => {
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let oldPostId: string;
  let recentPostId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "retention-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: `retention-test-${crypto.randomUUID()}`,
        name: "retention-test-source",
        url: "https://feeds.example.test/retention-test",
      })
      .returning({ id: schema.source.id });
    sourceId = source!.id;

    const now = new Date();
    const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

    const [oldPost] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `old-${crypto.randomUUID()}`,
        url: "https://example.com/old",
        text: "old post",
        raw: { html: "<div>old</div>" },
        firstSeenAt: days(91),
      })
      .returning({ id: schema.post.id });
    oldPostId = oldPost!.id;

    const [recentPost] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `recent-${crypto.randomUUID()}`,
        url: "https://example.com/recent",
        text: "recent post",
        raw: { html: "<div>recent</div>" },
        firstSeenAt: days(89),
      })
      .returning({ id: schema.post.id });
    recentPostId = recentPost!.id;

    await handle.db.insert(schema.postRevision).values([
      { postId: oldPostId, text: "old revision" },
      { postId: recentPostId, text: "recent revision" },
    ]);
  });

  afterAll(async () => {
    await handle.db.delete(schema.postRevision).where(eq(schema.postRevision.postId, oldPostId));
    await handle.db.delete(schema.postRevision).where(eq(schema.postRevision.postId, recentPostId));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("clears raw and deletes revisions for posts older than 90d only, idempotently", async () => {
    const first = await runRetention(handle, { retentionDays: 90 });
    expect(first.postsRawCleared).toBe(1);
    expect(first.revisionsDeleted).toBe(1);

    const [oldPost] = await handle.db.select().from(schema.post).where(eq(schema.post.id, oldPostId));
    const [recentPost] = await handle.db.select().from(schema.post).where(eq(schema.post.id, recentPostId));
    expect(oldPost!.raw).toEqual({});
    expect(recentPost!.raw).toEqual({ html: "<div>recent</div>" });

    const oldRevisions = await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, oldPostId));
    const recentRevisions = await handle.db
      .select()
      .from(schema.postRevision)
      .where(eq(schema.postRevision.postId, recentPostId));
    expect(oldRevisions).toHaveLength(0);
    expect(recentRevisions).toHaveLength(1);

    // both post rows still exist
    expect(oldPost).toBeDefined();
    expect(recentPost).toBeDefined();

    const second = await runRetention(handle, { retentionDays: 90 });
    expect(second.postsRawCleared).toBe(0);
    expect(second.revisionsDeleted).toBe(0);
  });
});

describe.skipIf(!canRun)("runRetention windows (integration)", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const keyK = `ret019.k.${suffix}`;
  const keyL = `ret019.l.${suffix}`;
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let userId: string;
  let watchId: string;
  const ids = {
    notifOld: crypto.randomUUID(),
    notifNew: crypto.randomUUID(),
    visitOld: crypto.randomUUID(),
    visitNew: crypto.randomUUID(),
  };
  const matchIds: { old?: string; new?: string } = {};
  const now = new Date();
  const ago = (days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const { db, sql } = handle;
    const [team] = await db.insert(schema.team).values({ name: `ret019-${suffix}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await db
      .insert(schema.user)
      .values({ teamId, email: `ret019-${suffix}@example.test`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
    const [source] = await db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `ret019-${suffix}`, name: "ret019", url: "https://feeds.example.test/ret019" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
    const [watch] = await db.insert(schema.watch).values({ userId, name: "ret019" }).returning({ id: schema.watch.id });
    watchId = watch!.id;

    // notifications (ops rows: no match)
    await db.insert(schema.notification).values([
      { id: ids.notifOld, userId, channel: "ops", status: "sent", createdAt: ago(181) },
      { id: ids.notifNew, userId, channel: "ops", status: "sent", createdAt: ago(179) },
    ]);

    // matches (+ one notification each), 181d / 179d old
    for (const [label, days] of [["old", 181], ["new", 179]] as const) {
      const [post] = await db
        .insert(schema.post)
        .values({ sourceId, platformPostId: `m-${label}-${suffix}`, url: "https://example.com/x" })
        .returning({ id: schema.post.id });
      const [m] = await db
        .insert(schema.match)
        .values({ postId: post!.id, watchId, score: 1, createdAt: ago(days) })
        .returning({ id: schema.match.id });
      matchIds[label] = m!.id;
      await db.insert(schema.notification).values({ userId, matchId: m!.id, channel: "telegram", status: "sent" });
    }

    // visits 31d / 29d old, each referenced by a post
    for (const [label, vid, days] of [["old", ids.visitOld, 31], ["new", ids.visitNew, 29]] as const) {
      await db.insert(schema.visit).values({ id: vid, sourceId, startedAt: ago(days) });
      await db
        .insert(schema.post)
        .values({ sourceId, platformPostId: `v-${label}-${suffix}`, url: "https://example.com/y", visitId: vid });
    }

    // config: K has 200 versions, L has 3
    await sql`insert into config (key, version, value, updated_by) select ${keyK}, g, to_jsonb(g), 'test' from generate_series(1, 200) g`;
    await sql`insert into config (key, version, value, updated_by) select ${keyL}, g, to_jsonb(g), 'test' from generate_series(1, 3) g`;
  });

  afterAll(async () => {
    const { db, sql } = handle;
    await sql`delete from config where key in (${keyK}, ${keyL})`;
    await sql`delete from notification where user_id = ${userId}`;
    await sql`delete from match where watch_id = ${watchId}`;
    await sql`delete from post where source_id = ${sourceId}`;
    await sql`delete from visit where source_id = ${sourceId}`;
    await db.delete(schema.watch).where(eq(schema.watch.id, watchId));
    await db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Prunes only rows past each window; second run is a no-op", async () => {
    const first = await runRetention(handle, { now });
    expect(first.notificationsDeleted).toBeGreaterThanOrEqual(1); // old ops row (the old match's notification goes via the match cascade)
    expect(first.matchesDeleted).toBeGreaterThanOrEqual(1);
    expect(first.visitsDeleted).toBeGreaterThanOrEqual(1);
    expect(first.configRowsDeleted).toBeGreaterThanOrEqual(150);

    const { sql } = handle;
    const notifIds = (await sql<{ id: string }[]>`select id from notification where id in (${ids.notifOld}, ${ids.notifNew})`).map((r) => r.id);
    expect(notifIds).toEqual([ids.notifNew]);
    const matches = (await sql<{ id: string }[]>`select id from match where watch_id = ${watchId}`).map((r) => r.id);
    expect(matches).toEqual([matchIds.new!]);
    const matchNotifs = await sql<{ match_id: string }[]>`select match_id from notification where user_id = ${userId} and match_id is not null`;
    expect(matchNotifs.map((r) => r.match_id)).toEqual([matchIds.new!]);
    const visits = (await sql<{ id: string }[]>`select id from visit where id in (${ids.visitOld}, ${ids.visitNew})`).map((r) => r.id);
    expect(visits).toEqual([ids.visitNew]);
    const posts = await sql<{ platform_post_id: string; visit_id: string | null }[]>`
      select platform_post_id, visit_id from post where source_id = ${sourceId} and platform_post_id like 'v-%'`;
    expect(posts.find((p) => p.platform_post_id.startsWith("v-old"))?.visit_id).toBeNull();
    expect(posts.find((p) => p.platform_post_id.startsWith("v-new"))?.visit_id).toBe(ids.visitNew);

    const k = await sql<{ min: number; max: number; n: number }[]>`select min(version)::int as min, max(version)::int as max, count(*)::int as n from config where key = ${keyK}`;
    expect(k[0]).toEqual({ min: 151, max: 200, n: 50 });
    const l = await sql<{ n: number }[]>`select count(*)::int as n from config where key = ${keyL}`;
    expect(l[0]!.n).toBe(3);

    const second = await runRetention(handle, { now });
    expect(second).toEqual({
      postsRawCleared: 0,
      revisionsDeleted: 0,
      notificationsDeleted: 0,
      matchesDeleted: 0,
      visitsDeleted: 0,
      configRowsDeleted: 0,
      thumbsPurged: 0,
    });
  });
});

describe.skipIf(!canRun)("registerRetentionJob (integration)", () => {
  let handle: DbHandle;
  let boss: PgBoss;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    boss = new PgBoss(TEST_DATABASE_URL!);
    await boss.start();
  });

  afterAll(async () => {
    await boss.unschedule(RETENTION_QUEUE).catch(() => undefined);
    await boss.deleteQueue(RETENTION_QUEUE).catch(() => undefined);
    await boss.stop({ graceful: false, close: true });
    await handle.close();
  });

  test("schedules the daily cron", async () => {
    await registerRetentionJob(boss, handle);
    const schedules = await boss.getSchedules();
    expect(schedules.find((s) => s.name === RETENTION_QUEUE)?.cron).toBe("0 4 * * *");

  });
});

describe.skipIf(!canRun)("retention vs notify sweeper (integration)", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let userId: string;
  let watchId: string;
  const now = new Date();
  const ago = (days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const { db } = handle;
    const [team] = await db.insert(schema.team).values({ name: `ret019r-${suffix}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await db.insert(schema.user).values({ teamId, email: `ret019r-${suffix}@example.test`, role: "hunter" }).returning({ id: schema.user.id });
    userId = user!.id;
    const [source] = await db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `ret019r-${suffix}`, name: "ret019r", url: "https://feeds.example.test/ret019r" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
    const [watch] = await db.insert(schema.watch).values({ userId, name: "ret019r" }).returning({ id: schema.watch.id });
    watchId = watch!.id;
  });

  afterAll(async () => {
    const { db, sql } = handle;
    await sql`delete from notification where user_id = ${userId}`;
    await sql`delete from match where watch_id = ${watchId}`;
    await sql`delete from post where source_id = ${sourceId}`;
    await db.delete(schema.watch).where(eq(schema.watch.id, watchId));
    await db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("aged matches are never re-sent: retention then sweeper enqueues nothing; notify refuses old matches", async () => {
    const { db } = handle;
    const mk = async (label: string, days: number): Promise<string> => {
      const [post] = await db.insert(schema.post).values({ sourceId, platformPostId: `r-${label}-${suffix}`, url: "https://example.com/r" }).returning({ id: schema.post.id });
      const [m] = await db
        .insert(schema.match)
        .values({ postId: post!.id, watchId, score: 1, createdAt: ago(days), notifyEnqueuedAt: ago(days) })
        .returning({ id: schema.match.id });
      return m!.id;
    };
    const veryOld = await mk("very-old", 200); // deleted by retention
    const oldKept = await mk("old-kept", 30); // survives retention, but past the 7d notify window
    const fresh = await mk("fresh", 1); // inside the window, claimed with no notification -> recoverable

    await runRetention(handle, { now });
    const left = (await handle.sql<{ id: string }[]>`select id from match where watch_id = ${watchId}`).map((r) => r.id).sort();
    expect(left).toEqual([oldKept, fresh].sort());

    const sent: { data: unknown }[] = [];
    const boss = { send: async (_n: string, data: unknown) => { sent.push({ data }); return null; } };
    await sweepStuckNotifyClaims(handle, boss as never, now);
    const sweptIds = sent.map((s) => (s.data as { matchId: string }).matchId);
    expect(sweptIds).toContain(fresh);
    expect(sweptIds).not.toContain(oldKept);
    expect(sweptIds).not.toContain(veryOld);

    const deps = { handle, notifiers: {}, rateLimiter: { acquire: async () => undefined }, now } as unknown as NotifyRunDeps;
    await runNotifyJob({ matchId: oldKept }, deps);
    const rows = await handle.sql<{ status: string; channel: string }[]>`select status, channel from notification where match_id = ${oldKept}`;
    expect(rows.map((r) => `${r.status}/${r.channel}`)).toEqual(["skipped/none"]);
  });
});

// retention half: step 6 purges cached thumbnails past thumbDays.
describe.skipIf(!canRun)("runRetention thumbnails", () => {
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let mediaDir: string;
  let oldId: string;
  let freshId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    mediaDir = await mkdtemp(`${tmpdir()}/thumb-ret-`);
    const [t] = await handle.db.insert(schema.team).values({ name: "thumb-retention-team" }).returning({ id: schema.team.id });
    teamId = t!.id;
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `tr-${crypto.randomUUID()}`, name: "tr", url: "https://feeds.example.test/tr" })
      .returning({ id: schema.source.id });
    sourceId = s!.id;
    const day = 24 * 60 * 60 * 1000;
    const rows = await handle.db
      .insert(schema.post)
      .values([
        { sourceId, platformPostId: `tr-old-${crypto.randomUUID()}`, url: "u", thumbState: "ok", firstSeenAt: new Date(Date.now() - 91 * day) },
        { sourceId, platformPostId: `tr-new-${crypto.randomUUID()}`, url: "u", thumbState: "ok", firstSeenAt: new Date(Date.now() - 5 * day) },
      ])
      .returning({ id: schema.post.id });
    oldId = rows[0]!.id;
    freshId = rows[1]!.id;
    for (const id of [oldId, freshId]) {
      await mkdir(dirname(thumbPath(mediaDir, id)), { recursive: true });
      await writeFile(thumbPath(mediaDir, id), "x");
    }
  });

  afterAll(async () => {
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await rm(mediaDir, { recursive: true, force: true });
    await handle.close();
  });

  test("old thumb file is unlinked and purged; fresh one stays; missing file is fine", async () => {
    const res = await runRetention(handle, { mediaDir });
    expect(res.thumbsPurged).toBeGreaterThanOrEqual(1);
    expect(existsSync(thumbPath(mediaDir, oldId))).toBe(false);
    expect(existsSync(thumbPath(mediaDir, freshId))).toBe(true);
    const rows = await handle.sql<{ id: string; thumb_state: string }[]>`select id, thumb_state from post where id in (${oldId}, ${freshId})`;
    expect(rows.find((r) => r.id === oldId)!.thumb_state).toBe("purged");
    expect(rows.find((r) => r.id === freshId)!.thumb_state).toBe("ok");
    await runRetention(handle, { mediaDir }); // idempotent, no throw
  });

  test("a non-ENOENT unlink error is logged and the post is still purged", async () => {
    const day = 24 * 60 * 60 * 1000;
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: `tr-eisdir-${crypto.randomUUID()}`, url: "u", thumbState: "ok", firstSeenAt: new Date(Date.now() - 91 * day) })
      .returning({ id: schema.post.id });
    await mkdir(thumbPath(mediaDir, p!.id), { recursive: true }); // unlink on a directory fails (not ENOENT)
    await runRetention(handle, { mediaDir });
    const [r] = await handle.sql<{ thumb_state: string }[]>`select thumb_state from post where id = ${p!.id}::uuid`;
    expect(r!.thumb_state).toBe("purged");
  });
});
