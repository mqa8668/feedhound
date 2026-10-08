import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createApp } from "../index";

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

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

describe.skipIf(!canRun)("notifications routes", () => {
  let handle: DbHandle;
  let teamId: string;
  let hunterId: string;
  let operatorId: string;
  let hunterKey: string;
  let operatorKey: string;
  let sentNotificationId: string;
  let failedNotificationId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);

    const [team] = await handle.db.insert(schema.team).values({ name: `notifications-test-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;

    const [hunter] = await handle.db.insert(schema.user).values({ teamId, email: `notif-h-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    hunterId = hunter!.id;
    const [operator] = await handle.db.insert(schema.user).values({ teamId, email: `notif-o-${crypto.randomUUID()}@example.com`, role: "operator" }).returning({ id: schema.user.id });
    operatorId = operator!.id;

    hunterKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: hunterId,
      name: "h",
      prefix: hunterKey.slice(0, 8),
      hash: await sha256Hex(hunterKey),
      scopes: ["notifications:read", "notifications:write"],
    });
    operatorKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: operatorId,
      name: "o",
      prefix: operatorKey.slice(0, 8),
      hash: await sha256Hex(operatorKey),
      scopes: ["notifications:read", "notifications:write"],
    });

    const [sent] = await handle.db.insert(schema.notification).values({ userId: hunterId, channel: "telegram", status: "sent", sentAt: new Date() }).returning({ id: schema.notification.id });
    sentNotificationId = sent!.id;
    const [failed] = await handle.db.insert(schema.notification).values({ userId: hunterId, channel: "telegram", status: "failed", attempts: 5, lastError: "boom" }).returning({ id: schema.notification.id });
    failedNotificationId = failed!.id;
    await handle.db.insert(schema.notification).values({ userId: operatorId, channel: "ops", status: "sent", sentAt: new Date() });
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, hunterId));
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, operatorId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, hunterId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, operatorId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, hunterId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, operatorId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("hunter sees only their own rows; operator sees all", async () => {
    const app = createApp(handle);

    const hunterRes = await app.request("/api/notifications", { headers: { Authorization: `Bearer ${hunterKey}` } });
    expect(hunterRes.status).toBe(200);
    const hunterBody = (await hunterRes.json()) as { notifications: { userId: string }[] };
    expect(hunterBody.notifications.length).toBeGreaterThanOrEqual(2);
    expect(hunterBody.notifications.every((n) => n.userId === hunterId)).toBe(true);

    const operatorRes = await app.request("/api/notifications", { headers: { Authorization: `Bearer ${operatorKey}` } });
    expect(operatorRes.status).toBe(200);
    const operatorBody = (await operatorRes.json()) as { notifications: { userId: string }[] };
    const userIds = new Set(operatorBody.notifications.map((n) => n.userId));
    expect(userIds.has(hunterId)).toBe(true);
    expect(userIds.has(operatorId)).toBe(true);
  });

  // An unrecognized `status`/`channel` filter is a 422 validation error (zod
  // enum), not a query that silently matches nothing; a malformed `:id` is a 404, not a
  // 500 from an invalid-uuid literal reaching Postgres.
  test("Invalid status/channel query -> 422; malformed :id -> 404 (not 500)", async () => {
    const app = createApp(handle);

    const badStatus = await app.request("/api/notifications?status=bogus", { headers: { Authorization: `Bearer ${hunterKey}` } });
    expect(badStatus.status).toBe(422);

    const badChannel = await app.request("/api/notifications?channel=bogus", { headers: { Authorization: `Bearer ${hunterKey}` } });
    expect(badChannel.status).toBe(422);

    const badGetId = await app.request("/api/notifications/not-a-uuid", { headers: { Authorization: `Bearer ${hunterKey}` } });
    expect(badGetId.status).toBe(404);

    const badRetryId = await app.request("/api/notifications/not-a-uuid/retry", { method: "POST", headers: { Authorization: `Bearer ${operatorKey}` } });
    expect(badRetryId.status).toBe(404);
  });

  test("POST /:id/retry: operator on a failed row -> pending, attempts=0; on a sent row -> 409; hunter -> 403", async () => {
    const app = createApp(handle);

    const forbidden = await app.request(`/api/notifications/${failedNotificationId}/retry`, { method: "POST", headers: { Authorization: `Bearer ${hunterKey}` } });
    expect(forbidden.status).toBe(403);

    const conflict = await app.request(`/api/notifications/${sentNotificationId}/retry`, { method: "POST", headers: { Authorization: `Bearer ${operatorKey}` } });
    expect(conflict.status).toBe(409);

    const ok = await app.request(`/api/notifications/${failedNotificationId}/retry`, { method: "POST", headers: { Authorization: `Bearer ${operatorKey}` } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { status: string; attempts: number };
    expect(body.status).toBe("pending");
    expect(body.attempts).toBe(0);
  });

  // Retry must also clear `failedAt` — otherwise a retried-then-sent row
  // is counted as both a failure and a success by `/status`'s `failedAt >= since OR sentAt
  // >= since`.
  test("Retry clears failedAt", async () => {
    const [row] = await handle.db
      .insert(schema.notification)
      .values({ userId: hunterId, channel: "telegram", status: "failed", attempts: 3, lastError: "boom", failedAt: new Date() })
      .returning({ id: schema.notification.id });

    const app = createApp(handle);
    const res = await app.request(`/api/notifications/${row!.id}/retry`, { method: "POST", headers: { Authorization: `Bearer ${operatorKey}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { failedAt: string | null };
    expect(body.failedAt).toBeNull();

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, row!.id));
  });

  // `channel=none` (marker rows) was missing from the enum and 422'd
  // even though the list endpoint otherwise returns those rows.
  test("channel=none is a valid filter, not a 422", async () => {
    const [marker] = await handle.db
      .insert(schema.notification)
      .values({ userId: hunterId, channel: "none", status: "suppressed", lastError: "watch disabled" })
      .returning({ id: schema.notification.id });

    const app = createApp(handle);
    const res = await app.request("/api/notifications?channel=none", { headers: { Authorization: `Bearer ${hunterKey}` } });
    expect(res.status).toBe(200);
    const listBody = (await res.json()) as { notifications: { id: string }[] };
    expect(listBody.notifications.some((n) => n.id === marker!.id)).toBe(true);

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, marker!.id));
  });

  // `coalesce(sentAt, failedAt, sendingAt) desc nulls last` sorted every
  // never-touched `pending` row after all terminal rows; with more history than `limit`, a
  // just-queued notification became unreachable. Active rows must always surface.
  test("A pending row is not pushed off the page by older sent-row history", async () => {
    // One batched insert/delete: 55 sequential round trips to a remote test DB exceeded the 5 s test timeout.
    const oldSent = await handle.db
      .insert(schema.notification)
      .values(Array.from({ length: 55 }, (_, i) => ({ userId: hunterId, channel: "telegram" as const, status: "sent" as const, sentAt: new Date(Date.now() - (i + 1) * 60_000) })))
      .returning({ id: schema.notification.id });
    const oldSentIds = oldSent.map((r) => r.id);
    const [pending] = await handle.db.insert(schema.notification).values({ userId: hunterId, channel: "telegram", status: "pending" }).returning({ id: schema.notification.id });

    const app = createApp(handle);
    const res = await app.request("/api/notifications?limit=50", { headers: { Authorization: `Bearer ${hunterKey}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: { id: string }[] };
    expect(body.notifications.some((n) => n.id === pending!.id)).toBe(true);

    await handle.db.delete(schema.notification).where(and(eq(schema.notification.userId, hunterId), eq(schema.notification.id, pending!.id)));
    await handle.db.delete(schema.notification).where(inArray(schema.notification.id, oldSentIds));
  });

  // The pending/terminal "bucket swap" made the `sent`/`failed` bucket
  // unreachable once the pending bucket alone exceeded `limit`, and had no `id` tiebreak
  // (nondeterministic order among rows sharing a sort key). A single `createdAt desc, id
  // desc` total order plus real (`nextCursor`) pagination must reach every row exactly
  // once, in a stable order, across as many pages as needed.
  test("Deterministic order + real pagination reaches every row exactly once, even with >limit pending rows", async () => {
    const pendingIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [row] = await handle.db.insert(schema.notification).values({ userId: hunterId, channel: "telegram", status: "pending" }).returning({ id: schema.notification.id });
      pendingIds.push(row!.id);
    }

    const app = createApp(handle);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = cursor ? `/api/notifications?limit=2&cursor=${encodeURIComponent(cursor)}` : "/api/notifications?limit=2";
      const res = await app.request(url, { headers: { Authorization: `Bearer ${hunterKey}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { notifications: { id: string }[]; nextCursor: string | null };
      expect(body.notifications.length).toBeLessThanOrEqual(2);
      seen.push(...body.notifications.map((n) => n.id));
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }

    // Every hunter-owned row (the 5 new pending rows + the sent/failed rows from earlier
    // tests still owned by hunterId) is reached exactly once — no duplicates, none skipped.
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of pendingIds) expect(seen).toContain(id);
    expect(seen).toContain(sentNotificationId);
    expect(seen).toContain(failedNotificationId);

    for (const id of pendingIds) await handle.db.delete(schema.notification).where(eq(schema.notification.id, id));
  });

  // Rows sharing one millisecond (µs apart) must not be skipped by the cursor.
  test("Paging across rows within one millisecond returns each exactly once; bad cursor 422; old ms cursor 200", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const sub = `2099-01-01T00:00:00.123${i}00Z`; // .123100 .. .123500: one millisecond, µs apart
      const [row] = await handle.db
        .insert(schema.notification)
        .values({ userId: hunterId, channel: "telegram", status: "pending", createdAt: sql`${sub}::timestamptz` })
        .returning({ id: schema.notification.id });
      ids.push(row!.id);
    }
    try {
      const app = createApp(handle);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20 && seen.length < 5; page++) {
        const url = cursor ? `/api/notifications?limit=2&cursor=${encodeURIComponent(cursor)}` : "/api/notifications?limit=2";
        const res = await app.request(url, { headers: { Authorization: `Bearer ${hunterKey}` } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { notifications: { id: string }[]; nextCursor: string | null };
        seen.push(...body.notifications.map((n) => n.id));
        if (!body.nextCursor) break;
        cursor = body.nextCursor;
      }
      // created_at desc: .123500 (ids[4]) first ... .123100 (ids[0]) last.
      expect(seen.slice(0, 5)).toEqual([...ids].reverse());

      const bad = await app.request("/api/notifications?cursor=%%%", { headers: { Authorization: `Bearer ${hunterKey}` } });
      expect(bad.status).toBe(422);
      const oldCursor = Buffer.from(`2099-01-01T00:00:00.123Z_${crypto.randomUUID()}`, "utf8").toString("base64url");
      const old = await app.request(`/api/notifications?cursor=${oldCursor}`, { headers: { Authorization: `Bearer ${hunterKey}` } });
      expect(old.status).toBe(200);
    } finally {
      for (const id of ids) await handle.db.delete(schema.notification).where(eq(schema.notification.id, id));
    }
  });

  // `since` used to filter on `sentAt`, which is null for every row that
  // hasn't terminally succeeded — a fresh `pending` row was invisible to any `?since=`
  // query, however recent. Filtering on `createdAt` (always set) fixes this.
  test("?since= includes a fresh pending row, not just sent ones", async () => {
    const [pending] = await handle.db.insert(schema.notification).values({ userId: hunterId, channel: "telegram", status: "pending" }).returning({ id: schema.notification.id });

    const app = createApp(handle);
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await app.request(`/api/notifications?since=${encodeURIComponent(since)}`, { headers: { Authorization: `Bearer ${hunterKey}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: { id: string }[] };
    expect(body.notifications.some((n) => n.id === pending!.id)).toBe(true);

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, pending!.id));
  });
});
