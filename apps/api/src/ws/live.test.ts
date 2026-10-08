import { PHONE_MASK } from "@feedhound/core/pii";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Session } from "../middleware/cf-access";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runThumbSweep } from "../../../agent/src/jobs/thumbs";
import { LiveFeed, thumbReadyPayloadSchema, type LiveClient, type LiveFrame } from "./live";

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
    console.warn(`live.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("live.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("live.test.ts: skipped — TEST_DATABASE_URL is unset");
}

// `post.new`/`post.updated`/`source.health` used to
// broadcast to every connected client with no team predicate. Exercises the
// private per-event handlers directly (bypassing `addClient`'s real
// `sql.listen`) so the test is deterministic and doesn't depend on NOTIFY
// delivery timing.
type PrivateLiveFeed = {
  clients: Set<LiveClient>;
  onPostNew(postId: string): Promise<void>;
  onSourceHealth(sourceId: string): Promise<void>;
  onMatchNew(matchId: string): Promise<void>;
};

function fakeClient(teamId: string, received: LiveFrame[], overrides?: Partial<Session>): LiveClient {
  const session: Session = { userId: "00000000-0000-0000-0000-000000000000", teamId, email: "x@example.com", role: "hunter", ...overrides };
  return { session, send: (frame) => received.push(frame) };
}

describe.skipIf(!canRun)("LiveFeed team scoping", () => {
  let handle: DbHandle;
  let teamAId: string;
  let teamBId: string;
  let sourceAId: string;
  let sourceBId: string;
  let postAId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [teamA] = await handle.db.insert(schema.team).values({ name: "live-scope-a" }).returning({ id: schema.team.id });
    teamAId = teamA!.id;
    const [teamB] = await handle.db.insert(schema.team).values({ name: "live-scope-b" }).returning({ id: schema.team.id });
    teamBId = teamB!.id;

    const [sourceA] = await handle.db
      .insert(schema.source)
      .values({ teamId: teamAId, kind: "web", platformId: "live-scope-a", name: "A", url: "https://feeds.example.test/live-scope-a" })
      .returning({ id: schema.source.id });
    sourceAId = sourceA!.id;
    const [sourceB] = await handle.db
      .insert(schema.source)
      .values({ teamId: teamBId, kind: "web", platformId: "live-scope-b", name: "B", url: "https://feeds.example.test/live-scope-b" })
      .returning({ id: schema.source.id });
    sourceBId = sourceB!.id;

    const [postA] = await handle.db
      .insert(schema.post)
      .values({ sourceId: sourceAId, platformPostId: "live-scope-p1", url: "https://x/1", title: "team A secret" })
      .returning({ id: schema.post.id });
    postAId = postA!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceAId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceAId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceBId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamAId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamBId));
    await handle.close();
  });

  test("post.new is only delivered to clients in the post's source's team", async () => {
    const feed = new LiveFeed(handle) as unknown as PrivateLiveFeed;
    const receivedA: LiveFrame[] = [];
    const receivedB: LiveFrame[] = [];
    feed.clients.add(fakeClient(teamAId, receivedA));
    feed.clients.add(fakeClient(teamBId, receivedB));

    await feed.onPostNew(postAId);

    expect(receivedA).toHaveLength(1);
    expect(receivedA[0]?.type).toBe("post.new");
    expect(receivedB).toHaveLength(0);
  });

  test("source.health is only delivered to clients in the source's team", async () => {
    const feed = new LiveFeed(handle) as unknown as PrivateLiveFeed;
    const receivedA: LiveFrame[] = [];
    const receivedB: LiveFrame[] = [];
    feed.clients.add(fakeClient(teamAId, receivedA));
    feed.clients.add(fakeClient(teamBId, receivedB));

    await feed.onSourceHealth(sourceAId);

    expect(receivedA).toHaveLength(1);
    expect(receivedA[0]?.type).toBe("source.health");
    expect(receivedB).toHaveLength(0);
  });

  // `match.new`'s `role === "operator"` short-circuit let *any* team's
  // operator receive another team's `matchId`/`watchId`/`postId`/`title` — the only event
  // of the three that wasn't team-scoped after the fix for the other two.
  test("match.new is only delivered to the watch owner and operators of the watch's own team", async () => {
    const [watchOwner] = await handle.db.insert(schema.user).values({ teamId: teamAId, email: `live-owner-${crypto.randomUUID()}@example.com`, role: "hunter" }).returning({ id: schema.user.id });
    const [watch] = await handle.db.insert(schema.watch).values({ userId: watchOwner!.id, name: `live-watch-${crypto.randomUUID()}`, include: ["t"] }).returning({ id: schema.watch.id });
    const [match] = await handle.db.insert(schema.match).values({ postId: postAId, watchId: watch!.id, score: 1 }).returning({ id: schema.match.id });

    const feed = new LiveFeed(handle) as unknown as PrivateLiveFeed;
    const receivedOwner: LiveFrame[] = [];
    const receivedOperatorA: LiveFrame[] = [];
    const receivedOperatorB: LiveFrame[] = [];
    const receivedHunterB: LiveFrame[] = [];
    feed.clients.add(fakeClient(teamAId, receivedOwner, { userId: watchOwner!.id }));
    feed.clients.add(fakeClient(teamAId, receivedOperatorA, { role: "operator" }));
    feed.clients.add(fakeClient(teamBId, receivedOperatorB, { role: "operator" }));
    feed.clients.add(fakeClient(teamBId, receivedHunterB));

    try {
      await feed.onMatchNew(match!.id);

      expect(receivedOwner).toHaveLength(1);
      expect(receivedOwner[0]?.type).toBe("match.new");
      expect(receivedOperatorA).toHaveLength(1); // same-team operator
      expect(receivedOperatorB).toHaveLength(0); // other-team operator — must not leak
      expect(receivedHunterB).toHaveLength(0);
    } finally {
      await handle.db.delete(schema.match).where(eq(schema.match.id, match!.id));
      await handle.db.delete(schema.watch).where(eq(schema.watch.id, watch!.id));
      await handle.db.delete(schema.user).where(eq(schema.user.id, watchOwner!.id));
    }
  });

  test("post.new carries snippet and priceSuspect", async () => {
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId: sourceAId, platformPostId: "live-scope-p2", url: "https://x/2", textNormalized: "\n  \nFirst  line\nsecond" })
      .returning({ id: schema.post.id });
    await handle.db.insert(schema.enrichment).values({ postId: p!.id, intent: "sell", priceVnd: null, priceRaw: "982.990.099", engine: "rule", displayTitle: "Toyota Vios 2016 · MT" });
    try {
      const feed = new LiveFeed(handle) as unknown as PrivateLiveFeed;
      const received: LiveFrame[] = [];
      feed.clients.add(fakeClient(teamAId, received));
      await feed.onPostNew(p!.id);
      const frame = received[0];
      expect(frame?.type).toBe("post.new");
      if (frame?.type !== "post.new") throw new Error("unreachable");
      expect(frame.data.snippet).toBe("First line");
      expect(frame.data.priceSuspect).toBe(true);
      expect(frame.data.displayTitle).toBe("Toyota Vios 2016 · MT");
    } finally {
      await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, p!.id));
      await handle.db.delete(schema.post).where(eq(schema.post.id, p!.id));
    }
  });

  test("post.new masks title, snippet and displayTitle", async () => {
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId: sourceAId, platformPostId: "live-scope-p3", url: "https://x/3", title: "Bán xe lh 0912 345 678", textNormalized: "ban xe zalo 0912345678" })
      .returning({ id: schema.post.id });
    await handle.db.insert(schema.enrichment).values({ postId: p!.id, intent: "sell", priceVnd: null, engine: "rule", displayTitle: "Vios 0912.345.678" });
    try {
      const feed = new LiveFeed(handle) as unknown as PrivateLiveFeed;
      const received: LiveFrame[] = [];
      feed.clients.add(fakeClient(teamAId, received));
      await feed.onPostNew(p!.id);
      const frame = received[0];
      if (frame?.type !== "post.new") throw new Error("expected post.new");
      expect(frame.data.title).toBe(`Bán xe lh ${PHONE_MASK}`);
      expect(frame.data.snippet).toBe(`ban xe zalo ${PHONE_MASK}`);
      expect(frame.data.displayTitle).toBe(`Vios ${PHONE_MASK}`);
      expect(JSON.stringify(frame)).not.toMatch(/0912|345/);
    } finally {
      await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, p!.id));
      await handle.db.delete(schema.post).where(eq(schema.post.id, p!.id));
    }
  });
});

// Wire test: the REAL agent sweep emits the NOTIFY, the REAL LiveFeed LISTENs, parses and relays it.
describe.skipIf(!canRun)("thumb.ready wire (agent sweep -> live feed)", () => {
  test("payload is schema-valid, relayed once per sweep to the owning team only", async () => {
    const handle = createDb(TEST_DATABASE_URL!);
    const mediaDir = await mkdtemp(`${tmpdir()}/live-thumb-`);
    const tag = crypto.randomUUID().slice(0, 8);
    const [tA] = await handle.db.insert(schema.team).values({ name: `thr-a-${tag}` }).returning({ id: schema.team.id });
    const [tB] = await handle.db.insert(schema.team).values({ name: `thr-b-${tag}` }).returning({ id: schema.team.id });
    const [src] = await handle.db
      .insert(schema.source)
      .values({ teamId: tA!.id, kind: "web", platformId: `thr-${tag}`, name: "thr", url: `https://feeds.example.test/thr-${tag}` })
      .returning({ id: schema.source.id });
    const media = [{ type: "image", url: `https://cdn.example.test/${tag}.jpg` }];
    const posts = await handle.db
      .insert(schema.post)
      .values([1, 2].map((n) => ({ sourceId: src!.id, platformPostId: `thr-${tag}-${n}`, url: "u", media })))
      .returning({ id: schema.post.id });
    const ids = posts.map((p) => p.id);
    const feed = new LiveFeed(handle);
    const a: LiveFrame[] = [];
    const b: LiveFrame[] = [];
    const rm1 = feed.addClient(fakeClient(tA!.id, a));
    const rm2 = feed.addClient(fakeClient(tB!.id, b));
    try {
      await new Promise((r) => setTimeout(r, 300)); // let LISTEN register
      const raw: string[] = [];
      await handle.sql.listen("thumb_ready", (p) => void raw.push(p));
      await runThumbSweep({
        handle,
        mediaDir,
        fetch: (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch,
        toThumb: async (buf) => buf,
        sleep: async () => {},
        config: { enabled: true, userAgent: "t", batch: 100, backfillDays: 7, maxBytes: 1_000_000, timeoutMs: 1000, allowedHosts: ["cdn.example.test"] },
      });
      for (let i = 0; i < 40 && a.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(raw.length).toBe(1);
      const parsed = thumbReadyPayloadSchema.safeParse(JSON.parse(raw[0]!));
      expect(parsed.success).toBe(true);
      expect(a).toHaveLength(1);
      expect(a[0]?.type).toBe("thumb.ready");
      const got = a[0]?.type === "thumb.ready" ? a[0].data.postIds : [];
      expect(got.sort()).toEqual([...ids].sort());
      expect(b).toHaveLength(0);
    } finally {
      rm1();
      rm2();
      await handle.db.delete(schema.post).where(eq(schema.post.sourceId, src!.id));
      await handle.db.delete(schema.source).where(eq(schema.source.id, src!.id));
      await handle.db.delete(schema.team).where(eq(schema.team.id, tA!.id));
      await handle.db.delete(schema.team).where(eq(schema.team.id, tB!.id));
      await rm(mediaDir, { recursive: true, force: true });
      await handle.close();
    }
  });

  test("schema rejects non-uuid ids and empty lists", () => {
    expect(thumbReadyPayloadSchema.safeParse({ postIds: ["x"] }).success).toBe(false);
    expect(thumbReadyPayloadSchema.safeParse({ postIds: [] }).success).toBe(false);
  });
});
