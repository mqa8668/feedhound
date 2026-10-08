import type { CategoryTree, CompiledWatch, Watch } from "@feedhound/core/matcher";
import { compileWatch } from "@feedhound/core/matcher";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { seedTaxonomyAndCatalogue } from "@feedhound/db/src/seed";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTelegramNotifier } from "@feedhound/bot/notifiers";
import { and, eq, inArray } from "drizzle-orm";
import { RateLimiter } from "../lib/rate-limit";
import { TelegramMock } from "../../../../tests/helpers/telegram-mock";
import { WatchIndex } from "../watch-index";
import type { PgBoss } from "pg-boss";
import { runMatchJob } from "./match";
import { runNotifyJob } from "./notify";

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
    console.warn(`match.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("match.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("match.test.ts: skipped — TEST_DATABASE_URL is unset");
}

interface SentJob {
  name: string;
  data: unknown;
}

/** Minimal fake `boss` — `runMatchJob` only ever calls `.send`. */
function makeFakeBoss(sent: SentJob[]): PgBoss {
  return {
    send: async (name: string, data: unknown) => {
      sent.push({ name, data });
      return null;
    },
  } as unknown as PgBoss;
}

function makeWatch(overrides: Partial<Watch>): Watch {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    userId: "u1",
    name: "test",
    enabled: true,
    include: [],
    includeAll: [],
    exclude: [],
    regex: null,
    categoryIds: [],
    itemIds: [],
    priceMin: null,
    priceMax: null,
    intents: [],
    sourceIds: [],
    notifierIds: [],
    quietHours: null,
    mutedUntil: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe.skipIf(!canRun)("runMatchJob", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let sourceId: string;

  /** Match.watchId has a real FK to watch — persist a Watch row matching each in-memory `Watch`. */
  async function persistWatch(w: Watch): Promise<void> {
    await handle.db.insert(schema.watch).values({ ...w, userId, mutedUntil: null, createdAt: new Date() });
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "match-job-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `match-job-test-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: "match-job-test", name: "Match job test", url: "https://feeds.example.test/match-job-test" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
  });

  afterAll(async () => {
    const posts = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sourceId));
    for (const p of posts) {
      await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, p.id));
    }
    // FK cascade (migration) deletes Match rows attached to these Posts/Watches.
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.catalogItem).where(eq(schema.catalogItem.name, "AC3 iPhone"));
    await handle.db.delete(schema.category).where(eq(schema.category.name, "AC3 Phones"));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.config).where(and(eq(schema.config.updatedBy, "test"), eq(schema.config.key, "app.tz")));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("Ingest -> enrich -> re-enrich yields exactly one Match per (post,watch) and 3 notify jobs total", async () => {
    const [category] = await handle.db
      .insert(schema.category)
      .values({ slug: `ac3-phones-${crypto.randomUUID()}`, name: "AC3 Phones", path: `electronics.ac3_${Date.now()}` })
      .returning({ id: schema.category.id, path: schema.category.path });
    const [item] = await handle.db
      .insert(schema.catalogItem)
      .values({ categoryId: category!.id, name: "AC3 iPhone" })
      .returning({ id: schema.catalogItem.id });

    const catTree: CategoryTree = new Map([[category!.id, category!.path]]);

    const w1 = makeWatch({ id: crypto.randomUUID(), include: ["iphone"], notifierIds: [crypto.randomUUID()] });
    const w2 = makeWatch({ id: crypto.randomUUID(), categoryIds: [category!.id], notifierIds: [crypto.randomUUID()] });
    const w3 = makeWatch({
      id: crypto.randomUUID(),
      include: ["iphone"],
      itemIds: [item!.id],
      priceMin: 10_000_000,
      priceMax: 30_000_000,
      notifierIds: [crypto.randomUUID()],
    });
    const index: CompiledWatch[] = [w1, w2, w3].map((w) => compileWatch(w, catTree));
    for (const w of [w1, w2, w3]) await persistWatch(w);

    const [post] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `ac3-${crypto.randomUUID()}`,
        url: "https://feeds.example.test/match-job-test/posts/1",
        text: "ban iphone con moi",
        textNormalized: "ban iphone con moi",
      })
      .returning({ id: schema.post.id });
    const postId = post!.id;

    const sent: SentJob[] = [];
    const boss = makeFakeBoss(sent);

    // ingest: only W1 has no enrichment filter, so only (P,W1) should match.
    await runMatchJob({ handle, boss, watchIndex: { getForTeam: () => index }, postId, trigger: "ingest" });

    let rows = await handle.db.select().from(schema.match).where(eq(schema.match.postId, postId));
    expect(rows.length).toBe(1);
    expect(rows[0]?.watchId).toBe(w1.id);
    expect(rows[0]?.score).toBe(1.0);
    expect(sent.length).toBe(1);

    await handle.db.insert(schema.enrichment).values({
      postId,
      revision: 0,
      intent: "sell",
      priceVnd: 20_000_000,
      categoryId: category!.id,
      itemId: item!.id,
    });

    // enrich: W2 (category match) and W3 (item + price match) now insert new Match rows;
    // W1 is unaffected (ON CONFLICT DO NOTHING — idempotent).
    await runMatchJob({ handle, boss, watchIndex: { getForTeam: () => index }, postId, trigger: "enrich" });
    rows = await handle.db.select().from(schema.match).where(eq(schema.match.postId, postId));
    expect(rows.length).toBe(3);
    const byWatch = new Map(rows.map((r) => [r.watchId, r.score]));
    expect(byWatch.get(w1.id)).toBe(1.0);
    expect(byWatch.get(w2.id)).toBe(0);
    expect(byWatch.get(w3.id)).toBe(3.0);
    expect(sent.length).toBe(3); // 1 (ingest) + 2 (enrich: W2, W3)

    // re-enrich (duplicate delivery of the same trigger): no new rows, no new notify jobs.
    await runMatchJob({ handle, boss, watchIndex: { getForTeam: () => index }, postId, trigger: "enrich" });
    const afterReEnrich = await handle.db.select().from(schema.match).where(eq(schema.match.postId, postId));
    expect(afterReEnrich.length).toBe(3);
    expect(sent.length).toBe(3);
  });

  test("Quiet hours — 23:30 -> quiet:true, 09:00 -> quiet:false", async () => {
    await handle.db
      .insert(schema.config)
      .values({ key: "app.tz", version: 1, value: "Asia/Ho_Chi_Minh", updatedBy: "test" })
      .onConflictDoNothing();

    const watch = makeWatch({
      id: crypto.randomUUID(),
      include: ["dep"],
      notifierIds: [crypto.randomUUID()],
      quietHours: { start: "22:00", end: "07:00" },
    });
    const index: CompiledWatch[] = [compileWatch(watch, new Map())];
    await persistWatch(watch);

    async function insertPost(suffix: string): Promise<string> {
      const [row] = await handle.db
        .insert(schema.post)
        .values({
          sourceId,
          platformPostId: `ac5-${suffix}-${crypto.randomUUID()}`,
          url: `https://feeds.example.test/match-job-test/posts/ac5-${suffix}`,
          text: "dep qua ban gap",
          textNormalized: "dep qua ban gap",
        })
        .returning({ id: schema.post.id });
      return row!.id;
    }

    const sentNight: SentJob[] = [];
    const postNight = await insertPost("night");
    // 23:30 Asia/Ho_Chi_Minh (UTC+7) = 16:30 UTC.
    await runMatchJob({
      handle,
      boss: makeFakeBoss(sentNight),
      watchIndex: { getForTeam: () => index },
      postId: postNight,
      trigger: "ingest",
      now: new Date("2026-09-18T16:30:00Z"),
    });
    expect(sentNight.length).toBe(1);
    expect((sentNight[0]?.data as { quiet: boolean }).quiet).toBe(true);

    const sentDay: SentJob[] = [];
    const postDay = await insertPost("day");
    // 09:00 Asia/Ho_Chi_Minh = 02:00 UTC.
    await runMatchJob({
      handle,
      boss: makeFakeBoss(sentDay),
      watchIndex: { getForTeam: () => index },
      postId: postDay,
      trigger: "ingest",
      now: new Date("2026-09-18T02:00:00Z"),
    });
    expect(sentDay.length).toBe(1);
    expect((sentDay[0]?.data as { quiet: boolean }).quiet).toBe(false);
  });

  // Regression: a `boss.send` failure must not
  // silently lose the notify job. On retry, the match job must re-scan its
  // own matches by `notifyEnqueuedAt` (not by "was this row newly inserted")
  // and enqueue exactly one notify job per match — never zero (lost) and
  // never more than one (duplicate).
  test("A boss.send failure on first run does not lose the notify job on retry", async () => {
    const watch = makeWatch({
      id: crypto.randomUUID(),
      include: ["macbook"],
      notifierIds: [crypto.randomUUID()],
    });
    const index: CompiledWatch[] = [compileWatch(watch, new Map())];
    await persistWatch(watch);

    const [post] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `finding3-${crypto.randomUUID()}`,
        url: "https://feeds.example.test/match-job-test/posts/finding3",
        text: "ban macbook con moi",
        textNormalized: "ban macbook con moi",
      })
      .returning({ id: schema.post.id });
    const postId = post!.id;

    const sent: SentJob[] = [];
    let sendCallCount = 0;
    const flakyBoss = {
      send: async (name: string, data: unknown) => {
        sendCallCount++;
        if (sendCallCount === 1) throw new Error("simulated boss.send failure");
        sent.push({ name, data });
        return null;
      },
    } as unknown as PgBoss;

    // First run: Match row is inserted, but boss.send throws before the row's
    // notifyEnqueuedAt is set — simulates pg-boss retrying the whole job.
    await expect(
      runMatchJob({ handle, boss: flakyBoss, watchIndex: { getForTeam: () => index }, postId, trigger: "ingest" }),
    ).rejects.toThrow("simulated boss.send failure");

    let rows = await handle.db.select().from(schema.match).where(eq(schema.match.postId, postId));
    expect(rows.length).toBe(1); // insert already committed
    expect(rows[0]?.notifyEnqueuedAt).toBeNull(); // notify decision not finalised
    expect(sent.length).toBe(0); // notify job was lost on this attempt

    // Retry (pg-boss redelivers the same job): must re-scan the existing
    // Match row (onConflictDoNothing yields nothing) and still enqueue notify.
    await runMatchJob({ handle, boss: flakyBoss, watchIndex: { getForTeam: () => index }, postId, trigger: "ingest" });

    rows = await handle.db.select().from(schema.match).where(eq(schema.match.postId, postId));
    expect(rows.length).toBe(1); // still exactly one Match row (idempotent)
    expect(rows[0]?.notifyEnqueuedAt).not.toBeNull();
    expect(sent.length).toBe(1); // exactly one notify job total, not zero, not two

    // A third run (e.g. duplicate `ingest` delivery) must not re-notify.
    await runMatchJob({ handle, boss: flakyBoss, watchIndex: { getForTeam: () => index }, postId, trigger: "ingest" });
    expect(sent.length).toBe(1);
  });

  // A watch with `notifierIds: []` still enqueues `notify`; the real notify
  // handler then routes to all of the owner's enabled notifiers (or records the no-target outcome).
  test("Empty notifierIds -> real match enqueues notify -> real notify sends to the owner's notifier", async () => {
    const mock = new TelegramMock();
    const userIds: string[] = [];
    try {
      const mkUser = async (): Promise<string> => {
        const [u] = await handle.db.insert(schema.user).values({ teamId, email: `wire-040-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
        userIds.push(u!.id);
        return u!.id;
      };
      const withNotifier = await mkUser();
      const withoutNotifier = await mkUser();
      const [n1] = await handle.db.insert(schema.notifier).values({ userId: withNotifier, kind: "telegram", config: { chatId: 424242, mode: "instant" }, enabled: true }).returning({ id: schema.notifier.id });
      const notifiers = { telegram: createTelegramNotifier({ botToken: "test", apiBase: mock.baseUrl }) };
      const rateLimiter = new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100_000, globalPerSec: 100_000 });

      for (const owner of [withNotifier, withoutNotifier]) {
        const watch = makeWatch({ id: crypto.randomUUID(), userId: owner, include: ["wire040phone"], notifierIds: [] });
        await handle.db.insert(schema.watch).values({ ...watch, userId: owner, mutedUntil: null, createdAt: new Date() });
        const [post] = await handle.db
          .insert(schema.post)
          .values({ sourceId, platformPostId: `wire040-${crypto.randomUUID()}`, url: "https://feeds.example.test/match-job-test/posts/wire040", text: "ban wire040phone", textNormalized: "ban wire040phone" })
          .returning({ id: schema.post.id });
        const sent: SentJob[] = [];
        await runMatchJob({ handle, boss: makeFakeBoss(sent), watchIndex: { getForTeam: () => [compileWatch(watch, new Map())] }, postId: post!.id, trigger: "ingest" });
        expect(sent.filter((j) => j.name === "notify")).toHaveLength(1);
        const { matchId } = sent[0]!.data as { matchId: string };
        await runNotifyJob({ matchId }, { handle, notifiers, rateLimiter });
        const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchId));
        expect(rows).toHaveLength(1);
        if (owner === withNotifier) {
          expect(rows[0]?.notifierId).toBe(n1!.id);
        } else {
          expect(rows[0]).toMatchObject({ notifierId: null, status: "suppressed", lastError: "no enabled notifier" });
        }
        // Only the owner with a notifier produced a Telegram send.
        expect(mock.callsFor("sendMessage")).toHaveLength(1);
      }
    } finally {
      if (userIds.length > 0) {
        await handle.db.delete(schema.notification).where(inArray(schema.notification.userId, userIds));
        await handle.db.delete(schema.watch).where(inArray(schema.watch.userId, userIds));
        await handle.db.delete(schema.notifier).where(inArray(schema.notifier.userId, userIds));
        await handle.db.delete(schema.user).where(inArray(schema.user.id, userIds));
      }
      await mock.close();
    }
  });

  test("Two overlapping match job runs for the same (post,watch) enqueue exactly one notify", async () => {
    const watch = makeWatch({
      id: crypto.randomUUID(),
      include: ["airpods"],
      notifierIds: [crypto.randomUUID()],
    });
    const index: CompiledWatch[] = [compileWatch(watch, new Map())];
    await persistWatch(watch);

    const [post] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `finding2-${crypto.randomUUID()}`,
        url: "https://feeds.example.test/match-job-test/posts/finding2",
        text: "ban airpods con moi",
        textNormalized: "ban airpods con moi",
      })
      .returning({ id: schema.post.id });
    const postId = post!.id;

    const sent: SentJob[] = [];
    const boss = makeFakeBoss(sent);

    // Simulates two overlapping triggers for the same post landing close
    // together (e.g. `ingest` and a duplicate `ingest` redelivery, or
    // `ingest` racing `enrich`) — before the finding-2 fix, both runs could
    // read `notifyEnqueuedAt: null` and both enqueue `notify`.
    await Promise.all([
      runMatchJob({ handle, boss, watchIndex: { getForTeam: () => index }, postId, trigger: "ingest" }),
      runMatchJob({ handle, boss, watchIndex: { getForTeam: () => index }, postId, trigger: "ingest" }),
    ]);

    const rows = await handle.db.select().from(schema.match).where(eq(schema.match.postId, postId));
    expect(rows.length).toBe(1); // ON CONFLICT DO NOTHING — one Match row regardless of the race
    expect(rows[0]?.notifyEnqueuedAt).not.toBeNull();
    expect(sent.length).toBe(1); // exactly one notify job, not two, not zero
  });

  test("A post only matches watches of its own team", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const teams: string[] = [];
    const users: string[] = [];
    const srcs: Record<"A" | "C", string> = { A: "", C: "" };
    const watchIds: Record<"A" | "B", string> = { A: "", B: "" };
    try {
      const teamOf: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
      for (const k of ["A", "B", "C"] as const) {
        const [t] = await handle.db.insert(schema.team).values({ name: `ac7-${k}-${tag}` }).returning({ id: schema.team.id });
        teamOf[k] = t!.id;
        teams.push(t!.id);
      }
      for (const k of ["A", "B"] as const) {
        const [u] = await handle.db
          .insert(schema.user)
          .values({ teamId: teamOf[k], email: `ac7-${k}-${tag}@example.test`, role: "hunter" })
          .returning({ id: schema.user.id });
        users.push(u!.id);
        const [w] = await handle.db
          .insert(schema.watch)
          .values({ userId: u!.id, name: `ac7-${k}`, include: ["ac7marker"] })
          .returning({ id: schema.watch.id });
        watchIds[k] = w!.id;
      }
      for (const k of ["A", "C"] as const) {
        const [s] = await handle.db
          .insert(schema.source)
          .values({ teamId: teamOf[k], kind: "web", platformId: `ac7-${k}-${tag}`, name: `ac7-${k}`, url: "https://feeds.example.test/ac7" })
          .returning({ id: schema.source.id });
        srcs[k] = s!.id;
      }

      const index = new WatchIndex({ handle });
      await index.reload();
      expect(index.getForTeam(teamOf.B).some((w) => w.id === watchIds.A)).toBe(false);
      expect(index.getForTeam(teamOf.B).some((w) => w.id === watchIds.B)).toBe(true);

      const sent: SentJob[] = [];
      const boss = makeFakeBoss(sent);
      const postFor = async (sid: string): Promise<string> => {
        const [p] = await handle.db
          .insert(schema.post)
          .values({ sourceId: sid, platformPostId: `ac7-${crypto.randomUUID()}`, url: "https://example.com/x", text: "ban iphone ac7marker", textNormalized: "ban iphone ac7marker" })
          .returning({ id: schema.post.id });
        return p!.id;
      };
      const postA = await postFor(srcs.A);
      await runMatchJob({ handle, boss, watchIndex: index, postId: postA, trigger: "ingest" });
      const rowsA = await handle.db.select().from(schema.match).where(eq(schema.match.postId, postA));
      expect(rowsA.map((r) => r.watchId)).toEqual([watchIds.A]);

      const postC = await postFor(srcs.C);
      await runMatchJob({ handle, boss, watchIndex: index, postId: postC, trigger: "ingest" });
      const rowsC = await handle.db.select().from(schema.match).where(eq(schema.match.postId, postC));
      expect(rowsC).toHaveLength(0);
    } finally {
      for (const sid of Object.values(srcs)) {
        if (sid) await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sid)); // cascades matches
      }
      for (const uid of users) await handle.db.delete(schema.watch).where(eq(schema.watch.userId, uid));
      for (const sid of Object.values(srcs)) if (sid) await handle.db.delete(schema.source).where(eq(schema.source.id, sid));
      for (const uid of users) await handle.db.delete(schema.user).where(eq(schema.user.id, uid));
      for (const tid of teams) await handle.db.delete(schema.team).where(eq(schema.team.id, tid));
    }
  });

  test("A post older than the match retention window creates no match", async () => {
    const [w] = await handle.db.insert(schema.watch).values({ userId, name: "old-post", include: ["zzoldpost"] }).returning({ id: schema.watch.id });
    try {
      const index = new WatchIndex({ handle });
      await index.reload();
      const mkPost = async (days: number): Promise<string> => {
        const [p] = await handle.db
          .insert(schema.post)
          .values({
            sourceId,
            platformPostId: `old-${days}-${crypto.randomUUID()}`,
            url: "https://example.com/x",
            text: "zzoldpost",
            textNormalized: "zzoldpost",
            firstSeenAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
          })
          .returning({ id: schema.post.id });
        return p!.id;
      };
      const boss = makeFakeBoss([]);
      const oldId = await mkPost(181);
      const freshId = await mkPost(179);
      await runMatchJob({ handle, boss, watchIndex: index, postId: oldId, trigger: "ingest" });
      await runMatchJob({ handle, boss, watchIndex: index, postId: freshId, trigger: "ingest" });
      expect(await handle.db.select().from(schema.match).where(eq(schema.match.postId, oldId))).toHaveLength(0);
      expect(await handle.db.select().from(schema.match).where(eq(schema.match.postId, freshId))).toHaveLength(1);
    } finally {
      await handle.db.delete(schema.watch).where(eq(schema.watch.id, w!.id)); // cascades matches
    }
  });
  test("match_state stays pending while enrich is pending, and when the version moved during the run", async () => {
    const [w] = await handle.db
      .insert(schema.watch)
      .values({ userId, name: "p015", include: ["zzpipeline015"], notifierIds: [crypto.randomUUID()] })
      .returning({ id: schema.watch.id });
    try {
      const index = new WatchIndex({ handle });
      await index.reload();
      const mkPost = async (enrichState: string): Promise<string> => {
        const [p] = await handle.db
          .insert(schema.post)
          .values({
            sourceId,
            platformPostId: `p015-${crypto.randomUUID()}`,
            url: "https://example.com/x",
            text: "zzpipeline015",
            textNormalized: "zzpipeline015",
            enrichState,
          })
          .returning({ id: schema.post.id });
        return p!.id;
      };
      const stateOf = async (id: string) => {
        const [r] = await handle.sql<{ match_state: string; pipeline_version: number }[]>`select match_state, pipeline_version from post where id = ${id}`;
        return r!;
      };

      // enrich still pending -> matched on text, but match_state is left alone.
      const pendingId = await mkPost("pending");
      await runMatchJob({ handle, boss: makeFakeBoss([]), watchIndex: index, postId: pendingId, trigger: "ingest" });
      expect((await stateOf(pendingId)).match_state).toBe("pending");

      // settled enrich -> done (version +1).
      const doneId = await mkPost("done");
      await runMatchJob({ handle, boss: makeFakeBoss([]), watchIndex: index, postId: doneId, trigger: "enrich" });
      expect(await stateOf(doneId)).toEqual({ match_state: "done", pipeline_version: 1 });

      // a capture upgrade bumps the version while the run is in flight (during its notify send) -> stays pending.
      const racedId = await mkPost("done");
      const bumpingBoss = {
        send: async () => {
          await handle.sql`update post set pipeline_version = pipeline_version + 1, match_state = 'pending', enrich_state = 'pending' where id = ${racedId}`;
          return null;
        },
      } as unknown as PgBoss;
      await runMatchJob({ handle, boss: bumpingBoss, watchIndex: index, postId: racedId, trigger: "enrich" });
      expect(await stateOf(racedId)).toEqual({ match_state: "pending", pipeline_version: 1 });
    } finally {
      await handle.db.delete(schema.watch).where(eq(schema.watch.id, w!.id));
    }
  }, 30_000);

  test("Region filter falls back to source_group override > auto > source default; the post's own region wins", async () => {
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where slug = 'cars' and attribute_schema <> '[]'::jsonb`;
    if (!seeded?.n) await seedTaxonomyAndCatalogue(TEST_DATABASE_URL!);
    const tag = crypto.randomUUID().slice(0, 8);
    const mkSource = async (name: string, defaults: Record<string, string>): Promise<string> => {
      const [src] = await handle.db
        .insert(schema.source)
        .values({ teamId, kind: "web", platformId: `r051-${name}-${tag}`, name: `r051-${name}`, url: "https://feeds.example.test/r051", defaults })
        .returning({ id: schema.source.id });
      return src!.id;
    };
    const group = async (sid: string, g: { auto?: string | null; override?: string | null }): Promise<void> => {
      await handle.db.insert(schema.sourceGroup).values({ sourceId: sid, autoTopicMethod: "default", autoRegionMethod: g.auto ? "auto" : "none", autoRegion: g.auto ?? null, overrideRegion: g.override ?? null });
    };
    const s = {
      override: await mkSource("override", {}),
      auto: await mkSource("auto", {}),
      overAuto: await mkSource("overauto", {}),
      none: await mkSource("none", {}),
      dflt: await mkSource("dflt", { region: "hcm" }),
      mixed: await mkSource("mixed", { region: "hcm" }),
    };
    await group(s.override, { override: "hcm" });
    await group(s.auto, { auto: "hcm" });
    await group(s.overAuto, { auto: "hcm", override: "ha_noi" });
    await group(s.mixed, { auto: "mixed" });
    const [w] = await handle.db
      .insert(schema.watch)
      .values({ userId, name: "r051", include: ["zz051reg"], attributeFilters: [{ key: "region", op: "in", values: ["hcm"] }] })
      .returning({ id: schema.watch.id });
    try {
      const index = new WatchIndex({ handle });
      await index.reload();
      const run = async (sid: string, attributes: Record<string, string>): Promise<number> => {
        const [p] = await handle.db
          .insert(schema.post)
          .values({ sourceId: sid, platformPostId: `r051-${crypto.randomUUID()}`, url: "https://example.com/x", text: "ban zz051reg", textNormalized: "ban zz051reg", enrichState: "done" })
          .returning({ id: schema.post.id });
        await handle.db.insert(schema.enrichment).values({ postId: p!.id, intent: "sell", engine: "rule", attributes });
        await runMatchJob({ handle, boss: makeFakeBoss([]), watchIndex: index, postId: p!.id, trigger: "enrich" });
        return (await handle.db.select().from(schema.match).where(and(eq(schema.match.postId, p!.id), eq(schema.match.watchId, w!.id)))).length;
      };
      expect(await run(s.override, {})).toBe(1);
      expect(await run(s.override, { region: "nam_dinh" })).toBe(0); // the post's own region wins
      expect(await run(s.auto, {})).toBe(1);
      expect(await run(s.overAuto, {})).toBe(0); // override ha_noi beats auto hcm
      expect(await run(s.none, {})).toBe(0); // no region anywhere
      expect(await run(s.dflt, {})).toBe(1); // source.defaults.region
      expect(await run(s.mixed, {})).toBe(0); // auto "mixed" is uninformative and wins over the default (override ?? auto ?? default)
    } finally {
      await handle.db.delete(schema.watch).where(eq(schema.watch.id, w!.id));
      for (const sid of Object.values(s)) {
        await handle.sql`delete from enrichment where post_id in (select id from post where source_id = ${sid}::uuid)`;
        await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sid));
        await handle.db.delete(schema.source).where(eq(schema.source.id, sid));
      }
    }
  }, 60_000);
});
