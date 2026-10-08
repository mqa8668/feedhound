import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTelegramApiClient } from "./telegram-api";
import { pollOnce, type PollDeps } from "./poll";
import { linkChat, resetLinkThrottleForTest } from "./link";
import { TelegramMock } from "../../../tests/helpers/telegram-mock";

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
    console.warn(`bot.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("bot.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("bot.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("bot poll loop (callbacks)", () => {
  let handle: DbHandle;
  let mock: TelegramMock;
  let deps: PollDeps;
  let teamId: string;
  let userId: string;
  const chatId = Math.floor(Math.random() * 1_000_000_000);

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    mock = new TelegramMock();
    deps = { handle, api: createTelegramApiClient({ botToken: "test", apiBase: mock.baseUrl }) };
    const [team] = await handle.db.insert(schema.team).values({ name: `bot-test-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `bot-${crypto.randomUUID()}@example.com`, role: "hunter", linkCode: "ABCD1234", linkCodeExpiresAt: new Date(Date.now() + 3_600_000) })
      .returning({ id: schema.user.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, userId));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
    await mock.close();
  });

  afterEach(() => {
    mock.calls.length = 0;
  });

  let offset = 0;

  test("expired code -> error reply, no change; valid code -> links, sets telegramChatId; unlinked commands only get instructions", async () => {
    mock.pushUpdate({ message: { chat: { id: chatId }, text: "/watch list" } });
    offset = await pollOnce(deps, offset);
    expect(mock.callsFor("sendMessage")).toHaveLength(1);
    let [user] = await handle.db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1);
    expect(user?.telegramChatId).toBeNull();

    mock.pushUpdate({ message: { chat: { id: chatId }, text: "/link WRONGCOD" } });
    offset = await pollOnce(deps, offset);
    const body1 = mock.callsFor("sendMessage").at(-1)!.body as { text: string };
    expect(body1.text).toContain("Code is invalid");

    mock.pushUpdate({ message: { chat: { id: chatId }, text: "/link ABCD1234" } });
    offset = await pollOnce(deps, offset);
    const body2 = mock.callsFor("sendMessage").at(-1)!.body as { text: string };
    expect(body2.text).toContain("Linked to");

    [user] = await handle.db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1);
    expect(user?.telegramChatId).toBe(String(chatId));
    expect(user?.linkCode).toBeNull();

    const notifierRows = await handle.db.select().from(schema.notifier).where(and(eq(schema.notifier.userId, userId), eq(schema.notifier.kind, "telegram")));
    expect(notifierRows).toHaveLength(1);
  });

  test('/watch add "ip15" -x "cần mua"; list; mute; del; status', async () => {
    mock.pushUpdate({ message: { chat: { id: chatId }, text: '/watch add "ip15" -x "cần mua"' } });
    offset = await pollOnce(deps, offset);
    const addReply = mock.callsFor("sendMessage").at(-1)!.body as { text: string };
    expect(addReply.text).toContain("ip15");

    const [watch] = await handle.db.select().from(schema.watch).where(and(eq(schema.watch.userId, userId), eq(schema.watch.name, "ip15"))).limit(1);
    expect(watch).toBeTruthy();
    expect(watch!.include).toEqual(["ip15"]);
    expect(watch!.exclude).toEqual(["cần mua"]);
    const notifierRows = await handle.db.select({ id: schema.notifier.id }).from(schema.notifier).where(eq(schema.notifier.userId, userId));
    expect(watch!.notifierIds).toEqual([notifierRows[0]!.id]);

    mock.pushUpdate({ message: { chat: { id: chatId }, text: "/watch list" } });
    offset = await pollOnce(deps, offset);
    const listReply = mock.callsFor("sendMessage").at(-1)!.body as { text: string };
    expect(listReply.text).toContain("ip15");

    mock.pushUpdate({ message: { chat: { id: chatId }, text: "/watch mute ip15 2h" } });
    offset = await pollOnce(deps, offset);
    const [mutedWatch] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, watch!.id)).limit(1);
    expect(mutedWatch?.mutedUntil).toBeTruthy();
    const deltaMs = mutedWatch!.mutedUntil!.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(1.9 * 3_600_000);
    expect(deltaMs).toBeLessThan(2.1 * 3_600_000);

    mock.pushUpdate({ message: { chat: { id: chatId }, text: "/status" } });
    offset = await pollOnce(deps, offset);
    const statusReply = mock.callsFor("sendMessage").at(-1)!.body as { text: string };
    expect(statusReply.text).toContain("Watches:");

    mock.pushUpdate({ message: { chat: { id: chatId }, text: "/watch del ip15" } });
    offset = await pollOnce(deps, offset);
    const delReply = mock.callsFor("sendMessage").at(-1)!.body as { text: string };
    expect(delReply.text).toContain("Deleted watch");
    const [deleted] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, watch!.id)).limit(1);
    expect(deleted).toBeUndefined();
  });

  // callback half: 
  test("m1 callback from the linked chat mutes the watch; from another chat is refused", async () => {
    const [notifierRow] = await handle.db.select().from(schema.notifier).where(eq(schema.notifier.userId, userId)).limit(1);
    const [watchForCallback] = await handle.db.insert(schema.watch).values({ userId, name: `cbw-${crypto.randomUUID()}`, include: ["x"], notifierIds: [notifierRow!.id], enabled: true }).returning();
    const [source] = await handle.db.insert(schema.source).values({ teamId, kind: "web", platformId: `bot-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" }).returning({ id: schema.source.id });
    const [post] = await handle.db.insert(schema.post).values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/x", title: "t" }).returning({ id: schema.post.id });
    const [notif] = await handle.db
      .insert(schema.notification)
      .values({ notifierId: notifierRow!.id, userId, channel: "telegram", status: "sent", payload: { postId: post!.id, userId, watchIds: [watchForCallback!.id], watchNames: [watchForCallback!.name] } })
      .returning();

    mock.pushUpdate({ callback_query: { id: "cb1", data: `m1:${notif!.id}`, message: { chat: { id: chatId }, message_id: 1 }, from: { id: chatId } } });
    offset = await pollOnce(deps, offset);
    expect(mock.callsFor("answerCallbackQuery")).toHaveLength(1);
    expect(mock.callsFor("editMessageReplyMarkup")).toHaveLength(1);
    const [muted] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, watchForCallback!.id)).limit(1);
    expect(muted?.mutedUntil).toBeTruthy();

    // From another chat: no change, "Not allowed" reply, no DB mutation.
    await handle.db.update(schema.watch).set({ mutedUntil: null }).where(eq(schema.watch.id, watchForCallback!.id));
    mock.calls.length = 0;
    mock.pushUpdate({ callback_query: { id: "cb2", data: `m1:${notif!.id}`, message: { chat: { id: 999_999_999 }, message_id: 1 }, from: { id: 999_999_999 } } });
    offset = await pollOnce(deps, offset);
    const cbReply = mock.callsFor("answerCallbackQuery").at(-1)!.body as { text: string };
    expect(cbReply.text).toContain("Not allowed");
    const [stillUnmuted] = await handle.db.select().from(schema.watch).where(eq(schema.watch.id, watchForCallback!.id)).limit(1);
    expect(stillUnmuted?.mutedUntil).toBeNull();

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, notif!.id));
    await handle.db.delete(schema.watch).where(eq(schema.watch.id, watchForCallback!.id));
    await handle.db.delete(schema.post).where(eq(schema.post.id, post!.id));
    await handle.db.delete(schema.source).where(eq(schema.source.id, source!.id));
  });

  // a garbage `m1:<not-a-uuid>` callback (stale button after a
  // deploy, or a tampered client) must be answered like any other invalid callback, not
  // let an invalid-uuid literal reach Postgres and throw (which `pollOnce`'s try/catch
  // would swallow, leaving the user's Telegram client spinning forever on that button).
  test("M1:<garbage> callback is answered 'Invalid', not thrown", async () => {
    mock.pushUpdate({ callback_query: { id: "cb-garbage", data: "m1:not-a-uuid", message: { chat: { id: chatId }, message_id: 1 }, from: { id: chatId } } });
    offset = await pollOnce(deps, offset);
    expect(mock.callsFor("answerCallbackQuery")).toHaveLength(1);
    const cbReply = mock.callsFor("answerCallbackQuery").at(-1)!.body as { text: string };
    expect(cbReply.text).toContain("Invalid");
    expect(mock.callsFor("editMessageReplyMarkup")).toHaveLength(0);
  });

  // `/watch add -r` must reuse the same regex validation
  // (`validateRegex` + `match.regexMaxLen`) as the API route, not store a raw pattern.
  test("/watch add -r rejects an unsafe regex the same way the API does", async () => {
    mock.pushUpdate({ message: { chat: { id: chatId }, text: '/watch add "bad-regex" -r "(a|a)+$"' } });
    offset = await pollOnce(deps, offset);
    const reply = mock.callsFor("sendMessage").at(-1)!.body as { text: string };
    expect(reply.text).toContain("Invalid regex");

    const [watch] = await handle.db.select().from(schema.watch).where(and(eq(schema.watch.userId, userId), eq(schema.watch.name, "bad-regex"))).limit(1);
    expect(watch).toBeUndefined();
  });

  // Timezone: mute/watch-list HH:MM must use `app.tz`
  // (Asia/Ho_Chi_Minh, UTC+7), not UTC.
  test("Mute reply shows Asia/Ho_Chi_Minh local time, not UTC", async () => {
    mock.pushUpdate({ message: { chat: { id: chatId }, text: '/watch add "tz-watch"' } });
    offset = await pollOnce(deps, offset);

    mock.pushUpdate({ message: { chat: { id: chatId }, text: "/watch mute tz-watch 1h" } });
    offset = await pollOnce(deps, offset);
    const reply = mock.callsFor("sendMessage").at(-1)!.body as { text: string };

    const [watch] = await handle.db.select().from(schema.watch).where(and(eq(schema.watch.userId, userId), eq(schema.watch.name, "tz-watch"))).limit(1);
    const expectedHHMM = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(watch!.mutedUntil!);
    expect(reply.text).toContain(expectedHHMM);

    await handle.db.delete(schema.watch).where(eq(schema.watch.id, watch!.id));
  });

  // Throttle: `/link` on an unlinked chat is rate-limited
  // per chat so the 8-char code space cannot be brute-forced.
  test("/link is throttled after repeated wrong-code attempts from the same chat", async () => {
    resetLinkThrottleForTest();
    const throttleChatId = Math.floor(Math.random() * 1_000_000_000);
    let lastReply = "";
    for (let i = 0; i < 6; i++) {
      mock.pushUpdate({ message: { chat: { id: throttleChatId }, text: "/link WRONGCOD" } });
      offset = await pollOnce(deps, offset);
      lastReply = (mock.callsFor("sendMessage").at(-1)!.body as { text: string }).text;
    }
    expect(lastReply).toContain("Too many attempts");
    resetLinkThrottleForTest();
  });

  // `/link`'s "no enabled notifier" marker clear (shared with `PATCH
  // /api/notifiers/:id`'s re-enable path via `clearNoEnabledNotifierMarkers`) must be
  // bounded by match age — linking a chat for a user with a weeks-old backlog of
  // unlinked matches must not flood-reenqueue every one of them.
  test("/link clears only recent 'no enabled notifier' markers, not weeks-old ones", async () => {
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `bot-link-src-${crypto.randomUUID()}`, name: "s", url: `https://feeds.example.test/bot-link-src-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    const [recentPost] = await handle.db.insert(schema.post).values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://x/link-recent", text: "t", textNormalized: "t" }).returning({ id: schema.post.id });
    const [oldPost] = await handle.db.insert(schema.post).values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://x/link-old", text: "t", textNormalized: "t" }).returning({ id: schema.post.id });
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `bot-link-watch-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [recentMatch] = await handle.db.insert(schema.match).values({ postId: recentPost!.id, watchId: watch!.id, score: 1, createdAt: new Date(Date.now() - 60 * 60 * 1000) }).returning({ id: schema.match.id });
    const [oldMatch] = await handle.db.insert(schema.match).values({ postId: oldPost!.id, watchId: watch!.id, score: 1, createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }).returning({ id: schema.match.id });
    const [recentMarker] = await handle.db
      .insert(schema.notification)
      .values({ matchId: recentMatch!.id, notifierId: null, userId, channel: "none", status: "suppressed", lastError: "no enabled notifier", payload: {} })
      .returning({ id: schema.notification.id });
    const [oldMarker] = await handle.db
      .insert(schema.notification)
      .values({ matchId: oldMatch!.id, notifierId: null, userId, channel: "none", status: "suppressed", lastError: "no enabled notifier", payload: {} })
      .returning({ id: schema.notification.id });

    // Reset the user back to unlinked with a fresh code, and remove the notifier created
    // by the earlier `/link` test, so `linkChat` inserts a fresh one.
    const linkCode = `LNK${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
    await handle.db.update(schema.user).set({ telegramChatId: null, linkCode, linkCodeExpiresAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.userId, userId));

    try {
      const result = await linkChat(handle, chatId, linkCode, new Date());
      expect(result.linked).toBe(true);

      const [recentAfter] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, recentMarker!.id));
      expect(recentAfter).toBeUndefined();
      const [oldAfter] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, oldMarker!.id));
      expect(oldAfter).toBeDefined();
    } finally {
      await handle.db.delete(schema.notification).where(eq(schema.notification.id, oldMarker!.id));
      await handle.db.delete(schema.match).where(eq(schema.match.id, recentMatch!.id));
      await handle.db.delete(schema.match).where(eq(schema.match.id, oldMatch!.id));
      await handle.db.delete(schema.watch).where(eq(schema.watch.id, watch!.id));
      await handle.db.delete(schema.post).where(eq(schema.post.id, recentPost!.id));
      await handle.db.delete(schema.post).where(eq(schema.post.id, oldPost!.id));
      await handle.db.delete(schema.source).where(eq(schema.source.id, source!.id));
    }
  });
  // /search is scoped to the linked user's team.
  test("/search only returns posts from the linked user's team", async () => {
    const tok = `zqx${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const [other] = await handle.db.insert(schema.team).values({ name: `bot-other-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    const mkSrc = async (t: string) =>
      (await handle.db.insert(schema.source).values({ teamId: t, kind: "web", platformId: `bot-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" }).returning({ id: schema.source.id }))[0]!.id;
    const own = await mkSrc(teamId);
    const foreign = await mkSrc(other!.id);
    const mkPost = async (sourceId: string, title: string) =>
      (await handle.db.insert(schema.post).values({ sourceId, platformPostId: crypto.randomUUID(), url: "https://example.com/p/x", title, text: `${title} ${tok}`, textNormalized: `${title} ${tok}` }).returning({ id: schema.post.id }))[0]!.id;
    const ownPost = await mkPost(own, "OWNPOST");
    const foreignPost = await mkPost(foreign, "FOREIGNPOST");
    try {
      mock.pushUpdate({ message: { chat: { id: chatId }, text: `/search ${tok}` } });
      offset = await pollOnce(deps, offset);
      const reply = mock.callsFor("sendMessage").at(-1)!.body as { text: string };
      expect(reply.text).toContain("OWNPOST");
      expect(reply.text).not.toContain("FOREIGNPOST");
    } finally {
      await handle.db.delete(schema.post).where(eq(schema.post.id, ownPost));
      await handle.db.delete(schema.post).where(eq(schema.post.id, foreignPost));
      await handle.db.delete(schema.source).where(eq(schema.source.id, own));
      await handle.db.delete(schema.source).where(eq(schema.source.id, foreign));
      await handle.db.delete(schema.team).where(eq(schema.team.id, other!.id));
    }
  });
});
