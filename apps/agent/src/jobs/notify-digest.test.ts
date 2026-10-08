import { createDb, schema, type DbHandle } from "@feedhound/db";
import { createTelegramNotifier } from "@feedhound/bot/notifiers";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";
import { RateLimiter } from "../lib/rate-limit";
import { runNotifyJob, type NotifierMap, type NotifyRunDeps } from "./notify";
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
    console.warn(`notify-digest.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("notify-digest.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("notify-digest.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("notify_digest job", () => {
  let handle: DbHandle;
  let mock: TelegramMock;
  let notifiers: NotifierMap;
  let teamId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    mock = new TelegramMock();
    notifiers = { telegram: createTelegramNotifier({ botToken: "test", apiBase: mock.baseUrl }) };
    const [team] = await handle.db.insert(schema.team).values({ name: `notify-digest-test-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
  });

  afterAll(async () => {
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
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
    await mock.close();
  });

  afterEach(async () => {
    mock.calls.length = 0;
    mock.resetScripts();
    // feedhound_test is shared. A test that overrides a config key and then fails
    // leaks the override to every later run, because fetchConfigValue reads
    // `order by version desc limit 1`. Clean up here, not at the end of a body.
    await handle.db.delete(schema.config).where(and(eq(schema.config.updatedBy, "test"), eq(schema.config.key, "notify.digest.maxEntries")));
  });

  function deps(now?: Date): NotifyRunDeps {
    return { handle, notifiers, rateLimiter: new RateLimiter({ perChatPerSec: 1000, perChatPerMin: 100_000, globalPerSec: 100_000 }), now };
  }

  test("5 matches over t=0..3min digest into one message at t=5min; nothing at t=4min", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const sourceId = source!.id;
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const notifierId = notifierRow!.id;
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierId], enabled: true }).returning();

    // 5 matches arrive at t=0,1,2,3min — one extra at t=3 to total 5.
    const t0 = new Date("2026-01-01T10:00:00Z");
    const arrivalMinutes = [0, 1, 2, 3, 3];
    const matchIds: string[] = [];
    for (let i = 0; i < arrivalMinutes.length; i++) {
      const [post] = await handle.db
        .insert(schema.post)
        .values({ sourceId, platformPostId: crypto.randomUUID(), url: `https://example.com/p/${i}`, title: `Post ${i}`, text: "iphone", textNormalized: "iphone" })
        .returning({ id: schema.post.id });
      const createdAt = new Date(t0.getTime() + arrivalMinutes[i]! * 60_000);
      const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: createdAt, createdAt }).returning();
      matchIds.push(match!.id);
      await runNotifyJob({ matchId: match!.id }, deps(createdAt));
    }

    const t4 = new Date(t0.getTime() + 4 * 60_000);
    const sentAt4 = await runNotifyDigestJob(deps(t4));
    expect(sentAt4).toBe(0);
    expect(mock.callsFor("sendMessage")).toHaveLength(0);

    // The t=0 row becomes due at t=5 (nextAttemptAt = createdAt + 5min); the digest flush rule flushes
    // the whole group (all 5 rows) together, not just the individually-due one.
    const t5 = new Date(t0.getTime() + 5 * 60_000);
    const sentAt5 = await runNotifyDigestJob(deps(t5));
    expect(sentAt5).toBe(5);
    expect(mock.callsFor("sendMessage")).toHaveLength(1);
    const body = mock.callsFor("sendMessage")[0]!.body as { text: string };
    expect(body.text).toContain("5 posts");

    const rows = await handle.db.select().from(schema.notification).where(inArray(schema.notification.matchId, matchIds));
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    const providerIds = new Set(rows.map((r) => r.providerMessageId));
    expect(providerIds.size).toBe(1);
  });

  // this job is the only production path that picks up `pending`
  // rows carrying a due `nextAttemptAt` (an instant-mode notifier's retry-backoff row).
  // A single-row group here must go through the full retry ladder, not get marked
  // `failed` on the very first failure.
  test("A due retry-backoff row (instant mode) retries via the ladder, not failed on first failure", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-retry-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "instant" }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();
    const [post] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/retry", title: "iPhone", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });

    const t0 = new Date("2026-02-01T10:00:00Z");
    const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();

    // Attempt 1 fails (500) -> pending, attempts=1, nextAttemptAt = t0 + 5s (default ladder).
    mock.script("sendMessage", { status: 500 });
    await runNotifyJob({ matchId: match!.id }, deps(t0));

    let [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match!.id)).limit(1);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    const dueAt = row!.nextAttemptAt!;
    expect(dueAt.getTime() - t0.getTime()).toBe(5_000);

    // The digest job (not `notify`) is what picks this row up in production once it is due.
    mock.script("sendMessage", { status: 500 });
    const sent = await runNotifyDigestJob(deps(dueAt));
    expect(sent).toBe(0);

    [row] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, match!.id)).limit(1);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(2);
    expect(row!.nextAttemptAt!.getTime() - dueAt.getTime()).toBe(30_000);

    // Test isolation: this row is left `pending` with a `nextAttemptAt` far in the past
    // relative to later tests' fake `now` — `runNotifyDigestJob` scans across the whole
    // table, so an un-cleaned row here would leak into a later test's due-group scan.
    await handle.db.delete(schema.notification).where(eq(schema.notification.matchId, match!.id));
  });

  // a multi-row digest group that hits a transient (retryable) failure must
  // go through the retry ladder — not lose every claimed row to `failed` on the first 5xx.
  test("a multi-row digest group retries a retryable failure via the ladder instead of failing outright", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-fail-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();

    const t0 = new Date("2026-03-01T10:00:00Z");
    const matchIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [post] = await handle.db
        .insert(schema.post)
        .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: `https://example.com/p/fail-${i}`, title: `Post ${i}`, text: "iphone", textNormalized: "iphone" })
        .returning({ id: schema.post.id });
      const createdAt = new Date(t0.getTime() + i * 60_000);
      const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: createdAt, createdAt }).returning();
      matchIds.push(match!.id);
      await runNotifyJob({ matchId: match!.id }, deps(createdAt));
    }

    const t5 = new Date(t0.getTime() + 5 * 60_000);
    mock.script("sendMessage", { status: 500 });
    const sent = await runNotifyDigestJob(deps(t5));
    expect(sent).toBe(0);
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    const rows = await handle.db.select().from(schema.notification).where(inArray(schema.notification.matchId, matchIds));
    // Both rows are retried (ladder), not lost to `failed`.
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    expect(rows.every((r) => r.nextAttemptAt!.getTime() - t5.getTime() === 5_000)).toBe(true);

    // Retry succeeds -> both rows sent with the same providerMessageId, exactly one more call.
    mock.calls.length = 0;
    mock.resetScripts();
    mock.script("sendMessage", { status: 200 });
    const t5plus5s = new Date(t5.getTime() + 5_000);
    const sentRetry = await runNotifyDigestJob(deps(t5plus5s));
    expect(sentRetry).toBe(2);
    expect(mock.callsFor("sendMessage")).toHaveLength(1);
    const afterRows = await handle.db.select().from(schema.notification).where(inArray(schema.notification.matchId, matchIds));
    expect(afterRows.every((r) => r.status === "sent")).toBe(true);
    const providerIds = new Set(afterRows.map((r) => r.providerMessageId));
    expect(providerIds.size).toBe(1);
  });

  // a chunked digest send (overflow -> multiple messages) that fails
  // partway through must have already finalized (marked `sent`) the rows in the
  // successfully-delivered chunk *before* the failing chunk is even attempted — a retry then
  // only re-processes the still-pending rows, never resending an already-delivered chunk.
  test("a partially-sent chunked digest finalizes the delivered chunk before the failing one, and the retry only re-sends the un-sent rows", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-chunk-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();

    // digestMaxEntries=1 forces one chunk per entry -> 2 matches = 2 chunks.
    const existingMaxEntriesVersions = await handle.db
      .select({ version: schema.config.version })
      .from(schema.config)
      .where(eq(schema.config.key, "notify.digest.maxEntries"))
      .orderBy(desc(schema.config.version))
      .limit(1);
    const maxEntriesVersion = (existingMaxEntriesVersions[0]?.version ?? 0) + 1;
    await handle.db.insert(schema.config).values({ key: "notify.digest.maxEntries", version: maxEntriesVersion, value: 1, updatedBy: "test" });

    const t0 = new Date("2026-03-02T10:00:00Z");
    const matchIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [post] = await handle.db
        .insert(schema.post)
        .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: `https://example.com/p/chunk-${i}`, title: `Post ${i}`, text: "iphone", textNormalized: "iphone" })
        .returning({ id: schema.post.id });
      const createdAt = new Date(t0.getTime() + i * 60_000);
      const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: createdAt, createdAt }).returning();
      matchIds.push(match!.id);
      await runNotifyJob({ matchId: match!.id }, deps(createdAt));
    }

    const t5 = new Date(t0.getTime() + 5 * 60_000);
    // Chunk 1/2 succeeds, chunk 2/2 fails (500, retryable).
    mock.script("sendMessage", { status: 200 });
    mock.script("sendMessage", { status: 500 });
    const sent = await runNotifyDigestJob(deps(t5));
    // Chunk 1's row is already finalized `sent` in this same run (persisted
    // before chunk 2 was even attempted) — only chunk 2's row is left pending/retrying.
    expect(sent).toBe(1);
    expect(mock.callsFor("sendMessage")).toHaveLength(2);

    const rows = await handle.db.select().from(schema.notification).where(inArray(schema.notification.matchId, matchIds));
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
    const pendingRow = rows.find((r) => r.status === "pending");
    expect(pendingRow?.attempts).toBe(1);
    expect(pendingRow!.nextAttemptAt!.getTime() - t5.getTime()).toBe(5_000);

    // Retry: only the still-pending row is sent — the already-`sent` row is never resent.
    mock.calls.length = 0;
    mock.resetScripts();
    mock.script("sendMessage", { status: 200 });
    const t5plus5s = new Date(t5.getTime() + 5_000);
    const sentRetry = await runNotifyDigestJob(deps(t5plus5s));
    expect(sentRetry).toBe(1);
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    const afterRows = await handle.db.select().from(schema.notification).where(inArray(schema.notification.matchId, matchIds));
    expect(afterRows.every((r) => r.status === "sent")).toBe(true);

  });

  // A solo row (quiet-hours release / retry-backoff — no `digestBatch`
  // flag) sharing the same (notifierId, primary watchId) group key as a due digest batch
  // must never be swept into that batch's flush just because the batch's min is due.
  test("A solo row with a far-future nextAttemptAt is not swept by a due batch in the same group", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-f5-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();

    const t0 = new Date("2026-04-01T10:00:00Z");
    const [postDue] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/f5-due", title: "Due", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchDue] = await handle.db.insert(schema.match).values({ postId: postDue!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();
    await runNotifyJob({ matchId: matchDue!.id }, deps(t0)); // digestBatch row due at t0+5min

    // Craft a solo row (as a quiet-hours release would leave one — no `digestBatch` flag)
    // sharing the same group key, but not due until far in the future.
    const [postFuture] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/f5-future", title: "Future", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchFuture] = await handle.db.insert(schema.match).values({ postId: postFuture!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();
    const farFuture = new Date(t0.getTime() + 24 * 3_600_000);
    await handle.db.insert(schema.notification).values({
      matchId: matchFuture!.id,
      notifierId: notifierRow!.id,
      userId,
      channel: "telegram",
      status: "pending",
      nextAttemptAt: farFuture,
      payload: { postId: postFuture!.id, userId, watchIds: [watch!.id], watchNames: [watch!.name] },
    });

    const t5 = new Date(t0.getTime() + 5 * 60_000);
    mock.script("sendMessage", { status: 200 });
    const sent = await runNotifyDigestJob(deps(t5));
    expect(sent).toBe(1); // only the due batch row
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    const [dueRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchDue!.id)).limit(1);
    expect(dueRow?.status).toBe("sent");
    const [futureRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchFuture!.id)).limit(1);
    expect(futureRow?.status).toBe("pending"); // untouched, never swept into the batch flush
    expect(futureRow?.nextAttemptAt?.getTime()).toBe(farFuture.getTime());

    await handle.db.delete(schema.notification).where(eq(schema.notification.matchId, matchFuture!.id));
  });

  // A quiet-hours release row now also carries
  // `payload.digestBatch = true` (so multiple quiet-hours releases at the
  // same time batch together) — but that means a genuinely-not-yet-due quiet row can share
  // a group with an already-due digest-accumulation batch for the same watch, and
  // `sendBatchGroup` must not flush the whole group just because the group's overall trigger
  // fired; only rows individually due are claimed and sent.
  test("A not-yet-due quiet-hours row (digestBatch=true) is not sent early alongside a due digest batch in the same group", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-r2f1-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();

    const t0 = new Date("2026-05-01T21:58:00Z");
    const [postDue] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/r2f1-due", title: "Due", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchDue] = await handle.db.insert(schema.match).values({ postId: postDue!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();
    await runNotifyJob({ matchId: matchDue!.id }, deps(t0)); // digestBatch row due at t0+5min = 22:03

    // Quiet-hours release row (22:05 arrival, quietHours end 07:00): carries
    // `digestBatch: true` but is not due for another ~9 h.
    const [postQuiet] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/r2f1-quiet", title: "Quiet", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchQuiet] = await handle.db.insert(schema.match).values({ postId: postQuiet!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();
    const quietUntil = new Date("2026-05-02T07:00:00Z");
    await handle.db.insert(schema.notification).values({
      matchId: matchQuiet!.id,
      notifierId: notifierRow!.id,
      userId,
      channel: "telegram",
      status: "pending",
      nextAttemptAt: quietUntil,
      payload: { postId: postQuiet!.id, userId, watchIds: [watch!.id], watchNames: [watch!.name], digestBatch: true, digestBatchKind: "quiet" },
    });

    const t5 = new Date(t0.getTime() + 5 * 60_000); // 22:03
    mock.script("sendMessage", { status: 200 });
    const sent = await runNotifyDigestJob(deps(t5));
    expect(sent).toBe(1); // only the due row
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    const [dueRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchDue!.id)).limit(1);
    expect(dueRow?.status).toBe("sent");
    const [quietRow] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchQuiet!.id)).limit(1);
    expect(quietRow?.status).toBe("pending"); // not sent inside quiet hours
    expect(quietRow?.nextAttemptAt?.getTime()).toBe(quietUntil.getTime());

    // At quietUntil, the (now on its own) quiet row is flushed.
    mock.calls.length = 0;
    mock.resetScripts();
    mock.script("sendMessage", { status: 200 });
    const sentAtQuietEnd = await runNotifyDigestJob(deps(quietUntil));
    expect(sentAtQuietEnd).toBe(1);
    const [quietRowAfter] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchQuiet!.id)).limit(1);
    expect(quietRowAfter?.status).toBe("sent");
  });

  // a row joining the group (freshly inserted, sorting earliest by
  // `nextAttemptAt`) while the rest of the group is in retry backoff must be included in the
  // next flush like any other due row — never skipped nor incorrectly marked `sent` without
  // actually being sent.
  test("a row joining the group during a retry backoff is sent correctly, not skipped or falsely marked sent", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-f1b-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();

    const t0 = new Date("2026-04-02T10:00:00Z");
    const matchIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [post] = await handle.db
        .insert(schema.post)
        .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: `https://example.com/p/f1b-${i}`, title: `Post ${i}`, text: "iphone", textNormalized: "iphone" })
        .returning({ id: schema.post.id });
      const createdAt = new Date(t0.getTime() + i * 60_000);
      const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: createdAt, createdAt }).returning();
      matchIds.push(match!.id);
      await runNotifyJob({ matchId: match!.id }, deps(createdAt));
    }

    // Both due at t0+5min/+6min; flush at t=6min fails (500) -> both pending, attempts=1,
    // nextAttemptAt = t6 + 5s.
    const t6 = new Date(t0.getTime() + 6 * 60_000);
    mock.script("sendMessage", { status: 500 });
    const firstAttempt = await runNotifyDigestJob(deps(t6));
    expect(firstAttempt).toBe(0);

    // A third match "joins" the group before the retry fires, sorting to the front
    // (earliest `nextAttemptAt`) of the group when the retry runs.
    const [postJoin] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/f1b-join", title: "Join", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchJoin] = await handle.db.insert(schema.match).values({ postId: postJoin!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t6, createdAt: t6 }).returning();
    matchIds.push(matchJoin!.id);
    await handle.db.insert(schema.notification).values({
      matchId: matchJoin!.id,
      notifierId: notifierRow!.id,
      userId,
      channel: "telegram",
      status: "pending",
      nextAttemptAt: new Date(t6.getTime() + 2_000), // earlier than the two retrying rows (+5s)
      payload: { postId: postJoin!.id, userId, watchIds: [watch!.id], watchNames: [watch!.name], digestBatch: true },
    });

    mock.calls.length = 0;
    mock.resetScripts();
    mock.script("sendMessage", { status: 200 });
    const t6plus5s = new Date(t6.getTime() + 5_000);
    const retrySent = await runNotifyDigestJob(deps(t6plus5s));
    // All three rows (the two retrying + the newly-joined one) are genuinely sent together.
    expect(retrySent).toBe(3);
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    const rows = await handle.db.select().from(schema.notification).where(inArray(schema.notification.matchId, matchIds));
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    const providerIds = new Set(rows.map((r) => r.providerMessageId));
    expect(providerIds.size).toBe(1);
  });

  // `nextAttemptAt` only equals `Match.createdAt + digestEveryMin` for a
  // fresh row -- a `dueRetried` row's `nextAttemptAt` is backoff-derived and can sort
  // earlier than a later-arrived sibling's, even though its match is genuinely the newest.
  // The digest must still list entries by `Match.createdAt` ("entries sorted by
  // Match.createdAt"), not by whichever `nextAttemptAt` a retry happened to leave behind.
  test("Digest entries are ordered by Match.createdAt, not by a retried row's backoff-derived nextAttemptAt", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-r5-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();

    const t0 = new Date("2026-05-02T10:00:00Z");
    const matchIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [post] = await handle.db
        .insert(schema.post)
        .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: `https://example.com/p/r5-${i}`, title: `Early ${i}`, text: "iphone", textNormalized: "iphone" })
        .returning({ id: schema.post.id });
      const createdAt = new Date(t0.getTime() + i * 60_000);
      const [match] = await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: createdAt, createdAt }).returning();
      matchIds.push(match!.id);
      await runNotifyJob({ matchId: match!.id }, deps(createdAt));
    }

    // Both due at t0+5min/+6min; flush at t=6min fails (500) -> both pending, attempts=1,
    // nextAttemptAt = t6 + 5s (backoff).
    const t6 = new Date(t0.getTime() + 6 * 60_000);
    mock.script("sendMessage", { status: 500 });
    const firstAttempt = await runNotifyDigestJob(deps(t6));
    expect(firstAttempt).toBe(0);

    // The newest match arrives after the failed flush, with its own `nextAttemptAt` due
    // *sooner* than the two backoff-retrying rows above (2s vs. 5s) -- sorting by
    // `nextAttemptAt` alone would put this newest post FIRST; sorting by `Match.createdAt`
    // must put it LAST.
    const [postLate] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/r5-late", title: "Latest", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchLate] = await handle.db.insert(schema.match).values({ postId: postLate!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t6, createdAt: t6 }).returning();
    matchIds.push(matchLate!.id);
    await handle.db.insert(schema.notification).values({
      matchId: matchLate!.id,
      notifierId: notifierRow!.id,
      userId,
      channel: "telegram",
      status: "pending",
      nextAttemptAt: new Date(t6.getTime() + 2_000),
      payload: { postId: postLate!.id, userId, watchIds: [watch!.id], watchNames: [watch!.name], digestBatch: true },
    });

    mock.calls.length = 0;
    mock.resetScripts();
    mock.script("sendMessage", { status: 200 });
    const t6plus5s = new Date(t6.getTime() + 5_000);
    const retrySent = await runNotifyDigestJob(deps(t6plus5s));
    expect(retrySent).toBe(3);
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    const body = mock.callsFor("sendMessage")[0]!.body as { text: string };
    const idxEarly0 = body.text.indexOf("Early 0");
    const idxEarly1 = body.text.indexOf("Early 1");
    const idxLatest = body.text.indexOf("Latest");
    expect(idxEarly0).toBeGreaterThan(-1);
    expect(idxEarly1).toBeGreaterThan(-1);
    expect(idxLatest).toBeGreaterThan(-1);
    expect(idxEarly0).toBeLessThan(idxEarly1);
    expect(idxEarly1).toBeLessThan(idxLatest);
  });

  // The retryable-failure path resets a failed row's `nextAttemptAt` to a short
  // backoff without clearing `digestBatch`/`digestBatchKind`, so it stays in the same
  // (notifierId, watch) cluster. A brand-new match arriving with its own, much later
  // `nextAttemptAt` (a fresh accumulation window, not part of the failed batch) must not be
  // swept into the flush just because the backed-off row's near-future retry makes the
  // cluster's naive `min(nextAttemptAt)` due.
  test("A fresh row with a far-future nextAttemptAt is not flushed early by a sibling's retry backoff", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-r3-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();

    const t0 = new Date("2026-04-04T10:00:00Z");
    const [postA] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/r3-a", title: "A", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchA] = await handle.db.insert(schema.match).values({ postId: postA!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();
    await runNotifyJob({ matchId: matchA!.id }, deps(t0)); // due at t0+5min

    // A's flush at t0+5min fails (500) -> pending, attempts=1, nextAttemptAt = t5 + 5s.
    const t5 = new Date(t0.getTime() + 5 * 60_000);
    mock.script("sendMessage", { status: 500 });
    const firstAttempt = await runNotifyDigestJob(deps(t5));
    expect(firstAttempt).toBe(0);

    // A brand-new match B arrives just after A's failed attempt — a fresh accumulation
    // window of its own, due only at its own createdAt + 5min (t5 + 1s + 5min), far later
    // than A's ~5s retry backoff.
    const tB = new Date(t5.getTime() + 1_000);
    const [postB] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/r3-b", title: "B", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchB] = await handle.db.insert(schema.match).values({ postId: postB!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: tB, createdAt: tB }).returning();
    await runNotifyJob({ matchId: matchB!.id }, deps(tB));

    // A's retry becomes due at t5+5s — B is nowhere near its own +5min due time.
    mock.calls.length = 0;
    mock.resetScripts();
    mock.script("sendMessage", { status: 200 });
    const t5plus5s = new Date(t5.getTime() + 5_000);
    const retrySent = await runNotifyDigestJob(deps(t5plus5s));
    expect(retrySent).toBe(1); // only A, never B
    expect(mock.callsFor("sendMessage")).toHaveLength(1);

    const [rowA] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchA!.id)).limit(1);
    expect(rowA?.status).toBe("sent");
    const [rowB] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchB!.id)).limit(1);
    expect(rowB?.status).toBe("pending"); // untouched, not swept into A's retry flush
    expect(rowB?.nextAttemptAt?.getTime()).toBe(new Date(tB.getTime() + 5 * 60_000).getTime());
  });

  // Tier 1 (fresh rows decide the cluster is due) previously flushed *every*
  // row in the cluster, including a sibling still in retry backoff whose own
  // `nextAttemptAt` was not yet due — sweeping it in and incrementing its `attempts`
  // off-ladder. A retried row not yet due must be left alone even when a fresh sibling in
  // the same cluster is due right now.
  test("A not-yet-due retry-backoff row is not swept in by a due fresh sibling", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-r4med-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const [notifierRow] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: Math.floor(Math.random() * 1_000_000_000), mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `w-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [notifierRow!.id], enabled: true }).returning();

    const t0 = new Date("2026-04-05T10:00:00Z");
    const [postA] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/r4med-a", title: "A", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchA] = await handle.db.insert(schema.match).values({ postId: postA!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();
    await runNotifyJob({ matchId: matchA!.id }, deps(t0)); // due at t0+5min

    // A's flush at t0+5min fails (500) -> pending, attempts=1, nextAttemptAt = t5 + 5s
    // (delaysSec[0]).
    const t5 = new Date(t0.getTime() + 5 * 60_000);
    mock.script("sendMessage", { status: 500 });
    const firstAttempt = await runNotifyDigestJob(deps(t5));
    expect(firstAttempt).toBe(0);
    const [rowAAfterFail] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchA!.id)).limit(1);
    expect(rowAAfterFail?.attempts).toBe(1);
    const aRetryDueAt = rowAAfterFail!.nextAttemptAt!;

    // A fresh sibling B arrives 1s later, due immediately (own accumulation window already
    // elapsed) — well before A's retry backoff (t5+5s) is due.
    const tB = new Date(t5.getTime() + 1_000);
    const [postB] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/r4med-b", title: "B", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [matchB] = await handle.db.insert(schema.match).values({ postId: postB!.id, watchId: watch!.id, score: 1, notifyEnqueuedAt: tB, createdAt: tB }).returning();
    await handle.db.insert(schema.notification).values({
      matchId: matchB!.id,
      notifierId: notifierRow!.id,
      userId,
      channel: "telegram",
      status: "pending",
      nextAttemptAt: tB, // due right now
      payload: { postId: postB!.id, userId, watchIds: [watch!.id], watchNames: [watch!.name], digestBatch: true },
    });

    expect(aRetryDueAt.getTime()).toBeGreaterThan(tB.getTime()); // A is not yet due at tB

    mock.calls.length = 0;
    mock.resetScripts();
    mock.script("sendMessage", { status: 200 });
    const sentAtTB = await runNotifyDigestJob(deps(tB));
    expect(sentAtTB).toBe(1); // only B, A stays in backoff untouched

    const [rowAAfterTB] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchA!.id)).limit(1);
    expect(rowAAfterTB?.status).toBe("pending");
    expect(rowAAfterTB?.attempts).toBe(1); // unchanged — not swept off-ladder
    expect(rowAAfterTB?.nextAttemptAt?.getTime()).toBe(aRetryDueAt.getTime());

    const [rowBAfterTB] = await handle.db.select().from(schema.notification).where(eq(schema.notification.matchId, matchB!.id)).limit(1);
    expect(rowBAfterTB?.status).toBe("sent");
  });

  // `runNotifyJob` (instant) and `runNotifyDigestJob` (digest), given the
  // *same* `RateLimiter` instance (as `apps/agent/src/index.ts` now wires both to), serialize
  // sends to the same chat to <=1/s even when interleaved — the bug was two independent
  // limiter instances each separately enforcing 1/s, allowing up to 2/s combined.
  test("A shared RateLimiter serializes interleaved instant + digest sends to the same chat", async () => {
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `u-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const userId = user!.id;
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `digest-f2-${crypto.randomUUID()}`, name: "g", url: "https://example.com/g" })
      .returning({ id: schema.source.id });
    const sharedChatId = Math.floor(Math.random() * 1_000_000_000);
    const [instantNotifier] = await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: { chatId: sharedChatId, mode: "instant" }, enabled: true }).returning();
    const [digestNotifier] = await handle.db
      .insert(schema.notifier)
      .values({ userId, kind: "telegram", config: { chatId: sharedChatId, mode: "digest", digestEveryMin: 5 }, enabled: true })
      .returning();
    const [watch1] = await handle.db.insert(schema.watch).values({ userId, name: `w1-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [instantNotifier!.id], enabled: true }).returning();
    const [watch2] = await handle.db.insert(schema.watch).values({ userId, name: `w2-${crypto.randomUUID()}`, include: ["iphone"], notifierIds: [digestNotifier!.id], enabled: true }).returning();

    mock.script("sendMessage", { status: 200 });
    mock.script("sendMessage", { status: 200 });
    mock.script("sendMessage", { status: 200 });
    mock.script("sendMessage", { status: 200 });

    const t0 = new Date("2026-04-03T10:00:00Z");
    const [digestPost] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://example.com/p/f2-digest", title: "Digest", text: "iphone", textNormalized: "iphone" })
      .returning({ id: schema.post.id });
    const [digestMatch] = await handle.db.insert(schema.match).values({ postId: digestPost!.id, watchId: watch2!.id, score: 1, notifyEnqueuedAt: t0, createdAt: t0 }).returning();

    const instantMatches = [];
    for (let i = 0; i < 3; i++) {
      const [post] = await handle.db
        .insert(schema.post)
        .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: `https://example.com/p/f2-instant-${i}`, title: `Instant ${i}`, text: "iphone", textNormalized: "iphone" })
        .returning({ id: schema.post.id });
      instantMatches.push(await handle.db.insert(schema.match).values({ postId: post!.id, watchId: watch1!.id, score: 1, notifyEnqueuedAt: t0 }).returning().then((r) => r[0]!));
    }

    let virtualNow = 0;
    const sendTimestamps: number[] = [];
    const limiter = new RateLimiter({
      perChatPerSec: 1,
      perChatPerMin: 1_000,
      globalPerSec: 1_000,
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

    // Set up the digest row's nextAttemptAt first (no send).
    await runNotifyJob({ matchId: digestMatch!.id }, { handle, notifiers: wrappedNotifiers, rateLimiter: limiter, now: t0 });

    const dueAt = new Date(t0.getTime() + 5 * 60_000);
    // Interleave: 3 instant sends and one due digest tick, all against the same chat, using
    // the *same* limiter instance — this is exactly what a shared instance in `index.ts` must
    // guarantee under concurrent job execution.
    await Promise.all([
      ...instantMatches.map((m) => runNotifyJob({ matchId: m.id }, { handle, notifiers: wrappedNotifiers, rateLimiter: limiter, now: dueAt })),
      runNotifyDigestJob({ handle, notifiers: wrappedNotifiers, rateLimiter: limiter, now: dueAt }),
    ]);

    expect(sendTimestamps).toHaveLength(4);
    const secondBuckets = new Map<number, number>();
    for (const t of sendTimestamps) {
      const bucket = Math.floor(t / 1_000);
      secondBuckets.set(bucket, (secondBuckets.get(bucket) ?? 0) + 1);
    }
    for (const count of secondBuckets.values()) expect(count).toBeLessThanOrEqual(1);
  });
});
