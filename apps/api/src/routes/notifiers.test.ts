import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
    console.warn(`notifiers.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("notifiers.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("notifiers.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("notifiers routes", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let apiKeyStr: string;
  let notifierId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `notifiers-test-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `nf-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    userId = user!.id;
    apiKeyStr = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({ userId, name: "k", prefix: apiKeyStr.slice(0, 8), hash: await sha256Hex(apiKeyStr), scopes: ["notifications:read", "notifications:write"] });
    const [notifier] = await handle.db.insert(schema.notifier).values({ userId, kind: "telegram", config: { chatId: 12345, mode: "instant" }, enabled: true }).returning({ id: schema.notifier.id });
    notifierId = notifier!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.notifier).where(eq(schema.notifier.userId, userId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("PATCH mode/digestEveryMin succeeds; chatId is immutable", async () => {
    const app = createApp(handle);
    const res = await app.request(`/api/notifiers/${notifierId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKeyStr}`, "Content-Type": "application/json" },
      body: JSON.stringify({ config: { mode: "digest", digestEveryMin: 15 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { chatId: number; mode: string; digestEveryMin: number } };
    expect(body.config.chatId).toBe(12345);
    expect(body.config.mode).toBe("digest");
    expect(body.config.digestEveryMin).toBe(15);
  });

  // `droppedMarkersOutsideBound` must always be present (defaulting to 0)
  // instead of only on the re-enable branch, so every caller can read the field
  // unconditionally instead of branching on whether it exists.
  test("PATCH not re-enabling still includes droppedMarkersOutsideBound (0)", async () => {
    const app = createApp(handle);
    const res = await app.request(`/api/notifiers/${notifierId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKeyStr}`, "Content-Type": "application/json" },
      body: JSON.stringify({ config: { mode: "digest", digestEveryMin: 20 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { droppedMarkersOutsideBound: number };
    expect(body.droppedMarkersOutsideBound).toBe(0);
  });

  test("PATCH enabled=false disables the notifier", async () => {
    const app = createApp(handle);
    const res = await app.request(`/api/notifiers/${notifierId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKeyStr}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  // A "no enabled notifier" marker always carries a real `matchId` in production
  // (`markNoTarget` in `notify.ts` never leaves it null); build a real
  // source/post/watch/match fixture so `clearNoEnabledNotifierMarkers`'s join against
  // `match.created_at` exercises the same shape as production data.
  async function makeMatchFixture(matchCreatedAt: Date): Promise<string> {
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `nf-src-${crypto.randomUUID()}`, name: "s", url: `https://feeds.example.test/nf-src-${crypto.randomUUID()}` })
      .returning({ id: schema.source.id });
    const [post] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: crypto.randomUUID(), url: "https://x/1", text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });
    const [watch] = await handle.db.insert(schema.watch).values({ userId, name: `nf-watch-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [match] = await handle.db
      .insert(schema.match)
      .values({ postId: post!.id, watchId: watch!.id, score: 1, createdAt: matchCreatedAt })
      .returning({ id: schema.match.id });
    return match!.id;
  }

  // `notify.ts`'s `markNoTarget("no enabled notifier")` marker is
  // permanent once written; re-enabling the notifier that made it fire must clear it so the
  // CR-1 sweeper can re-arm the underlying match instead of skipping it forever.
  // Bounded by match age — a marker attached to a match older than
  // `MARKER_CLEAR_MAX_AGE_HOURS` must survive re-enabling, so a notifier disabled for
  // weeks does not flood-reenqueue every historical match on re-enable.
  test("PATCH enabled=false then true clears recent 'no enabled notifier' markers but not weeks-old ones", async () => {
    const recentMatchId = await makeMatchFixture(new Date(Date.now() - 60 * 60 * 1000)); // 1h ago
    const oldMatchId = await makeMatchFixture(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)); // 30 days ago
    // `notification_match_no_notifier_unique` allows only one `notifierId is null` marker
    // per `matchId`, so the unrelated (different `lastError`) marker needs its own match.
    const unrelatedMatchId = await makeMatchFixture(new Date(Date.now() - 60 * 60 * 1000));

    const [marker] = await handle.db
      .insert(schema.notification)
      .values({ matchId: recentMatchId, notifierId: null, userId, channel: "none", status: "suppressed", lastError: "no enabled notifier", payload: {} })
      .returning({ id: schema.notification.id });
    const [oldMarker] = await handle.db
      .insert(schema.notification)
      .values({ matchId: oldMatchId, notifierId: null, userId, channel: "none", status: "suppressed", lastError: "no enabled notifier", payload: {} })
      .returning({ id: schema.notification.id });

    // Unrelated marker (different lastError) and a genuinely-unrelated notification must
    // survive the re-enable — only the stale "no enabled notifier" markers are cleared.
    const [unrelated] = await handle.db
      .insert(schema.notification)
      .values({ matchId: unrelatedMatchId, notifierId: null, userId, channel: "none", status: "suppressed", lastError: "watch disabled", payload: {} })
      .returning({ id: schema.notification.id });

    const app = createApp(handle);
    await app.request(`/api/notifiers/${notifierId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKeyStr}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await app.request(`/api/notifiers/${notifierId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKeyStr}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    // The age/count bound leaves the 30-day-old marker uncleared — this must
    // be surfaced to the caller, not dropped silently.
    const body = (await res.json()) as { droppedMarkersOutsideBound: number };
    expect(body.droppedMarkersOutsideBound).toBe(1);

    const [markerAfter] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, marker!.id));
    expect(markerAfter).toBeUndefined();
    const [oldMarkerAfter] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, oldMarker!.id));
    expect(oldMarkerAfter).toBeDefined();
    const [unrelatedAfter] = await handle.db.select().from(schema.notification).where(eq(schema.notification.id, unrelated!.id));
    expect(unrelatedAfter).toBeDefined();

    await handle.db.delete(schema.notification).where(eq(schema.notification.id, oldMarker!.id));
    await handle.db.delete(schema.notification).where(eq(schema.notification.id, unrelated!.id));
    await handle.db.delete(schema.match).where(eq(schema.match.id, recentMatchId));
    await handle.db.delete(schema.match).where(eq(schema.match.id, oldMatchId));
    await handle.db.delete(schema.match).where(eq(schema.match.id, unrelatedMatchId));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.post).where(eq(schema.post.url, "https://x/1"));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
  });
});

// Session access and `?userId=` (operator, same team) on GET /api/notifiers.
describe.skipIf(!canRun)("GET /api/notifiers by session", () => {
  let handle: DbHandle;
  let teamId: string;
  let otherTeamId: string;
  const emails: Record<"op" | "hunter" | "x", string> = { op: `nf040-op-${crypto.randomUUID()}@example.com`, hunter: `nf040-h-${crypto.randomUUID()}@example.com`, x: `nf040-x-${crypto.randomUUID()}@example.com` };
  const ids: Record<"op" | "hunter" | "x", string> = { op: "", hunter: "", x: "" };
  let originalNodeEnv: string | undefined;
  let originalDevBypass: string | undefined;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    const teams = await handle.db.insert(schema.team).values([{ name: `nf040-a-${crypto.randomUUID()}` }, { name: `nf040-b-${crypto.randomUUID()}` }]).returning({ id: schema.team.id });
    teamId = teams[0]!.id;
    otherTeamId = teams[1]!.id;
    const users = await handle.db
      .insert(schema.user)
      .values([
        { teamId, email: emails.op, role: "operator" },
        { teamId, email: emails.hunter, role: "hunter" },
        { teamId: otherTeamId, email: emails.x, role: "hunter" },
      ])
      .returning({ id: schema.user.id, email: schema.user.email });
    for (const u of users) for (const k of ["op", "hunter", "x"] as const) if (u.email === emails[k]) ids[k] = u.id;
    await handle.db.insert(schema.notifier).values([
      { userId: ids.op, kind: "telegram", config: { chatId: 1, mode: "instant" }, enabled: true },
      { userId: ids.hunter, kind: "telegram", config: { chatId: 2, mode: "instant" }, enabled: true },
      { userId: ids.x, kind: "telegram", config: { chatId: 3, mode: "instant" }, enabled: true },
    ]);
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DEV_AUTH_BYPASS = originalDevBypass;
    const all = Object.values(ids);
    for (const id of all) await handle.db.delete(schema.notifier).where(eq(schema.notifier.userId, id));
    for (const id of all) await handle.db.delete(schema.user).where(eq(schema.user.id, id));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, otherTeamId));
    await handle.close();
  });

  const list = async (email: string, query = ""): Promise<{ status: number; userIds: string[] }> => {
    const res = await createApp(handle).request(`/api/notifiers${query}`, { headers: { "X-Dev-User": email } });
    const body = (res.status === 200 ? ((await res.json()) as { notifiers: { userId: string }[] }) : { notifiers: [] }).notifiers;
    return { status: res.status, userIds: body.map((n) => n.userId) };
  };

  test("operator lists a teammate's rows; cross-team is 404; a hunter's ?userId= is ignored", async () => {
    expect(await list(emails.op, `?userId=${ids.hunter}`)).toEqual({ status: 200, userIds: [ids.hunter] });
    expect((await list(emails.op, `?userId=${ids.x}`)).status).toBe(404);
    expect(await list(emails.hunter, `?userId=${ids.op}`)).toEqual({ status: 200, userIds: [ids.hunter] });
    expect(await list(emails.op)).toEqual({ status: 200, userIds: [ids.op] });
  });

  test("a teammate's rows omit config; own rows keep it", async () => {
    const get = async (query: string): Promise<Record<string, unknown>[]> => {
      const res = await createApp(handle).request(`/api/notifiers${query}`, { headers: { "X-Dev-User": emails.op } });
      return ((await res.json()) as { notifiers: Record<string, unknown>[] }).notifiers;
    };
    const mate = await get(`?userId=${ids.hunter}`);
    expect(mate).toHaveLength(1);
    expect(mate[0]).not.toHaveProperty("config");
    expect(mate[0]).toMatchObject({ kind: "telegram", enabled: true });
    expect((await get(""))[0]).toHaveProperty("config");
  });
});
