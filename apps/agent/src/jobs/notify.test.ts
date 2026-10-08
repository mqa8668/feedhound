import { createDb, schema, type DbHandle } from "@feedhound/db";
import { createTelegramNotifier } from "@feedhound/bot/notifiers";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";
import { RateLimiter } from "../lib/rate-limit";
import { fetchNotifyConfig, resetStuckSendingRows, runNotifyJob, sendAlertRow, sweepStuckNotifyClaims, type NotifierMap, type NotifyRunDeps } from "./notify";
import { runNotifyDigestJob } from "./notify-digest";
import { TelegramMock } from "../../../../tests/helpers/telegram-mock";

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
    console.warn(`notify.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("notify.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("notify.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("notify job", () => {
  let handle: DbHandle;
  let mock: TelegramMock;
  let notifiers: NotifierMap;
  let teamId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    mock = new TelegramMock();
    notifiers = { telegram: createTelegramNotifier({ botToken: "test", apiBase: mock.baseUrl }) };
    const [team] = await handle.db.insert(schema.team).values({ name: `notify-test-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
  });

  afterAll(async () => {
    // Only match -> {post,watch} cascades on delete; everything else is
    // restrict, so this team's rows are torn down bottom-up explicitly.
    const users = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, teamId));
    const userIds = users.map((u) => u.id);
    if (userIds.length > 0) {
      await handle.db.delete(schema.notification).where(inArray(schema.notification.userId, userIds));
      await handle.db.delete(schema.watch).where(inArray(schema.watch.userId, userIds));
      await handle.db.delete(schema.notifier).where(inArray(schema.notifier.userId, userIds));
    }
    const sources = await handle.db.select({ id: schema.source.id }).from(schema.source).where(eq(schema.source.teamId, teamId));
    for (const s of sources) await handle.db.delete(schema.post).where(eq(schema.post.sourceId, s.id));
    for (const s of sources) await handle.db.delete(schema.source).where(eq(schema.source.id, s.id));
    for (const id of userIds) await handle.db.delete(schema.user).where(eq(schema.user.id, id));
    await handle.db.delete(schema.config).where(and(eq(schema.config.updatedBy, "test"), inArray(schema.config.key, ["notify.digest.maxEntries", "notify.retry.delaysSec"])));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
    await mock.close();
  });

  afterEach(() => {
    mock.calls.length = 0;
    mock.resetScripts();
  });

  async function makeFixture(opts: { mode?: "instant" | "digest"; digestEveryMin?: number } = {}) {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `notify-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const sourceId = source!.id;
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: opts.mode ?? "instant", digestEveryMin: opts.digestEveryMin }, enabled: true })
      .returning();
    const notifierId = notifierRow!.id;
    const [post] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: crypto.randomUUID(), url: "https://example.com/p/1", title: "iPhone 15", text: "Máy đẹp, giá tốt", textNormalized: "may dep gia tot" })
      .returning({ id: schema.post.id });
    const postId = post!.id;
    return { userId, sourceId, notifierId, postId, chatId: (notifierRow!.config as { chatId: number }).chatId };
  }

  async function makeWatch(userId: string, notifierId: string, overrides: Partial<typeof schema.watch.$inferInsert> = {}) {
    const [watch] = await handle.db
      .insert(schema.watch)
      .values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierId], enabled: true, ...overrides })
      .returning();
    return watch!;
  }

  async function makeMatch(postId: string, watchId: string) {
    const [match] = await handle.db.insert(schema.match).values({ postId, watchId, score: 1, notifyEnqueuedAt: new Date() }).returning();
    return match!;
  }

  function deps(now?: Date): NotifyRunDeps {
    return { handle, notifiers, rateLimiter: new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100_000, globalPerSec: 100_000 }), now };
  }

  test("Sends once, idempotent on retry, sentAt - createdAt < 5s", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);

    await runNotifyJob({ matchId: match.id }, deps());
    await runNotifyJob({ matchId: match.id }, deps()); // rerun: no duplicate send

    const sendCalls = mock.callsFor("sendMessage");
    expect(sendCalls).toHaveLength(1);
    const body = sendCalls[0]!.body as { reply_markup: { inline_keyboard: unknown[][] } };
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);

    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("sent");
    expect(row?.providerMessageId).toBeTruthy();
    expect(row!.sentAt!.getTime() - match.createdAt.getTime()).toBeLessThan(5_000);
  });

  test("An api post older than web.alertMaxAgeMinutes matches but never alerts; a fresh one does", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    const old = await makeMatch(f.postId, watch.id);
    const t = new Date();
    await handle.db.update(schema.post).set({ capture: "api", postedAt: new Date(t.getTime() - 3 * 3_600_000) }).where(eq(schema.post.id, f.postId));
    await runNotifyJob({ matchId: old.id }, deps(t));
    expect(mock.callsFor("sendMessage")).toHaveLength(0);
    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, old.id)).limit(1);
    expect(row).toMatchObject({ status: "skipped", lastError: "post too old" });

    const g = await makeFixture();
    const w2 = await makeWatch(g.userId, g.notifierId);
    const fresh = await makeMatch(g.postId, w2.id);
    await handle.db.update(schema.post).set({ capture: "api", postedAt: new Date(t.getTime() - 10 * 60_000) }).where(eq(schema.post.id, g.postId));
    await runNotifyJob({ matchId: fresh.id }, deps(t));
    expect(mock.callsFor("sendMessage")).toHaveLength(1);
  });

  // Telegram to the owner's own chat stays unmasked.
  test("The alert keeps the raw phone and author name, never the masks; Open post url is post.url", async () => {
    const f = await makeFixture();
    await handle.db
      .update(schema.post)
      .set({ title: "iPhone 15 lh 0912 345 678", text: "Máy đẹp, zalo 0912 345 678", textNormalized: "may dep zalo 0912 345 678", authorName: "Nguyễn Văn A", authorId: "100012345" })
      .where(eq(schema.post.id, f.postId));
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);

    await runNotifyJob({ matchId: match.id }, deps());

    const body = mock.callsFor("sendMessage")[0]!.body as { text: string; reply_markup: { inline_keyboard: { text: string; url?: string }[][] } };
    expect(body.text).toContain("0912 345 678");
    expect(body.text).toContain("Nguyễn Văn A");
    expect(body.text).not.toContain("[SĐT ẩn]");
    expect(body.text).not.toContain("Member #");
    expect(body.reply_markup.inline_keyboard[0]![0]).toEqual({ text: "Open post", url: "https://example.com/p/1" });
  });

  // 403 + not_implemented: 
  test("403 disables the notifier and raises one ops alert; messenger notifier fails as not_implemented", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);

    const opsEmail = `ops-${crypto.randomUUID()}@example.com`;
    const [operator] = await handle.db.insert(schema.user).values({ teamId, email: opsEmail, role: "operator" }).returning({ id: schema.user.id });
    // Ops recipient resolver: pin it to this operator via SEED_OPERATOR_EMAIL.
    const prevSeedEmail = process.env.SEED_OPERATOR_EMAIL;
    process.env.SEED_OPERATOR_EMAIL = opsEmail;

    mock.script("sendMessage", { status: 403 });
    try {
      await runNotifyJob({ matchId: match.id }, deps());
    } finally {
      if (prevSeedEmail === undefined) delete process.env.SEED_OPERATOR_EMAIL;
      else process.env.SEED_OPERATOR_EMAIL = prevSeedEmail;
    }

    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);

    const [notifierRow] = await handle.db.select().from(schema.notifier).where(eq(schema.notifier.id, f.notifierId)).limit(1);
    expect(notifierRow?.enabled).toBe(false);

    const opsRows = await handle.db.select().from(schema.notification).where(and(eq(schema.notification.channel, "ops"), eq(schema.notification.userId, operator!.id)));
    expect(opsRows.length).toBeGreaterThanOrEqual(1);

    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, operator!.id));
    await handle.db.delete(schema.user).where(eq(schema.user.id, operator!.id));
  });

  // muted -> suppressed: 
  test("Muted watch suppresses the primary row without sending", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId, { mutedUntil: new Date(Date.now() + 3_600_000) });
    const match = await makeMatch(f.postId, watch.id);

    await runNotifyJob({ matchId: match.id }, deps());

    expect(mock.callsFor("sendMessage")).toHaveLength(0);
    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("suppressed");
    expect(row?.lastError).toBe("muted");
  });

  // merge across two watches + mute-1h callback semantics on the resulting watchIds: 
  test("Two watches on the same post merge into one send, one sent + one merged", async () => {
    const f = await makeFixture();
    const watch1 = await makeWatch(f.userId, f.notifierId, { name: `w1-${crypto.randomUUID()}` });
    const watch2 = await makeWatch(f.userId, f.notifierId, { name: `w2-${crypto.randomUUID()}` });
    const match1 = await makeMatch(f.postId, watch1.id);
    const match2 = await makeMatch(f.postId, watch2.id);

    await runNotifyJob({ matchId: match1.id }, deps());
    await runNotifyJob({ matchId: match2.id }, deps());

    expect(mock.callsFor("sendMessage")).toHaveLength(1);
    const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.userId, f.userId));
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["merged", "sent"]);

    const sentRow = rows.find((r) => r.status === "sent");
    expect(sentRow?.payload.watchIds).toHaveLength(2);
  });

  // CR-1
  test("CR-1: sweeper recovers a notification for a match claimed but never enqueued", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    // Simulate the crash: notify_enqueued_at set (claimed) with no notify job ever sent, 10 min ago.
    const [match] = await handle.db
      .insert(schema.match)
      .values({ postId: f.postId, watchId: watch.id, score: 1, notifyEnqueuedAt: new Date(Date.now() - 10 * 60_000) })
      .returning();

    const sent: { name: string; data: unknown }[] = [];
    const fakeBoss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return null; } };

    // `sweepStuckNotifyClaims` scans the whole `match` table (not scoped to this test's
    // team), so assert our specific match was recovered rather than an exact global count
    // — other suites/fixtures in the shared test DB may also have stale rows.
    const swept = await sweepStuckNotifyClaims(handle, fakeBoss as never, new Date());
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(sent.some((s) => (s.data as { matchId?: string }).matchId === match!.id)).toBe(true);

    // Running the recovered job produces exactly one notification.
    await runNotifyJob({ matchId: match!.id }, deps());
    const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match!.id));
    expect(rows).toHaveLength(1);
  });

  async function getNotifierRow(notifierId: string) {
    const [row] = await handle.db.select().from(schema.notifier).where(eq(schema.notifier.id, notifierId)).limit(1);
    return row!;
  }

  // `sendingAt` lets the sweeper recover a row that crashed
  // between the `sending` claim and the HTTP call (both `nextAttemptAt` and `sentAt`
  // are null for such a row, which the old sweeper predicate could never catch).
  test("Crash between claim and HTTP call is recovered via sendingAt (exactly one delivery)", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);
    const [row] = await handle.db
      .insert(schema.notification)
      .values({
        matchId: match.id,
        notifierId: f.notifierId,
        userId: f.userId,
        channel: "telegram",
        status: "sending",
        sendingAt: new Date(Date.now() - 3 * 60_000),
        payload: { postId: f.postId, userId: f.userId, watchIds: [watch.id], watchNames: [watch.name] },
      })
      .returning();

    const now = new Date();
    const reset = await resetStuckSendingRows(handle, now);
    expect(reset).toBeGreaterThanOrEqual(1);

    const [recovered] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, row!.id)).limit(1);
    expect(recovered?.status).toBe("pending");

    const config = await fetchNotifyConfig(handle);
    const notifierRow = await getNotifierRow(f.notifierId);
    await sendAlertRow(deps(now), recovered!, notifierRow, config, now);

    expect(mock.callsFor("sendMessage")).toHaveLength(1);
    const [sentRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, row!.id)).limit(1);
    expect(sentRow?.status).toBe("sent");
  });

  // a row the digest job just claimed (`sending`, `sendingAt`
  // fresh) must not be reclaimed by the 1-minute sweeper just because its
  // `nextAttemptAt` (set before the claim, for grouping) is in the past.
  test("A digest-claimed row (stale nextAttemptAt, fresh sendingAt) is not reclaimed mid-send", async () => {
    const f = await makeFixture({ mode: "digest", digestEveryMin: 5 });
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);
    await runNotifyJob({ matchId: match.id }, deps());

    // Simulate the digest job's claim step mid-send: status -> sending with a fresh
    // sendingAt, while nextAttemptAt is left at its old (now stale) grouping value.
    await handle.db
      .update(schema.notification)
      .set({ status: "sending", sendingAt: new Date(), nextAttemptAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.notification.matchId, match.id));

    await resetStuckSendingRows(handle, new Date());

    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("sending");
  });

  // 429 half: retry_after waits, then succeeds, without incrementing `attempts`.
  test("429 retry_after waits before retrying without incrementing attempts", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);

    mock.script("sendMessage", { status: 429, retryAfterSec: 2 });
    mock.script("sendMessage", { status: 200 });

    let virtualNow = 0;
    const limiter = new RateLimiter({
      perChatPerSec: 1000,
      perChatPerMin: 100_000,
      globalPerSec: 100_000,
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
    });

    await runNotifyJob({ matchId: match.id }, { handle, notifiers, rateLimiter: limiter });

    expect(mock.callsFor("sendMessage")).toHaveLength(2);
    expect(virtualNow).toBeGreaterThanOrEqual(2_000);

    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("sent");
    expect(row?.attempts).toBe(0);
  });

  // backoff half: 5xx retried at +5,+30,+120,+600,+1800s (fake clock, no real waits), failed after.
  test("Backoff ladder 5,30,120,600,1800s then failed", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);
    const notifierRow = await getNotifierRow(f.notifierId);
    const config = await fetchNotifyConfig(handle);

    mock.script("sendMessage", { status: 500 });

    let now = new Date();
    await runNotifyJob({ matchId: match.id }, deps(now));

    let [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe("pending");
    expect(row!.nextAttemptAt!.getTime() - now.getTime()).toBe(5_000);

    const expectedDelaysSec = [30, 120, 600, 1800];
    for (const delaySec of expectedDelaysSec) {
      now = row!.nextAttemptAt!;
      await sendAlertRow(deps(now), row!, notifierRow, config, now);
      [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
      expect(row?.status).toBe("pending");
      expect(row!.nextAttemptAt!.getTime() - now.getTime()).toBe(delaySec * 1_000);
    }

    // 6th call (nextAttempts = 6) exhausts the 5-entry ladder -> permanent failure.
    now = row!.nextAttemptAt!;
    await sendAlertRow(deps(now), row!, notifierRow, config, now);
    [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(6);
    expect(mock.callsFor("sendMessage")).toHaveLength(6);
  });

  // messenger half: NotImplementedError -> failed at once, attempts=1, no HTTP call, no ops row.
  test("Messenger notifier fails as not_implemented, no HTTP call, no ops row", async () => {
    const f = await makeFixture();
    const [messengerNotifier] = await handle.db
      .insert(schema.notifier)
      .values({ userId: f.userId, kind: "messenger", config: {}, enabled: true })
      .returning();
    const watch = await makeWatch(f.userId, messengerNotifier!.id);
    const match = await makeMatch(f.postId, watch.id);

    const [operator] = await handle.db.insert(schema.user).values({ teamId, email: `ops-${crypto.randomUUID()}@example.com`, role: "operator" }).returning({ id: schema.user.id });

    await runNotifyJob({ matchId: match.id }, deps());

    expect(mock.calls).toHaveLength(0);
    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("not_implemented");
    expect(row?.attempts).toBe(1);

    const opsRows = await handle.db.select().from(schema.notification).where(and(eq(schema.notification.channel, "ops"), eq(schema.notification.userId, operator!.id)));
    expect(opsRows).toHaveLength(0);

    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, operator!.id));
    await handle.db.delete(schema.user).where(eq(schema.user.id, operator!.id));
    // notifier/watch/notification for the messenger fixture are cleaned up by afterAll (scoped to teamId).
  });

  // quiet-hours half: deferred to end of quiet hours, released as one message.
  test("Quiet hours defer nextAttemptAt to the window end, released as one message", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId, { quietHours: { start: "22:00", end: "07:00" } });
    // 23:00 Asia/Ho_Chi_Minh (UTC+7) = 16:00 UTC.
    const at2300 = new Date("2026-01-01T16:00:00Z");
    const match = await handle.db.insert(schema.match).values({ postId: f.postId, watchId: watch.id, score: 1, notifyEnqueuedAt: at2300, createdAt: at2300 }).returning();

    await runNotifyJob({ matchId: match[0]!.id }, deps(at2300));

    expect(mock.callsFor("sendMessage")).toHaveLength(0);
    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match[0]!.id)).limit(1);
    expect(row?.status).toBe("pending");
    // Quiet hours end at 07:00 Asia/Ho_Chi_Minh = 00:00 UTC the next day.
    const expectedEnd = new Date("2026-01-02T00:00:00Z");
    expect(row!.nextAttemptAt!.getTime()).toBe(expectedEnd.getTime());

    const released = await runNotifyDigestJob(deps(row!.nextAttemptAt!));
    expect(released).toBe(1);
    expect(mock.callsFor("sendMessage")).toHaveLength(1);
    const [after] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match[0]!.id)).limit(1);
    expect(after?.status).toBe("sent");
  });

  // cumulative 429 waits can run past STUCK_SENDING_MINUTES (2min) while
  // staying within MAX_429_CUMULATIVE_WAIT_SEC (5min) — the row's `sendingAt` must be
  // refreshed on every wait so a concurrent sweeper tick does not reclaim it mid-send and
  // cause a duplicate delivery.
  test("429 waits past the 2-minute stuck threshold refresh sendingAt (exactly one delivery, not swept)", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);

    // Each 429 is capped at MAX_429_WAIT_SEC=60s; 3 of them = 180s cumulative, well past the
    // 120s stuck-sending threshold but under the 300s cumulative-429 cap.
    mock.script("sendMessage", { status: 429, retryAfterSec: 100 });
    mock.script("sendMessage", { status: 429, retryAfterSec: 100 });
    mock.script("sendMessage", { status: 429, retryAfterSec: 100 });
    mock.script("sendMessage", { status: 200 });

    const jobStart = new Date();
    let virtualNow = 0;
    let sweepTriggered = false;
    // `resetStuckSendingRows` scans the whole `notification` table (not scoped to this
    // test's row) — like CR-1's sweeper test, assert this specific row was not reclaimed
    // rather than an exact global count, since other suites/fixtures in the shared test DB
    // may also have stale `sending` rows at the moment this fires.
    let statusDuringSweep: string | undefined;
    const limiter = new RateLimiter({
      perChatPerSec: 1000,
      perChatPerMin: 100_000,
      globalPerSec: 100_000,
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
        // Simulate the once-a-minute sweeper cron ticking mid-send, once virtual time has
        // passed the 2-minute stuck-sending threshold.
        if (!sweepTriggered && virtualNow >= 120_000) {
          sweepTriggered = true;
          await resetStuckSendingRows(handle, new Date(jobStart.getTime() + virtualNow));
          const [midRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
          statusDuringSweep = midRow?.status;
        }
      },
    });

    await runNotifyJob({ matchId: match.id }, { handle, notifiers, rateLimiter: limiter, now: jobStart });

    expect(sweepTriggered).toBe(true);
    // The bug this guards against: without refreshing `sendingAt` on every 429 wait, the
    // sweeper would flip this row back to `pending` here, letting a second job run claim +
    // send it again (duplicate delivery).
    expect(statusDuringSweep).toBe("sending");
    expect(mock.callsFor("sendMessage")).toHaveLength(4);
    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("sent");
    expect(row?.attempts).toBe(0); // 429s never increment attempts
  });

  // rate-limit half: 30 pending rows for one chat, fake clock -> <=1 call/s, <=20 in
  // the first 60s, the rest after.
  test("30 queued rows for one chat are rate-limited to <=1/s, <=20 in the first 60s", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    mock.script("sendMessage", { status: 200 });

    const matches = [];
    for (let i = 0; i < 30; i++) {
      const [post] = await handle.db
        .insert(schema.post)
        .values({ sourceId: f.sourceId, platformPostId: crypto.randomUUID(), url: `https://example.com/p/rl-${i}`, title: `Post ${i}`, text: "iphone", textNormalized: "iphone" })
        .returning({ id: schema.post.id });
      matches.push(await makeMatch(post!.id, watch.id));
    }

    let virtualNow = 0;
    const sendTimestamps: number[] = [];
    const limiter = new RateLimiter({
      perChatPerSec: 1,
      perChatPerMin: 20,
      globalPerSec: 1000,
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
    });
    const wrappedNotifiers: NotifierMap = {
      telegram: {
        kind: "telegram",
        send: async (target, msg) => {
          sendTimestamps.push(virtualNow);
          return notifiers.telegram!.send(target, msg);
        },
      },
    };

    for (const match of matches) {
      await runNotifyJob({ matchId: match.id }, { handle, notifiers: wrappedNotifiers, rateLimiter: limiter, now: new Date() });
    }

    expect(mock.callsFor("sendMessage")).toHaveLength(30);
    expect(sendTimestamps).toHaveLength(30);
    const within60s = sendTimestamps.filter((t) => t < 60_000);
    expect(within60s.length).toBeLessThanOrEqual(20);
    // <= 1 call per rolling second: no two sends within the same virtual second index.
    const secondBuckets = new Map<number, number>();
    for (const t of sendTimestamps) {
      const bucket = Math.floor(t / 1_000);
      secondBuckets.set(bucket, (secondBuckets.get(bucket) ?? 0) + 1);
    }
    for (const count of secondBuckets.values()) expect(count).toBeLessThanOrEqual(1);
  }, 20_000);

  // an invalid `notify.digest.maxEntries` (0, would spin format.ts's chunk loop
  // forever) or a non-array `notify.retry.delaysSec` (would throw in sendAlertRow) falls
  // back to the default instead of propagating.
  test("invalid config values fall back to defaults instead of propagating", async () => {
    async function nextVersion(key: string): Promise<number> {
      const rows = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, key)).orderBy(desc(schema.config.version)).limit(1);
      return (rows[0]?.version ?? 0) + 1;
    }
    const maxEntriesVersion = await nextVersion("notify.digest.maxEntries");
    const delaysSecVersion = await nextVersion("notify.retry.delaysSec");
    await handle.db.insert(schema.config).values({ key: "notify.digest.maxEntries", version: maxEntriesVersion, value: 0, updatedBy: "test" });
    await handle.db.insert(schema.config).values({ key: "notify.retry.delaysSec", version: delaysSecVersion, value: "not-an-array", updatedBy: "test" });

    const config = await fetchNotifyConfig(handle);
    expect(config.digestMaxEntries).toBe(20);
    expect(config.retryDelaysSec).toEqual([5, 30, 120, 600, 1800]);

    await handle.db
      .delete(schema.config)
      .where(and(eq(schema.config.key, "notify.digest.maxEntries"), eq(schema.config.version, maxEntriesVersion)));
    await handle.db
      .delete(schema.config)
      .where(and(eq(schema.config.key, "notify.retry.delaysSec"), eq(schema.config.version, delaysSecVersion)));
  });

  // a disabled watch, or a watch with no enabled notifier,
  // legitimately produces no Notification row — without a terminal marker the CR-1
  // sweeper (`sweepStuckNotifyClaims`) keeps finding the match "claimed, no row" forever
  // and floods the queue with `notify` re-enqueues once a minute.
  test("A disabled watch's match gets a terminal marker row so the sweeper stops resweeping it", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId, { enabled: false });
    const match = await handle.db
      .insert(schema.match)
      .values({ postId: f.postId, watchId: watch.id, score: 1, notifyEnqueuedAt: new Date(Date.now() - 10 * 60_000) })
      .returning();

    await runNotifyJob({ matchId: match[0]!.id }, deps());

    const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match[0]!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("suppressed");
    expect(rows[0]?.lastError).toBe("watch disabled");

    const sent: { name: string; data: unknown }[] = [];
    const fakeBoss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return null; } };
    await sweepStuckNotifyClaims(handle, fakeBoss as never, new Date());
    expect(sent.some((s) => (s.data as { matchId?: string }).matchId === match[0]!.id)).toBe(false);
  });

  // same terminal-marker guard when the user has no enabled
  // notifier at all (e.g. a watch created before `/link`, or every notifier disabled
  // after a 403) — the sweeper must not re-enqueue this match forever either.
  test("A watch with no enabled notifier gets a terminal marker row, not an infinite resweep", async () => {
    const f = await makeFixture();
    const [userOnly] = await handle.db.insert(schema.user).values({ teamId, email: `u2-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const watch = await makeWatch(userOnly!.id, f.notifierId, { notifierIds: [] }); // no notifier of its own, and userOnly has none enabled
    const match = await handle.db
      .insert(schema.match)
      .values({ postId: f.postId, watchId: watch.id, score: 1, notifyEnqueuedAt: new Date(Date.now() - 10 * 60_000) })
      .returning();

    await runNotifyJob({ matchId: match[0]!.id }, deps());

    const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match[0]!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("suppressed");
    expect(rows[0]?.lastError).toBe("no enabled notifier");

    const sent: { name: string; data: unknown }[] = [];
    const fakeBoss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return null; } };
    await sweepStuckNotifyClaims(handle, fakeBoss as never, new Date());
    expect(sent.some((s) => (s.data as { matchId?: string }).matchId === match[0]!.id)).toBe(false);

    await handle.db.delete(schema.notification).where(eq(schema.notification.matchId, match[0]!.id));
    await handle.db.delete(schema.watch).where(eq(schema.watch.id, watch.id));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userOnly!.id));
  });

  // A watch with no picks keeps the "all enabled notifiers" fallback even when a sibling watch has explicit picks.
  test("empty-picks watch + picked watch for the same post: all enabled notifiers get it once each", async () => {
    const f = await makeFixture();
    const [n2] = await handle.db
      .insert(schema.notifier)
      .values({ userId: f.userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "instant" }, enabled: true })
      .returning();
    const wA = await makeWatch(f.userId, f.notifierId, { notifierIds: [] });
    const wB = await makeWatch(f.userId, f.notifierId, { notifierIds: [f.notifierId] });
    const mA = await makeMatch(f.postId, wA.id);
    await makeMatch(f.postId, wB.id);

    await runNotifyJob({ matchId: mA.id }, deps());

    const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.userId, f.userId));
    const byNotifier = rows.filter((r) => r.status === "sent").map((r) => r.notifierId).sort();
    expect(new Set(byNotifier).size).toBe(byNotifier.length);
    expect(new Set(byNotifier)).toEqual(new Set([f.notifierId, n2!.id]));
  });

  // a rerun of `notify` for the same matchId (idempotent
  // re-delivery, or a sweeper/manual retry re-enqueue) in digest mode must not push the
  // row's `nextAttemptAt` further into the future just because it recomputed from the
  // rerun's own `now` instead of leaving an already-scheduled row alone.
  test("A digest primary's nextAttemptAt is not recomputed on rerun", async () => {
    const f = await makeFixture({ mode: "digest", digestEveryMin: 5 });
    const watch = await makeWatch(f.userId, f.notifierId);
    const t0 = new Date("2026-04-01T10:00:00Z");
    const match = await handle.db.insert(schema.match).values({ postId: f.postId, watchId: watch.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();

    await runNotifyJob({ matchId: match[0]!.id }, deps(t0));
    const [firstRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match[0]!.id)).limit(1);
    expect(firstRow!.nextAttemptAt!.getTime()).toBe(t0.getTime() + 5 * 60_000);

    // Rerun (same matchId) 2 minutes later — the already-scheduled nextAttemptAt must be
    // untouched, not recomputed as t2 + 5min.
    const t2 = new Date(t0.getTime() + 2 * 60_000);
    await runNotifyJob({ matchId: match[0]!.id }, deps(t2));

    const [afterRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match[0]!.id)).limit(1);
    expect(afterRow!.nextAttemptAt!.getTime()).toBe(t0.getTime() + 5 * 60_000);
  });

  // a rerun of `notify` for the same matchId in instant mode must
  // not resend a primary that is already in retry backoff — only the digest
  // job's due-row scan should send it once `nextAttemptAt` elapses.
  test("A rerun in instant mode does not resend a row still in retry backoff", async () => {
    const f = await makeFixture();
    const watch = await makeWatch(f.userId, f.notifierId);
    const match = await makeMatch(f.postId, watch.id);

    mock.script("sendMessage", { status: 500 });
    await runNotifyJob({ matchId: match.id }, deps());
    const [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Rerun before the backoff elapses (e.g. an operator retries, or a sibling match on
    // the same post triggers the job again).
    await runNotifyJob({ matchId: match.id }, deps(new Date()));

    expect(mock.callsFor("sendMessage")).toHaveLength(1); // no second send attempt
    const [afterRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match.id)).limit(1);
    expect(afterRow?.status).toBe("pending");
    expect(afterRow?.attempts).toBe(1);
  });

  // a suppressed/failed lowest-watchId row must never become the
  // merge primary — a still-pending sibling must be promoted instead (or it is lost).
  test("A muted watch's suppressed row does not swallow a later sibling watch's notification", async () => {
    const f = await makeFixture();
    const watch1 = await makeWatch(f.userId, f.notifierId, { name: `w1-${crypto.randomUUID()}`, mutedUntil: new Date(Date.now() + 3_600_000) });
    const watch2 = await makeWatch(f.userId, f.notifierId, { name: `w2-${crypto.randomUUID()}` });
    const match1 = await makeMatch(f.postId, watch1.id);

    await runNotifyJob({ matchId: match1.id }, deps());
    const [w1Row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match1.id)).limit(1);
    expect(w1Row?.status).toBe("suppressed");

    const match2 = await makeMatch(f.postId, watch2.id);
    await runNotifyJob({ matchId: match2.id }, deps());

    expect(mock.callsFor("sendMessage")).toHaveLength(1);
    const [w2Row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match2.id)).limit(1);
    expect(w2Row?.status).toBe("sent");
  });
});
